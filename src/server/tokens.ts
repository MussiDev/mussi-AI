import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRef, Bus } from './bus.js';
import { DbUnavailableError, type Db, type TokenDelta } from './db.js';

// The only module that reads transcripts. A transcript holds the whole conversation, so from every
// parsed line only four non-negative integers are kept; the parsed object is dropped at once and
// nothing read from the file is ever logged, stored or emitted besides those counters.

export interface TokenTrackerOptions {
  db: Db;
  bus: Bus;
  /** Allowed root of transcripts. Defaults to ~/.claude/projects. */
  projectsDir?: string;
  /** Runtime diagnostics. Messages are generic and never carry transcript content. */
  log?: (msg: string) => void;
  /** Clock used to detect tasks that started before the tracker did. Defaults to Date.now. */
  now?: () => number;
  /** Maximum bytes read from one file per trigger. Defaults to 8 MB; tests lower it. */
  maxReadBytes?: number;
}

export interface TokenTracker {
  dispose(): void;
  /** Read-only diagnostic for tests: how much state the tracker is holding. */
  stats(): { files: number; flagged: number; tasks: number };
}

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_REMEMBERED_IDS = 1000;
const MAX_REMEMBERED_TASKS = 10_000;
const NEWLINE = 0x0a;
// session and agent id become path segments, so only this alphabet and length are accepted.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

const ZERO: TokenDelta = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

interface FileState {
  cursor: number;
  /** message.id -> usage counted so far, oldest first. */
  ids: Map<string, TokenDelta>;
}

type Resolved = { ok: true; file: string } | { ok: false };

