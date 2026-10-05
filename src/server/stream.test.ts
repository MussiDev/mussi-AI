import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createBus, type Bus } from './bus.js';
import { DbUnavailableError, openDb, type Db } from './db.js';
import { startServer } from './main.js';
import { loadOrCreateToken, resolveDataDir } from './secrets.js';
import { createStreamHub, type StreamHub } from './stream.js';

// ---------------------------------------------------------------- harness

const agent = new http.Agent({ keepAlive: true });
const homes: string[] = [];
const dbs: Db[] = [];
const servers: http.Server[] = [];
const hubs: StreamHub[] = [];
const clients: Sse[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const failures: unknown[] = [];
  const step = async (fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(e);
    }
  };
  for (const c of clients.splice(0)) await step(() => c.close());
  for (const close of closers.splice(0)) await step(close);
  for (const hub of hubs.splice(0)) await step(() => hub.dispose());
  for (const s of servers.splice(0)) {
    await step(async () => {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    });
  }
  for (const d of dbs.splice(0)) await step(() => (d.isAvailable() ? d.close() : undefined));
  await step(() => agent.destroy());
  for (const h of homes.splice(0)) await step(() => fs.rmSync(h, { recursive: true, force: true, maxRetries: 3 }));
  if (failures.length > 0) throw failures[0];
});

interface Entry {
  session: string;
  agent_key: string;
  name: string;
  is_boss: boolean;
  stage: string;
  project: string;
  session_ended_at: number | null;
  task: {
    id: number;
    started_at: number;
    ended_at: number | null;
    tokens: { input: number; output: number; cache_creation: number; cache_read: number; total: number; incomplete: boolean };
  } | null;
}

interface Msg {
  event: string | null;
  data: string | null;
  comment: string | null;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(5);
  expect(pred(), `timed out waiting for: ${label}`).toBe(true);
}

/** A real SSE client over node:http that records every message with its arrival time. */
class Sse {
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  body = '';
  messages: Msg[] = [];
  ended = false;
  req!: http.ClientRequest;
  private buffer = '';
  private waiters: Array<() => void> = [];

  static open(port: number, o: { headers?: Record<string, string>; path?: string; method?: string } = {}): Promise<Sse> {
    return new Promise((resolve, reject) => {
      const sse = new Sse();
      clients.push(sse);
      sse.req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: o.path ?? '/stream',
          method: o.method ?? 'GET',
          headers: { accept: 'text/event-stream', ...(o.headers ?? {}) },
          agent: false,
        },
        (res) => {
          sse.status = res.statusCode ?? 0;
          sse.headers = res.headers;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => sse.feed(chunk));
          res.on('close', () => sse.finish());
          resolve(sse);
        },
      );
      sse.req.on('error', (e) => {
        if (sse.status === 0) reject(e);
        sse.finish();
      });
      sse.req.end();
    });
  }

  private feed(chunk: string): void {
    this.body += chunk;
    this.buffer += chunk;
    for (;;) {
      const i = this.buffer.indexOf('\n\n');
      if (i === -1) break;
      const block = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      const msg: Msg = { event: null, data: null, comment: null, at: performance.now() };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) msg.comment = line.slice(1).trim();
        else if (line.startsWith('event: ')) msg.event = line.slice(7);
        else if (line.startsWith('data: ')) msg.data = line.slice(6);
      }
      this.messages.push(msg);
    }
    this.notify();
  }

  private finish(): void {
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (pred()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), ms);
      const check = (): void => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  ofType(event: string): Msg[] {
    return this.messages.filter((m) => m.event === event);
  }

  get updates(): Msg[] {
    return this.ofType('update');
  }

  update(n: number): Entry {
    return JSON.parse(this.updates[n]?.data ?? 'null') as Entry;
  }

  snapshot(): Entry[] {
    const m = this.ofType('snapshot')[0];
    return (JSON.parse(m?.data ?? '{"agents":null}') as { agents: Entry[] }).agents;
  }

  get json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }

  async closed(): Promise<void> {
    await this.waitFor(() => this.ended, 'the stream to end');
  }

  close(): void {
    this.req.destroy();
  }
}

interface Harness {
  port: number;
  token: string;
  db: Db;
  bus: Bus;
  hub: StreamHub;
  logs: string[];
  down: { value: boolean; error: Error };
  /** Server-side responses of every /stream request, in arrival order. */
  responses: http.ServerResponse[];
  /** Pretended pending write bytes per /stream response (by arrival index); the real value when unset. */
  buffered: Map<number, number>;
  home: string;
  nextTs(): number;
}

interface HarnessOptions {
  keepaliveMs?: number;
  maxBufferedBytes?: number;
  maxTrackedAgents?: number;
  noStream?: boolean;
  stream?: (db: Db, bus: Bus, log: (m: string) => void) => StreamHub;
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-str-'));
  homes.push(home);
  return home;
}

