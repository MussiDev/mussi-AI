import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createBus, type Bus } from './bus.js';
import { openDb, type Db } from './db.js';
import { DEFAULT_PORT, PortInUseError, describeError, resolvePort, runMain, startServer, type RunningServer } from './main.js';
import { loadOrCreateToken, resolveDataDir } from './secrets.js';

// ---------------------------------------------------------------- harness

const agent = new http.Agent({ keepAlive: true });
const homes: string[] = [];
const dbs: Db[] = [];
const servers: http.Server[] = [];
const running: RunningServer[] = [];
const blockers: net.Server[] = [];

afterEach(async () => {
  // Each resource is closed on its own, so one failing close cannot leak the rest.
  const failures: unknown[] = [];
  const step = async (fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(e);
    }
  };
  for (const r of running.splice(0)) await step(() => r.close());
  for (const s of servers.splice(0)) {
    await step(async () => {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    });
  }
  for (const b of blockers.splice(0)) await step(() => new Promise<void>((resolve) => b.close(() => resolve())));
  // A server closed through running[] already closed its database; only live handles are closed here.
  for (const d of dbs.splice(0)) await step(() => (d.isAvailable() ? d.close() : undefined));
  await step(() => agent.destroy());
  for (const h of homes.splice(0)) await step(() => fs.rmSync(h, { recursive: true, force: true, maxRetries: 3 }));
  if (failures.length > 0) throw failures[0];
});

interface Harness {
  port: number;
  token: string;
  db: Db;
  bus: Bus;
  dataDir: string;
  logs: string[];
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ing-'));
  homes.push(home);
  return home;
}

function openFor(home: string, logs: string[]): { dataDir: string; token: string; db: Db } {
  const dataDir = resolveDataDir({}, home);
  const token = loadOrCreateToken(dataDir);
  const db = openDb({ dataDir, dbPath: path.join(dataDir, 'office.db'), log: (m) => logs.push(m) });
  dbs.push(db);
  return { dataDir, token, db };
}

async function harness(wrap?: (db: Db) => Db): Promise<Harness> {
  const logs: string[] = [];
  const { dataDir, token, db } = openFor(makeHome(), logs);
  const bus = createBus({ onListenerError: (_err, name) => logs.push(`Bus listener failed for ${name}`) });
  let port = 0;
  const app = createApp({ token, db: wrap ? wrap(db) : db, bus, getPort: () => port, log: (m) => logs.push(m) });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  port = (server.address() as AddressInfo).port;
  return { port, token, db, bus, dataDir, logs };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

interface SendOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  host?: string;
  signal?: AbortSignal;
}

function send(port: number, o: SendOptions = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(
      {
        host: o.host ?? '127.0.0.1',
        port,
        method: o.method ?? 'POST',
        path: o.path ?? '/events',
        headers: o.headers ?? {},
        agent,
        ...(o.signal ? { signal: o.signal } : {}),
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Not JSON: leave the parsed body empty.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', (e) => {
      // The server may answer and close before the whole body is sent.
      if (!answered) reject(e);
    });
    req.end(o.body);
  });
}