interface ReadOutcome {
  delta: TokenDelta;
  incomplete: boolean;
  cursor: number;
  ids: Map<string, TokenDelta>;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** The four counters of a usage object, or null when any is present but not a non-negative integer. */
function readUsage(usage: Record<string, unknown>): TokenDelta | null {
  const input = usage['input_tokens'];
  const output = usage['output_tokens'];
  const cacheCreation = usage['cache_creation_input_tokens'] ?? 0;
  const cacheRead = usage['cache_read_input_tokens'] ?? 0;
  if (!isCount(input) || !isCount(output) || !isCount(cacheCreation) || !isCount(cacheRead)) return null;
  return { input, output, cacheCreation, cacheRead };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isZero(d: TokenDelta): boolean {
  return d.input === 0 && d.output === 0 && d.cacheCreation === 0 && d.cacheRead === 0;
}

function add(a: TokenDelta, b: TokenDelta): TokenDelta {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** Larger-wins difference per counter, and the value to remember. Never negative. */
function growth(seen: TokenDelta, now: TokenDelta): { diff: TokenDelta; kept: TokenDelta } {
  const diff = {
    input: Math.max(0, now.input - seen.input),
    output: Math.max(0, now.output - seen.output),
    cacheCreation: Math.max(0, now.cacheCreation - seen.cacheCreation),
    cacheRead: Math.max(0, now.cacheRead - seen.cacheRead),
  };
  return { diff, kept: add(seen, diff) };
}

export function createTokenTracker(opts: TokenTrackerOptions): TokenTracker {
  const { db, bus } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const maxRead = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const startedAt = now();
  const projectsDir = opts.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');

  // Known limitation (accepted): hooks are asynchronous, so usage written to a boss transcript before
  // the server processes the task's opening event is not counted (the cursor starts at the file's end then).
  const files = new Map<string, FileState>();
  const knownTasks = new Set<number>();
  const flagged = new Set<number>();
  /** Tasks whose incomplete flag still has to be written (the database was unavailable). */
  const pendingFlag = new Set<number>();
  // Per-session indexes so everything held for a session can be released when it ends.
  const sessionFiles = new Map<string, Set<string>>();
  const sessionTasks = new Map<string, Set<number>>();
  const latestTask = new Map<string, Map<string, number>>();

  function index<K, V>(map: Map<string, Map<K, V> | Set<V>>, session: string, make: () => Map<K, V> | Set<V>): Map<K, V> | Set<V> {
    let entry = map.get(session);
    if (entry === undefined) {
      entry = make();
      map.set(session, entry);
    }
    return entry;
  }

  function trackFile(session: string, file: string): void {
    (index(sessionFiles, session, () => new Set<string>()) as Set<string>).add(file);
  }

  function trackTask(session: string, agentKey: string, taskId: number): void {
    (index(sessionTasks, session, () => new Set<number>()) as Set<number>).add(taskId);
    (index(latestTask, session, () => new Map<string, number>()) as Map<string, number>).set(agentKey, taskId);
  }

  /** Realpath of the transcript for this agent, only when it lies strictly inside projectsDir and is .jsonl. */
  function resolveFile(ref: AgentRef): Resolved {
    const session = db.getSession(ref.session);
    if (session === undefined || session.transcript === null) return { ok: false };
    if (ref.agentKey !== 'boss' && !(SAFE_SEGMENT.test(ref.session) && SAFE_SEGMENT.test(ref.agentKey))) {
      return { ok: false };
    }
    const candidate =
      ref.agentKey === 'boss'
        ? session.transcript
        : path.join(path.dirname(session.transcript), ref.session, 'subagents', `agent-${ref.agentKey}.jsonl`);
    try {
      const root = fs.realpathSync(projectsDir);
      const real = fs.realpathSync(candidate);
      if (!isInside(root, real) || !real.toLowerCase().endsWith('.jsonl') || !fs.statSync(real).isFile()) {
        return { ok: false };
      }
      return { ok: true, file: real };
    } catch {
      return { ok: false };
    }
  }

  function remember(taskId: number): void {
    knownTasks.add(taskId);
    if (knownTasks.size > MAX_REMEMBERED_TASKS) {
      const oldest = knownTasks.values().next().value;
      if (oldest !== undefined) knownTasks.delete(oldest);
    }
  }

  /** Flags the task once per tracker lifetime. Returns true when the database changed. */
  function flag(taskId: number): boolean {
    if (flagged.has(taskId)) return false;
    if (!store(taskId, ZERO, true)) return false;
    flagged.add(taskId);
    return true;
  }

  /** Writes to the database; an outage is reported without content and does not propagate. */
  function store(taskId: number, delta: TokenDelta, incomplete: boolean): boolean {
    try {
      db.addTokens(taskId, delta, { incomplete });
      return true;
    } catch (e) {
      if (!(e instanceof DbUnavailableError)) throw e;
      log('Token usage not stored: database unavailable');
      return false;
    }
  }

  /**
   * First sight of a task. The boss transcript holds the whole conversation, so its cursor starts at
   * the current end (only usage written while the task is open counts); a subagent file belongs to
   * that agent and starts at 0. A task that began before this tracker lost part of its usage.
   */
  function discover(ref: AgentRef, taskId: number, startedAtOfTask: number | undefined): boolean {
    trackTask(ref.session, ref.agentKey, taskId);
    if (knownTasks.has(taskId)) {
      // A flag that could not be stored earlier is retried here, never written twice.
      return pendingFlag.has(taskId) ? retryFlag(taskId) : false;
    }
    remember(taskId);
    if (ref.agentKey === 'boss') {
      const resolved = resolveFile(ref);
      if (resolved.ok) {
        try {
          const size = fs.statSync(resolved.file).size;
          const state = files.get(resolved.file);
          if (state) state.cursor = size;
          else files.set(resolved.file, { cursor: size, ids: new Map() });
          trackFile(ref.session, resolved.file);
        } catch {
          // The read will report the missing file.
        }
      }
    }
    if (startedAtOfTask === undefined || startedAtOfTask < startedAt) {
      pendingFlag.add(taskId);
      return retryFlag(taskId);
    }
    return false;
  }

  function retryFlag(taskId: number): boolean {
    const changed = flag(taskId);
    if (flagged.has(taskId)) pendingFlag.delete(taskId);
    return changed;
  }

  function parseChunk(text: string, ids: Map<string, TokenDelta>): { delta: TokenDelta; invalid: boolean } {
    let delta = ZERO;
    let invalid = false;
    for (const raw of text.split('\n')) {
      const lineText = raw.trim();
      if (lineText === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lineText);
      } catch {
        invalid = true;
        continue;
      }
      if (!isRecord(parsed) || parsed['type'] !== 'assistant') continue;
      const message = parsed['message'];
      if (!isRecord(message) || !isRecord(message['usage'])) continue;
      const usage = readUsage(message['usage']);
      if (usage === null) {
        invalid = true;
        continue;
      }
      const id = message['id'];
      if (typeof id !== 'string') {
        delta = add(delta, usage);
        continue;
      }
      const before = ids.get(id);
      const { diff, kept } = before ? growth(before, usage) : { diff: usage, kept: usage };
      ids.delete(id);
      ids.set(id, kept);
      if (ids.size > MAX_REMEMBERED_IDS) {
        const oldest = ids.keys().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
      delta = add(delta, diff);
    }
    return { delta, invalid };
  }

  /** Reads one bounded chunk of complete lines. Nothing is committed to the state here. */
  function readChunk(file: string, state: FileState): ReadOutcome {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const cursor = state.cursor > size ? 0 : state.cursor;
      const len = Math.min(size - cursor, maxRead);
      if (len <= 0) return { delta: ZERO, incomplete: false, cursor, ids: state.ids };
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, cursor + got);
        if (n === 0) break;
        got += n;
      }
      const end = buf.subarray(0, got).lastIndexOf(NEWLINE);
      if (end === -1) {
        // No complete line yet. A line longer than the cap can never complete inside one read: skip it.
        if (got === maxRead && size - cursor >= maxRead) return { delta: ZERO, incomplete: true, cursor: cursor + got, ids: state.ids };
        return { delta: ZERO, incomplete: false, cursor, ids: state.ids };
      }
      const ids = new Map(state.ids);
      const { delta, invalid } = parseChunk(buf.subarray(0, end + 1).toString('utf8'), ids);
      return { delta, incomplete: invalid, cursor: cursor + end + 1, ids };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Reads what is new for the agent and adds it to the task. Returns true when something changed. */
  function collect(ref: AgentRef, taskId: number): boolean {
    const resolved = resolveFile(ref);
    if (!resolved.ok) {
      log('Token usage not read: transcript unavailable');
      return flag(taskId);
    }
    let state = files.get(resolved.file);
    if (state === undefined) {
      let cursor = 0;
      try {
        // Without an earlier sighting the boss history must not be counted either.
        if (ref.agentKey === 'boss') cursor = fs.statSync(resolved.file).size;
      } catch {
        log('Token usage not read: transcript unavailable');
        return flag(taskId);
      }
      state = { cursor, ids: new Map() };
      files.set(resolved.file, state);
      trackFile(ref.session, resolved.file);
    }
    let outcome: ReadOutcome;
    try {
      outcome = readChunk(resolved.file, state);
    } catch {
      log('Token usage not read: transcript unreadable');
      return flag(taskId);
    }
    const needsFlag = outcome.incomplete && !flagged.has(taskId);
    let changed = false;
    if (!isZero(outcome.delta) || needsFlag) {
      if (!store(taskId, outcome.delta, outcome.incomplete)) return false;
      changed = true;
      if (outcome.incomplete) flagged.add(taskId);
    }
    state.cursor = outcome.cursor;
    state.ids = outcome.ids;
    return changed;
  }

  function trigger(payload: AgentRef, taskId: number | null): void {
    if (taskId === null) return;
    // Rebuilt so the emitted payload is exactly an AgentRef, whatever the trigger carried.
    const ref: AgentRef = { session: payload.session, agentKey: payload.agentKey };
    const open = db.getOpenTask(ref.session, ref.agentKey);
    const first = discover(ref, taskId, open?.id === taskId ? open.started_at : undefined);
    const changed = collect(ref, taskId);
    if (first || changed) bus.emit('agentChanged', ref);
  }

  const onAgentChanged = (ref: AgentRef): void => {
    const open = db.getOpenTask(ref.session, ref.agentKey);
    if (open === undefined) return;
    // No emit here: the agentChanged being handled is still reaching the other listeners, which read the database after this one.
    discover(ref, open.id, open.started_at);
  };
  const onToolFinished = (p: AgentRef & { taskId: number | null }): void => trigger(p, p.taskId);
  const onAgentStopped = (p: AgentRef & { taskId: number | null }): void => trigger(p, p.taskId);

  /**
   * Final read for each agent's latest task of the session (so late usage is not lost), then release
   * every piece of state held for the session. Older tasks of the same agent get nothing: the cursor
   * is per file, so the latest task is the one the late lines belong to.
   */
  const onSessionEnded = (p: { session: string }): void => {
    const agents = latestTask.get(p.session);
    try {
      if (agents) {
        for (const [agentKey, taskId] of agents) {
          const ref: AgentRef = { session: p.session, agentKey };
          if (collect(ref, taskId)) bus.emit('agentChanged', ref);
        }
      }
    } finally {
      for (const file of sessionFiles.get(p.session) ?? []) files.delete(file);
      for (const id of sessionTasks.get(p.session) ?? []) {
        knownTasks.delete(id);
        flagged.delete(id);
        pendingFlag.delete(id);
      }
      sessionFiles.delete(p.session);
      sessionTasks.delete(p.session);
      latestTask.delete(p.session);
    }
  };

  bus.on('agentChanged', onAgentChanged);
  bus.on('sessionEnded', onSessionEnded);
  bus.on('toolFinished', onToolFinished);
  bus.on('agentStopped', onAgentStopped);

  return {
    dispose(): void {
      bus.off('agentChanged', onAgentChanged);
      bus.off('sessionEnded', onSessionEnded);
      bus.off('toolFinished', onToolFinished);
      bus.off('agentStopped', onAgentStopped);
    },
    stats: () => ({ files: files.size, flagged: flagged.size, tasks: knownTasks.size }),
  };
}
