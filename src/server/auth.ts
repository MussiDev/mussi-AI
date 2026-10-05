import crypto from 'node:crypto';
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from 'express';
import { tokenMatches } from './secrets.js';

export interface Auth {
  middleware: RequestHandler;
  pairRouter: Router;
  sessionCount(): number;
}

const DEFAULT_MAX_SESSIONS = 50;
const COOKIE_NAME = 'ao_session';
const HEX64 = /^[0-9a-fA-F]{64}$/;
const BEARER = /^Bearer ([0-9a-fA-F]{64})$/;

function bearerToken(header: string | undefined): string | null {
  const match = header === undefined ? null : BEARER.exec(header);
  return match ? (match[1] as string) : null;
}

function sessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return HEX64.test(value) ? value : null;
  }
  return null;
}

export function createAuth(opts: { token: string; maxSessions?: number }): Auth {
  const { token } = opts;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // Map keeps insertion order, so the first key is always the oldest session.
  const sessions = new Map<string, true>();

  const middleware: RequestHandler = (req, res, next) => {
    const bearer = bearerToken(req.headers.authorization);
    if (bearer !== null && tokenMatches(token, bearer)) {
      next();
      return;
    }
    const cookie = sessionCookie(req.headers.cookie);
    if (cookie !== null && sessions.has(cookie)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };

  const requireJson: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    next();
  };

  const pairHandler: RequestHandler = (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    const candidate = (body as Record<string, unknown>)['token'];
    if (typeof candidate !== 'string' || !HEX64.test(candidate) || !tokenMatches(token, candidate)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, true);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value as string;
      sessions.delete(oldest);
    }
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/`);
    res.status(204).end();
  };

  const bodyErrors: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large' });
    } else if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
    } else {
      next(err);
    }
  };

  const pairRouter = express.Router();
  pairRouter.post(
    '/pair',
    requireJson,
    express.json({ limit: '1kb', type: 'application/json' }),
    pairHandler,
    bodyErrors,
  );

  return { middleware, pairRouter, sessionCount: () => sessions.size };
}
