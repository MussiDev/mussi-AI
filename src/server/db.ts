import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Stage } from '../shared/events.js';
import { SecretsError, loadKey } from './secrets.js';

// The only module that talks to SQLite. Statements use bound parameters only.

const SCHEMA_VERSION = 1;
const MIGRATION_SQL = new URL('./migrations/001-init.sql', import.meta.url);

export class DbUnavailableError extends Error {
  constructor(message = 'Database is unavailable') {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

/** The database must not be used as it is: newer schema or a key that cannot decrypt it. */
export class DbStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbStartupError';
  }
}

export interface SessionRow {
  id: string;
  user: string;
  project: string;
  transcript: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface AgentRow {
  session: string;
  agent_key: string;
  name: string;
  is_boss: 0 | 1;
  stage: Stage;
  last_ts: number;
}

export interface TaskRow {
  id: number;
  session: string;
  agent_key: string;
  started_at: number;
  ended_at: number | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_creation: number;
  tokens_cache_read: number;
  tokens_incomplete: 0 | 1;
}

export interface StoredEvent {
  task_id: number | null;
  ts: number;
  hook: string;
  user: string;
  project: string;
  session: string;
  agent_key: string;
  agent_name: string;
  tool: string | null;
  file: string | null;
  notification: string | null;
}

export interface TokenDelta {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface Db {
  isAvailable(): boolean;
  transaction<T>(fn: () => T): T;
  upsertSession(s: SessionRow): void;
  endSession(id: string, endedAt: number): void;
  getSession(id: string): SessionRow | undefined;
  getAgent(session: string, agentKey: string): AgentRow | undefined;
  upsertAgent(a: AgentRow): void;
  getOpenTask(session: string, agentKey: string): TaskRow | undefined;
  /** The agent's task with the highest id, open or closed. */
  getLatestTask(session: string, agentKey: string): TaskRow | undefined;
  openTask(session: string, agentKey: string, startedAt: number): number;
  closeTask(id: number, endedAt: number): void;
  insertEvent(e: StoredEvent): number;
  addTokens(taskId: number, delta: TokenDelta, opts?: { incomplete?: boolean }): void;
  listSessions(): SessionRow[];
  listAgents(): AgentRow[];
  listOpenTasks(): TaskRow[];
  close(): void;
}

export interface OpenDbOptions {
  dataDir: string;
  dbPath: string;
  /** Receives one message when the database becomes unavailable. Silent when absent. */
  log?: (msg: string) => void;
}

export function resolveDbPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  const override = env['AGENTS_OFFICE_DB'];
  return override ? override : path.join(dataDir, 'office.db');
}

function prepareStatements(db: Database.Database) {
  return {
    upsertSession: db.prepare(
      `INSERT INTO sessions (id, user, project, transcript, started_at, ended_at)
       VALUES (@id, @user, @project, @transcript, @started_at, @ended_at)
       ON CONFLICT (id) DO UPDATE SET
         user = excluded.user,
         project = excluded.project,
         transcript = COALESCE(excluded.transcript, sessions.transcript)`,
    ),
    endSession: db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getAgent: db.prepare('SELECT * FROM agents WHERE session = ? AND agent_key = ?'),
    upsertAgent: db.prepare(
      `INSERT INTO agents (session, agent_key, name, is_boss, stage, last_ts)
       VALUES (@session, @agent_key, @name, @is_boss, @stage, @last_ts)
       ON CONFLICT (session, agent_key) DO UPDATE SET
         name = excluded.name,
         is_boss = excluded.is_boss,
         stage = excluded.stage,
         last_ts = excluded.last_ts`,
    ),
    getOpenTask: db.prepare(
      'SELECT * FROM tasks WHERE session = ? AND agent_key = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    ),
    getLatestTask: db.prepare('SELECT * FROM tasks WHERE session = ? AND agent_key = ? ORDER BY id DESC LIMIT 1'),
    openTask: db.prepare('INSERT INTO tasks (session, agent_key, started_at) VALUES (?, ?, ?)'),
    closeTask: db.prepare('UPDATE tasks SET ended_at = ? WHERE id = ?'),
    insertEvent: db.prepare(
      `INSERT INTO events (task_id, ts, hook, user, project, session, agent_key, agent_name, tool, file, notification)
       VALUES (@task_id, @ts, @hook, @user, @project, @session, @agent_key, @agent_name, @tool, @file, @notification)`,
    ),
    addTokens: db.prepare(
      `UPDATE tasks SET
         tokens_input = tokens_input + @input,
         tokens_output = tokens_output + @output,
         tokens_cache_creation = tokens_cache_creation + @cacheCreation,
         tokens_cache_read = tokens_cache_read + @cacheRead,
         tokens_incomplete = CASE WHEN @incomplete = 1 THEN 1 ELSE tokens_incomplete END
       WHERE id = @id`,
    ),
    listSessions: db.prepare('SELECT * FROM sessions ORDER BY started_at, id'),
    listAgents: db.prepare('SELECT * FROM agents ORDER BY session, agent_key'),
    listOpenTasks: db.prepare('SELECT * FROM tasks WHERE ended_at IS NULL ORDER BY id'),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

interface Connection {
  raw: Database.Database;
  stmts: Statements;
}

/** SQLite error code of a thrown value, or undefined when it is not a SqliteError. */
function sqliteCode(e: unknown): string | undefined {
  return e instanceof Database.SqliteError ? (e as Error & { code: string }).code : undefined;
}

class SqliteDb implements Db {
  private conn: Connection | null = null;
  private logged = false;

  constructor(private readonly opts: OpenDbOptions) {}

  /** First connection: startup errors propagate, anything else leaves the handle unavailable. */
  start(): void {
    try {
      this.conn = this.connect();
    } catch (e) {
      if (e instanceof SecretsError || e instanceof DbStartupError) throw e;
      this.fail(e);
    }
  }

  private connect(): Connection {
    const { dataDir, dbPath } = this.opts;
    const dbExists = fs.existsSync(dbPath);
    const keyFile = path.join(dataDir, 'db.key');
    const key = loadKey(dataDir, { dbExists });

    const raw = new Database(dbPath);
    try {
      // The cipher and the key come before any other statement.
      raw.pragma("cipher='sqlcipher'");
      raw.key(Buffer.from(key, 'utf8'));

      let version: number;
      try {
        version = Number(raw.pragma('user_version', { simple: true }));
      } catch (e) {
        if (dbExists && sqliteCode(e) === 'SQLITE_NOTADB') {
          throw new DbStartupError(
            `Database ${dbPath} cannot be decrypted with the key in ${keyFile} (wrong key, or not a valid database)`,
          );
        }
        throw e;
      }
      if (version > SCHEMA_VERSION) {
        throw new DbStartupError(
          `Database ${dbPath} has schema version ${version}, newer than the supported version ${SCHEMA_VERSION}`,
        );
      }

      raw.pragma('journal_mode = WAL');
      raw.pragma('foreign_keys = ON');
      if (version === 0) {
        const sql = fs.readFileSync(MIGRATION_SQL, 'utf8');
        raw.transaction(() => {
          raw.exec(sql);
          raw.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
      }
      const conn = { raw, stmts: prepareStatements(raw) };
      this.logged = false;
      return conn;
    } catch (e) {
      raw.close();
      throw e;
    }
  }

  private fail(e: unknown): void {
    const conn = this.conn;
    this.conn = null;
    try {
      conn?.raw.close();
    } catch {
      // Already closed or broken: nothing left to release.
    }
    if (!this.logged) {
      this.logged = true;
      // Only the error name: the message can carry file paths (and so the operating system user name).
      this.opts.log?.(`Database unavailable: ${e instanceof Error ? e.name : 'Error'}`);
    }
  }

  /** Returns a live connection, trying to reopen once when the handle is unavailable. */
  private ensure(): Connection {
    if (!this.conn) {
      try {
        this.conn = this.connect();
      } catch (e) {
        this.fail(e);
        throw new DbUnavailableError();
      }
    }
    return this.conn;
  }

  private run<T>(fn: (c: Connection) => T): T {
    const conn = this.ensure();
    try {
      return fn(conn);
    } catch (e) {
      // Constraint violations are the caller's bug, not an outage.
      const code = sqliteCode(e);
      if (code !== undefined && !code.startsWith('SQLITE_CONSTRAINT')) {
        this.fail(e);
        throw new DbUnavailableError();
      }
      throw e;
    }
  }

  isAvailable(): boolean {
    return this.conn !== null;
  }

  transaction<T>(fn: () => T): T {
    return this.run((c) => c.raw.transaction(fn)());
  }

  upsertSession(s: SessionRow): void {
    this.run((c) => c.stmts.upsertSession.run(s));
  }

  endSession(id: string, endedAt: number): void {
    this.run((c) => c.stmts.endSession.run(endedAt, id));
  }

  getSession(id: string): SessionRow | undefined {
    return this.run((c) => c.stmts.getSession.get(id) as SessionRow | undefined);
  }

  getAgent(session: string, agentKey: string): AgentRow | undefined {
    return this.run((c) => c.stmts.getAgent.get(session, agentKey) as AgentRow | undefined);
  }

  upsertAgent(a: AgentRow): void {
    this.run((c) => c.stmts.upsertAgent.run(a));
  }

  getOpenTask(session: string, agentKey: string): TaskRow | undefined {
    return this.run((c) => c.stmts.getOpenTask.get(session, agentKey) as TaskRow | undefined);
  }

  getLatestTask(session: string, agentKey: string): TaskRow | undefined {
    return this.run((c) => c.stmts.getLatestTask.get(session, agentKey) as TaskRow | undefined);
  }

  openTask(session: string, agentKey: string, startedAt: number): number {
    return this.run((c) => Number(c.stmts.openTask.run(session, agentKey, startedAt).lastInsertRowid));
  }

  closeTask(id: number, endedAt: number): void {
    this.run((c) => c.stmts.closeTask.run(endedAt, id));
  }

  insertEvent(e: StoredEvent): number {
    return this.run((c) => Number(c.stmts.insertEvent.run(e).lastInsertRowid));
  }

  addTokens(taskId: number, delta: TokenDelta, opts?: { incomplete?: boolean }): void {
    this.run((c) => c.stmts.addTokens.run({ ...delta, id: taskId, incomplete: opts?.incomplete ? 1 : 0 }));
  }

  listSessions(): SessionRow[] {
    return this.run((c) => c.stmts.listSessions.all() as SessionRow[]);
  }

  listAgents(): AgentRow[] {
    return this.run((c) => c.stmts.listAgents.all() as AgentRow[]);
  }

  listOpenTasks(): TaskRow[] {
    return this.run((c) => c.stmts.listOpenTasks.all() as TaskRow[]);
  }

  close(): void {
    const conn = this.conn;
    this.conn = null;
    conn?.raw.close();
  }
}

export function openDb(opts: OpenDbOptions): Db {
  const db = new SqliteDb(opts);
  db.start();
  return db;
}
