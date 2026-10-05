import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HookName, OfficeEvent, Stage } from '../shared/events.js';
import { applyEvent, type AgentState } from './state.js';

function ev(overrides: Partial<OfficeEvent> = {}): OfficeEvent {
  return {
    v: 1,
    ts: 1000,
    hook: 'UserPromptSubmit',
    user: 'ana',
    project: 'proj',
    session: 's1',
    agent_id: null,
    agent: 'boss',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    session: 's1',
    agentKey: 'boss',
    name: 'boss',
    isBoss: true,
    stage: 'Thinking',
    lastTs: 1000,
    hasOpenTask: true,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const pre = (tool: string | null | undefined, ts = 2000) => ev({ hook: 'PreToolUse', tool, ts });

describe('PreToolUse mapping', () => {
  it.each(['Read', 'Grep', 'Glob'])('%s sets Reading (AC-09)', (tool) => {
    expect(applyEvent(agent(), pre(tool)).agent.stage).toBe('Reading');
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])('%s sets Editing (AC-10)', (tool) => {
    expect(applyEvent(agent(), pre(tool)).agent.stage).toBe('Editing');
  });

  it.each(['Bash', 'WebFetch', 'mcp__x__y', ''])('%s sets Running (AC-11)', (tool) => {
    expect(applyEvent(agent(), pre(tool)).agent.stage).toBe('Running');
  });

  it.each([null, undefined])('missing tool %s sets Running', (tool) => {
    expect(applyEvent(agent(), pre(tool)).agent.stage).toBe('Running');
  });
});

describe('stage mapping for other hooks', () => {
  it.each(['PostToolUse', 'PostToolUseFailure'] as const)('%s sets Thinking (AC-12)', (hook) => {
    const result = applyEvent(agent({ stage: 'Running' }), ev({ hook, ts: 2000 }));
    expect(result.agent.stage).toBe('Thinking');
  });

  it('PermissionRequest sets Waiting (AC-14)', () => {
    expect(applyEvent(agent(), ev({ hook: 'PermissionRequest', ts: 2000 })).agent.stage).toBe('Waiting');
  });

  it('permission_prompt notification sets Waiting (AC-14)', () => {
    const e = ev({ hook: 'Notification', notification: 'permission_prompt', ts: 2000 });
    expect(applyEvent(agent(), e).agent.stage).toBe('Waiting');
  });

  it.each(['idle_prompt', null, undefined])('notification %s changes no stage', (notification) => {
    const e = ev({ hook: 'Notification', notification, ts: 2000 });
    expect(applyEvent(agent({ stage: 'Editing' }), e).agent.stage).toBe('Editing');
  });

  it('Stop and SubagentStop set Done (AC-15)', () => {
    expect(applyEvent(agent(), ev({ hook: 'Stop', ts: 2000 })).agent.stage).toBe('Done');
    const sub = agent({ agentKey: 'a1', name: 'coder', isBoss: false });
    const e = ev({ hook: 'SubagentStop', agent_id: 'a1', agent: 'coder', ts: 2000 });
    expect(applyEvent(sub, e).agent.stage).toBe('Done');
  });

  it('SessionEnd sets Done', () => {
    expect(applyEvent(agent(), ev({ hook: 'SessionEnd', ts: 2000 })).agent.stage).toBe('Done');
  });

  it.each(['SessionStart', 'SubagentStart'] as const)('%s causes no stage change', (hook) => {
    const result = applyEvent(agent({ stage: 'Editing' }), ev({ hook, ts: 2000 }));
    expect(result.agent.stage).toBe('Editing');
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.stale).toBe(false);
  });
});

describe('full hook x tool table', () => {
  // Start stage always differs from the expected stage for transition rows; no-change rows start at Editing.
  const table: Array<[HookName, string | null, string | null, Stage, Stage]> = [
    ['UserPromptSubmit', null, null, 'Editing', 'Thinking'],
    ['PreToolUse', 'Read', null, 'Editing', 'Reading'],
    ['PreToolUse', 'Grep', null, 'Editing', 'Reading'],
    ['PreToolUse', 'Glob', null, 'Editing', 'Reading'],
    ['PreToolUse', 'Edit', null, 'Reading', 'Editing'],
    ['PreToolUse', 'Write', null, 'Reading', 'Editing'],
    ['PreToolUse', 'NotebookEdit', null, 'Reading', 'Editing'],
    ['PreToolUse', 'Bash', null, 'Editing', 'Running'],
    ['PreToolUse', 'Other', null, 'Editing', 'Running'],
    ['PreToolUse', null, null, 'Editing', 'Running'],
    ['PostToolUse', 'Read', null, 'Editing', 'Thinking'],
    ['PostToolUse', 'Bash', null, 'Editing', 'Thinking'],
    ['PostToolUseFailure', 'Edit', null, 'Editing', 'Thinking'],
    ['PermissionRequest', 'Bash', null, 'Editing', 'Waiting'],
    ['Notification', null, 'permission_prompt', 'Editing', 'Waiting'],
    ['Notification', null, 'other', 'Editing', 'Editing'],
    ['Stop', null, null, 'Editing', 'Done'],
    ['SubagentStop', null, null, 'Editing', 'Done'],
    ['SessionEnd', null, null, 'Editing', 'Done'],
    ['SessionStart', null, null, 'Editing', 'Editing'],
    ['SubagentStart', null, null, 'Editing', 'Editing'],
  ];

  it.each(table)('%s tool=%s notification=%s from %s -> %s', (hook, tool, notification, start, expected) => {
    const result = applyEvent(agent({ stage: start }), ev({ hook, tool, notification, ts: 2000 }));
    expect(result.agent.stage).toBe(expected);
  });
});

describe('registration', () => {
  it('registers an unknown agent and applies the event (AC-13)', () => {
    const e = ev({ hook: 'PreToolUse', tool: 'Read', ts: 500, agent_id: 'a9', agent: 'coder' });
    const result = applyEvent(undefined, e);
    expect(result.registered).toBe(true);
    expect(result.agent).toEqual({
      session: 's1',
      agentKey: 'a9',
      name: 'coder',
      isBoss: false,
      stage: 'Reading',
      lastTs: 500,
      hasOpenTask: true,
    });
  });

  it('registers the boss with key "boss" when agent_id is null', () => {
    const result = applyEvent(undefined, ev({ hook: 'UserPromptSubmit', ts: 500 }));
    expect(result.agent.agentKey).toBe('boss');
    expect(result.agent.isBoss).toBe(true);
    expect(result.agent.name).toBe('boss');
  });

  it('a known agent is not flagged as registered', () => {
    expect(applyEvent(agent(), ev({ ts: 2000 })).registered).toBe(false);
  });

  it.each(['Stop', 'SessionStart'] as const)('%s registers an unknown agent without a task', (hook) => {
    const result = applyEvent(undefined, ev({ hook, ts: 500 }));
    expect(result.registered).toBe(true);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
  });
});

describe('task lifecycle', () => {
  it('first event of an unknown agent opens a task at its ts (AC-19)', () => {
    const result = applyEvent(undefined, ev({ ts: 777 }));
    expect(result.taskChange).toEqual({ kind: 'open', startedAt: 777 });
    expect(result.agent.hasOpenTask).toBe(true);
  });

  it('the first event after Done opens a new task at its ts (AC-19)', () => {
    const done = agent({ stage: 'Done', hasOpenTask: false, lastTs: 1000 });
    const result = applyEvent(done, ev({ hook: 'UserPromptSubmit', ts: 3000 }));
    expect(result.taskChange).toEqual({ kind: 'open', startedAt: 3000 });
    expect(result.agent.hasOpenTask).toBe(true);
    expect(result.agent.stage).toBe('Thinking');
  });

  it('an event with an open task opens nothing', () => {
    const result = applyEvent(agent(), pre('Read'));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(true);
  });

  it('reaching Done closes the task with the event ts (AC-20)', () => {
    const result = applyEvent(agent(), ev({ hook: 'Stop', ts: 4000 }));
    expect(result.taskChange).toEqual({ kind: 'close', endedAt: 4000 });
    expect(result.agent.hasOpenTask).toBe(false);
  });

  it('SessionEnd closes an open task', () => {
    const result = applyEvent(agent(), ev({ hook: 'SessionEnd', ts: 4000 }));
    expect(result.taskChange).toEqual({ kind: 'close', endedAt: 4000 });
  });

  it('Done for an agent with no open task creates no task and does not throw', () => {
    const idle = agent({ stage: 'Done', hasOpenTask: false });
    const result = applyEvent(idle, ev({ hook: 'Stop', ts: 4000 }));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
    expect(result.agent.stage).toBe('Done');
  });

  it('SessionStart on a known agent without a task opens no task', () => {
    const idle = agent({ stage: 'Done', hasOpenTask: false });
    const result = applyEvent(idle, ev({ hook: 'SessionStart', ts: 4000 }));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.stage).toBe('Done');
  });
});

