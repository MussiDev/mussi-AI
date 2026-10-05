import type { RequestHandler, Response } from 'express';
import type { AgentRef, Bus } from './bus.js';
import { DbUnavailableError, type AgentRow, type Db, type SessionRow, type TaskRow } from './db.js';

// Live stream of agent state over Server-Sent Events. No SQL here (only the Db API) and nothing from
// an event besides the agent state is ever sent: no user, file path, transcript path or event text.
// Diagnostics go through the injected logger as fixed generic lines.

export interface StreamHubOptions {
  db: Db;
  bus: Bus;
  /** Runtime diagnostics. Messages are generic and never carry request or event content. */
  log?: (msg: string) => void;
  /** Interval of the keepalive comment. Defaults to 15 seconds; tests lower it. */
  keepaliveMs?: number;
  /** A client whose pending write buffer exceeds this many bytes is dropped. Defaults to 1 MB. */
  maxBufferedBytes?: number;
  /** Upper bound of the last-sent entries remembered for no-op suppression. Defaults to 10 000. */
  maxTrackedAgents?: number;
}

export interface StreamHub {
  /** Mount behind the auth middleware: it sends the snapshot and registers the client. */
  handler: RequestHandler;
  clientCount(): number;
  /** Diagnostic for tests: how many last-sent entries the hub is holding. */
  trackedAgents(): number;
  /** Unsubscribes from the bus, stops the keepalive timer and ends every client. */
  dispose(): void;
}

export interface TokensView {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
  incomplete: boolean;
}

export interface AgentEntry {
  session: string;
  agent_key: string;
  name: string;
  is_boss: boolean;
  stage: string;
  project: string;
  session_ended_at: number | null;
  task: { id: number; started_at: number; ended_at: number | null; tokens: TokensView } | null;
}

const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_MAX_BUFFERED = 1024 * 1024;
const DEFAULT_MAX_TRACKED = 10_000;

function taskView(t: TaskRow): NonNullable<AgentEntry['task']> {
  return {
    id: t.id,
    started_at: t.started_at,
    ended_at: t.ended_at,
    tokens: {
      input: t.tokens_input,
      output: t.tokens_output,
      cache_creation: t.tokens_cache_creation,
      cache_read: t.tokens_cache_read,
      total: t.tokens_input + t.tokens_output + t.tokens_cache_creation + t.tokens_cache_read,
      incomplete: t.tokens_incomplete === 1,
    },
  };
}

function entryFor(agent: AgentRow, session: SessionRow | undefined, task: TaskRow | undefined): AgentEntry {
  return {
    session: agent.session,
    agent_key: agent.agent_key,
    name: agent.name,
    is_boss: agent.is_boss === 1,
    stage: agent.stage,
    project: session?.project ?? '',
    session_ended_at: session?.ended_at ?? null,
    task: task === undefined ? null : taskView(task),
  };
}

