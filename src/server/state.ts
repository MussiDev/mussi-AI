import type { HookName, OfficeEvent, Stage } from '../shared/events.js';

export interface AgentState {
  session: string;
  agentKey: string;
  name: string;
  isBoss: boolean;
  stage: Stage;
  lastTs: number;
  hasOpenTask: boolean;
}

export type TaskChange =
  | { kind: 'none' }
  | { kind: 'open'; startedAt: number }
  | { kind: 'close'; endedAt: number };

export interface ApplyResult {
  agent: AgentState;
  taskChange: TaskChange;
  stale: boolean;
  registered: boolean;
}

const READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);
const EDITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

function preToolStage(tool: string | null | undefined): Stage {
  if (tool !== null && tool !== undefined) {
    if (READING_TOOLS.has(tool)) return 'Reading';
    if (EDITING_TOOLS.has(tool)) return 'Editing';
  }
  return 'Running';
}

/** Stage the event moves the agent to, or undefined when the hook carries no stage meaning. */
function stageFor(event: OfficeEvent): Stage | undefined {
  switch (event.hook) {
    case 'PreToolUse':
      return preToolStage(event.tool);
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'UserPromptSubmit':
      return 'Thinking';
    case 'PermissionRequest':
      return 'Waiting';
    case 'Notification':
      return event.notification === 'permission_prompt' ? 'Waiting' : undefined;
    case 'Stop':
    case 'SubagentStop':
    case 'SessionEnd':
      return 'Done';
    default:
      return undefined;
  }
}

// Exhaustive over HookName: adding a hook in shared/events.ts is a compile error until it is listed here.
const SUPPORTED: Readonly<Record<HookName, true>> = {
  SessionStart: true,
  UserPromptSubmit: true,
  PreToolUse: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  PermissionRequest: true,
  Notification: true,
  SubagentStart: true,
  SubagentStop: true,
  Stop: true,
  SessionEnd: true,
};

/**
 * Pure state transition for one event. Never mutates its inputs.
 * `agent` is undefined for an agent not seen before.
 */
export function applyEvent(agent: AgentState | undefined, event: OfficeEvent): ApplyResult {
  const registered = agent === undefined;
  const current: AgentState = agent ?? {
    session: event.session,
    agentKey: event.agent_id ?? 'boss',
    name: event.agent,
    isBoss: event.agent_id === null,
    stage: 'Thinking',
    lastTs: event.ts,
    hasOpenTask: false,
  };

  if (!Object.hasOwn(SUPPORTED, event.hook)) {
    return { agent: { ...current }, taskChange: { kind: 'none' }, stale: false, registered };
  }

  if (event.ts < current.lastTs) {
    return { agent: { ...current }, taskChange: { kind: 'none' }, stale: true, registered: false };
  }

  const next = stageFor(event);
  const stage = next ?? current.stage;
  let taskChange: TaskChange = { kind: 'none' };
  if (next === 'Done') {
    if (current.hasOpenTask) taskChange = { kind: 'close', endedAt: event.ts };
  } else if (next !== undefined && !current.hasOpenTask) {
    // Only an event that starts work (it has a non-Done stage meaning) opens a task.
    taskChange = { kind: 'open', startedAt: event.ts };
  }

  const hasOpenTask =
    taskChange.kind === 'open' ? true : taskChange.kind === 'close' ? false : current.hasOpenTask;
  return {
    agent: { ...current, stage, lastTs: event.ts, hasOpenTask },
    taskChange,
    stale: false,
    registered,
  };
}
