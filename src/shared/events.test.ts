import { describe, expect, it } from 'vitest';
import { HOOKS, OfficeEvent, STAGES, parseEvent } from './events.js';

const minimal = {
  v: 1,
  ts: 1759000000000,
  hook: 'PreToolUse',
  user: 'joako',
  project: 'mussi-AI',
  session: 'sess-1',
  agent_id: null,
  agent: 'boss',
};

function expectInvalid(input: unknown, field: string): void {
  const result = parseEvent(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.field).toBe(field);
}

describe('parseEvent', () => {
  it('parses a valid minimal event and keeps only the allowed fields', () => {
    const result = parseEvent(minimal);
    expect(result).toEqual({ ok: true, event: minimal });
  });

  it('keeps the optional fields when present', () => {
    const full = {
      ...minimal,
      agent_id: 'a1',
      agent: 'explorer',
      tool: 'Edit',
      file: 'src/a.ts',
      notification: 'permission_prompt',
      transcript: '/home/x/.claude/projects/p/s.jsonl',
    };
    expect(parseEvent(full)).toEqual({ ok: true, event: full });
  });

  it('discards extra fields such as tool_input and prompt', () => {
    const result = parseEvent({
      ...minimal,
      tool_input: { content: 'secret code' },
      prompt: 'secret prompt',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.event).sort()).toEqual(Object.keys(minimal).sort());
      expect(JSON.stringify(result.event)).not.toContain('secret');
    }
  });

  it('fails naming session when session is missing', () => {
    const { session: _session, ...rest } = minimal;
    expectInvalid(rest, 'session');
  });

  it.each(['user', 'project', 'agent'])('fails naming %s when it is empty', (key) => {
    expectInvalid({ ...minimal, [key]: '' }, key);
  });

  it('fails naming ts when ts is a string', () => {
    expectInvalid({ ...minimal, ts: '1759000000000' }, 'ts');
  });

  it.each([0, -5, 1.5])('fails naming ts when ts is %s', (ts) => {
    expectInvalid({ ...minimal, ts }, 'ts');
  });

  it('fails naming hook when the hook name is unknown', () => {
    expectInvalid({ ...minimal, hook: 'NotAHook' }, 'hook');
  });

  it('accepts every supported hook name', () => {
    for (const hook of HOOKS) expect(parseEvent({ ...minimal, hook }).ok).toBe(true);
  });

  it('fails naming v when the version is not 1', () => {
    expectInvalid({ ...minimal, v: 2 }, 'v');
  });

  it('fails naming agent_id when it is missing', () => {
    const { agent_id: _agentId, ...rest } = minimal;
    expectInvalid(rest, 'agent_id');
  });

  it('accepts null for the nullable optional fields', () => {
    const result = parseEvent({ ...minimal, tool: null, file: null, notification: null, transcript: null });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['user', 65],
    ['project', 129],
    ['session', 129],
    ['agent_id', 129],
    ['agent', 65],
    ['tool', 65],
    ['file', 1025],
    ['notification', 33],
    ['transcript', 1025],
  ])('fails naming %s when longer than the maximum', (key, length) => {
    expectInvalid({ ...minimal, [key]: 'x'.repeat(length) }, key);
  });

  it('accepts values exactly at the maximum length', () => {
    const result = parseEvent({ ...minimal, user: 'x'.repeat(64), file: 'f'.repeat(1024) });
    expect(result.ok).toBe(true);
  });

  it('fails naming agent when agent_id is null and agent is not "boss"', () => {
    expectInvalid({ ...minimal, agent_id: null, agent: 'x' }, 'agent');
  });

  it('accepts agent "boss" when agent_id is null', () => {
    expect(parseEvent({ ...minimal, agent_id: null, agent: 'boss' }).ok).toBe(true);
  });

  it('accepts any non-empty agent name when agent_id is set', () => {
    expect(parseEvent({ ...minimal, agent_id: 'a1', agent: 'frontend-dev' }).ok).toBe(true);
    expect(parseEvent({ ...minimal, agent_id: 'a1', agent: 'boss' }).ok).toBe(true);
  });

  it('fails with an empty path when the input is not an object', () => {
    const result = parseEvent('not an event');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('');
  });
});

describe('definitions', () => {
  it('exposes the six stages', () => {
    expect(STAGES).toEqual(['Thinking', 'Reading', 'Editing', 'Running', 'Waiting', 'Done']);
  });

  it('exposes OfficeEvent as the single zod definition', () => {
    expect(OfficeEvent.safeParse(minimal).success).toBe(true);
  });
});