function openFor(home: string, logs: string[]): { token: string; db: Db } {
  const dataDir = resolveDataDir({}, home);
  const token = loadOrCreateToken(dataDir);
  const db = openDb({ dataDir, dbPath: path.join(dataDir, 'office.db'), log: (m) => logs.push(m) });
  dbs.push(db);
  return { token, db };
}

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const logs: string[] = [];
  const home = makeHome();
  const { token, db } = openFor(home, logs);
  const bus = createBus({ onListenerError: (_err, name) => logs.push(`Bus listener failed for ${name}`) });
  const down = { value: false, error: new DbUnavailableError() as Error };
  // The stream reads through a proxy so a test can make the snapshot fail without touching ingestion.
  const failing = new Proxy(db, {
    get(target, prop) {
      if (prop === 'listAgents' && down.value) {
        return () => {
          throw down.error;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const log = (m: string): void => {
    logs.push(m);
  };
  const hub = o.stream
    ? o.stream(failing, bus, log)
    : createStreamHub({
        db: failing,
        bus,
        log,
        ...(o.keepaliveMs !== undefined ? { keepaliveMs: o.keepaliveMs } : {}),
        ...(o.maxBufferedBytes !== undefined ? { maxBufferedBytes: o.maxBufferedBytes } : {}),
        ...(o.maxTrackedAgents !== undefined ? { maxTrackedAgents: o.maxTrackedAgents } : {}),
      });
  hubs.push(hub);
  let port = 0;
  const app = createApp({ token, db: failing, bus, getPort: () => port, log, ...(o.noStream ? {} : { stream: hub }) });
  const responses: http.ServerResponse[] = [];
  const buffered = new Map<number, number>();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/stream')) {
      const index = responses.length;
      responses.push(res);
      Object.defineProperty(res, 'writableLength', {
        configurable: true,
        get: () => buffered.get(index) ?? (Reflect.get(Object.getPrototypeOf(res) as object, 'writableLength', res) as number),
      });
    }
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  port = (server.address() as AddressInfo).port;
  let ts = 1000;
  return { port, token, db, bus, hub, logs, down, responses, buffered, home, nextTs: () => ++ts };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
}

function request(
  port: number,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers ?? {}, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Not JSON.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(o.body);
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function ev(h: { nextTs(): number }, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ts: h.nextTs(),
    hook: 'UserPromptSubmit',
    user: 'alice',
    project: 'proj',
    session: 's1',
    agent_id: null,
    agent: 'boss',
    ...over,
  };
}

async function post(h: Harness, over: Record<string, unknown> = {}): Promise<Res> {
  const res = await request(h.port, {
    method: 'POST',
    path: '/events',
    headers: { 'content-type': 'application/json', ...bearer(h.token) },
    body: JSON.stringify(ev(h, over)),
  });
  expect(res.status).toBe(202);
  return res;
}

async function connect(h: Harness, headers: Record<string, string> = bearer(h.token)): Promise<Sse> {
  const sse = await Sse.open(h.port, { headers });
  expect(sse.status).toBe(200);
  await sse.waitFor(() => sse.ofType('snapshot').length > 0, 'the snapshot');
  return sse;
}

// ---------------------------------------------------------------- db.getLatestTask is tested in db.test.ts

describe('GET /stream: delivery', () => {
  it('sends the snapshot first and then the later changes to a client with a valid token (AC-23, AC-31)', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);

    expect(c.headers['content-type']).toContain('text/event-stream');
    expect(c.headers['cache-control']).toBe('no-cache, no-transform');
    expect(c.headers['access-control-allow-origin']).toBeUndefined();
    expect(c.messages[0]?.event).toBe('snapshot');
    expect(c.snapshot()).toEqual([
      {
        session: 's1',
        agent_key: 'boss',
        name: 'boss',
        is_boss: true,
        stage: 'Thinking',
        project: 'proj',
        session_ended_at: null,
        task: {
          id: expect.any(Number),
          started_at: 1001,
          ended_at: null,
          tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0, incomplete: false },
        },
      },
    ]);

    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the update');
    expect(c.messages.map((m) => m.event)).toEqual(['snapshot', 'update']);
    expect(c.update(0)).toMatchObject({ session: 's1', agent_key: 'boss', stage: 'Reading', task: { ended_at: null } });
  });

  it('sends an empty snapshot when there are no agents, and ignores query parameters', async () => {
    const h = await harness();
    const c = await Sse.open(h.port, { path: '/stream?since=5&agent=zzz', headers: bearer(h.token) });
    expect(c.status).toBe(200);
    await c.waitFor(() => c.messages.length > 0, 'the snapshot');
    expect(c.messages[0]?.data).toBe('{"agents":[]}');
  });

  it('includes subagents with is_boss false and their own task', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    await post(h, { hook: 'PreToolUse', tool: 'Read', agent_id: 'a1', agent: 'reviewer' });
    const c = await connect(h);
    const sub = c.snapshot().find((a) => a.agent_key === 'a1');
    expect(sub).toMatchObject({ name: 'reviewer', is_boss: false, project: 'proj' });
    expect(sub?.task).not.toBeNull();
  });

  it('shows the final frozen task values of a Done agent in the snapshot', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const open = h.db.getOpenTask('s1', 'boss');
    h.db.addTokens(open?.id ?? -1, { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 });
    await post(h, { hook: 'Stop' });
    const c = await connect(h);
    const [entry] = c.snapshot();
    expect(entry?.stage).toBe('Done');
    expect(entry?.task?.ended_at).not.toBeNull();
    expect(entry?.task?.tokens).toEqual({ input: 10, output: 20, cache_creation: 30, cache_read: 40, total: 100, incomplete: false });
  });

  it('delivers stage, token total and task start and end changes to every connected client (AC-24)', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const a = await connect(h);
    const b = await connect(h);

    await post(h, { hook: 'PreToolUse', tool: 'Edit' });
    // The token tracker stores counters and then emits agentChanged; do the same here.
    const open = h.db.getOpenTask('s1', 'boss');
    h.db.addTokens(open?.id ?? -1, { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }, { incomplete: true });
    h.bus.emit('agentChanged', { session: 's1', agentKey: 'boss' });
    await post(h, { hook: 'Stop' });
    await post(h, { hook: 'UserPromptSubmit' });

    for (const c of [a, b]) {
      await c.waitFor(() => c.updates.length === 4, 'four updates');
      expect(c.update(0).stage).toBe('Editing');
      expect(c.update(1).task?.tokens).toEqual({ input: 1, output: 2, cache_creation: 3, cache_read: 4, total: 10, incomplete: true });
      expect(c.update(2)).toMatchObject({ stage: 'Done', task: { ended_at: expect.any(Number) } });
      expect(c.update(3)).toMatchObject({ stage: 'Thinking', task: { ended_at: null } });
      expect(c.update(3).task?.id).toBeGreaterThan(c.update(2).task?.id ?? Infinity);
    }
  });

  it('delivers an update within 300 ms of the event at p95 over 200 events (NFR-01)', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    const latencies: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await post(h, { hook: 'PreToolUse', tool: i % 2 === 0 ? 'Read' : 'Bash' });
      await c.waitFor(() => c.updates.length === i + 1, `update ${i + 1}`);
      latencies.push((c.updates[i]?.at ?? Infinity) - t0);
    }
    latencies.sort((x, y) => x - y);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? Infinity;
    console.info(`NFR-01 observed p95 ${p95.toFixed(2)} ms over ${latencies.length} events`);
    expect(latencies).toHaveLength(200);
    expect(p95).toBeLessThan(300);
  }, 30_000);

  it('produces no update for a no-op agentChanged or an idle notification', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    h.bus.emit('agentChanged', { session: 's1', agentKey: 'boss' });
    await post(h, { hook: 'Notification', notification: 'idle_prompt' });
    h.bus.emit('agentChanged', { session: 'ghost', agentKey: 'boss' });
    await sleep(120);
    expect(c.updates).toHaveLength(0);
    // A real change still goes through afterwards.
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    await c.waitFor(() => c.updates.length === 1, 'the update');
  });

  it('sends one update when two events produce the same entry', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await post(h, { hook: 'PreToolUse', tool: 'Grep' });
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    await c.waitFor(() => c.updates.length === 2, 'two updates');
    await sleep(60);
    expect(c.updates.map((m) => (JSON.parse(m.data ?? '{}') as Entry).stage)).toEqual(['Reading', 'Running']);
  });

  it('does not suppress a legitimate update after a state returned to an earlier value while nobody listened', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const first = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await first.waitFor(() => first.updates.length === 1, 'the update');
    first.close();
    await until(() => h.hub.clientCount() === 0, 'the client to be released');
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    const second = await connect(h);
    expect(second.snapshot()[0]?.stage).toBe('Running');
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await second.waitFor(() => second.updates.length === 1, 'the update back to Reading');
    expect(second.update(0).stage).toBe('Reading');
  });

  it('sends the session end with its time and releases the tracked entries of that session', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the first update');
    expect(h.hub.trackedAgents()).toBe(1);
    const end = await post(h, { hook: 'SessionEnd' });
    expect(end.status).toBe(202);
    await c.waitFor(() => c.updates.length === 2, 'the final update');
    expect(c.update(1)).toMatchObject({ stage: 'Done', session_ended_at: expect.any(Number), task: { ended_at: expect.any(Number) } });
    expect(h.hub.trackedAgents()).toBe(0);
  });

  it('keeps the table of last-sent entries bounded', async () => {
    const h = await harness({ maxTrackedAgents: 3 });
    await post(h, { hook: 'UserPromptSubmit', session: 'seed' });
    const c = await connect(h);
    for (let i = 0; i < 6; i++) await post(h, { hook: 'UserPromptSubmit', session: `x${i}` });
    await c.waitFor(() => c.updates.length === 6, 'six updates');
    expect(h.hub.trackedAgents()).toBeLessThanOrEqual(3);
  });

  it('flows token counters from the real tracker into an update, with total as the sum', async () => {
    const logs: string[] = [];
    const home = makeHome();
    const { token, db } = openFor(home, logs);
    const projects = path.join(home, 'projects');
    fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
    const transcript = path.join(projects, 'proj', 's1.jsonl');
    fs.writeFileSync(transcript, '');
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m), projectsDir: projects });
    closers.push(() => server.close());
    const h = { port: server.port, token, nextTs: (() => { let t = Date.now() + 1000; return () => ++t; })() } as Harness;

    await post(h, { hook: 'UserPromptSubmit', transcript });
    const c = await connect(h);
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 } },
      }) + '\n',
    );
    await post(h, { hook: 'PostToolUse', tool: 'Bash', transcript });
    await c.waitFor(() => c.updates.length >= 1, 'the token update');
    expect(c.update(0).task?.tokens).toEqual({ input: 3, output: 4, cache_creation: 5, cache_read: 6, total: 18, incomplete: false });
    expect(logs).toEqual([]);
  });

  it('sends the keepalive comment on the injected interval', async () => {
    const h = await harness({ keepaliveMs: 25 });
    const c = await connect(h);
    await c.waitFor(() => c.messages.filter((m) => m.comment === 'keepalive').length >= 2, 'two keepalive comments');
    expect(c.body).toContain(': keepalive\n\n');
  });

  it('uses a 15 second keepalive by default and stops the timer on dispose', () => {
    vi.useFakeTimers();
    const bus = createBus();
    const hub = createStreamHub({ db: stubDb(), bus });
    const res = fakeRes();
    hub.handler(fakeReq(), res as never, () => {});
    expect(res.writes).toHaveLength(1);
    vi.advanceTimersByTime(14_999);
    expect(res.writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(res.writes[1]).toBe(': keepalive\n\n');
    hub.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('GET /stream: clients', () => {
  it('releases a disconnected client while the other keeps receiving without errors (AC-25)', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const a = await connect(h);
    const b = await connect(h);
    expect(h.hub.clientCount()).toBe(2);

    a.close();
    await until(() => h.hub.clientCount() === 1, 'the client to be released');
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await b.waitFor(() => b.updates.length === 1, 'the update on the remaining client');
    expect(h.logs).toEqual([]);
  });

  it('drops a client whose write fails and keeps updating the others (AC-25)', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const a = await connect(h);
    const b = await connect(h);
    const serverSideA = h.responses[0];
    expect(serverSideA).toBeDefined();
    (serverSideA as http.ServerResponse).write = (() => {
      throw new Error('SECRET-WRITE-FAILURE');
    }) as never;

    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await b.waitFor(() => b.updates.length === 1, 'the update on the healthy client');
    await a.closed();
    expect(h.hub.clientCount()).toBe(1);
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    await b.waitFor(() => b.updates.length === 2, 'the next update on the healthy client');
    expect(h.logs.join('\n')).not.toContain('SECRET-WRITE-FAILURE');
    expect(h.logs.every((l) => l.length < 100)).toBe(true);
  });

  it('drops a client whose response emits an error', async () => {
    const h = await harness();
    const a = await connect(h);
    const b = await connect(h);
    h.responses[0]?.emit('error', new Error('socket exploded'));
    await a.closed();
    expect(h.hub.clientCount()).toBe(1);
    await post(h, { hook: 'UserPromptSubmit' });
    await b.waitFor(() => b.updates.length === 1, 'the update');
    expect(h.logs.join('\n')).not.toContain('socket exploded');
  });

  it('drops a client whose write buffer exceeds 1 MB (plus its snapshot) and keeps the others', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const slow = await connect(h);
    const fast = await connect(h);
    const snapshotBytes = Buffer.byteLength(slow.body);
    h.buffered.set(0, 1024 * 1024 + snapshotBytes + 1);

    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await fast.waitFor(() => fast.updates.length === 1, 'the update on the fast client');
    await slow.closed();
    expect(h.hub.clientCount()).toBe(1);
  });

  it('keeps a client whose buffer is exactly at the limit plus its snapshot', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    h.buffered.set(0, 1024 * 1024 + Buffer.byteLength(c.body));
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the update');
    expect(h.hub.clientCount()).toBe(1);
  });

  it('does not drop a client for the size of its own snapshot, however small the limit, and still applies the limit to updates', async () => {
    const h = await harness({ maxBufferedBytes: 50 });
    for (let i = 0; i < 6; i++) await post(h, { hook: 'UserPromptSubmit', session: `s${i}` });
    const probe = await Sse.open(h.port, { headers: bearer(h.token) });
    await probe.waitFor(() => probe.ofType('snapshot').length === 1, 'the probe snapshot');
    const snapshotBytes = Buffer.byteLength(probe.body);
    expect(snapshotBytes).toBeGreaterThan(50 * 4);
    probe.close();
    await until(() => h.hub.clientCount() === 0, 'the probe to be released');

    // Everything of the snapshot still pending: bigger than the limit, within limit + snapshot.
    h.buffered.set(1, snapshotBytes);
    const c = await Sse.open(h.port, { headers: bearer(h.token) });
    await c.waitFor(() => c.ofType('snapshot').length === 1, 'the snapshot');
    const healthy = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the update after the snapshot');
    expect(h.hub.clientCount()).toBe(2);

    // Exactly at the allowance is kept; one byte more is dropped.
    h.buffered.set(1, 50 + snapshotBytes);
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    await c.waitFor(() => c.updates.length === 2, 'the update at the allowance');
    expect(h.hub.clientCount()).toBe(2);
    h.buffered.set(1, 50 + snapshotBytes + 1);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.closed();
    expect(h.hub.clientCount()).toBe(1);
    await healthy.waitFor(() => healthy.updates.length === 3, 'the healthy client keeps receiving');
  });

  it('dispose ends every client and unsubscribes from the bus', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const a = await connect(h);
    const b = await connect(h);
    expect(h.bus.listenerCount('agentChanged')).toBe(1);

    h.hub.dispose();
    await a.closed();
    await b.closed();
    expect(h.hub.clientCount()).toBe(0);
    expect(h.bus.listenerCount('agentChanged')).toBe(0);
    expect(h.bus.listenerCount('sessionEnded')).toBe(0);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    expect(a.updates).toHaveLength(0);
  });

  it('server close ends the clients and leaves no bus listeners (wiring in startServer)', async () => {
    const logs: string[] = [];
    const { token, db } = openFor(makeHome(), logs);
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m) });
    // Registered so the listeners close even if an assertion fails before the inline close below.
    closers.push(async () => {
      try {
        await server.close();
      } catch {
        // already closed by the test body
      }
    });
    const c = await Sse.open(server.port, { headers: bearer(token) });
    expect(c.status).toBe(200);
    await c.waitFor(() => c.ofType('snapshot').length === 1, 'the snapshot');

    await server.close();
    await c.closed();
    expect(server.bus.listenerCount('agentChanged')).toBe(0);
    expect(server.bus.listenerCount('sessionEnded')).toBe(0);
    expect(logs).toEqual([]);
  });

});