function message(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function createStreamHub(opts: StreamHubOptions): StreamHub {
  const { db, bus } = opts;
  const log = opts.log ?? (() => {});
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
  const maxTracked = opts.maxTrackedAgents ?? DEFAULT_MAX_TRACKED;

  // Every connected client with its own buffer allowance: maxBufferedBytes plus the size of the snapshot it
  // was just sent. The snapshot is the whole stored history (listAgents has no retention yet), so it can be
  // large by itself and must not count against the slow-client rule; updates beyond it do.
  // TODO(FEAT-001b): the 3D office should filter by session_ended_at, or a retention ticket should prune.
  const clients = new Map<Response, number>();
  let timer: NodeJS.Timeout | null = null;

  // Last serialized entry sent, per session then agent. Lets a no-op agentChanged pass unnoticed.
  const lastSent = new Map<string, Map<string, string>>();
  let tracked = 0;

  function remember(session: string, agentKey: string, data: string): void {
    let agents = lastSent.get(session);
    if (agents === undefined) {
      agents = new Map();
      lastSent.set(session, agents);
    }
    if (!agents.has(agentKey)) tracked += 1;
    agents.set(agentKey, data);
    // Past the bound the oldest session's entries go first. Worst case: one repeated update later.
    while (tracked > maxTracked) {
      const oldest = lastSent.keys().next().value as string;
      release(oldest);
    }
  }

  function release(session: string): void {
    const agents = lastSent.get(session);
    if (agents === undefined) return;
    tracked -= agents.size;
    lastSent.delete(session);
  }

  function entryOf(agent: AgentRow, sessions: Map<string, SessionRow | undefined>): AgentEntry {
    if (!sessions.has(agent.session)) sessions.set(agent.session, db.getSession(agent.session));
    return entryFor(agent, sessions.get(agent.session), db.getLatestTask(agent.session, agent.agent_key));
  }

  function drop(res: Response): void {
    if (!clients.delete(res)) return;
    stopTimerIfIdle();
    try {
      res.end();
    } catch {
      // The socket is already gone.
    }
    res.destroy();
  }

  /** Writes to one client; a throw or an oversized buffer drops it without touching the others. */
  function write(res: Response, chunk: string): void {
    try {
      res.write(chunk);
      if (res.writableLength > (clients.get(res) ?? maxBuffered)) {
        log('Stream client dropped: too slow');
        drop(res);
      }
    } catch {
      log('Stream client dropped: write failed');
      drop(res);
    }
  }

  function broadcast(chunk: string): void {
    for (const res of [...clients.keys()]) write(res, chunk);
  }

  function startTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => broadcast(': keepalive\n\n'), keepaliveMs);
    timer.unref();
  }

  function stopTimerIfIdle(): void {
    if (clients.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  const handler: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET') {
      // HEAD would otherwise register a client that can never read; fall through to the fixed 404.
      next();
      return;
    }
    let agents: AgentEntry[];
    try {
      const sessions = new Map<string, SessionRow | undefined>();
      agents = db.listAgents().map((a) => entryOf(a, sessions));
    } catch (e) {
      if (e instanceof DbUnavailableError) {
        res.status(503).json({ error: 'database_unavailable' });
        return;
      }
      throw e;
    }
    // What the snapshot shows is what this hub regards as sent, so a later no-op signal stays silent.
    // Safe: the snapshot is built synchronously, so no commit can sit between it and its notification.
    for (const a of agents) remember(a.session, a.agent_key, JSON.stringify(a));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const snapshot = message('snapshot', JSON.stringify({ agents }));
    clients.set(res, maxBuffered + Buffer.byteLength(snapshot));
    res.on('error', () => {
      log('Stream client dropped: connection error');
      drop(res);
    });
    res.on('close', () => drop(res));
    startTimer();
    write(res, snapshot);
  };

  const onStreamAgentChanged = (ref: AgentRef): void => {
    if (clients.size === 0) return;
    try {
      const agent = db.getAgent(ref.session, ref.agentKey);
      if (agent === undefined) return;
      const entry = entryOf(agent, new Map());
      const data = JSON.stringify(entry);
      if (lastSent.get(entry.session)?.get(entry.agent_key) === data) return;
      remember(entry.session, entry.agent_key, data);
      broadcast(message('update', data));
    } catch (e) {
      log(e instanceof DbUnavailableError ? 'Stream update skipped: database unavailable' : 'Stream update failed');
    }
  };

  // A SessionEnd whose agent events are all stale emits no agentChanged, so the end time would never reach
  // the clients. Rebuild the session's entries first (the normal suppression drops what was already sent),
  // and only then release what is held for the session.
  const onStreamSessionEnded = (p: { session: string }): void => {
    try {
      if (clients.size > 0) {
        const sessions = new Map<string, SessionRow | undefined>();
        for (const agent of db.listAgents()) {
          if (agent.session !== p.session) continue;
          const entry = entryOf(agent, sessions);
          const data = JSON.stringify(entry);
          if (lastSent.get(entry.session)?.get(entry.agent_key) === data) continue;
          remember(entry.session, entry.agent_key, data);
          broadcast(message('update', data));
        }
      }
    } catch (e) {
      log(e instanceof DbUnavailableError ? 'Stream update skipped: database unavailable' : 'Stream update failed');
    } finally {
      release(p.session);
    }
  };

  bus.on('agentChanged', onStreamAgentChanged);
  bus.on('sessionEnded', onStreamSessionEnded);

  return {
    handler,
    clientCount: () => clients.size,
    trackedAgents: () => tracked,
    dispose(): void {
      bus.off('agentChanged', onStreamAgentChanged);
      bus.off('sessionEnded', onStreamSessionEnded);
      for (const res of [...clients.keys()]) {
        clients.delete(res);
        try {
          res.end();
        } catch {
          // Already closed.
        }
      }
      stopTimerIfIdle();
    },
  };
}
