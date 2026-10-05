import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import type { Bus } from './bus.js';
import { createAuth } from './auth.js';
import { DbUnavailableError, type Db } from './db.js';
import { ingestEvent } from './ingest.js';
import type { StreamHub } from './stream.js';

export interface AppOptions {
  token: string;
  db: Db;
  bus: Bus;
  /** Port the server is listening on; read per request so tests can use ephemeral ports. */
  getPort: () => number;
  log?: (msg: string) => void;
  /** Live stream hub. When absent, GET /stream is not mounted and answers the fixed 404. */
  stream?: StreamHub;
}

const BODY_LIMIT = '64kb';

const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function methodLabel(method: string): string {
  return METHODS.has(method) ? method : 'OTHER';
}

/** A fixed label, never the raw URL. */
function routeLabel(url: string): string {
  const pathname = url.split('?')[0];
  if (pathname === '/events') return 'events';
  if (pathname === '/pair') return 'pair';
  if (pathname === '/stream') return 'stream';
  return 'unknown';
}

export function createApp(opts: AppOptions): Express {
  const { db, bus, getPort, log } = opts;
  const auth = createAuth({ token: opts.token });
  const app = express();
  app.disable('x-powered-by');

  // Every refused request (status 400 or above) gets one generic line: method, a fixed route label
  // and the status. The URL, headers, body and token are never logged.
  app.use((req, res, next) => {
    if (log) {
      const end = res.end.bind(res);
      let logged = false;
      res.end = ((...args: Parameters<typeof res.end>) => {
        if (!logged && res.statusCode >= 400) {
          logged = true;
          log(`Refused ${methodLabel(req.method)} ${routeLabel(req.originalUrl)} ${res.statusCode}`);
        }
        return end(...args);
      }) as typeof res.end;
    }
    next();
  });

  // 1. Host and Origin guard on every route, including /pair. No CORS headers are ever sent.
  const hostOriginGuard: RequestHandler = (req, res, next) => {
    const port = getPort();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const host = req.headers.host?.toLowerCase();
    const origin = req.headers.origin;
    const hostOk = host !== undefined && hosts.includes(host);
    const originOk = origin === undefined || hosts.some((h) => origin.toLowerCase() === `http://${h}`);
    if (!hostOk || !originOk) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
  app.use(hostOriginGuard);

  // 2. Pairing carries its own 1 KB parser and is not behind the auth middleware.
  // No global express.json(): every body parser is scoped to the route that needs it.
  app.use(auth.pairRouter);

  // 3. POST /events: auth, content type, size and JSON parse, then the handler.
  const requireJson: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'unsupported_media_type' });
      return;
    }
    next();
  };

  const ingest: RequestHandler = (req, res) => {
    try {
      const result = ingestEvent(db, bus, req.body);
      if (!result.ok) {
        res.status(422).json({ error: 'invalid_event', field: result.field });
        return;
      }
      res.status(202).json({ ok: true });
    } catch (e) {
      if (e instanceof DbUnavailableError) {
        res.status(503).json({ error: 'database_unavailable' });
        return;
      }
      throw e;
    }
  };

  app.post(
    '/events',
    auth.middleware,
    requireJson,
    express.json({ limit: BODY_LIMIT, type: 'application/json' }),
    ingest,
  );

  // 4. GET /stream: the Host/Origin guard above and the auth middleware run first, so a refusal is a
  // normal JSON answer before any SSE header is flushed. Mounted BEFORE the catch-all below.
  if (opts.stream) app.get('/stream', auth.middleware, opts.stream.handler);

  // 5. Unknown routes: a fixed body, never the requested path.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // 6. Errors: body-parser failures map to the spec's codes, anything else is a generic 500.
  // Neither the error text nor the request content is ever sent or logged.
  const finalHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (res.headersSent) {
      // A stream that fails after its headers went out can no longer send a status. Express's default
      // handler would print a stack with console.error, so log a fixed line and destroy the response.
      // The error itself is never logged.
      log?.('Response failed after headers were sent');
      res.destroy();
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large' });
    } else if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
    } else if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
      res.status(415).json({ error: 'unsupported_media_type' });
    } else {
      res.status(500).json({ error: 'internal_error' });
    }
  };
  app.use(finalHandler);

  return app;
}
