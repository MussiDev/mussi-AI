export interface HookEvent {
  v: 1;
  ts: number;
  hook: string;
  user: string;
  project: string;
  session: string;
  agent_id: string | null;
  agent: string;
  tool?: string;
  file?: string;
  notification?: string;
  transcript?: string;
}

export interface RunIo {
  env?: Record<string, string | undefined>;
  now?: () => number;
  username?: () => string;
  fetch?: typeof fetch;
}

export const SUPPORTED_HOOKS: readonly string[];
export function resolvePort(env: Record<string, string | undefined>): number;
export interface TokenFs {
  statSync: (file: string) => { isFile: () => boolean; size: number };
  readFileSync: (file: string, encoding: 'utf8') => string;
}
export function readToken(env: Record<string, string | undefined>, deps?: TokenFs): string | null;
export function buildEvent(hookJson: unknown, now: number, username: string): HookEvent | null;
/** Resolves true when a request was attempted; never rejects. */
export function run(input: string, io?: RunIo): Promise<boolean>;
