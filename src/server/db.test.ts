import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent } from '../shared/events.js';
import {
  DbStartupError,
  DbUnavailableError,
  openDb,
  resolveDbPath,
  type Db,
  type SessionRow,
  type StoredEvent,
} from './db.js';
import { KeyMissingError } from './secrets.js';

// SQLCipher refuses PRAGMA key on :memory: and temporary databases, so every
// test uses a real file inside a directory that is removed afterwards.
let dir: string;
let dbPath: string;
let handles: Db[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-db-'));
  dbPath = path.join(dir, 'office.db');
  handles = [];
});

afterEach(() => {
  for (const h of handles) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(p: string = dbPath, log?: (m: string) => void): Db {
  const db = openDb({ dataDir: dir, dbPath: p, ...(log ? { log } : {}) });
  handles.push(db);
  return db;
}

function keyHex(): string {
  return fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim();
}

function raw<T>(fn: (d: Database.Database) => T, key: string | null = keyHex()): T {
  const d = new Database(dbPath);
  try {
    if (key !== null) {
      d.pragma("cipher='sqlcipher'");
      d.key(Buffer.from(key));
    }
    return fn(d);
  } finally {
    d.close();
  }
}

function count(table: string): number {
  return raw((d) => (d.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

const session: SessionRow = {
  id: 's1',
  user: 'alice',
  project: 'proj',
  transcript: null,
  started_at: 1000,
  ended_at: null,
};

function seed(db: Db, s: SessionRow = session): void {
  db.upsertSession(s);
  db.upsertAgent({ session: s.id, agent_key: 'boss', name: 'boss', is_boss: 1, stage: 'Thinking', last_ts: 1000 });
}

function stored(extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    task_id: null,
    ts: 1001,
    hook: 'PreToolUse',
    user: 'alice',
    project: 'proj',
    session: 's1',
    agent_key: 'boss',
    agent_name: 'boss',
    tool: 'Read',
    file: null,
    notification: null,
    ...extra,
  };
}

describe('resolveDbPath', () => {
  it('uses AGENTS_OFFICE_DB when set', () => {
    expect(resolveDbPath({ AGENTS_OFFICE_DB: '/x/y.db' }, '/data')).toBe('/x/y.db');
  });
  it('defaults to office.db inside the data directory', () => {
    expect(resolveDbPath({}, dir)).toBe(path.join(dir, 'office.db'));
  });
});

describe('schema', () => {
  it('creates exactly the four tables and the listed indexes', () => {
    open().close();
    const { tables, indexes } = raw((d) => ({
      tables: (d
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[])
        .map((r) => r.name),
      indexes: (d
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[])
        .map((r) => r.name),
    }));
    expect(tables).toEqual(['agents', 'events', 'sessions', 'tasks']);
    expect(indexes).toEqual([
      'idx_events_agent_ts',
      'idx_events_task',
      'idx_tasks_open',
      'idx_tasks_started_at',
    ]);
  });

  it('stores user_version 1 and runs in WAL mode', () => {
    open();
    const mode = raw((d) => d.pragma('journal_mode', { simple: true }));
    const version = raw((d) => d.pragma('user_version', { simple: true }));
    expect(mode).toBe('wal');
    expect(version).toBe(1);
  });

  it('enforces foreign keys without making the handle unavailable', () => {
    const db = open();
    expect(() =>
      db.upsertAgent({ session: 'nope', agent_key: 'boss', name: 'boss', is_boss: 1, stage: 'Thinking', last_ts: 1 }),
    ).toThrow();
    expect(() => db.insertEvent(stored({ task_id: 999 }))).toThrow();
    expect(db.isAvailable()).toBe(true);
  });
});

describe('persistence', () => {
  it('serves events and tasks written before closing after reopening (AC-21)', () => {
    const db = open();
    seed(db);
    const taskId = db.openTask('s1', 'boss', 1001);
    db.insertEvent(stored({ task_id: taskId }));
    db.close();

    const again = open();
    expect(again.getSession('s1')?.user).toBe('alice');
    expect(again.getAgent('s1', 'boss')?.stage).toBe('Thinking');
    expect(again.getOpenTask('s1', 'boss')?.id).toBe(taskId);
    expect(again.listSessions()).toHaveLength(1);
    expect(again.listAgents()).toHaveLength(1);
    expect(again.listOpenTasks()).toHaveLength(1);
    expect(count('events')).toBe(1);
  });

  it('stores the user, project, session and agent identifiers (AC-05)', () => {
    const db = open();
    seed(db);
    const id = db.insertEvent(stored());
    const row = raw((d) => d.prepare('SELECT * FROM events WHERE id = ?').get(id)) as Record<string, unknown>;
    expect(row).toMatchObject({
      user: 'alice',
      project: 'proj',
      session: 's1',
      agent_key: 'boss',
      agent_name: 'boss',
      hook: 'PreToolUse',
      tool: 'Read',
    });
  });

  it('leaves no content of extra fields in any column (AC-07, AC-08)', () => {
    const parsed = parseEvent({
      v: 1,
      ts: 1002,
      hook: 'PostToolUse',
      user: 'alice',
      project: 'proj',
      session: 's1',
      agent_id: null,
      agent: 'boss',
      tool: 'Edit',
      file: 'src/a.ts',
      tool_input: { content: 'SECRET-CODE-BODY', file_path: 'src/a.ts' },
      prompt: 'SECRET-PROMPT-TEXT',
    });
    if (!parsed.ok) throw new Error('fixture must parse');
    const e = parsed.event;
    const db = open();
    seed(db);
    db.insertEvent({
      task_id: null,
      ts: e.ts,
      hook: e.hook,
      user: e.user,
      project: e.project,
      session: e.session,
      agent_key: 'boss',
      agent_name: e.agent,
      tool: e.tool ?? null,
      file: e.file ?? null,
      notification: e.notification ?? null,
    });
    db.close();
    const dump = raw((d) => JSON.stringify(d.prepare('SELECT * FROM events').all()));
    expect(dump).toContain('src/a.ts');
    expect(dump).not.toContain('SECRET-CODE-BODY');
    expect(dump).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('endSession sets the end time and upsertSession keeps the known transcript', () => {
    const db = open();
    db.upsertSession({ ...session, transcript: '/t/a.jsonl' });
    db.upsertSession({ ...session, transcript: null });
    db.endSession('s1', 5000);
    expect(db.getSession('s1')).toMatchObject({ transcript: '/t/a.jsonl', ended_at: 5000, started_at: 1000 });
  });

  it('upsertAgent updates stage and last_ts; closeTask ends the task', () => {
    const db = open();
    seed(db);
    db.upsertAgent({ session: 's1', agent_key: 'boss', name: 'boss', is_boss: 1, stage: 'Editing', last_ts: 2000 });
    expect(db.getAgent('s1', 'boss')).toMatchObject({ stage: 'Editing', last_ts: 2000 });
    const id = db.openTask('s1', 'boss', 1500);
    db.closeTask(id, 1800);
    expect(db.getOpenTask('s1', 'boss')).toBeUndefined();
    expect(db.getAgent('s1', 'nobody')).toBeUndefined();
  });

  it('addTokens accumulates the four counters and can flag incomplete', () => {
    const db = open();
    seed(db);
    const id = db.openTask('s1', 'boss', 1001);
    db.addTokens(id, { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 });
    expect(db.getOpenTask('s1', 'boss')).toMatchObject({
      tokens_input: 1,
      tokens_output: 2,
      tokens_cache_creation: 3,
      tokens_cache_read: 4,
      tokens_incomplete: 0,
    });
    db.addTokens(id, { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 }, { incomplete: true });
    expect(db.getOpenTask('s1', 'boss')).toMatchObject({
      tokens_input: 11,
      tokens_output: 22,
      tokens_cache_creation: 33,
      tokens_cache_read: 44,
      tokens_incomplete: 1,
    });
    db.addTokens(id, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    expect(db.getOpenTask('s1', 'boss')?.tokens_incomplete).toBe(1);
  });

  it('stores 500 events inserted in a loop inside transactions (NFR-03)', () => {
    const db = open();
    seed(db);
    for (let i = 0; i < 500; i++) {
      db.transaction(() => {
        db.insertEvent(stored({ ts: 2000 + i }));
      });
    }
    expect(count('events')).toBe(500);
  });
});

describe('encryption at rest', () => {
  it('encrypts a new database with the key from the key file (AC-38)', () => {
    const db = open();
    seed(db);
    db.close();
    expect(keyHex()).toMatch(/^[0-9a-f]{64}$/);
    // Without the key the file is unreadable.
    expect(() => raw((d) => d.pragma('user_version', { simple: true }), null)).toThrow();
    expect(() => raw((d) => d.prepare('SELECT * FROM sessions').all(), null)).toThrow();
    // With the key it is readable.
    expect(raw((d) => d.prepare('SELECT user FROM sessions').all())).toEqual([{ user: 'alice' }]);
  });

  it('keeps user, project and path text out of the db and WAL bytes (AC-40)', () => {
    const needles = ['zz_user_unique', 'zz-project-unique', 'C:/zz/secret/path.ts'];
    const s: SessionRow = { ...session, user: needles[0]!, project: needles[1]! };
    const walPath = `${dbPath}-wal`;
    const db = open();
    seed(db, s);
    db.insertEvent(stored({ user: needles[0]!, project: needles[1]!, file: needles[2]! }));

    // While the connection is still open the WAL holds the uncheckpointed writes.
    expect(fs.existsSync(walPath)).toBe(true);
    const walBytes = fs.readFileSync(walPath);
    expect(walBytes.length).toBeGreaterThan(0);
    for (const n of needles) expect(walBytes.indexOf(n)).toBe(-1);

    db.close();
    const dbBytes = fs.readFileSync(dbPath);
    expect(dbBytes.length).toBeGreaterThan(0);
    for (const n of needles) expect(dbBytes.indexOf(n)).toBe(-1);

    // Control: the same checks find the strings in an unencrypted database and its WAL.
    const plainPath = path.join(dir, 'plain.db');
    const plain = new Database(plainPath);
    plain.pragma('journal_mode = WAL');
    plain.exec('CREATE TABLE t (a TEXT, b TEXT, c TEXT)');
    plain.prepare('INSERT INTO t VALUES (?, ?, ?)').run(...needles);
    const plainWal = fs.readFileSync(`${plainPath}-wal`);
    for (const n of needles) expect(plainWal.indexOf(n)).toBeGreaterThanOrEqual(0);
    plain.close();
    const plainBytes = fs.readFileSync(plainPath);
    for (const n of needles) expect(plainBytes.indexOf(n)).toBeGreaterThanOrEqual(0);
  });

  it('throws KeyMissingError when the key file is missing and the database exists (AC-39)', () => {
    open().close();
    fs.rmSync(path.join(dir, 'db.key'));
    expect(() => open()).toThrow(KeyMissingError);
    expect(fs.existsSync(path.join(dir, 'db.key'))).toBe(false);
  });

  it('refuses a wrong key naming the key file and creates no new database (AC-39)', () => {
    const db = open();
    seed(db);
    db.close();
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = hash();
    const keyFile = path.join(dir, 'db.key');
    const wrong = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, wrong);

    let error: unknown;
    try {
      open();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbStartupError);
    const message = (error as Error).message;
    expect(message).toContain(keyFile);
    expect(message).toContain('wrong key, or not a valid database');
    expect(message).not.toContain(wrong);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort()).toEqual(['office.db']);
    expect(hash()).toBe(before);
  });
});

describe('versioning', () => {
  it('refuses a database with a newer user_version naming the version, before enabling WAL', () => {
    // Created by hand in rollback-journal mode, never touched by openDb.
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'db.key'), key, { mode: 0o600 });
    raw((d) => {
      d.pragma('user_version = 7');
      d.exec('CREATE TABLE marker (x INTEGER)');
    }, key);
    expect(raw((d) => d.pragma('journal_mode', { simple: true }), key)).not.toBe('wal');

    let error: unknown;
    try {
      open();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbStartupError);
    expect((error as Error).message).toContain('schema version 7');
    expect(raw((d) => d.pragma('journal_mode', { simple: true }), key)).not.toBe('wal');
  });

  it('does not reapply the migration when reopening a version 1 database', () => {
    const db = open();
    seed(db);
    db.close();
    expect(open().getSession('s1')).toBeDefined();
  });
});

describe('availability', () => {
  it('marks the handle unavailable on an unwritable path and writes throw DbUnavailableError (AC-22)', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file, not a directory');
    const logs: string[] = [];
    const db = open(path.join(blocker, 'office.db'), (m) => logs.push(m));
    expect(db.isAvailable()).toBe(false);
    expect(() => db.upsertSession(session)).toThrow(DbUnavailableError);
    expect(() => db.insertEvent(stored())).toThrow(DbUnavailableError);
    expect(() => db.listSessions()).toThrow(DbUnavailableError);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(keyHex());
  });

  it('tries to reopen on the next call and recovers when the path becomes usable', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const db = open(path.join(blocker, 'office.db'));
    expect(db.isAvailable()).toBe(false);
    fs.rmSync(blocker);
    fs.mkdirSync(blocker);
    db.upsertSession(session);
    expect(db.isAvailable()).toBe(true);
    expect(db.getSession('s1')?.user).toBe('alice');
  });

  it('rolls back a transaction that fails midway and leaves no partial event (AC-22)', () => {
    const db = open();
    seed(db);
    expect(() =>
      db.transaction(() => {
        db.insertEvent(stored());
        db.openTask('s1', 'boss', 1001);
        throw new Error('injected failure');
      }),
    ).toThrow('injected failure');
    expect(db.isAvailable()).toBe(true);
    expect(count('events')).toBe(0);
    expect(count('tasks')).toBe(0);
  });

  it('marks the handle unavailable and logs once when a write fails in SQLite (AC-22)', () => {
    const logs: string[] = [];
    const db = open(dbPath, (m) => logs.push(m));
    seed(db);
    raw((d) => d.exec('DROP TABLE events'));
    expect(() => db.insertEvent(stored())).toThrow(DbUnavailableError);
    expect(db.isAvailable()).toBe(false);
    expect(logs).toHaveLength(1);
    // The next call reopens once; the schema is still broken, so it fails again without logging twice.
    expect(() => db.insertEvent(stored())).toThrow(DbUnavailableError);
    expect(logs).toHaveLength(1);
  });

  it('commits a transaction that succeeds and returns its value', () => {
    const db = open();
    seed(db);
    const id = db.transaction(() => db.insertEvent(stored()));
    expect(id).toBeGreaterThan(0);
  });
});