describe('GET /stream: access control and failures', () => {
  it('returns 401 and streams nothing without a token or cookie, or with a wrong one (AC-32)', async () => {
    const h = await harness();
    for (const headers of [{}, bearer('0'.repeat(64)), { authorization: 'Bearer nope' }]) {
      const c = await Sse.open(h.port, { headers });
      await c.closed();
      expect(c.status).toBe(401);
      expect(c.json).toEqual({ error: 'unauthorized' });
      expect(c.headers['content-type']).toContain('application/json');
      expect(c.messages).toEqual([]);
    }
    expect(h.hub.clientCount()).toBe(0);
    expect(h.logs).toEqual(['Refused GET stream 401', 'Refused GET stream 401', 'Refused GET stream 401']);
  });

  it('does not accept the token in the query string', async () => {
    const h = await harness();
    const c = await Sse.open(h.port, { path: `/stream?token=${h.token}` });
    await c.closed();
    expect(c.status).toBe(401);
    expect(h.logs.join('\n')).not.toContain(h.token);
  });

  it('grants access to the pairing cookie obtained from POST /pair', async () => {
    const h = await harness();
    const paired = await request(h.port, {
      method: 'POST',
      path: '/pair',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: h.token }),
    });
    expect(paired.status).toBe(204);
    const cookie = String(paired.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^ao_session=/);
    const c = await connect(h, { cookie });
    expect(c.snapshot()).toEqual([]);
  });

  it('returns 403 forbidden for a foreign Host or the Origin of another site', async () => {
    const h = await harness();
    const foreignHost = await Sse.open(h.port, { headers: { ...bearer(h.token), host: 'evil.example' } });
    await foreignHost.closed();
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.json).toEqual({ error: 'forbidden' });

    const foreignOrigin = await Sse.open(h.port, { headers: { ...bearer(h.token), origin: 'http://evil.example' } });
    await foreignOrigin.closed();
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.json).toEqual({ error: 'forbidden' });
    expect(foreignOrigin.messages).toEqual([]);
    expect(h.hub.clientCount()).toBe(0);
    expect(h.logs).toEqual(['Refused GET stream 403', 'Refused GET stream 403']);
  });

  it('accepts the server own origin and sends no CORS headers', async () => {
    const h = await harness();
    const c = await connect(h, { ...bearer(h.token), origin: `http://127.0.0.1:${h.port}` });
    expect(Object.keys(c.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('returns 503 database_unavailable when the snapshot cannot be built, and recovers afterwards', async () => {
    const h = await harness();
    h.down.value = true;
    const c = await Sse.open(h.port, { headers: bearer(h.token) });
    await c.closed();
    expect(c.status).toBe(503);
    expect(c.json).toEqual({ error: 'database_unavailable' });
    expect(c.headers['content-type']).toContain('application/json');
    expect(h.hub.clientCount()).toBe(0);
    expect(h.logs).toEqual(['Refused GET stream 503']);

    h.down.value = false;
    const again = await connect(h);
    expect(again.status).toBe(200);
  });

  it('answers a generic 500 when building the snapshot fails for another reason', async () => {
    const h = await harness();
    h.down.error = new Error('SECRET-INTERNAL-DETAIL');
    h.down.value = true;
    const c = await Sse.open(h.port, { headers: bearer(h.token) });
    await c.closed();
    expect(c.status).toBe(500);
    expect(c.json).toEqual({ error: 'internal_error' });
    expect(c.body).not.toContain('SECRET-INTERNAL-DETAIL');
    expect(h.logs).toEqual(['Refused GET stream 500']);
  });

  it('skips an update, with a generic line, when the database fails while broadcasting', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    const getAgent = vi.spyOn(h.db, 'getAgent').mockImplementation(() => {
      throw new DbUnavailableError();
    });
    h.bus.emit('agentChanged', { session: 's1', agentKey: 'boss' });
    getAgent.mockImplementation(() => {
      throw new Error('SECRET-QUERY-DETAIL');
    });
    h.bus.emit('agentChanged', { session: 's1', agentKey: 'boss' });
    getAgent.mockRestore();
    expect(h.logs).toHaveLength(2);
    expect(h.logs.join('\n')).not.toContain('SECRET');
    expect(c.updates).toHaveLength(0);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the update after the failures');
  });

  it('mounts the route before the 404 catch-all, answers HEAD and unknown paths with the fixed 404', async () => {
    const h = await harness();
    const ok = await connect(h);
    expect(ok.status).toBe(200);
    const unknown = await request(h.port, { path: '/nope', headers: bearer(h.token) });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'not_found' });
    const head = await request(h.port, { method: 'HEAD', path: '/stream', headers: bearer(h.token) });
    expect(head.status).toBe(404);
    expect(h.hub.clientCount()).toBe(1);
  });

  it('leaves /stream unmounted (fixed 404) when createApp has no hub', async () => {
    const h = await harness({ noStream: true });
    const res = await request(h.port, { path: '/stream', headers: bearer(h.token) });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });

  it('logs nothing for a 200 stream, including when the client aborts', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    const c = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await c.waitFor(() => c.updates.length === 1, 'the update');
    c.close();
    await until(() => h.hub.clientCount() === 0, 'the client to be released');
    await post(h, { hook: 'PreToolUse', tool: 'Bash' });
    expect(h.logs).toEqual([]);
  });

  it('logs a fixed line and destroys the response when a handler fails after the headers were sent', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness({
      stream: () => ({
        handler: ((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: snapshot\ndata: {"agents":[]}\n\n');
          throw new Error('SECRET-LATE-FAILURE');
        }) as RequestHandler,
        clientCount: () => 0,
        trackedAgents: () => 0,
        dispose: () => {},
      }),
    });
    // The destroy may beat the first bytes to the client, so the request can end in a reset.
    await Sse.open(h.port, { headers: bearer(h.token) }).catch(() => undefined);
    await until(() => h.logs.length > 0, 'the failure line');
    expect(h.logs).toEqual(['Response failed after headers were sent']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('never streams the user, file paths, the transcript path or other event content', async () => {
    const h = await harness();
    const markers = ['USERMARK', '/FILEMARK/secret.ts', 'NOTIFMARK', '/TRANSMARK/t.jsonl', 'TOOLMARK'];
    const content = { user: 'USERMARK', file: '/FILEMARK/secret.ts', transcript: '/TRANSMARK/t.jsonl' };
    await post(h, { hook: 'UserPromptSubmit', ...content });
    const c = await connect(h);
    await post(h, { hook: 'PreToolUse', tool: 'TOOLMARK', ...content });
    await post(h, { hook: 'Notification', notification: 'NOTIFMARK', ...content });
    await post(h, { hook: 'PostToolUse', tool: 'Edit', ...content });
    await post(h, { hook: 'Stop', ...content });
    await c.waitFor(() => c.updates.length >= 3, 'the updates');
    for (const m of markers) expect(c.body).not.toContain(m);
    const keys = Object.keys(c.update(0)).sort();
    expect(keys).toEqual(['agent_key', 'is_boss', 'name', 'project', 'session', 'session_ended_at', 'stage', 'task']);
  });
});

