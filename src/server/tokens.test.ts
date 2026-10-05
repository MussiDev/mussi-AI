import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { createBus, type Bus } from './bus.js';
import { DbUnavailableError, openDb, type Db, type TaskRow } from './db.js';
import { loadOrCreateToken, resolveDataDir } from './secrets.js';
import { createTokenTracker, type TokenTracker } from './tokens.js';

// ---------------------------------------------------------------- harness

const SECRET = 'SECRET-MARKER-sk-ant-do-not-leak-9f3a';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript-sample.jsonl');

const roots: string[] = [];
const dbs: Db[] = [];
const trackers: TokenTracker[] = [];

afterEach(() => {
  for (const t of trackers.splice(0)) t.dispose();
  for (const d of dbs.splice(0)) if (d.isAvailable()) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3 });
});

interface Usage {
  i: number;
  o: number;
  cc: number;
  cr: number;
}

interface Ctx {
  root: string;
  dataDir: string;
  projects: string;
  proj: string;
  transcript: string;
  db: Db;
  bus: Bus;
  logs: string[];
  listenerErrors: string[];
  seen: Array<[string, unknown]>;
  tracker: TokenTracker;
}

interface SetupOptions {
  now?: () => number;
  maxReadBytes?: number;
  wrapDb?: (db: Db) => Db;
  transcriptName?: string;
  writeTranscript?: boolean;
}

function setup(o: SetupOptions = {}): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-tok-'));
  roots.push(root);
  const logs: string[] = [];
  const dataDir = resolveDataDir({}, root);
  loadOrCreateToken(dataDir);
  const db = openDb({ dataDir, dbPath: path.join(dataDir, 'office.db'), log: (m) => logs.push(m) });
  dbs.push(db);
  const listenerErrors: string[] = [];
  const bus = createBus({ onListenerError: (err, name) => listenerErrors.push(`${name}: ${String(err)}`) });
  const projects = path.join(root, 'projects');
  const proj = path.join(projects, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, o.transcriptName ?? 's1.jsonl');
  if (o.writeTranscript !== false) fs.writeFileSync(transcript, '');
  db.upsertSession({ id: 's1', user: 'alice', project: 'proj', transcript, started_at: 1000, ended_at: null });
  const seen: Array<[string, unknown]> = [];
  for (const name of ['agentChanged', 'toolFinished', 'agentStopped', 'sessionEnded'] as const) {
    bus.on(name, ((p: unknown) => seen.push([name, p])) as never);
  }
  const tracker = createTokenTracker({
    db: o.wrapDb ? o.wrapDb(db) : db,
    bus,
    projectsDir: projects,
    log: (m) => logs.push(m),
    now: o.now ?? (() => 0),
    ...(o.maxReadBytes !== undefined ? { maxReadBytes: o.maxReadBytes } : {}),
  } as Parameters<typeof createTokenTracker>[0]);
  trackers.push(tracker);
  return { root, dataDir, projects, proj, transcript, db, bus, logs, listenerErrors, seen, tracker };
}

function openTask(c: Ctx, agentKey = 'boss', startedAt = 1000, session = 's1'): number {
  c.db.upsertAgent({
    session,
    agent_key: agentKey,
    name: agentKey,
    is_boss: agentKey === 'boss' ? 1 : 0,
    stage: 'Thinking',
    last_ts: startedAt,
  });
  return c.db.openTask(session, agentKey, startedAt);
}

function raw<T>(c: Ctx, fn: (d: Database.Database) => T): T {
  const d = new Database(path.join(c.dataDir, 'office.db'));
  try {
    d.pragma("cipher='sqlcipher'");
    d.key(Buffer.from(fs.readFileSync(path.join(c.dataDir, 'db.key'), 'utf8').trim()));
    return fn(d);
  } finally {
    d.close();
  }
}

function task(c: Ctx, id: number): TaskRow {
  return raw(c, (d) => d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow);
}

function totals(t: TaskRow): [number, number, number, number] {
  return [t.tokens_input, t.tokens_output, t.tokens_cache_creation, t.tokens_cache_read];
}

