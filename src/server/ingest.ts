import type { OfficeEvent } from '../shared/events.js';
import { parseEvent } from '../shared/events.js';
import type { Bus } from './bus.js';
import type { AgentRow, Db, TaskRow } from './db.js';
import { applyEvent, type AgentState } from './state.js';

export type IngestResult = { ok: true } | { ok: false; field: string };

interface Applied {
  agentKey: string;
  stale: boolean;
}

function toState(row: AgentRow, open: TaskRow | undefined): AgentState {
  return {
    session: row.session,
    agentKey: row.agent_key,
    name: row.name,
    isBoss: row.is_boss === 1,
    stage: row.stage,
    lastTs: row.last_ts,
    hasOpenTask: open !== undefined,
  };
}

/** Applies the event to one agent and persists the result. Returns the task the event belongs to. */
function applyToAgent(db: Db, event: OfficeEvent, agentKey: string): { applied: Applied; taskId: number | null } {
  const row = db.getAgent(event.session, agentKey);
  const open = db.getOpenTask(event.session, agentKey);
  const result = applyEvent(row ? toState(row, open) : undefined, event);
  const { agent, taskChange } = result;

  db.upsertAgent({
    session: agent.session,
    agent_key: agent.agentKey,
    name: agent.name,
    is_boss: agent.isBoss ? 1 : 0,
    stage: agent.stage,
    last_ts: agent.lastTs,
  });

  let taskId = open?.id ?? null;
  if (taskChange.kind === 'open') {
    taskId = db.openTask(agent.session, agent.agentKey, taskChange.startedAt);
  } else if (taskChange.kind === 'close' && taskId !== null) {
    db.closeTask(taskId, taskChange.endedAt);
  }
  return { applied: { agentKey, stale: result.stale }, taskId };
}

/** One transaction: session, agent state, task change and the event row. Returns who changed. */
function store(db: Db, event: OfficeEvent): Applied[] {
  db.upsertSession({
    id: event.session,
    user: event.user,
    project: event.project,
    transcript: event.transcript ?? null,
    started_at: event.ts,
    ended_at: null,
  });

  const ownKey = event.agent_id ?? 'boss';
  // SessionEnd reaches every agent of the session, not only the one that sent it.
  const keys =
    event.hook === 'SessionEnd'
      ? [...new Set([ownKey, ...db.listAgents().filter((a) => a.session === event.session).map((a) => a.agent_key)])]
      : [ownKey];

  const applied: Applied[] = [];
  let ownTaskId: number | null = null;
  for (const key of keys) {
    const outcome = applyToAgent(db, event, key);
    applied.push(outcome.applied);
    if (key === ownKey) ownTaskId = outcome.taskId;
  }

  // Only the allowed columns are stored, so prompt text, code and file contents never reach the database.
  db.insertEvent({
    task_id: ownTaskId,
    ts: event.ts,
    hook: event.hook,
    user: event.user,
    project: event.project,
    session: event.session,
    agent_key: ownKey,
    agent_name: event.agent,
    tool: event.tool ?? null,
    file: event.file ?? null,
    notification: event.notification ?? null,
  });

  if (event.hook === 'SessionEnd') db.endSession(event.session, event.ts);
  return applied;
}

function announce(bus: Bus, event: OfficeEvent, applied: Applied[]): void {
  const ownKey = event.agent_id ?? 'boss';
  const session = event.session;
  for (const a of applied) {
    if (!a.stale) bus.emit('agentChanged', { session, agentKey: a.agentKey });
  }
  switch (event.hook) {
    case 'PostToolUse':
    case 'PostToolUseFailure':
      bus.emit('toolFinished', { session, agentKey: ownKey });
      break;
    case 'Stop':
    case 'SubagentStop':
      bus.emit('agentStopped', { session, agentKey: ownKey });
      break;
    case 'SessionEnd':
      bus.emit('sessionEnded', { session });
      break;
    default:
      break;
  }
}

/**
 * Validates, stores and announces one event. Throws DbUnavailableError when the database is down
 * and rethrows any other storage error; in both cases nothing was stored and nothing was emitted.
 */
export function ingestEvent(db: Db, bus: Bus, input: unknown): IngestResult {
  const parsed = parseEvent(input);
  if (!parsed.ok) return { ok: false, field: parsed.field };
  const applied = db.transaction(() => store(db, parsed.event));
  announce(bus, parsed.event, applied);
  return { ok: true };
}