describe('GET /stream: session end, ordering and realism (correction round)', () => {
  it('sends the session end time even when every agent event of the SessionEnd is stale', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit', ts: 5000 });
    await post(h, { hook: 'PreToolUse', tool: 'Read', agent_id: 'a1', agent: 'reviewer', ts: 5001 });
    const a = await connect(h);
    const b = await connect(h);
    // Older than every agent's last_ts: ingest applies it as stale, emits no agentChanged, but ends the session.
    await post(h, { hook: 'SessionEnd', ts: 100 });
    for (const c of [a, b]) {
      await until(() => c.updates.length >= 2, 'one update per agent of the ended session');
      await sleep(60);
      expect(c.updates).toHaveLength(2);
      expect([c.update(0), c.update(1)].map((e) => [e.agent_key, e.session_ended_at])).toEqual([
        ['a1', 100],
        ['boss', 100],
      ]);
    }
    expect(h.hub.trackedAgents()).toBe(0);
  });

  it('does not duplicate updates for a normal SessionEnd', async () => {
    const h = await harness();
    await post(h, { hook: 'UserPromptSubmit' });
    await post(h, { hook: 'PreToolUse', tool: 'Read', agent_id: 'a1', agent: 'reviewer' });
    const c = await connect(h);
    await post(h, { hook: 'SessionEnd' });
    await until(() => c.updates.length >= 2, 'the final updates');
    await sleep(80);
    expect(c.updates).toHaveLength(2);
    expect(c.updates.map((m) => (JSON.parse(m.data ?? '{}') as Entry).session_ended_at).every((t) => t !== null)).toBe(true);
    expect(h.hub.trackedAgents()).toBe(0);
  });

  it('shows the first update of an agent with the incomplete flag the tracker wrote before the hub read it', async () => {
    const logs: string[] = [];
    const home = makeHome();
    const { token, db } = openFor(home, logs);
    // A task already open before this server starts: the tracker flags it incomplete on discovery
    // and does not announce that flag again, so the hub must read it after the tracker wrote it.
    db.upsertSession({ id: 's1', user: 'alice', project: 'proj', transcript: null, started_at: 1000, ended_at: null });
    db.upsertAgent({ session: 's1', agent_key: 'boss', name: 'boss', is_boss: 1, stage: 'Thinking', last_ts: 1000 });
    db.openTask('s1', 'boss', 1000);
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m) });
    closers.push(() => server.close());
    const h = { port: server.port, token, nextTs: () => 2000 } as Harness;

    const c = await connect(h);
    expect(c.snapshot()[0]?.task?.tokens.incomplete).toBe(false);
    await post(h, { hook: 'PreToolUse', tool: 'Read' });
    await until(() => c.updates.length >= 1, 'the first update');
    expect(c.update(0)).toMatchObject({ stage: 'Reading', task: { tokens: { incomplete: true } } });
  });

  it('keeps the p95 below 300 ms with the token tracker active and a real transcript (NFR-01)', async () => {
    const logs: string[] = [];
    const home = makeHome();
    const { token, db } = openFor(home, logs);
    const projects = path.join(home, 'projects');
    fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
    const transcript = path.join(projects, 'proj', 's1.jsonl');
    fs.writeFileSync(transcript, '');
    const server = await startServer({ token, db, port: 0, log: (m) => logs.push(m), projectsDir: projects });
    closers.push(() => server.close());
    let t = Date.now() + 1000;
    const h = { port: server.port, token, nextTs: () => ++t } as Harness;

    await post(h, { hook: 'UserPromptSubmit', transcript });
    const c = await connect(h);
    const latencies: number[] = [];
    let ptr = 0;
    for (let i = 0; i < 200; i++) {
      const pre = i % 2 === 0;
      const expected = pre ? (i % 4 === 0 ? 'Reading' : 'Running') : 'Thinking';
      if (!pre) {
        fs.appendFileSync(
          transcript,
          JSON.stringify({
            type: 'assistant',
            message: { id: `m${i}`, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
          }) + '\n',
        );
      }
      const t0 = performance.now();
      await post(
        h,
        pre
          ? { hook: 'PreToolUse', tool: expected === 'Reading' ? 'Read' : 'Bash', transcript }
          : { hook: 'PostToolUse', tool: 'Bash', transcript },
      );
      const found = (): number => c.updates.findIndex((m, k) => k >= ptr && (JSON.parse(m.data ?? '{}') as Entry).stage === expected);
      await c.waitFor(() => found() !== -1, `the ${expected} update of event ${i + 1}`);
      const k = found();
      latencies.push((c.updates[k]?.at ?? Infinity) - t0);
      ptr = k + 1;
    }
    latencies.sort((x, y) => x - y);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? Infinity;
    console.info(`NFR-01 (tracker active) observed p95 ${p95.toFixed(2)} ms over ${latencies.length} events`);
    expect(latencies).toHaveLength(200);
    expect(p95).toBeLessThan(300);
    // The tracker really ran: the counters of the 100 reads reached the stream (2 tokens per line).
    await until(
      () => c.updates.some((m) => (JSON.parse(m.data ?? '{}') as Entry).task?.tokens.total === 200),
      'the counters of all 100 reads',
    );
  }, 60_000);

  it('answers the POST fast and sends the stage update before the counters when a large transcript delta is pending', async () => {
    const logs: string[] = [];
    const home = makeHome();
    const { token, db } = openFor(home, logs);
    const projects = path.join(home, 'projects');
    fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
    const transcript = path.join(projects, 'proj', 's1.jsonl');
    fs.writeFileSync(transcript, '');
    // The test client shares this process's event loop, so it cannot see the order of the two by itself:
    // the order is observed on the server side, at the moment the 202 is ended and the counters are stored.
    const order: string[] = [];
    const originalEnd = http.ServerResponse.prototype.end;
    vi.spyOn(http.ServerResponse.prototype, 'end').mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
      if (this.statusCode === 202) order.push('response');
      return (originalEnd as (...a: unknown[]) => http.ServerResponse).apply(this, args);
    } as never);
    const ordered = new Proxy(db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop === 'addTokens') order.push('counters');
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const server = await startServer({ token, db: ordered, port: 0, log: (m) => logs.push(m), projectsDir: projects });
    closers.push(() => server.close());
    let t = Date.now() + 1000;
    const h = { port: server.port, token, nextTs: () => ++t } as Harness;
    await post(h, { hook: 'UserPromptSubmit', transcript });
    const c = await connect(h);
    order.length = 0;

    // About 5 MB of usage lines, numbers only.
    const one =
      JSON.stringify({
        type: 'assistant',
        message: { id: 'mXXXXXX', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } },
      }) + '\n';
    const lines = Math.ceil((5 * 1024 * 1024) / one.length);
    const parts: string[] = [];
    for (let n = 0; n < lines; n++) parts.push(one.replace('mXXXXXX', `m${n}`));
    const text = parts.join('');
    fs.appendFileSync(transcript, text);
    expect(Buffer.byteLength(text)).toBeGreaterThan(4.5 * 1024 * 1024);

    // No absolute time assertion on purpose: client and server share this event loop, so the
    // elapsed time here cannot prove that the response preceded the read. The proof is the
    // server-side order asserted below ('response' before 'counters').
    await post(h, { hook: 'Stop', transcript });

    await until(() => c.updates.length >= 2, 'the stage update and the counter update', 10_000);
    expect(c.update(0)).toMatchObject({ stage: 'Done', task: { tokens: { total: 0 } } });
    expect(c.update(1).task?.tokens.total).toBe(lines * 4);
    // The 202 was ended before the transcript was read and the counters stored.
    expect(order.slice(0, 2)).toEqual(['response', 'counters']);
  }, 30_000);

  it('never touches the database after close(), even with a read scheduled just before', async () => {
    const logs: string[] = [];
    const home = makeHome();
    const { token, db } = openFor(home, logs);
    const projects = path.join(home, 'projects');
    fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
    const transcript = path.join(projects, 'proj', 's1.jsonl');
    fs.writeFileSync(transcript, '');
    let closed = false;
    const after: string[] = [];
    const guarded = new Proxy(db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (closed) after.push(String(prop));
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (prop === 'close') closed = true;
          return result;
        };
      },
    });
    const server = await startServer({ token, db: guarded, port: 0, log: (m) => logs.push(m), projectsDir: projects });
    // Registered so the listeners close even if an assertion fails before the inline close below.
    closers.push(async () => {
      try {
        await server.close();
      } catch {
        // already closed by the test body
      }
    });
    const ts = Date.now() + 1000;
    const h = { port: server.port, token, nextTs: () => ts } as Harness;
    await post(h, { hook: 'UserPromptSubmit', transcript, ts });
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n',
    );
    const taskId = db.getOpenTask('s1', 'boss')?.id ?? null;
    server.bus.emit('toolFinished', { session: 's1', agentKey: 'boss', taskId });
    await server.close();
    await sleep(50);
    expect(after).toEqual([]);
    expect(logs).toEqual([]);
  });
});

// ---------------------------------------------------------------- fakes for the timer test

function stubDb(): Db {
  return {
    listAgents: () => [],
    getAgent: () => undefined,
    getSession: () => undefined,
    getLatestTask: () => undefined,
  } as unknown as Db;
}

function fakeReq(): never {
  return Object.assign(new EventEmitter(), { method: 'GET' }) as never;
}

function fakeRes(): EventEmitter & { writes: string[]; writableLength: number } {
  const ee = new EventEmitter();
  const writes: string[] = [];
  return Object.assign(ee, {
    writes,
    writableLength: 0,
    statusCode: 200,
    writeHead(): void {},
    flushHeaders(): void {},
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    end(): void {
      ee.emit('close');
    },
    destroy(): void {
      ee.emit('close');
    },
  });
}
