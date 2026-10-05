// Claude Code hook for Agents Office.
//
// Reads ONE hook JSON object on stdin, builds an event with the allowed fields only,
// and POSTs it to the local server. It is fire-and-forget: it prints NOTHING to stdout
// or stderr (for some hooks stdout becomes context for Claude) and ALWAYS exits 0
// (exit 2 would block actions). Node built-ins only; the only file it reads is the
// auth token file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same names as HOOKS in src/shared/events.ts. */
export const SUPPORTED_HOOKS = [
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
];

const DEFAULT_PORT = 4317;
const HOST = '127.0.0.1'; // never taken from the environment
const REQUEST_TIMEOUT_MS = 800;
const STDIN_TIMEOUT_MS = 500;
const SAFETY_TIMEOUT_MS = 1000;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TOKEN_FILE_BYTES = 256;
const HEX64 = /^[0-9a-fA-F]{64}$/;

// Server-side limits (src/shared/events.ts). Values over a limit are never truncated.
const LIMITS = { user: 64, project: 128, session: 128, agent_id: 128, agent: 64, tool: 64, file: 1024, notification: 32, transcript: 1024 };

/** @param {string | undefined} raw */
function parsePort(raw) {
  if (typeof raw !== 'string' || !/^[0-9]{1,5}$/.test(raw)) return DEFAULT_PORT;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/** @param {Record<string, string | undefined>} env */
export function resolvePort(env) {
  return parsePort(env['AGENTS_OFFICE_PORT']);
}

/**
 * Auth token from <AGENTS_OFFICE_HOME or ~/.agents-office>/token, or null when missing, unreadable or malformed.
 * Only a regular file of at most 256 bytes is read, so a FIFO or device can never block the process.
 * @param {Record<string, string | undefined>} env
 * @param {{ statSync: (file: string) => { isFile: () => boolean, size: number }, readFileSync: (file: string, encoding: 'utf8') => string }} [deps]
 * @returns {string | null}
 */
export function readToken(env, deps = fs) {
  try {
    const override = env['AGENTS_OFFICE_HOME'];
    const dir = override ? override : path.join(os.homedir(), '.agents-office');
    const file = path.join(dir, 'token');
    const info = deps.statSync(file);
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES) return null;
    const content = deps.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    return HEX64.test(content) ? content : null;
  } catch {
    return null;
  }
}

