import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from './auth.js';

const TOKEN = crypto.randomBytes(32).toString('hex');
const WRONG = crypto.randomBytes(32).toString('hex');

const servers: Server[] = [];

async function start(
  maxSessions?: number,
): Promise<{ url: string; sessionCount: () => number; errors: unknown[] }> {
  const errors: unknown[] = [];
  const auth = createAuth(maxSessions === undefined ? { token: TOKEN } : { token: TOKEN, maxSessions });
  const app = express();
  app.use(auth.pairRouter);
  app.use(auth.middleware);
  app.post('/events', (_req, res) => {
    res.status(202).json({ ok: true });
  });
  app.get('/stream', (_req, res) => {
    res.status(200).send('stream');
  });
  // Stands in for the app-level error handler that Block 4 mounts. Status 599 is a marker that no
  // real handler in this module uses, so a response with it proves that an error was forwarded
  // by the pairing router with next(err) instead of being answered there.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    errors.push(err);
    res.status(599).json({ error: 'global_handler' });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, sessionCount: auth.sessionCount, errors };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

function pair(url: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(`${url}/pair`, { method: 'POST', headers: { 'content-type': contentType }, body });
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

async function allHeadersAndBody(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${headers}\n${await res.text()}`;
}

describe('bearer token', () => {
  it('lets a valid Bearer token through (AC-31)', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/events`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(202);
    const s = await fetch(`${url}/stream`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(s.status).toBe(200);
  });

  it('returns 401 with no token on the events and stream routes (AC-32)', async () => {
    const { url } = await start();
    const e = await fetch(`${url}/events`, { method: 'POST' });
    const s = await fetch(`${url}/stream`);
    expect(e.status).toBe(401);
    expect(s.status).toBe(401);
    expect(await e.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 for a wrong token (AC-32)', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/stream`, { headers: { authorization: `Bearer ${WRONG}` } });
    expect(res.status).toBe(401);
  });

  it.each([
    ['wrong scheme', `Basic ${TOKEN}`],
    ['token with no scheme', TOKEN],
    ['too short', `Bearer ${TOKEN.slice(0, 63)}`],
    ['too long', `Bearer ${TOKEN}0`],
    ['non-hex', `Bearer ${'z'.repeat(64)}`],
    ['empty bearer', 'Bearer '],
  ])('returns 401 for a malformed Authorization header: %s', async (_name, header) => {
    const { url } = await start();
    const res = await fetch(`${url}/stream`, { headers: { authorization: header } });
    expect(res.status).toBe(401);
  });

  it('ignores a token passed in the query string', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/stream?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('returns an identical 401 body whatever part was wrong', async () => {
    const { url } = await start();
    const bodies = await Promise.all(
      [
        {},
        { authorization: `Bearer ${WRONG}` },
        { authorization: 'Bearer nope' },
        { authorization: `Basic ${TOKEN}` },
        { cookie: `ao_session=${WRONG}` },
        { cookie: 'ao_session=garbage' },
      ].map(async (headers) => {
        const res = await fetch(`${url}/stream`, { headers });
        expect(res.status).toBe(401);
        return res.text();
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe('{"error":"unauthorized"}');
  });

  it('never leaks the token in any failure response', async () => {
    const { url } = await start();
    const responses = [
      await fetch(`${url}/stream`, { headers: { authorization: `Bearer ${WRONG}` } }),
      await fetch(`${url}/stream`),
      await pair(url, JSON.stringify({ token: WRONG })),
      await pair(url, 'not json'),
      await pair(url, 'x'.repeat(2000)),
      await pair(url, JSON.stringify({ token: TOKEN }), 'text/plain'),
    ];
    for (const res of responses) {
      const dump = await allHeadersAndBody(res);
      expect(dump).not.toContain(TOKEN);
      expect(dump).not.toContain(WRONG);
    }
  });
});

describe('POST /pair', () => {
  it('answers 204 with an HttpOnly SameSite=Strict cookie different from the token (AC-36)', async () => {
    const { url, sessionCount } = await start();
    const res = await pair(url, JSON.stringify({ token: TOKEN }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ao_session=[0-9a-f]{64};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).not.toMatch(/Max-Age|Expires/i);
    expect(setCookie).not.toContain(TOKEN);
    expect(cookieOf(res)).not.toBe(`ao_session=${TOKEN}`);
    expect(await res.text()).toBe('');
    expect(sessionCount()).toBe(1);
  });

  it('issues a different session id on each pairing', async () => {
    const { url } = await start();
    const a = cookieOf(await pair(url, JSON.stringify({ token: TOKEN })));
    const b = cookieOf(await pair(url, JSON.stringify({ token: TOKEN })));
    expect(a).not.toBe(b);
  });

  it('grants access to the stream route with the pairing cookie (AC-36)', async () => {
    const { url } = await start();
    const cookie = cookieOf(await pair(url, JSON.stringify({ token: TOKEN })));
    const res = await fetch(`${url}/stream`, { headers: { cookie: `other=1; ${cookie}; x=y` } });
    expect(res.status).toBe(200);
    const ev = await fetch(`${url}/events`, { method: 'POST', headers: { cookie } });
    expect(ev.status).toBe(202);
  });

  it('returns 401 and sets no cookie for an invalid token (AC-37)', async () => {
    const { url, sessionCount } = await start();
    for (const token of [WRONG, 'abc', 'z'.repeat(64), 123, null]) {
      const res = await pair(url, JSON.stringify({ token }));
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    const missing = await pair(url, JSON.stringify({}));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('set-cookie')).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it('ignores a token in the query string', async () => {
    const { url } = await start();
    const q = await fetch(`${url}/pair?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(q.status).toBe(401);
    expect(q.headers.get('set-cookie')).toBeNull();
  });

  it('returns 401 for a cookie unknown to the server (AC-32)', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/stream`, { headers: { cookie: `ao_session=${WRONG}` } });
    expect(res.status).toBe(401);
  });

  it('does not accept the auth token itself as the cookie value', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/stream`, { headers: { cookie: `ao_session=${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('returns 400 when the body is not JSON', async () => {
    const { url } = await start();
    const res = await pair(url, 'not json at all');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 400 when the JSON is not an object', async () => {
    const { url } = await start();
    for (const body of ['[]', '"x"', '5', 'null']) {
      const res = await pair(url, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    }
  });

  it('returns 413 when the body is larger than 1 KB', async () => {
    const { url } = await start();
    const res = await pair(url, JSON.stringify({ token: TOKEN, pad: 'a'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 415 for a text/plain content type', async () => {
    const { url } = await start();
    const res = await pair(url, JSON.stringify({ token: TOKEN }), 'text/plain');
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 401 with no cookie and no session for an empty JSON body', async () => {
    const { url, sessionCount } = await start();
    const res = await pair(url, '');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it('pins the behavior of a JSON content type with no body at all (401, no session)', async () => {
    const { url, sessionCount } = await start();
    const res = await fetch(`${url}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it('passes other body-parser errors to the global handler without answering itself', async () => {
    const { url, sessionCount, errors } = await start();
    const res = await pair(url, JSON.stringify({ token: TOKEN }), 'application/json; charset=iso-8859-1');
    expect(res.status).toBe(599);
    expect(errors).toHaveLength(1);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it('finds the pairing cookie among cookie parts without an equals sign', async () => {
    const { url } = await start();
    const id = cookieOf(await pair(url, JSON.stringify({ token: TOKEN }))).slice('ao_session='.length);
    const ok = await fetch(`${url}/stream`, { headers: { cookie: `foo; ao_session=${id}; bar` } });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${url}/stream`, { headers: { cookie: 'foo' } });
    expect(bad.status).toBe(401);
  });

  it('caps the session map and drops the oldest session first', async () => {
    const { url, sessionCount } = await start(3);
    const cookies: string[] = [];
    for (let i = 0; i < 4; i++) {
      cookies.push(cookieOf(await pair(url, JSON.stringify({ token: TOKEN }))));
    }
    expect(sessionCount()).toBe(3);
    const status = async (c: string): Promise<number> =>
      (await fetch(`${url}/stream`, { headers: { cookie: c } })).status;
    expect(await status(cookies[0] as string)).toBe(401);
    expect(await status(cookies[1] as string)).toBe(200);
    expect(await status(cookies[2] as string)).toBe(200);
    expect(await status(cookies[3] as string)).toBe(200);
  });
});