function line(id: string, u: Usage, text = 'plain'): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: {
        id,
        model: 'm-test',
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: u.i,
          output_tokens: u.o,
          cache_creation_input_tokens: u.cc,
          cache_read_input_tokens: u.cr,
          service_tier: 'standard',
        },
      },
    }) + '\n'
  );
}

function append(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

function opened(c: Ctx, agentKey = 'boss'): void {
  c.bus.emit('agentChanged', { session: 's1', agentKey });
}

function toolDone(c: Ctx, taskId: number | null, agentKey = 'boss'): void {
  c.bus.emit('toolFinished', { session: 's1', agentKey, taskId } as never);
}

function stopped(c: Ctx, taskId: number | null, agentKey = 'boss'): void {
  c.bus.emit('agentStopped', { session: 's1', agentKey, taskId } as never);
}

function changes(c: Ctx): number {
  return c.seen.filter(([n]) => n === 'agentChanged').length;
}

const canLink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lnk-'));
  try {
    fs.mkdirSync(path.join(dir, 't'));
    fs.symlinkSync(path.join(dir, 't'), path.join(dir, 'l'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ---------------------------------------------------------------- required tests

describe('summing usage', () => {
  it('sums the four counters of assistant lines into the open task', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 10, o: 5, cc: 100, cr: 1000 }) + line('m2', { i: 1, o: 2, cc: 3, cr: 4 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([11, 7, 103, 1004]);
    expect(task(c, id).tokens_incomplete).toBe(0);
  });

  it('counts several lines with the same message id once (fixture)', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, fs.readFileSync(FIXTURE, 'utf8'));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([11, 7, 103, 1004]);
  });

  it('adds only the new lines since the saved offset on a second read', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    append(c.transcript, line('m2', { i: 2, o: 3, cc: 4, cr: 5 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([3, 4, 5, 6]);
  });

  it('does not double count when the same state is announced twice', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    toolDone(c, id);
    stopped(c, id);
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
  });

  it('adds only the difference when the same id reappears with larger usage, never subtracts', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 10, o: 5, cc: 0, cr: 0 }));
    toolDone(c, id);
    append(c.transcript, line('m1', { i: 10, o: 20, cc: 7, cr: 0 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([10, 20, 7, 0]);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([10, 20, 7, 1]);
  });

  it('keeps counting correctly past the bounded id memory', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    let text = '';
    for (let n = 0; n < 1100; n++) text += line(`m${n}`, { i: 1, o: 2, cc: 0, cr: 0 });
    append(c.transcript, text);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([1100, 2200, 0, 0]);
  });

  it('counts an assistant line without a message id and ignores lines of other types', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    const noId = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 4, output_tokens: 1 } } });
    append(c.transcript, noId + '\n{"type":"user"}\n{"type":"assistant","message":{"id":"x"}}\n\n[1]\n');
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([4, 1, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(0);
  });

  it('resolves the subagent file from the agent id and the session directory', () => {
    const c = setup();
    const id = openTask(c, 'a1');
    const sub = path.join(c.proj, 's1', 'subagents', 'agent-a1.jsonl');
    append(sub, line('s-1', { i: 2, o: 2, cc: 2, cr: 2 }));
    // The boss transcript must not be used for a subagent.
    append(c.transcript, line('b-1', { i: 100, o: 100, cc: 100, cr: 100 }));
    opened(c, 'a1');
    toolDone(c, id, 'a1');
    expect(totals(task(c, id))).toEqual([2, 2, 2, 2]);
  });
});