/** A non-empty string within the limit, otherwise undefined. */
function optional(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the event for a hook JSON, or null when nothing must be sent.
 * @param {unknown} hookJson
 * @param {number} now
 * @param {string} username
 */
export function buildEvent(hookJson, now, username) {
  if (!isObject(hookJson)) return null;
  const hook = hookJson['hook_event_name'];
  if (typeof hook !== 'string' || !SUPPORTED_HOOKS.includes(hook)) return null;

  const session = optional(hookJson['session_id'], LIMITS.session);
  if (session === undefined) return null;

  const user = optional(username, LIMITS.user);
  if (user === undefined) return null;

  // Both separators on any OS; an empty or missing cwd falls back to a fixed word.
  const cwd = hookJson['cwd'];
  const segment = typeof cwd === 'string' ? cwd.split(/[\\/]+/).filter(Boolean).pop() : undefined;
  const project = segment === undefined ? 'unknown' : optional(segment, LIMITS.project);
  if (project === undefined) return null;

  // agent_id is present only inside a subagent. Without it the event is the boss's: this also
  // covers SubagentStart (its agent_type is the NEW subagent's type) and --agent main threads.
  const rawAgentId = hookJson['agent_id'];
  const hasAgentId = typeof rawAgentId === 'string' && rawAgentId.length > 0;
  if (hasAgentId && rawAgentId.length > LIMITS.agent_id) return null;
  const agentId = hasAgentId ? rawAgentId : null;
  let agent = 'boss';
  if (hasAgentId) {
    const type = hookJson['agent_type'];
    if (typeof type === 'string' && type.length > LIMITS.agent) return null;
    agent = optional(type, LIMITS.agent) ?? 'agent';
  }

  /** @type {Record<string, unknown>} */
  const event = { v: 1, ts: now, hook, user, project, session, agent_id: agentId, agent };

  const tool = optional(hookJson['tool_name'], LIMITS.tool);
  if (tool !== undefined) event['tool'] = tool;

  // Only the PATH is read from tool_input; nothing else in it is ever touched.
  const toolInput = hookJson['tool_input'];
  if (isObject(toolInput)) {
    const file = optional(toolInput['file_path'], LIMITS.file) ?? optional(toolInput['notebook_path'], LIMITS.file);
    if (file !== undefined) event['file'] = file;
  }

  const notification = optional(hookJson['notification_type'], LIMITS.notification);
  if (notification !== undefined) event['notification'] = notification;

  const transcript = optional(hookJson['transcript_path'], LIMITS.transcript);
  if (transcript !== undefined) event['transcript'] = transcript;

  return event;
}

function currentUsername() {
  return os.userInfo().username;
}

/**
 * Processes the raw stdin text. Resolves true when a request was attempted; never rejects
 * and never writes to stdout or stderr.
 * @param {string} input
 * @param {{ env?: Record<string, string | undefined>, now?: () => number, username?: () => string, fetch?: typeof fetch }} [io]
 */
export async function run(input, io = {}) {
  try {
    const env = io.env ?? process.env;
    let json;
    try {
      json = JSON.parse(input);
    } catch {
      return false;
    }
    let username;
    try {
      username = (io.username ?? currentUsername)();
    } catch {
      username = 'unknown';
    }
    if (typeof username !== 'string' || username.length === 0) username = 'unknown';
    const event = buildEvent(json, (io.now ?? Date.now)(), username);
    if (event === null) return false;
    const token = readToken(env);
    if (token === null) return false;

    try {
      const send = io.fetch ?? fetch;
      const response = await send(`http://${HOST}:${resolvePort(env)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The status is ignored; the body is only cancelled to free the socket.
      await response.body?.cancel();
    } catch {
      // Server down, slow or erroring: nothing to report.
    }
    return true;
  } catch {
    return false;
  }
}

/** Reads stdin fully, capped at 1 MB and bounded in time. Returns '' when oversized. */
function readStdin() {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (/** @type {string} */ text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.stdin.destroy();
      } catch {
        // ignore
      }
      resolve(text);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), STDIN_TIMEOUT_MS);
    try {
      process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_STDIN_BYTES) finish('');
        else chunks.push(chunk);
      });
      process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', () => finish(''));
    } catch {
      finish('');
    }
  });
}

/**
 * TEST-ONLY crash injection, read by the entry point only. AGENTS_OFFICE_HOOK_TEST_CRASH is
 * one of "throw" (uncaught throw after stdin is read), "reject" (unhandled rejection) or
 * "late-throw" (throw from a timer after run() returned). It has no effect when absent or
 * unrecognised and never touches host, port or token handling.
 * @param {string | undefined} mode
 * @param {'after-stdin' | 'after-run'} phase
 */
async function injectCrash(mode, phase) {
  if (phase === 'after-stdin') {
    if (mode === 'throw') {
      process.nextTick(() => {
        throw new Error('injected crash');
      });
    } else if (mode === 'reject') {
      void Promise.reject(new Error('injected rejection'));
    }
  } else if (mode === 'late-throw') {
    setTimeout(() => {
      throw new Error('injected late crash');
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function main() {
  // Hard stop: whatever happens, the process ends with 0 within about a second.
  setTimeout(() => process.exit(0), SAFETY_TIMEOUT_MS);
  try {
    const input = await readStdin();
    await injectCrash(process.env['AGENTS_OFFICE_HOOK_TEST_CRASH'], 'after-stdin');
    await run(input);
    await injectCrash(process.env['AGENTS_OFFICE_HOOK_TEST_CRASH'], 'after-run');
  } catch {
    // never surface anything
  }
  process.exit(0);
}

function isEntryPoint() {
  try {
    if (!process.argv[1]) return false;
    const self = path.resolve(fileURLToPath(import.meta.url));
    let entry = path.resolve(process.argv[1]);
    try {
      // import.meta.url is a real path; resolve links (symlinks, junctions) on the argv side too.
      entry = fs.realpathSync(entry);
    } catch {
      // keep the plain resolved path
    }
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Installed before any other work: nothing may ever print or exit non-zero.
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  void main();
}
