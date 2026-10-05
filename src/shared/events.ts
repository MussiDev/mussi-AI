import { z } from 'zod';

// Single definition of an event, shared by server, hook tests and frontend.
// This module performs no I/O.

export const HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

export const STAGES = ['Thinking', 'Reading', 'Editing', 'Running', 'Waiting', 'Done'] as const;

export type HookName = (typeof HOOKS)[number];
export type Stage = (typeof STAGES)[number];

// zod objects strip unknown keys by default, which is how prompt text, code
// and file contents never reach storage. Do not switch to strict() or passthrough().
export const OfficeEvent = z.object({
  v: z.literal(1),
  ts: z.number().int().positive(),
  hook: z.enum(HOOKS),
  user: z.string().min(1).max(64),
  project: z.string().min(1).max(128),
  session: z.string().min(1).max(128),
  agent_id: z.string().max(128).nullable(),
  agent: z.string().min(1).max(64),
  tool: z.string().max(64).nullable().optional(),
  file: z.string().max(1024).nullable().optional(),
  notification: z.string().max(32).nullable().optional(),
  transcript: z.string().max(1024).nullable().optional(),
}).refine((event) => event.agent_id !== null || event.agent === 'boss', {
  path: ['agent'],
  message: 'agent must be "boss" when agent_id is null',
});

export type OfficeEvent = z.infer<typeof OfficeEvent>;

export type ParseResult = { ok: true; event: OfficeEvent } | { ok: false; field: string };

/** Returns the clean event, or the dotted path of the first invalid field ('' for a non-object input). */
export function parseEvent(input: unknown): ParseResult {
  const result = OfficeEvent.safeParse(input);
  if (result.success) return { ok: true, event: result.data };
  // A failed parse always carries at least one issue; slice keeps this branch-free.
  const path = result.error.issues.slice(0, 1).flatMap((issue) => issue.path);
  return { ok: false, field: path.map(String).join('.') };
}