describe('initial cursor', () => {
  it('does not count the history already in the boss transcript', () => {
    const c = setup();
    append(c.transcript, line('old1', { i: 500, o: 500, cc: 500, cr: 500 }));
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('new1', { i: 1, o: 2, cc: 3, cr: 4 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([1, 2, 3, 4]);
  });

  it('counts a subagent file from the start', () => {
    const c = setup();
    const id = openTask(c, 'a1');
    const sub = path.join(c.proj, 's1', 'subagents', 'agent-a1.jsonl');
    append(sub, line('s-1', { i: 5, o: 5, cc: 5, cr: 5 }));
    opened(c, 'a1');
    append(sub, line('s-2', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id, 'a1');
    expect(totals(task(c, id))).toEqual([6, 6, 6, 6]);
  });

  it('discovers a task from the payload of toolFinished when no agentChanged was seen', () => {
    const c = setup();
    append(c.transcript, line('old1', { i: 9, o: 9, cc: 9, cr: 9 }));
    const id = openTask(c);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(0);
    append(c.transcript, line('new1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
  });

  it('flags a task that started before the tracker as tokens-incomplete', () => {
    const c = setup({ now: () => 5000 });
    const id = openTask(c, 'boss', 1000);
    opened(c);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('does not flag a task that started after the tracker', () => {
    const c = setup({ now: () => 500 });
    const id = openTask(c, 'boss', 1000);
    opened(c);
    expect(task(c, id).tokens_incomplete).toBe(0);
  });

  it('flags a task that is first seen only when it is already closed', () => {
    const c = setup();
    const id = openTask(c);
    c.db.closeTask(id, 2000);
    stopped(c, id);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });
});

describe('triggers', () => {
  it('attributes the final delta to the task the stop event closed', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 3, o: 3, cc: 3, cr: 3 }));
    c.db.closeTask(id, 2000);
    stopped(c, id);
    expect(totals(task(c, id))).toEqual([3, 3, 3, 3]);
  });

  it('does nothing when the payload carries no task', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 3, o: 3, cc: 3, cr: 3 }));
    c.seen.length = 0;
    toolDone(c, null);
    stopped(c, null);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(c.seen.filter(([n]) => n === 'agentChanged')).toEqual([]);
  });

  it('emits agentChanged after a change and not when nothing changed', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    c.seen.length = 0;
    toolDone(c, id);
    expect(c.seen.filter(([n]) => n === 'agentChanged')).toEqual([['agentChanged', { session: 's1', agentKey: 'boss' }]]);
    c.seen.length = 0;
    toolDone(c, id);
    expect(changes(c)).toBe(0);
  });

  it('stops reacting after dispose', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    c.tracker.dispose();
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
  });
});

describe('result carries numbers only', () => {
  it('never lets transcript text reach the database, the bus, the logger or an error', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(
      c.transcript,
      line('m1', { i: 1, o: 1, cc: 1, cr: 1 }, SECRET) +
        `{"type":"assistant","message":{"id":"m2","content":"${SECRET}","usage":{"input_tokens":-1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n` +
        `this is not json ${SECRET}\n`,
    );
    toolDone(c, id);
    const dump = raw(c, (d) =>
      ['sessions', 'agents', 'tasks', 'events'].map((t) => JSON.stringify(d.prepare(`SELECT * FROM ${t}`).all())).join('\n'),
    );
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
    expect(dump).not.toContain(SECRET);
    expect(JSON.stringify(c.seen)).not.toContain(SECRET);
    expect(c.logs.join('\n')).not.toContain(SECRET);
    expect(c.listenerErrors.join('\n')).not.toContain(SECRET);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });
});

