import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createBus, type Bus } from './bus.js';
import { openDb, resolveDbPath, type Db } from './db.js';
import { loadOrCreateToken, resolveDataDir } from './secrets.js';
import { createStreamHub } from './stream.js';
import { createTokenTracker } from './tokens.js';

export const DEFAULT_PORT = 4317;

export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} is already in use on 127.0.0.1; stop the other process or set AGENTS_OFFICE_PORT to another port`);
    this.name = 'PortInUseError';
  }
}

export interface RunningServer {
  port: number;
  bus: Bus;
  /** Stops listening, drops open connections and closes the database. */
  close(): Promise<void>;
}

export interface StartOptions {
  token: string;
  db: Db;
  /** 0 picks an ephemeral port (tests). */
  port: number;
  /** Runtime diagnostics (refusals, listener failures, database outages). Never carries request content. */
  log: (msg: string) => void;
  /** Startup messages such as the ::1 fallback. Defaults to console.log. */
  out?: (msg: string) => void;
  /** Transcript root for token usage tracking. Defaults to ~/.claude/projects (tests inject a temp directory). */
  projectsDir?: string;
}

export interface MainIo {
  /** Receives startup and shutdown messages. Defaults to console.log. */
  out?: (msg: string) => void;
  /** Runtime diagnostics sink. Defaults to console.error. */
  err?: (msg: string) => void;
  /** Home directory used to confine the data directory. Defaults to the user's home. */
  home?: string;
}

export interface MainResult {
  exitCode: number;
  server?: RunningServer;
}

/** AGENTS_OFFICE_PORT as an integer from 1 to 65535; DEFAULT_PORT when unset or empty. */
export function resolvePort(env: NodeJS.ProcessEnv): number {
  const value = env['AGENTS_OFFICE_PORT'];
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) {
    throw new Error('AGENTS_OFFICE_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function shutdown(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Listens on 127.0.0.1 and ::1 only. If ::1 is unavailable it logs that and keeps 127.0.0.1. */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { token, db, log } = opts;
  // main.ts is the only module allowed to print.
  const out = opts.out ?? ((msg: string) => console.log(msg));
  const bus = createBus({ onListenerError: (_err, name) => log(`Bus listener failed for ${name}`) });
  const tracker = createTokenTracker({ db, bus, log, ...(opts.projectsDir !== undefined ? { projectsDir: opts.projectsDir } : {}) });
  // Registered after the tracker: bus listeners run in registration order, and the tracker must store
  // the counters before the hub reads them.
  const stream = createStreamHub({ db, bus, log });
  let port = opts.port;
  const app = createApp({ token, db, bus, getPort: () => port, log, stream });

  const v4 = http.createServer(app);
  try {
    await listen(v4, '127.0.0.1', opts.port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(opts.port);
    throw e;
  }
  port = (v4.address() as AddressInfo).port;

  const listeners = [v4];
  const v6 = http.createServer(app);
  try {
    await listen(v6, '::1', port);
    listeners.push(v6);
  } catch (e) {
    out(`Could not listen on ::1 port ${port} (${describeError(e)}); continuing on 127.0.0.1 only`);
  }

  return {
    port,
    bus,
    close: async () => {
      await Promise.all(listeners.map(shutdown));
      tracker.dispose();
      stream.dispose();
      db.close();
    },
  };
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Starts the service and returns an exit code instead of exiting, so tests can drive it.
 * Exit code 0 comes with the running server; 1 means startup failed and the message was printed.
 * Messages carry the token file path, never the token or the database key.
 */
export async function runMain(env: NodeJS.ProcessEnv, io: MainIo = {}): Promise<MainResult> {
  // main.ts is the only module allowed to print.
  const out = io.out ?? ((msg: string) => console.log(msg));
  const err = io.err ?? ((msg: string) => console.error(msg));
  let db: Db | undefined;
  try {
    const port = resolvePort(env);
    const dataDir = resolveDataDir(env, io.home);
    const token = loadOrCreateToken(dataDir);
    db = openDb({ dataDir, dbPath: resolveDbPath(env, dataDir), log: err });
    const server = await startServer({ token, db, port, log: err, out });
    out(`Agents Office listening on http://127.0.0.1:${server.port}`);
    out(`Auth token file: ${path.join(dataDir, 'token')}`);
    return { exitCode: 0, server };
  } catch (e) {
    db?.close();
    out(describeError(e));
    return { exitCode: 1 };
  }
}

/* v8 ignore start */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMain(process.env);
  if (result.server === undefined) {
    process.exit(result.exitCode);
  }
  const server = result.server;
  const stop = (): void => {
    console.log('Shutting down');
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
/* v8 ignore stop */