function bearer(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.token}` };
}

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ts: 1000,
    hook: 'UserPromptSubmit',
    user: 'alice',
    project: 'proj',
    session: 's1',
    agent_id: null,
    agent: 'boss',
    ...over,
  };
}

function post(h: Harness, event: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return send(h.port, {
    headers: { 'content-type': 'application/json', ...bearer(h), ...headers },
    body: JSON.stringify(event),
  });
}

function readKey(h: Harness): string {
  return fs.readFileSync(path.join(h.dataDir, 'db.key'), 'utf8').trim();
}

function raw<T>(h: Harness, fn: (d: Database.Database) => T, key: string = readKey(h)): T {
  const d = new Database(path.join(h.dataDir, 'office.db'));
  try {
    d.pragma("cipher='sqlcipher'");
    d.key(Buffer.from(key));
    return fn(d);
  } finally {
    d.close();
  }
}

function rows(h: Harness, sql: string): Array<Record<string, unknown>> {
  return raw(h, (d) => d.prepare(sql).all() as Array<Record<string, unknown>>);
}

function countEvents(h: Harness, key?: string): number {
  return raw(h, (d) => (d.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c, key);
}

function dump(h: Harness): string {
  return raw(h, (d) =>
    ['sessions', 'agents', 'tasks', 'events']
      .map((t) => JSON.stringify(d.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n'),
  );
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function block(host: string, port: number): Promise<net.Server | null> {
  const s = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    s.once('error', () => resolve(false));
    s.listen(port, host, () => resolve(true));
  });
  if (!ok) return null;
  blockers.push(s);
  return s;
}

const ipv6Available = (await block('::1', 0)) !== null;
const ipv6Name = (name: string): string =>
  ipv6Available ? name : `${name} (skipped: no usable ::1 loopback on this machine)`;

const BIG = 'x'.repeat(70 * 1024);

// ---------------------------------------------------------------- required tests

describe('POST /events', () => {
  it('a valid event with a valid auth token returns 202 and is stored with its identifiers', async () => {
    const h = await harness();
    const res = await post(h, ev({ agent_id: 'a1', agent: 'explorer', hook: 'PreToolUse', tool: 'Read' }));
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ ok: true });
    expect(rows(h, 'SELECT * FROM events')).toEqual([
      expect.objectContaining({
        user: 'alice',
        project: 'proj',
        session: 's1',
        agent_key: 'a1',
        agent_name: 'explorer',
        hook: 'PreToolUse',
        tool: 'Read',
        ts: 1000,
      }),
    ]);
    expect(rows(h, 'SELECT * FROM sessions')).toEqual([
      expect.objectContaining({ id: 's1', user: 'alice', project: 'proj', started_at: 1000 }),
    ]);
  });

  it('a request with no auth token returns 401 and stores nothing', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev()) });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'unauthorized' });
    expect(countEvents(h)).toBe(0);
  });

  it('a request with a wrong auth token returns 401 and stores nothing', async () => {
    const h = await harness();
    const res = await post(h, ev(), { authorization: `Bearer ${'0'.repeat(64)}` });
    expect(res.status).toBe(401);
    expect(countEvents(h)).toBe(0);
  });

  it('a body that is not JSON returns 400 and stores nothing', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json', ...bearer(h) },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_json' });
    expect(countEvents(h)).toBe(0);
  });

  it('a body over 64 KB returns 413 and stores nothing', async () => {
    const h = await harness();
    const res = await post(h, ev({ padding: BIG }));
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: 'too_large' });
    expect(countEvents(h)).toBe(0);
  });

  it('a text/plain body returns 415 and stores nothing', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'text/plain', ...bearer(h) },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ error: 'unsupported_media_type' });
    expect(countEvents(h)).toBe(0);
  });

  it('a request with a body-less POST and no content type returns 415', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: bearer(h) });
    expect(res.status).toBe(415);
  });

  it('a charset other than utf-8 (iso-8859-1) returns 415 and stores nothing', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json; charset=iso-8859-1', ...bearer(h) },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ error: 'unsupported_media_type' });
    expect(countEvents(h)).toBe(0);
  });

  it('an unsupported content encoding returns 415', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json', 'content-encoding': 'bogus', ...bearer(h) },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(415);
  });

  it('an Origin of another site returns 403 forbidden and stores nothing', async () => {
    const h = await harness();
    const res = await post(h, ev(), { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'forbidden' });
    expect(countEvents(h)).toBe(0);
  });

  it('a foreign Host returns 403 forbidden and stores nothing', async () => {
    const h = await harness();
    const res = await post(h, ev(), { host: `evil.example:${h.port}` });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'forbidden' });
    expect(countEvents(h)).toBe(0);
  });

  it('a loopback Host with the wrong port returns 403', async () => {
    const h = await harness();
    const res = await post(h, ev(), { host: `127.0.0.1:${h.port + 1}` });
    expect(res.status).toBe(403);
  });

  it('accepts localhost and [::1] hosts and the own origin, and sends no CORS headers', async () => {
    const h = await harness();
    for (const [host, origin] of [
      [`localhost:${h.port}`, `http://localhost:${h.port}`],
      [`[::1]:${h.port}`, `http://[::1]:${h.port}`],
      [`127.0.0.1:${h.port}`, `http://127.0.0.1:${h.port}`],
    ] as const) {
      const res = await post(h, ev(), { host, origin });
      expect(res.status).toBe(202);
      expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('an Origin of null or of the right host on another scheme or port returns 403', async () => {
    const h = await harness();
    for (const origin of ['null', `https://127.0.0.1:${h.port}`, `http://127.0.0.1:${h.port + 1}`]) {
      expect((await post(h, ev(), { origin })).status).toBe(403);
    }
  });

  it('does not advertise the framework', async () => {
    const h = await harness();
    const res = await post(h, ev());
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('an event missing session returns 422 naming the field', async () => {
    const h = await harness();
    const { session: _omit, ...noSession } = ev();
    const res = await post(h, noSession);
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: 'invalid_event', field: 'session' });
    expect(countEvents(h)).toBe(0);
  });

  it('an event with ts of the wrong type returns 422 invalid_event', async () => {
    const h = await harness();
    const res = await post(h, ev({ ts: 'yesterday' }));
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: 'invalid_event', field: 'ts' });
    expect(countEvents(h)).toBe(0);
  });

  it('an empty JSON body returns 422', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: { 'content-type': 'application/json', ...bearer(h) } });
    expect(res.status).toBe(422);
    expect(res.json['error']).toBe('invalid_event');
  });

  it('an event with extra fields stores none of them', async () => {
    const h = await harness();
    const res = await post(
      h,
      ev({ prompt: 'SECRET-PROMPT-TEXT', tool_input: { command: 'SECRET-COMMAND' }, cwd: 'SECRET-CWD' }),
    );
    expect(res.status).toBe(202);
    const all = dump(h);
    expect(all).not.toContain('SECRET');
    expect(all).toContain('alice');
  });

  it('a file-edit event stores the path and no edited text', async () => {
    const h = await harness();
    const res = await post(
      h,
      ev({
        hook: 'PreToolUse',
        tool: 'Edit',
        file: 'C:/proj/src/a.ts',
        new_string: 'SECRET-NEW-CODE',
        old_string: 'SECRET-OLD-CODE',
        content: 'SECRET-FILE-CONTENT',
      }),
    );
    expect(res.status).toBe(202);
    const stored = rows(h, 'SELECT * FROM events');
    expect(stored[0]).toEqual(expect.objectContaining({ tool: 'Edit', file: 'C:/proj/src/a.ts' }));
    expect(dump(h)).not.toContain('SECRET');
  });

  it('with the database unavailable the service returns 503 and stores nothing', async () => {
    const h = await harness();
    const key = readKey(h);
    h.db.close();
    const keyFile = path.join(h.dataDir, 'db.key');
    fs.rmSync(keyFile);
    const res = await post(h, ev());
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: 'database_unavailable' });
    expect(h.logs.some((l) => l.includes('Database unavailable'))).toBe(true);
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    expect(countEvents(h, key)).toBe(0);
  });

  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
  it.skipIf(lan === undefined)(
    lan === undefined
      ? 'a connection through a non-loopback address fails (skipped: no non-loopback IPv4 address on this machine)'
      : 'a connection through a non-loopback address fails',
    async () => {
      // The real startServer decides what to bind, so the test targets its actual listeners.
      const logs: string[] = [];
      const { token, db } = openFor(makeHome(), logs);
      const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m) });
      running.push(server);
      const address = (lan as { address: string }).address;
      const failure = await send(server.port, {
        host: address,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, host: `${address}:${server.port}` },
        body: JSON.stringify(ev()),
        // A firewall that drops packets would otherwise hang until the OS timeout.
        signal: AbortSignal.timeout(4000),
      }).then(
        () => null,
        (e: unknown) => e as { code?: string; name?: string },
      );
      // Any HTTP answer (a 403 or a 202) means the address was reachable and fails the test.
      expect(failure).not.toBeNull();
      const unreachable = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ABORT_ERR'];
      expect(unreachable).toContain(failure?.code);
    },
    15_000,
  );

  it('starting on a port already in use fails with an error naming the port', async () => {
    const logs: string[] = [];
    const { token, db } = openFor(makeHome(), logs);
    const busy = await block('127.0.0.1', 0);
    const port = (busy?.address() as AddressInfo).port;
    const failure = await startServer({ token, db, port, log: (m) => logs.push(m) }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PortInUseError);
    expect((failure as Error).message).toContain(String(port));
  });

  it('an event stream of 50 events per second for 10 seconds stores all 500 events', async () => {
    const h = await harness();
    const total = 500;
    const start = Date.now();
    const pending: Array<Promise<Res>> = [];
    for (let i = 0; i < total; i++) {
      const wait = start + i * 20 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      pending.push(post(h, ev({ session: `load-${i % 5}`, ts: 1_000_000 + i, hook: 'PreToolUse', tool: 'Bash' })));
    }
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.status === 202)).toHaveLength(total);
    expect(countEvents(h)).toBe(total);
  }, 30_000);
});