describe('error handling', () => {
  it('does not read a transcript outside the projects directory and flags the task', () => {
    const c = setup({ writeTranscript: false });
    const outside = path.join(c.root, 'outside.jsonl');
    fs.writeFileSync(outside, line('m1', { i: 9, o: 9, cc: 9, cr: 9 }, SECRET));
    c.db.upsertSession({ id: 's1', user: 'alice', project: 'proj', transcript: outside, started_at: 1000, ended_at: null });
    const id = openTask(c);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(c.logs.join('\n')).not.toContain(SECRET);
  });

  it('does not read a file that is not .jsonl and flags the task', () => {
    const c = setup({ transcriptName: 's1.txt' });
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 9, o: 9, cc: 9, cr: 9 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it.skipIf(!canLink)(
    canLink
      ? 'does not follow a link that escapes the projects directory'
      : 'does not follow a link that escapes the projects directory (skipped: this machine forbids symlinks and junctions)',
    () => {
      const c = setup({ writeTranscript: false });
      const outsideDir = path.join(c.root, 'elsewhere');
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 's1.jsonl'), line('m1', { i: 9, o: 9, cc: 9, cr: 9 }));
      const link = path.join(c.projects, 'escape');
      fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      c.db.upsertSession({
        id: 's1',
        user: 'alice',
        project: 'proj',
        transcript: path.join(link, 's1.jsonl'),
        started_at: 1000,
        ended_at: null,
      });
      const id = openTask(c);
      toolDone(c, id);
      expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
      expect(task(c, id).tokens_incomplete).toBe(1);
    },
  );

  it('flags the task when the projects directory itself does not exist', () => {
    const c = setup();
    fs.rmSync(c.projects, { recursive: true, force: true });
    const id = openTask(c);
    toolDone(c, id);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('keeps the total and flags the task when the transcript file is missing', () => {
    const c = setup({ writeTranscript: false });
    const id = openTask(c);
    c.db.addTokens(id, { input: 7, output: 0, cacheCreation: 0, cacheRead: 0 });
    opened(c);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([7, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('flags a boss task whose session has no transcript path', () => {
    const c = setup();
    c.db.upsertSession({ id: 's2', user: 'alice', project: 'proj', transcript: null, started_at: 1000, ended_at: null });
    const id = openTask(c);
    c.bus.emit('toolFinished', { session: 's2', agentKey: 'boss', taskId: id });
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('flags a subagent task whose session is unknown', () => {
    const c = setup();
    const id = openTask(c, 'a1');
    c.bus.emit('toolFinished', { session: 'nope', agentKey: 'a1', taskId: id } as never);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('skips invalid lines, counts the valid ones and flags the task', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    const bad = (u: unknown): string => JSON.stringify({ type: 'assistant', message: { id: 'b', usage: u } }) + '\n';
    append(
      c.transcript,
      line('ok', { i: 1, o: 1, cc: 1, cr: 1 }) +
        'not json at all\n' +
        bad({ input_tokens: -1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }) +
        bad({ input_tokens: 1.5, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }) +
        bad({ input_tokens: '3', output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }),
    );
    append(c.transcript, '\n');
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('leaves a partial last line unread until its newline arrives, without error', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    const second = line('m2', { i: 2, o: 2, cc: 2, cr: 2 });
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }) + second.slice(0, 40));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
    expect(task(c, id).tokens_incomplete).toBe(0);
    expect(c.logs).toEqual([]);
    append(c.transcript, second.slice(40));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([3, 3, 3, 3]);
    expect(task(c, id).tokens_incomplete).toBe(0);
  });

  it('reports a database outage generically, does not crash, and retries the same lines later', () => {
    let down = true;
    const c = setup({
      wrapDb: (db) =>
        new Proxy(db, {
          get(t, p) {
            if (p === 'addTokens') {
              return (...a: Parameters<Db['addTokens']>) => {
                if (down) throw new DbUnavailableError();
                return t.addTokens(...a);
              };
            }
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
          },
        }),
    });
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 4, o: 4, cc: 4, cr: 4 }, SECRET));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(c.logs.length).toBeGreaterThan(0);
    expect(c.logs.join('\n')).not.toContain(SECRET);
    expect(c.listenerErrors).toEqual([]);
    down = false;
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([4, 4, 4, 4]);
  });

  it('rethrows an unexpected storage error so the bus reports it', () => {
    const c = setup({
      wrapDb: (db) =>
        new Proxy(db, {
          get(t, p) {
            if (p === 'addTokens') {
              return () => {
                throw new Error('boom');
              };
            }
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
          },
        }),
    });
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    expect(c.listenerErrors).toHaveLength(1);
  });
});

describe('per-read cap', () => {
  it('reads at most the cap per trigger and the remainder on the next one', () => {
    const one = line('m00', { i: 1, o: 1, cc: 1, cr: 1 });
    const cap = Buffer.byteLength(one) * 2 + 5;
    const c = setup({ maxReadBytes: cap });
    const id = openTask(c);
    opened(c);
    let text = '';
    for (let n = 10; n < 14; n++) text += line(`m${n}`, { i: 1, o: 1, cc: 1, cr: 1 });
    append(c.transcript, text);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([2, 2, 2, 2]);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([4, 4, 4, 4]);
  });

  it('skips a single line longer than the cap and flags the task', () => {
    const c = setup({ maxReadBytes: 64 });
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    toolDone(c, id);
    toolDone(c, id);
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
  });

  it('starts again from the beginning when the file shrinks', () => {
    const c = setup();
    const id = openTask(c);
    opened(c);
    append(c.transcript, line('m1', { i: 1, o: 1, cc: 1, cr: 1 }) + line('m2', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id);
    fs.writeFileSync(c.transcript, line('m3', { i: 5, o: 5, cc: 5, cr: 5 }));
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([7, 7, 7, 7]);
  });
});

// ---------------------------------------------------------------- correction round

const BAD_SEGMENTS: Array<[string, string]> = [
  ['dots', '..'],
  ['a single dot', '.'],
  ['an embedded dot', 'x.y'],
  ['a slash', 'a/../b'],
  ['a backslash', 'a\\..\\b'],
  ['an empty string', ''],
  ['a very long value', 'a'.repeat(200)],
];

describe('subagent path hardening', () => {
  it.each(BAD_SEGMENTS)('does not read a decoy when the agent key has %s, and flags the task', (_n, key) => {
    const c = setup();
    const decoy = path.join(c.proj, 's1', 'subagents', `agent-${key}.jsonl`);
    append(decoy, line('d1', { i: 9, o: 9, cc: 9, cr: 9 }, SECRET));
    const id = openTask(c, key);
    c.bus.emit('toolFinished', { session: 's1', agentKey: key, taskId: id });
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(c.logs.join('\n')).not.toContain(SECRET);
  });

  it.each(BAD_SEGMENTS)('does not read a decoy when the session id has %s, and flags the task', (_n, sessionId) => {
    const c = setup();
    const base = path.join(c.proj, 'other.jsonl');
    c.db.upsertSession({ id: sessionId, user: 'alice', project: 'proj', transcript: base, started_at: 1000, ended_at: null });
    const decoy = path.join(path.dirname(base), sessionId, 'subagents', 'agent-a1.jsonl');
    append(decoy, line('d1', { i: 9, o: 9, cc: 9, cr: 9 }));
    const id = openTask(c, 'a1', 1000, sessionId);
    c.bus.emit('toolFinished', { session: sessionId, agentKey: 'a1', taskId: id });
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
  });

  it('still reads a subagent whose ids use letters, digits, underscore and hyphen', () => {
    const c = setup();
    const id = openTask(c, 'agent_A-1');
    append(path.join(c.proj, 's1', 'subagents', 'agent-agent_A-1.jsonl'), line('s1', { i: 1, o: 1, cc: 1, cr: 1 }));
    toolDone(c, id, 'agent_A-1');
    expect(totals(task(c, id))).toEqual([1, 1, 1, 1]);
  });
});

describe('release on session end', () => {
  it('drops every piece of state of the session and counts late usage once more', () => {
    const c = setup();
    const boss = openTask(c);
    const sub = openTask(c, 'a1');
    opened(c);
    opened(c, 'a1');
    append(c.transcript, line('b1', { i: 1, o: 1, cc: 1, cr: 1 }));
    append(path.join(c.proj, 's1', 'subagents', 'agent-a1.jsonl'), line('s1', { i: 2, o: 2, cc: 2, cr: 2 }));
    toolDone(c, boss);
    c.db.closeTask(boss, 2000);
    c.db.closeTask(sub, 2000);
    // Late usage, written after the last trigger and before the session ended.
    append(c.transcript, line('b2', { i: 4, o: 4, cc: 4, cr: 4 }));
    c.bus.emit('sessionEnded', { session: 's1' });
    expect(totals(task(c, boss))).toEqual([5, 5, 5, 5]);
    expect(totals(task(c, sub))).toEqual([2, 2, 2, 2]);
    expect(c.tracker.stats()).toEqual({ files: 0, flagged: 0, tasks: 0 });
  });

  it('releases flagged entries too', () => {
    const c = setup({ writeTranscript: false });
    const id = openTask(c);
    toolDone(c, id);
    expect(c.tracker.stats().flagged).toBe(1);
    c.bus.emit('sessionEnded', { session: 's1' });
    expect(c.tracker.stats()).toEqual({ files: 0, flagged: 0, tasks: 0 });
  });

  it('leaves another session untouched and starts fresh for a reused session id', () => {
    const c = setup();
    const other = path.join(c.proj, 's2.jsonl');
    fs.writeFileSync(other, '');
    c.db.upsertSession({ id: 's2', user: 'alice', project: 'proj', transcript: other, started_at: 1000, ended_at: null });
    const t1 = openTask(c);
    const t2 = openTask(c, 'boss', 1000, 's2');
    opened(c);
    c.bus.emit('agentChanged', { session: 's2', agentKey: 'boss' });
    expect(c.tracker.stats()).toEqual({ files: 2, flagged: 0, tasks: 2 });
    c.bus.emit('sessionEnded', { session: 's1' });
    expect(c.tracker.stats()).toEqual({ files: 1, flagged: 0, tasks: 1 });
    // s2 is still tracked: usage written to its file is counted.
    append(other, line('o1', { i: 3, o: 3, cc: 3, cr: 3 }));
    c.bus.emit('toolFinished', { session: 's2', agentKey: 'boss', taskId: t2 });
    expect(totals(task(c, t2))).toEqual([3, 3, 3, 3]);
    // The ended session id comes back (a resumed session): fresh state, no throw.
    c.db.closeTask(t1, 2000);
    const t3 = openTask(c, 'boss', 3000);
    opened(c);
    append(c.transcript, line('n1', { i: 7, o: 7, cc: 7, cr: 7 }));
    toolDone(c, t3);
    expect(totals(task(c, t3))).toEqual([7, 7, 7, 7]);
  });
});

describe('flag retry', () => {
  it('writes the restart flag once the database is back, exactly once', () => {
    let down = true;
    let flagWrites = 0;
    const c = setup({
      now: () => 5000,
      wrapDb: (db) =>
        new Proxy(db, {
          get(t, p) {
            if (p === 'addTokens') {
              return (...a: Parameters<Db['addTokens']>) => {
                if (down) throw new DbUnavailableError();
                if (a[2]?.incomplete) flagWrites++;
                return t.addTokens(...a);
              };
            }
            const v = Reflect.get(t, p) as unknown;
            return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
          },
        }),
    });
    const id = openTask(c, 'boss', 1000);
    opened(c);
    expect(task(c, id).tokens_incomplete).toBe(0);
    down = false;
    toolDone(c, id);
    toolDone(c, id);
    opened(c);
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(flagWrites).toBe(1);
  });
});

describe('edge paths', () => {
  it('counts a subagent file that appears after its task was first seen, from 0, and flags the missing period', () => {
    const c = setup();
    const id = openTask(c, 'a1');
    opened(c, 'a1');
    toolDone(c, id, 'a1');
    expect(task(c, id).tokens_incomplete).toBe(1);
    append(path.join(c.proj, 's1', 'subagents', 'agent-a1.jsonl'), line('s1', { i: 2, o: 2, cc: 2, cr: 2 }));
    toolDone(c, id, 'a1');
    expect(totals(task(c, id))).toEqual([2, 2, 2, 2]);
  });

  it('does not read a transcript path that is a directory named like a .jsonl file, and does not crash', () => {
    const c = setup({ writeTranscript: false, transcriptName: 'dir.jsonl' });
    fs.mkdirSync(c.transcript);
    const id = openTask(c);
    opened(c);
    toolDone(c, id);
    expect(totals(task(c, id))).toEqual([0, 0, 0, 0]);
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(c.listenerErrors).toEqual([]);
  });

  it('flags a subagent task first seen after a tracker restart and counts its file from 0 (may include earlier usage)', () => {
    const c = setup({ now: () => 5000 });
    // Written before this tracker started, for the same agent: counted anyway, which is why the flag matters.
    append(path.join(c.proj, 's1', 'subagents', 'agent-a1.jsonl'), line('old', { i: 5, o: 5, cc: 5, cr: 5 }));
    const id = openTask(c, 'a1', 1000);
    opened(c, 'a1');
    toolDone(c, id, 'a1');
    expect(task(c, id).tokens_incomplete).toBe(1);
    expect(totals(task(c, id))).toEqual([5, 5, 5, 5]);
  });
});