describe('ordering', () => {
  it('an older event is stale: stage unchanged, no task change, lastTs kept', () => {
    const current = agent({ stage: 'Editing', lastTs: 5000 });
    const result = applyEvent(current, pre('Read', 4000));
    expect(result.stale).toBe(true);
    expect(result.agent.stage).toBe('Editing');
    expect(result.agent.lastTs).toBe(5000);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.registered).toBe(false);
  });

  it('a stale Stop does not close the task', () => {
    const result = applyEvent(agent({ lastTs: 5000 }), ev({ hook: 'Stop', ts: 4000 }));
    expect(result.stale).toBe(true);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.stage).toBe('Thinking');
  });

  it('two events with the same ts are both applied', () => {
    const first = applyEvent(agent({ lastTs: 1000 }), pre('Read', 2000));
    const second = applyEvent(first.agent, pre('Edit', 2000));
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.agent.stage).toBe('Editing');
    expect(second.agent.lastTs).toBe(2000);
  });

  it('a newer event advances lastTs', () => {
    expect(applyEvent(agent(), pre('Read', 2500)).agent.lastTs).toBe(2500);
  });
});

describe('purity', () => {
  it('does not mutate deep-frozen inputs and returns without throwing', () => {
    const current = deepFreeze(agent());
    const event = deepFreeze(pre('Edit'));
    const currentCopy = structuredClone(current);
    const eventCopy = structuredClone(event);
    const result = applyEvent(current, event);
    expect(result.agent).not.toBe(current);
    expect(current).toEqual(currentCopy);
    expect(event).toEqual(eventCopy);
    const fresh = applyEvent(undefined, event);
    expect(fresh.agent.stage).toBe('Editing');
    expect(event).toEqual(eventCopy);
  });

  it('imports only the type import from ../shared/events.js', () => {
    const source = readFileSync(new URL('./state.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').map((line) => line.trimEnd()).filter((line) => /^\s*(import|export\s.*\sfrom)\s/.test(line));
    expect(imports).toEqual(["import type { HookName, OfficeEvent, Stage } from '../shared/events.js';"]);
    expect(source).not.toMatch(/require\(|import\(/);
  });
});

const doneAgent = (overrides: Partial<AgentState> = {}) =>
  agent({ stage: 'Done', hasOpenTask: false, lastTs: 100, ...overrides });
const NON_WORK = ['idle_prompt', 'auth_success', 'elicitation_dialog'];

describe('events that do not start work never open a task (AC-41)', () => {
  it.each(NON_WORK)('notification %s after Done opens nothing and keeps Done', (notification) => {
    const result = applyEvent(doneAgent(), ev({ hook: 'Notification', notification, ts: 500 }));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
    expect(result.agent.stage).toBe('Done');
  });

  it('SubagentStart after Done opens nothing', () => {
    const result = applyEvent(doneAgent(), ev({ hook: 'SubagentStart', ts: 500 }));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
  });

  it.each(['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'] as const)('%s after Done opens nothing', (hook) => {
    const result = applyEvent(doneAgent(), ev({ hook, ts: 500 }));
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
  });

  it.each([
    ['idle_prompt Notification', { hook: 'Notification', notification: 'idle_prompt' }],
    ['Notification without type', { hook: 'Notification' }],
    ['SessionStart', { hook: 'SessionStart' }],
    ['SubagentStart', { hook: 'SubagentStart' }],
  ] as const)('unknown agent first event %s registers with no task, stage Thinking', (_n, partial) => {
    const result = applyEvent(undefined, ev({ ...partial, ts: 500 }));
    expect(result.registered).toBe(true);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.agent.hasOpenTask).toBe(false);
    expect(result.agent.stage).toBe('Thinking');
  });

  it('trace: Stop closes, idle notification changes nothing, prompt opens at its own ts', () => {
    const start = agent({ lastTs: 50 });
    const stop = applyEvent(start, ev({ hook: 'Stop', ts: 100 }));
    expect(stop.taskChange).toEqual({ kind: 'close', endedAt: 100 });
    const idle = applyEvent(stop.agent, ev({ hook: 'Notification', notification: 'idle_prompt', ts: 500 }));
    expect(idle.taskChange).toEqual({ kind: 'none' });
    expect(idle.agent.stage).toBe('Done');
    const prompt = applyEvent(idle.agent, ev({ hook: 'UserPromptSubmit', ts: 900 }));
    expect(prompt.taskChange).toEqual({ kind: 'open', startedAt: 900 });
  });
});

describe('events that start work open a task (AC-19)', () => {
  const starters: Array<[string, Partial<OfficeEvent>]> = [
    ['UserPromptSubmit', { hook: 'UserPromptSubmit' }],
    ['PreToolUse', { hook: 'PreToolUse', tool: 'Read' }],
    ['PostToolUse', { hook: 'PostToolUse' }],
    ['PostToolUseFailure', { hook: 'PostToolUseFailure' }],
    ['PermissionRequest', { hook: 'PermissionRequest' }],
    ['permission_prompt Notification', { hook: 'Notification', notification: 'permission_prompt' }],
  ];

  it.each(starters)('%s after Done opens a task at its ts', (_n, partial) => {
    const result = applyEvent(doneAgent(), ev({ ...partial, ts: 700 }));
    expect(result.taskChange).toEqual({ kind: 'open', startedAt: 700 });
    expect(result.agent.hasOpenTask).toBe(true);
  });

  it.each(starters)('unknown agent first %s opens a task at its ts', (_n, partial) => {
    const result = applyEvent(undefined, ev({ ...partial, ts: 700 }));
    expect(result.registered).toBe(true);
    expect(result.taskChange).toEqual({ kind: 'open', startedAt: 700 });
  });
});

describe('unsupported hook', () => {
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])('prototype key %s is not accepted as a hook', (name) => {
    const current = doneAgent({ stage: 'Editing', lastTs: 100 });
    const result = applyEvent(current, ev({ hook: name as unknown as HookName, ts: 900 }));
    expect(result.agent).toEqual(current);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.stale).toBe(false);
  });

  it('is ignored completely: no stage change, no task, lastTs not advanced', () => {
    const current = doneAgent({ stage: 'Editing', lastTs: 100 });
    const event = ev({ hook: 'Bogus' as unknown as HookName, ts: 900 });
    const result = applyEvent(current, event);
    expect(result.agent).toEqual(current);
    expect(result.taskChange).toEqual({ kind: 'none' });
    expect(result.stale).toBe(false);
    expect(result.registered).toBe(false);
  });
});