// ---------------------------------------------------------------- guard order

describe('guard order', () => {
  it('a foreign Origin with no token answers 403 before auth', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(403);
  });

  it('no token with a wrong content type answers 401 before 415', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: { 'content-type': 'text/plain' }, body: 'hello' });
    expect(res.status).toBe(401);
  });

  it('a wrong content type with a huge body answers 415 before 413', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: { 'content-type': 'text/plain', ...bearer(h) }, body: BIG });
    expect(res.status).toBe(415);
  });

  it('a huge body that is not JSON answers 413 before 400', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json', ...bearer(h) },
      body: `{${BIG}`,
    });
    expect(res.status).toBe(413);
  });

  it('invalid JSON answers 400 and valid JSON that is not an event answers 422', async () => {
    const h = await harness();
    const headers = { 'content-type': 'application/json', ...bearer(h) };
    expect((await send(h.port, { headers, body: '{"v":' })).status).toBe(400);
    expect((await send(h.port, { headers, body: '{"v":2}' })).status).toBe(422);
    expect((await send(h.port, { headers, body: '[]' })).status).toBe(422);
  });

  it('no token with invalid JSON answers 401, not 400: nothing is parsed before auth', async () => {
    const h = await harness();
    const res = await send(h.port, { headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'unauthorized' });
  });

  it('no token with a 100 KB body answers 401, not 413', async () => {
    const h = await harness();
    const res = await send(h.port, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev({ padding: 'y'.repeat(100 * 1024) })),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------- pairing through the real app

describe('POST /pair through the full app', () => {
  function pair(h: Harness, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return send(h.port, {
      path: '/pair',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('pairs with the right token and the cookie then authenticates POST /events', async () => {
    const h = await harness();
    const res = await pair(h, { token: h.token });
    expect(res.status).toBe(204);
    const cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^ao_session=[0-9a-f]{64}$/);
    const ingested = await send(h.port, {
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(ev()),
    });
    expect(ingested.status).toBe(202);
  });

  it('an unsupported content encoding answers 415 with no cookie', async () => {
    const h = await harness();
    const res = await pair(h, { token: h.token }, { 'content-encoding': 'bogus' });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ error: 'unsupported_media_type' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a charset other than utf-8 (iso-8859-1) answers 415 with no cookie', async () => {
    const h = await harness();
    const res = await pair(h, { token: h.token }, { 'content-type': 'application/json; charset=iso-8859-1' });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ error: 'unsupported_media_type' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a wrong token does not pair', async () => {
    const h = await harness();
    const res = await pair(h, { token: '1'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a foreign Origin gets 403 and no cookie', async () => {
    const h = await harness();
    const res = await pair(h, { token: h.token }, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a foreign Host gets 403 and no cookie', async () => {
    const h = await harness();
    const res = await pair(h, { token: h.token }, { host: `evil.example:${h.port}` });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('keeps its own 1 KB limit while a 2 KB event to /events is accepted', async () => {
    const h = await harness();
    const pad = 'p'.repeat(2048);
    expect((await pair(h, { token: h.token, pad })).status).toBe(413);
    expect((await post(h, ev({ pad }))).status).toBe(202);
  });
});

// ---------------------------------------------------------------- reducer end to end

describe('stage and task lifecycle end to end', () => {
  it('opens a task on a prompt, Stop closes it, an idle notification opens nothing, a later prompt opens a task at its own ts', async () => {
    const h = await harness();
    await post(h, ev({ ts: 1000, hook: 'UserPromptSubmit' }));
    expect(rows(h, 'SELECT started_at, ended_at FROM tasks')).toEqual([{ started_at: 1000, ended_at: null }]);

    await post(h, ev({ ts: 2000, hook: 'Stop' }));
    expect(rows(h, 'SELECT started_at, ended_at FROM tasks')).toEqual([{ started_at: 1000, ended_at: 2000 }]);
    expect(h.db.getAgent('s1', 'boss')?.stage).toBe('Done');

    await post(h, ev({ ts: 3000, hook: 'Notification', notification: 'idle_prompt' }));
    expect(rows(h, 'SELECT id FROM tasks')).toHaveLength(1);
    expect(h.db.getAgent('s1', 'boss')?.stage).toBe('Done');

    await post(h, ev({ ts: 4000, hook: 'UserPromptSubmit' }));
    expect(rows(h, 'SELECT started_at, ended_at FROM tasks ORDER BY id')).toEqual([
      { started_at: 1000, ended_at: 2000 },
      { started_at: 4000, ended_at: null },
    ]);
  });

  it('links each event to the task it opened, closed or ran inside', async () => {
    const h = await harness();
    await post(h, ev({ ts: 1000, hook: 'UserPromptSubmit' }));
    await post(h, ev({ ts: 1500, hook: 'PreToolUse', tool: 'Bash' }));
    await post(h, ev({ ts: 2000, hook: 'Stop' }));
    await post(h, ev({ ts: 3000, hook: 'SessionStart' }));
    const links = rows(h, 'SELECT hook, task_id FROM events ORDER BY id');
    const taskId = rows(h, 'SELECT id FROM tasks')[0]?.['id'];
    expect(links).toEqual([
      { hook: 'UserPromptSubmit', task_id: taskId },
      { hook: 'PreToolUse', task_id: taskId },
      { hook: 'Stop', task_id: taskId },
      { hook: 'SessionStart', task_id: null },
    ]);
  });

  it('stores a stale event but does not change the stage', async () => {
    const h = await harness();
    await post(h, ev({ ts: 5000, hook: 'PreToolUse', tool: 'Edit' }));
    expect(h.db.getAgent('s1', 'boss')?.stage).toBe('Editing');
    const stale = await post(h, ev({ ts: 4500, hook: 'PostToolUse', tool: 'Edit' }));
    expect(stale.status).toBe(202);
    expect(h.db.getAgent('s1', 'boss')).toEqual(expect.objectContaining({ stage: 'Editing', last_ts: 5000 }));
    expect(countEvents(h)).toBe(2);
  });

  it('SessionEnd closes the open tasks of every agent of the session and ends it, storing the event once', async () => {
    const h = await harness();
    await post(h, ev({ ts: 1000, hook: 'UserPromptSubmit' }));
    await post(h, ev({ ts: 1100, hook: 'PreToolUse', tool: 'Read', agent_id: 'a1', agent: 'explorer' }));
    await post(h, ev({ ts: 1200, session: 'other', hook: 'UserPromptSubmit' }));
    const res = await post(h, ev({ ts: 2000, hook: 'SessionEnd' }));
    expect(res.status).toBe(202);
    expect(rows(h, "SELECT agent_key, ended_at FROM tasks WHERE session = 's1' ORDER BY agent_key")).toEqual([
      { agent_key: 'a1', ended_at: 2000 },
      { agent_key: 'boss', ended_at: 2000 },
    ]);
    expect(h.db.getAgent('s1', 'a1')?.stage).toBe('Done');
    expect(h.db.getAgent('s1', 'boss')?.stage).toBe('Done');
    expect(h.db.getSession('s1')?.ended_at).toBe(2000);
    expect(h.db.getSession('other')?.ended_at).toBeNull();
    expect(h.db.getOpenTask('other', 'boss')).toBeDefined();
    expect(rows(h, "SELECT id FROM events WHERE hook = 'SessionEnd'")).toHaveLength(1);
  });

  it('a SessionEnd for a session never seen registers it and opens no task', async () => {
    const h = await harness();
    const res = await post(h, ev({ ts: 2000, hook: 'SessionEnd', session: 'fresh' }));
    expect(res.status).toBe(202);
    expect(rows(h, 'SELECT id FROM tasks')).toHaveLength(0);
    expect(h.db.getSession('fresh')?.ended_at).toBe(2000);
  });

  it('keeps the transcript path once the session knows it', async () => {
    const h = await harness();
    await post(h, ev({ ts: 1000, transcript: 'C:/t/s1.jsonl' }));
    await post(h, ev({ ts: 1100, hook: 'PostToolUse' }));
    expect(h.db.getSession('s1')?.transcript).toBe('C:/t/s1.jsonl');
  });
});

// ---------------------------------------------------------------- bus

describe('bus', () => {
  function record(bus: Bus): Array<[string, unknown]> {
    const seen: Array<[string, unknown]> = [];
    bus.on('agentChanged', (p) => seen.push(['agentChanged', p]));
    bus.on('toolFinished', (p) => seen.push(['toolFinished', p]));
    bus.on('agentStopped', (p) => seen.push(['agentStopped', p]));
    bus.on('sessionEnded', (p) => seen.push(['sessionEnded', p]));
    return seen;
  }

  it('emits agentChanged, toolFinished, agentStopped and sessionEnded after the event is stored', async () => {
    const h = await harness();
    const seen = record(h.bus);
    const boss = { session: 's1', agentKey: 'boss' };
    const sub = { session: 's1', agentKey: 'a1' };

    await post(h, ev({ ts: 1000, hook: 'UserPromptSubmit' }));
    expect(seen).toEqual([['agentChanged', boss]]);

    seen.length = 0;
    await post(h, ev({ ts: 1100, hook: 'PostToolUse', tool: 'Bash' }));
    expect(seen).toEqual([
      ['agentChanged', boss],
      ['toolFinished', boss],
    ]);

    seen.length = 0;
    await post(h, ev({ ts: 1200, hook: 'PostToolUseFailure', tool: 'Bash' }));
    expect(seen).toEqual([
      ['agentChanged', boss],
      ['toolFinished', boss],
    ]);

    seen.length = 0;
    await post(h, ev({ ts: 1300, hook: 'Stop' }));
    expect(seen).toEqual([
      ['agentChanged', boss],
      ['agentStopped', boss],
    ]);

    seen.length = 0;
    await post(h, ev({ ts: 1400, hook: 'SubagentStop', agent_id: 'a1', agent: 'explorer' }));
    expect(seen).toEqual([
      ['agentChanged', sub],
      ['agentStopped', sub],
    ]);

    seen.length = 0;
    await post(h, ev({ ts: 1500, hook: 'SessionEnd' }));
    expect(seen).toEqual([
      ['agentChanged', boss],
      ['agentChanged', sub],
      ['sessionEnded', { session: 's1' }],
    ]);
  });

  it('does not announce a stale event as a state change', async () => {
    const h = await harness();
    await post(h, ev({ ts: 5000, hook: 'PreToolUse', tool: 'Edit' }));
    const seen = record(h.bus);
    await post(h, ev({ ts: 4000, hook: 'UserPromptSubmit' }));
    expect(seen).toEqual([]);
  });

  it('emits nothing when the event is rejected or the database is unavailable', async () => {
    const h = await harness();
    const seen = record(h.bus);
    await post(h, ev({ ts: 'bad' }));
    await post(h, ev(), { authorization: `Bearer ${'0'.repeat(64)}` });
    expect(seen).toEqual([]);

    const key = readKey(h);
    h.db.close();
    fs.rmSync(path.join(h.dataDir, 'db.key'));
    await post(h, ev());
    fs.writeFileSync(path.join(h.dataDir, 'db.key'), key, { mode: 0o600 });
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------- unexpected errors

describe('internal errors', () => {
  it('answers 500 internal_error without echoing error text or event content, and logs a generic line', async () => {
    const h = await harness(
      (db) =>
        Object.create(db, {
          transaction: {
            value: () => {
              throw new Error('SECRET-INTERNAL-DETAIL');
            },
          },
        }) as Db,
    );
    const res = await post(h, ev({ user: 'unique-user-zed', prompt: 'SECRET-PROMPT' }));
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'internal_error' });
    const everything = res.text + JSON.stringify(res.headers) + h.logs.join('\n');
    for (const leak of ['SECRET-INTERNAL-DETAIL', 'unique-user-zed', 'SECRET-PROMPT', h.token, 'Error:']) {
      expect(everything).not.toContain(leak);
    }
    expect(h.logs.length).toBeGreaterThan(0);
  });

  it('a failure midway through the transaction leaves no partial event', async () => {
    const h = await harness(
      (db) =>
        Object.create(db, {
          insertEvent: {
            value: () => {
              throw new Error('boom');
            },
          },
        }) as Db,
    );
    const res = await post(h, ev({ hook: 'UserPromptSubmit' }));
    expect(res.status).toBe(500);
    for (const table of ['sessions', 'agents', 'tasks', 'events']) {
      expect(rows(h, `SELECT * FROM ${table}`)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- main

describe('startup', () => {
  it('defaults to port 4317 and validates AGENTS_OFFICE_PORT', () => {
    expect(DEFAULT_PORT).toBe(4317);
    expect(resolvePort({})).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '8080' })).toBe(8080);
    for (const bad of ['abc', '0', '65536', '12.5', '-1', '', ' 80', '1e3']) {
      if (bad === '') {
        expect(resolvePort({ AGENTS_OFFICE_PORT: bad })).toBe(4317);
      } else {
        expect(() => resolvePort({ AGENTS_OFFICE_PORT: bad })).toThrow(/AGENTS_OFFICE_PORT/);
      }
    }
  });

  it('runMain starts on the configured port, prints the token file path and never the token', async () => {
    const home = makeHome();
    const port = await freePort();
    const env = { AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: String(port) };
    const out: string[] = [];
    const result = await runMain(env, { out: (m) => out.push(m), home });
    expect(result.exitCode).toBe(0);
    expect(result.server).toBeDefined();
    running.push(result.server as RunningServer);

    const tokenFile = path.join(resolveDataDir(env, home), 'token');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const printed = out.join('\n');
    expect(printed).toContain(tokenFile);
    expect(printed).toContain(String(port));
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(fs.readFileSync(path.join(resolveDataDir(env, home), 'db.key'), 'utf8').trim());

    const body = JSON.stringify(ev());
    const good = await send(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    });
    expect(good.status).toBe(202);
    const noToken = await send(port, { headers: { 'content-type': 'application/json' }, body });
    expect(noToken.status).toBe(401);
  });

  it('closing the running server also closes the database', async () => {
    const logs: string[] = [];
    const { token, db } = openFor(makeHome(), logs);
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m) });
    expect(server.port).toBeGreaterThan(0);
    expect(db.isAvailable()).toBe(true);
    await server.close();
    expect(db.isAvailable()).toBe(false);
  });

  it.skipIf(!ipv6Available)(ipv6Name('also listens on ::1 with the same app'), async () => {
    const logs: string[] = [];
    const { token, db } = openFor(makeHome(), logs);
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m) });
    running.push(server);
    const res = await send(server.port, {
      host: '::1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, host: `[::1]:${server.port}` },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(202);
  });

  it.skipIf(!ipv6Available)(ipv6Name('keeps 127.0.0.1 and reports it when ::1 cannot be used'), async () => {
    const logs: string[] = [];
    const startup: string[] = [];
    const { token, db } = openFor(makeHome(), logs);
    // Occupy ::1 first and take whatever port it got, so the busy side is known to be busy.
    const blocker = await block('::1', 0);
    const port = (blocker?.address() as AddressInfo).port;
    const server = await startServer({ token, db, port, log: (m) => logs.push(m), out: (m) => startup.push(m) });
    running.push(server);
    expect(startup.some((l) => l.includes('::1'))).toBe(true);
    expect(logs.some((l) => l.includes('::1'))).toBe(false);
    const res = await send(port, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(ev()),
    });
    expect(res.status).toBe(202);
  });

  async function failing(
    env: NodeJS.ProcessEnv,
    home: string,
  ): Promise<{ result: Awaited<ReturnType<typeof runMain>>; printed: string }> {
    const out: string[] = [];
    const result = await runMain(env, { out: (m) => out.push(m), home });
    return { result, printed: out.join('\n') };
  }

  it('an invalid port returns exit code 1 naming AGENTS_OFFICE_PORT', async () => {
    const home = makeHome();
    const { result, printed } = await failing(
      { AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: 'banana' },
      home,
    );
    expect(result.exitCode).toBe(1);
    expect(result.server).toBeUndefined();
    expect(printed).toContain('AGENTS_OFFICE_PORT');
  });

  it('a data directory outside home returns exit code 1 with the SecretsError message', async () => {
    const home = makeHome();
    const outside = makeHome();
    const { result, printed } = await failing(
      { AGENTS_OFFICE_HOME: outside, AGENTS_OFFICE_PORT: String(await freePort()) },
      home,
    );
    expect(result.exitCode).toBe(1);
    expect(printed).toContain('must be inside the home directory');
  });

  it('a missing database key returns exit code 1 naming the key file and never the token', async () => {
    const home = makeHome();
    const dataDir = resolveDataDir({ AGENTS_OFFICE_HOME: path.join(home, '.ao') }, home);
    const token = loadOrCreateToken(dataDir);
    fs.writeFileSync(path.join(dataDir, 'office.db'), 'not really a database');
    const { result, printed } = await failing(
      { AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: String(await freePort()) },
      home,
    );
    expect(result.exitCode).toBe(1);
    expect(printed).toContain('db.key');
    expect(printed).not.toContain(token);
  });

  it('a database that cannot be decrypted returns exit code 1 from DbStartupError', async () => {
    const home = makeHome();
    const envHome = path.join(home, '.ao');
    const dataDir = resolveDataDir({ AGENTS_OFFICE_HOME: envHome }, home);
    loadOrCreateToken(dataDir);
    fs.writeFileSync(path.join(dataDir, 'db.key'), 'a'.repeat(64), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'office.db'), Buffer.alloc(4096, 7));
    const { result, printed } = await failing(
      { AGENTS_OFFICE_HOME: envHome, AGENTS_OFFICE_PORT: String(await freePort()) },
      home,
    );
    expect(result.exitCode).toBe(1);
    expect(printed).toContain('cannot be decrypted');
    expect(printed).not.toContain('a'.repeat(64));
  });

  it('a port already in use returns exit code 1 with a message naming the port', async () => {
    const home = makeHome();
    const busy = await block('127.0.0.1', 0);
    const port = (busy?.address() as AddressInfo).port;
    const env = { AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: String(port) };
    const { result, printed } = await failing(env, home);
    expect(result.exitCode).toBe(1);
    expect(printed).toContain(String(port));
    const token = fs.readFileSync(path.join(resolveDataDir(env, home), 'token'), 'utf8').trim();
    expect(printed).not.toContain(token);
  });

  it('PortInUseError is an Error carrying the port in its message', () => {
    expect(new PortInUseError(4317)).toBeInstanceOf(Error);
    expect(new PortInUseError(4317).message).toContain('4317');
  });
});

// ---------------------------------------------------------------- bus isolation

describe('bus listener isolation', () => {
  it('a throwing listener does not skip the next one, does not change the 202 and the event is stored once', async () => {
    const h = await harness();
    const received: unknown[] = [];
    h.bus.on('agentChanged', () => {
      throw new Error('SECRET-LISTENER-FAILURE');
    });
    h.bus.on('agentChanged', (p) => received.push(p));
    const res = await post(h, ev({ user: 'unique-user-zed' }));
    expect(res.status).toBe(202);
    expect(received).toEqual([{ session: 's1', agentKey: 'boss' }]);
    expect(countEvents(h)).toBe(1);
    const listenerLines = h.logs.filter((l) => l.includes('Bus listener failed'));
    expect(listenerLines).toHaveLength(1);
    expect(listenerLines[0]).toContain('agentChanged');
    const everything = h.logs.join('\n');
    for (const leak of ['SECRET-LISTENER-FAILURE', 'unique-user-zed', 's1', 'proj']) {
      expect(everything).not.toContain(leak);
    }
  });

  it('a rejecting async listener is reported and does not break the response', async () => {
    const h = await harness();
    h.bus.on('toolFinished', (async () => {
      throw new Error('SECRET-ASYNC');
    }) as () => void);
    const res = await post(h, ev({ hook: 'PostToolUse', tool: 'Bash' }));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.logs.filter((l) => l.includes('Bus listener failed for toolFinished'))).toHaveLength(1);
    expect(h.logs.join('\n')).not.toContain('SECRET-ASYNC');
  });

  it('a bus without an error callback still isolates listener failures', () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on('sessionEnded', () => {
      throw new Error('x');
    });
    bus.once('sessionEnded', (p) => seen.push(p.session));
    expect(bus.emit('sessionEnded', { session: 'a' })).toBe(true);
    expect(bus.emit('sessionEnded', { session: 'b' })).toBe(true);
    expect(bus.emit('agentStopped', { session: 'b', agentKey: 'boss' })).toBe(false);
    expect(seen).toEqual(['a']);
  });
});

// ---------------------------------------------------------------- refusal logging

describe('refusal logging', () => {
  const refusals = (h: Harness): string[] => h.logs.filter((l) => l.startsWith('Refused '));
  const json = { 'content-type': 'application/json' };

  const cases: Array<[string, (h: Harness) => Promise<Res>, string]> = [
    ['403 foreign host', (h) => post(h, ev(), { host: `evil.example:${h.port}` }), 'Refused POST events 403'],
    ['401 no token', (h) => send(h.port, { headers: json, body: JSON.stringify(ev()) }), 'Refused POST events 401'],
    [
      '415 content type',
      (h) => send(h.port, { headers: { 'content-type': 'text/plain', ...bearer(h) }, body: 'x' }),
      'Refused POST events 415',
    ],
    ['413 too large', (h) => post(h, ev({ padding: BIG })), 'Refused POST events 413'],
    ['400 invalid json', (h) => send(h.port, { headers: { ...json, ...bearer(h) }, body: '{bad' }), 'Refused POST events 400'],
    ['422 invalid event', (h) => post(h, ev({ ts: 'bad' })), 'Refused POST events 422'],
    [
      '401 on pair',
      (h) => send(h.port, { path: '/pair', headers: json, body: JSON.stringify({ token: '1'.repeat(64) }) }),
      'Refused POST pair 401',
    ],
    ['404 unknown route', (h) => send(h.port, { method: 'GET', path: '/nope', headers: {} }), 'Refused GET unknown 404'],
  ];

  for (const [name, run, line] of cases) {
    it(`${name} produces exactly one generic line`, async () => {
      const h = await harness();
      await run(h);
      expect(refusals(h)).toEqual([line]);
    });
  }

  it('503 database unavailable produces exactly one refusal line', async () => {
    const h = await harness();
    const key = readKey(h);
    h.db.close();
    fs.rmSync(path.join(h.dataDir, 'db.key'));
    const res = await post(h, ev());
    fs.writeFileSync(path.join(h.dataDir, 'db.key'), key, { mode: 0o600 });
    expect(res.status).toBe(503);
    expect(refusals(h)).toEqual(['Refused POST events 503']);
  });

  it('500 internal error produces exactly one refusal line', async () => {
    const h = await harness(
      (db) =>
        Object.create(db, {
          transaction: {
            value: () => {
              throw new Error('boom');
            },
          },
        }) as Db,
    );
    const res = await post(h, ev());
    expect(res.status).toBe(500);
    expect(refusals(h)).toEqual(['Refused POST events 500']);
  });

  it('a 202 and a 204 produce no refusal line', async () => {
    const h = await harness();
    expect((await post(h, ev())).status).toBe(202);
    const paired = await send(h.port, { path: '/pair', headers: json, body: JSON.stringify({ token: h.token }) });
    expect(paired.status).toBe(204);
    expect(refusals(h)).toEqual([]);
  });

  it('never logs the URL, Host, Origin, headers, body, token or event fields', async () => {
    const h = await harness();
    await send(h.port, {
      method: 'GET',
      path: '/nope<script>SECRETMARK?token=SECRETMARK2',
      headers: { origin: 'http://origin-marker.example' },
    });
    await send(h.port, { method: 'GET', path: '/nope<script>SECRETMARK', headers: { 'x-secret-header': 'SECRETMARK3' } });
    await post(h, ev({ user: 'unique-user-zed', ts: 'bad' }), { host: 'host-marker.example' });
    await post(h, ev({ user: 'unique-user-zed', ts: 'bad' }));
    expect(refusals(h)).toEqual([
      'Refused GET unknown 403',
      'Refused GET unknown 404',
      'Refused POST events 403',
      'Refused POST events 422',
    ]);
    const everything = h.logs.join('\n');
    for (const leak of ['SECRET', 'script', 'nope', 'marker', 'unique-user-zed', h.token, '127.0.0.1', 'proj']) {
      expect(everything).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------- unknown routes

describe('unknown routes', () => {
  it('answers a fixed JSON 404 without echoing the path', async () => {
    const h = await harness();
    const res = await send(h.port, { method: 'GET', path: '/nope<script>', headers: {} });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
    expect(res.text).not.toContain('nope');
    expect(res.text).not.toContain('script');
  });

  it('GET /events (wrong method) answers the same fixed 404', async () => {
    const h = await harness();
    const res = await send(h.port, { method: 'GET', path: '/events', headers: bearer(h) });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });

  it('the Host guard still runs first on an unknown route', async () => {
    const h = await harness();
    const res = await send(h.port, { method: 'GET', path: '/nope', headers: { host: `evil.example:${h.port}` } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'forbidden' });
  });
});

// ---------------------------------------------------------------- main edge branches

describe('startup edge cases', () => {
  it('describeError renders Error messages and plain values', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('plain failure')).toBe('plain failure');
  });

  it('a listen failure other than EADDRINUSE is rethrown as is', async () => {
    const { token, db } = openFor(makeHome(), []);
    const failure = await startServer({ token, db, port: 70000, log: () => {} }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PortInUseError);
  });
});

// ---------------------------------------------------------------- output channels

describe('output channels', () => {
  async function boot(io: { out?: (m: string) => void; err?: (m: string) => void }) {
    const home = makeHome();
    const port = await freePort();
    const env = { AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: String(port) };
    const result = await runMain(env, { home, ...io });
    expect(result.exitCode).toBe(0);
    running.push(result.server as RunningServer);
    const dataDir = resolveDataDir(env, home);
    const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
    return { port, token, tokenFile: path.join(dataDir, 'token'), server: result.server as RunningServer };
  }

  const json = { 'content-type': 'application/json' };

  it('sends refusals and bus-listener failures to the diagnostics sink and startup lines to out', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const { port, token, tokenFile, server } = await boot({ out: (m) => out.push(m), err: (m) => err.push(m) });

    await send(port, { headers: json, body: JSON.stringify(ev()) });
    server.bus.on('agentChanged', () => {
      throw new Error('listener down');
    });
    const ok = await send(port, { headers: { ...json, authorization: `Bearer ${token}` }, body: JSON.stringify(ev()) });
    expect(ok.status).toBe(202);

    expect(err).toEqual(['Refused POST events 401', 'Bus listener failed for agentChanged']);
    expect(out.some((l) => l.includes(tokenFile))).toBe(true);
    expect(out.some((l) => l.includes('listening'))).toBe(true);
    expect(out.filter((l) => l.includes('Refused') || l.includes('Bus listener'))).toEqual([]);
    expect(err.filter((l) => l.includes(tokenFile) || l.includes('listening'))).toEqual([]);
  });

  it('without injection uses console.error for diagnostics and console.log for startup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { port, tokenFile } = await boot({});
      await send(port, { headers: json, body: JSON.stringify(ev()) });
      const logged = log.mock.calls.map((c) => String(c[0]));
      const errored = error.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes(tokenFile))).toBe(true);
      expect(logged.some((l) => l.includes('listening'))).toBe(true);
      expect(logged.filter((l) => l.includes('Refused'))).toEqual([]);
      expect(errored).toEqual(['Refused POST events 401']);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('a startup failure without an output function goes to console.log and touches only the temp home', async () => {
    const home = makeHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runMain({ AGENTS_OFFICE_HOME: path.join(home, '.ao'), AGENTS_OFFICE_PORT: 'nope' });
      expect(result.exitCode).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('AGENTS_OFFICE_PORT'));
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
