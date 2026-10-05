import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOKS, parseEvent } from '../src/shared/events.js';
import { buildEvent, readToken, resolvePort, run, SUPPORTED_HOOKS } from './agents-office-hook.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents-office-hook.mjs');
const TOKEN = 'a1'.repeat(32);
const ALLOWED_KEYS = [
  'v', 'ts', 'hook', 'user', 'project', 'session', 'agent_id', 'agent',
  'tool', 'file', 'notification', 'transcript',
];

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  port: number;
  requests: Captured[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hook-'));
  fs.writeFileSync(path.join(home, 'token'), TOKEN + '\n');
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Stub that mimics the server: validates with the real parseEvent; 'hang' never answers. */
function startStub(mode: 'validate' | 'hang' = 'validate'): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, rawBody, body });
      if (mode === 'hang') return;
      const ok = parseEvent(body).ok;
      res.statusCode = ok ? 202 : 422;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const stub: Stub = {
        port: (server.address() as AddressInfo).port,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      };
      cleanups.push(stub.close);
      resolve(stub);
    });
  });
}

async function closedPort(): Promise<number> {
  const stub = await startStub();
  const port = stub.port;
  await stub.close();
  return port;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function spawnHook(
  stdin: string,
  env: Record<string, string>,
  opts: { keepStdinOpen?: boolean; script?: string } = {},
): Promise<Spawned> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(process.execPath, [opts.script ?? SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdin.on('error', () => undefined);
    const guard = setTimeout(() => child.kill(), 5000);
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr, ms: performance.now() - start });
    });
    child.stdin.write(stdin);
    if (!opts.keepStdinOpen) child.stdin.end();
  });
}

function baseEnv(port: number): Record<string, string> {
  return { AGENTS_OFFICE_HOME: home, AGENTS_OFFICE_PORT: String(port) };
}

function hookJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    transcript_path: '/t/session.jsonl',
    cwd: 'C:\\work\\my-proj',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/a.ts' },
    ...over,
  };
}

describe('allowed fields only (AC-28, AC-30)', () => {
  it('an edit hook JSON sends exactly the allowed fields', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const body = stub.requests[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(
      ['v', 'ts', 'hook', 'user', 'project', 'session', 'agent_id', 'agent', 'tool', 'file', 'transcript'].sort(),
    );
    expect(body).toMatchObject({
      v: 1,
      hook: 'PostToolUse',
      user: os.userInfo().username,
      project: 'my-proj',
      session: 'sess-1',
      agent_id: null,
      agent: 'boss',
      tool: 'Edit',
      file: '/repo/src/a.ts',
      transcript: '/t/session.jsonl',
    });
    expect(Number.isInteger(body['ts'])).toBe(true);
    expect(Object.keys(body).every((k) => ALLOWED_KEYS.includes(k))).toBe(true);
  });

  it('never forwards prompt, tool output or file contents', async () => {
    const stub = await startStub();
    const secrets = {
      prompt: 'SECRET_PROMPT_MARKER',
      tool_output: 'SECRET_OUTPUT_MARKER',
      tool_response: 'SECRET_RESPONSE_MARKER',
      last_assistant_message: 'SECRET_ASSISTANT_MARKER',
      message: 'SECRET_MESSAGE_MARKER',
      permission_mode: 'SECRET_MODE_MARKER',
      effort: 'SECRET_EFFORT_MARKER',
    };
    const input = hookJson({
      ...secrets,
      tool_input: {
        file_path: '/repo/src/a.ts',
        content: 'SECRET_CONTENT_MARKER',
        old_string: 'SECRET_OLD_MARKER',
        new_string: 'SECRET_NEW_MARKER',
        command: 'SECRET_COMMAND_MARKER',
      },
    });
    const r = await spawnHook(JSON.stringify(input), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const req = stub.requests[0];
    const everything = JSON.stringify([req?.rawBody, req?.url, req?.headers]);
    expect(everything).not.toContain('SECRET_');
  });

  it('notebook_path is used when file_path is absent', () => {
    const e = buildEvent(hookJson({ tool_input: { notebook_path: '/n/book.ipynb' } }), 1, 'u');
    expect(e?.file).toBe('/n/book.ipynb');
  });

  it('file_path wins over notebook_path', () => {
    const e = buildEvent(hookJson({ tool_input: { file_path: '/a', notebook_path: '/b' } }), 1, 'u');
    expect(e?.file).toBe('/a');
  });

  it('non-string or over-long optional fields are omitted', () => {
    const e = buildEvent(
      hookJson({
        tool_name: 42,
        tool_input: { file_path: { nested: 'x' } },
        notification_type: 'n'.repeat(33),
        transcript_path: 't'.repeat(1025),
      }),
      1,
      'u',
    );
    expect(e).not.toBeNull();
    expect(e).not.toHaveProperty('tool');
    expect(e).not.toHaveProperty('file');
    expect(e).not.toHaveProperty('notification');
    expect(e).not.toHaveProperty('transcript');
  });

  it('over-long file path is omitted and a missing tool_input is tolerated', () => {
    expect(buildEvent(hookJson({ tool_input: { file_path: 'f'.repeat(1025) } }), 1, 'u')).not.toBeNull();
    expect(buildEvent(hookJson({ tool_input: { file_path: 'f'.repeat(1025) } }), 1, 'u')).not.toHaveProperty('file');
    expect(buildEvent(hookJson({ tool_input: 'text' }), 1, 'u')).not.toHaveProperty('file');
    expect(buildEvent(hookJson({ tool_input: null }), 1, 'u')).not.toHaveProperty('file');
  });

  it('sends the notification type', () => {
    const e = buildEvent(hookJson({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 1, 'u');
    expect(e?.notification).toBe('idle_prompt');
  });

  it('over-long or invalid required fields send nothing', () => {
    expect(buildEvent(hookJson({ session_id: 's'.repeat(129) }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson({ session_id: '' }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson({ session_id: 7 }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson({ cwd: '/x/' + 'p'.repeat(129) }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson(), 1, 'u'.repeat(65))).toBeNull();
    expect(buildEvent(hookJson({ agent_id: 'a1', agent_type: 'x'.repeat(65) }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson({ agent_id: 'a'.repeat(129), agent_type: 'x' }), 1, 'u')).toBeNull();
  });

  it('project falls back to a fixed word when cwd is empty or missing, and handles both separators', () => {
    expect(buildEvent(hookJson({ cwd: undefined }), 1, 'u')?.project).toBe('unknown');
    expect(buildEvent(hookJson({ cwd: '' }), 1, 'u')?.project).toBe('unknown');
    expect(buildEvent(hookJson({ cwd: '/home/me/proj/' }), 1, 'u')?.project).toBe('proj');
    expect(buildEvent(hookJson({ cwd: 'D:\\a\\b\\' }), 1, 'u')?.project).toBe('b');
  });

  it('non-object hook JSON builds nothing', () => {
    expect(buildEvent(null, 1, 'u')).toBeNull();
    expect(buildEvent('x', 1, 'u')).toBeNull();
    expect(buildEvent([], 1, 'u')).toBeNull();
  });
});

describe('hook mapping', () => {
  it('supports exactly the 11 hooks of the shared definition', () => {
    expect([...SUPPORTED_HOOKS].sort()).toEqual([...HOOKS].sort());
  });

  it('maps every supported hook name', () => {
    for (const name of HOOKS) {
      expect(buildEvent(hookJson({ hook_event_name: name }), 1, 'u')?.hook).toBe(name);
    }
  });

  it('an unsupported hook name builds nothing', () => {
    expect(buildEvent(hookJson({ hook_event_name: 'Bogus' }), 1, 'u')).toBeNull();
    expect(buildEvent(hookJson({ hook_event_name: undefined }), 1, 'u')).toBeNull();
  });

  it('SubagentStart (parent context) is a boss event even with agent_type', () => {
    const e = buildEvent(
      { hook_event_name: 'SubagentStart', session_id: 's', cwd: '/p/proj', agent_type: 'code-reviewer' },
      1,
      'u',
    );
    expect(e?.agent).toBe('boss');
    expect(e?.agent_id).toBeNull();
  });

  it('a subagent hook keeps its id and name; a missing agent_type falls back to "agent"', () => {
    const e = buildEvent(hookJson({ agent_id: 'ag-9', agent_type: 'Explore' }), 1, 'u');
    expect(e?.agent_id).toBe('ag-9');
    expect(e?.agent).toBe('Explore');
    expect(buildEvent(hookJson({ agent_id: 'ag-9' }), 1, 'u')?.agent).toBe('agent');
  });

  it('a --agent main thread (agent_type without agent_id) stays boss', () => {
    const e = buildEvent(hookJson({ agent_type: 'my-agent' }), 1, 'u');
    expect(e?.agent).toBe('boss');
    expect(e?.agent_id).toBeNull();
  });

  it('the real server validation accepts every event built for all 11 hooks, boss and subagent', async () => {
    const stub = await startStub();
    const io = { env: baseEnv(stub.port) };
    for (const name of HOOKS) {
      await run(JSON.stringify(hookJson({ hook_event_name: name })), io);
      await run(JSON.stringify(hookJson({ hook_event_name: name, agent_id: 'ag-1', agent_type: 'Explore' })), io);
      await run(JSON.stringify({ hook_event_name: name, session_id: 's', cwd: '/p/x', agent_type: 'Plan' }), io);
    }
    expect(stub.requests).toHaveLength(HOOKS.length * 3);
    for (const req of stub.requests) {
      expect(parseEvent(req.body)).toMatchObject({ ok: true });
    }
  });
});

describe('request shape (AC-34)', () => {
  it('goes to 127.0.0.1 with the configured port, JSON, exact Bearer token, no Origin, small body', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson()), {
      ...baseEnv(stub.port),
      AGENTS_OFFICE_HOST: 'evil.example',
    });
    expect(r.code).toBe(0);
    const req = stub.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/events');
    expect(req?.headers.host).toBe(`127.0.0.1:${stub.port}`);
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers.origin).toBeUndefined();
    expect(Buffer.byteLength(req?.rawBody ?? '')).toBeLessThan(64 * 1024);
  });

  it('reads the token from the token file in AGENTS_OFFICE_HOME (a different token is sent when the file changes)', async () => {
    const stub = await startStub();
    const other = 'bc'.repeat(32);
    fs.writeFileSync(path.join(home, 'token'), other);
    await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${other}`);
  });

  it('resolvePort accepts 1-65535 integers and defaults to 4317 otherwise', () => {
    expect(resolvePort({})).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '5000' })).toBe(5000);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '0' })).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '65536' })).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '12.5' })).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: 'abc' })).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '1e3' })).toBe(4317);
    expect(resolvePort({ AGENTS_OFFICE_PORT: '' })).toBe(4317);
  });
});

describe('token file (AC-35)', () => {
  it('readToken returns the 64-hex token without the trailing newline', () => {
    expect(readToken({ AGENTS_OFFICE_HOME: home })).toBe(TOKEN);
  });

  it('a missing token file sends nothing and exits 0 with no output', async () => {
    const stub = await startStub();
    fs.rmSync(path.join(home, 'token'));
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(stub.requests).toHaveLength(0);
    expect(readToken({ AGENTS_OFFICE_HOME: home })).toBeNull();
  });

  it.each([
    ['too short', 'ab'.repeat(31)],
    ['too long', 'ab'.repeat(33)],
    ['non-hex', 'zz'.repeat(32)],
    ['empty', ''],
    ['with inner whitespace', 'ab'.repeat(16) + ' ' + 'ab'.repeat(15) + 'a'],
  ])('a malformed token file (%s) sends nothing', async (_name, content) => {
    const stub = await startStub();
    fs.writeFileSync(path.join(home, 'token'), content);
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(stub.requests).toHaveLength(0);
  });

  it('a token path that is a directory sends nothing', async () => {
    const stub = await startStub();
    fs.rmSync(path.join(home, 'token'));
    fs.mkdirSync(path.join(home, 'token'));
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('robustness (AC-29)', () => {
  it('invalid JSON on stdin exits 0, sends nothing, prints nothing', async () => {
    const stub = await startStub();
    const r = await spawnHook('{not json', baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(stub.requests).toHaveLength(0);
  });

  it('empty stdin exits 0 and sends nothing', async () => {
    const stub = await startStub();
    const r = await spawnHook('', baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(stub.requests).toHaveLength(0);
  });

  it('an unsupported hook name sends nothing and exits 0', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson({ hook_event_name: 'Bogus' })), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(stub.requests).toHaveLength(0);
  });

  it('with the server down the script exits 0 within 1 second and prints nothing', async () => {
    const port = await closedPort();
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(port));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.ms).toBeLessThan(1000);
  });

  it('run() resolves (does not throw) when the server is down', async () => {
    const port = await closedPort();
    await expect(run(JSON.stringify(hookJson()), { env: baseEnv(port) })).resolves.toBe(true);
  });

  it('a server that never answers does not keep the script alive beyond about 1 second', async () => {
    const stub = await startStub('hang');
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(stub.requests).toHaveLength(1);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    // 1500 and not 1000: the script's own safety timer is 1000 ms and Windows process start plus
    // child-process plumbing adds tens of milliseconds on top of it.
    expect(r.ms).toBeLessThan(1500);
  });

  it('stdin that never closes does not hang the script', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port), { keepStdinOpen: true });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    // Same 1500 ms bound as above: 500 ms stdin wait + request, well under the 1000 ms safety timer.
    expect(r.ms).toBeLessThan(1500);
  });

  it.each(['throw', 'reject', 'late-throw'])(
    'a crash outside every try/catch (%s) still exits 0 with empty stdout and stderr',
    async (mode) => {
      const stub = await startStub();
      const r = await spawnHook(JSON.stringify(hookJson()), {
        ...baseEnv(stub.port),
        AGENTS_OFFICE_HOOK_TEST_CRASH: mode,
      });
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('');
      expect(r.code).toBe(0);
    },
  );

  it('an unrecognised AGENTS_OFFICE_HOOK_TEST_CRASH value is harmless and still sends the event', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson()), {
      ...baseEnv(stub.port),
      AGENTS_OFFICE_HOOK_TEST_CRASH: 'nonsense',
    });
    expect(r.code).toBe(0);
    expect(r.stderr + r.stdout).toBe('');
    expect(stub.requests).toHaveLength(1);
  });

  it('oversized stdin (over 1 MB) sends nothing and exits 0', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson({ prompt: 'x'.repeat(1_200_000) })), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('an unexpected exception inside the script is caught (fetch throws, rejects, username throws)', async () => {
    // The injected stand-ins deliberately do not match the full fetch signature.
    const throwingFetch = (): never => {
      throw new Error('boom SECRET_BOOM');
    };
    await expect(
      run(JSON.stringify(hookJson()), { env: baseEnv(1), fetch: throwingFetch as unknown as typeof fetch }),
    ).resolves.toBe(true);
    const rejectingFetch = (): Promise<never> => Promise.reject(new Error('rejected'));
    await expect(
      run(JSON.stringify(hookJson()), { env: baseEnv(1), fetch: rejectingFetch as unknown as typeof fetch }),
    ).resolves.toBe(true);
    const sent: string[] = [];
    const okFetch = ((_url: string, init: { body: string }) => {
      sent.push(init.body);
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
    await run(JSON.stringify(hookJson()), {
      env: baseEnv(1),
      fetch: okFetch,
      username: () => {
        throw new Error('no user');
      },
    });
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({ user: 'unknown' });
  });

  it('run() ignores bad input without throwing', async () => {
    const stub = await startStub();
    const io = { env: baseEnv(stub.port) };
    await expect(run('', io)).resolves.toBe(false);
    await expect(run('nope', io)).resolves.toBe(false);
    await expect(run('[]', io)).resolves.toBe(false);
    await expect(run(JSON.stringify(hookJson({ hook_event_name: 'X' })), io)).resolves.toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it('prints nothing on success', async () => {
    const stub = await startStub();
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(stub.requests).toHaveLength(1);
  });

  it('does not follow redirects (the token is not forwarded elsewhere)', async () => {
    const target = await startStub();
    const redirector = http.createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader('Location', `http://127.0.0.1:${target.port}/events`);
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => redirector.close(() => r())));
    const port = (redirector.address() as AddressInfo).port;
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(port));
    expect(r.code).toBe(0);
    expect(target.requests).toHaveLength(0);
  });
});

describe('performance (NFR-02)', () => {
  it('50 runs against the stub finish with p95 below 200 ms', async () => {
    const stub = await startStub();
    const times: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
      expect(r.code).toBe(0);
      times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1] ?? Infinity;
    console.info(
      `NFR-02 observed: p95=${p95.toFixed(1)} ms, median=${(times[24] ?? 0).toFixed(1)} ms, max=${(times[49] ?? 0).toFixed(1)} ms`,
    );
    expect(stub.requests).toHaveLength(50);
    expect(p95).toBeLessThan(200);
  }, 60_000);
});

describe('limits stay in sync with the server definition', () => {
  const validEvent = {
    v: 1, ts: 1, hook: 'PostToolUse', user: 'u', project: 'p', session: 's', agent_id: null, agent: 'boss',
  };
  type Built = ReturnType<typeof buildEvent>;
  const fields: Array<{
    name: string;
    /** Same value placed in an otherwise valid hand-made event, validated by the real parseEvent. */
    server: (value: string) => Record<string, unknown>;
    /** The script's event for the value. */
    script: (value: string) => Built;
  }> = [
    { name: 'user', server: (v) => ({ ...validEvent, user: v }), script: (v) => buildEvent(hookJson(), 1, v) },
    { name: 'project', server: (v) => ({ ...validEvent, project: v }), script: (v) => buildEvent(hookJson({ cwd: '/x/' + v }), 1, 'u') },
    { name: 'session', server: (v) => ({ ...validEvent, session: v }), script: (v) => buildEvent(hookJson({ session_id: v }), 1, 'u') },
    { name: 'agent_id', server: (v) => ({ ...validEvent, agent_id: v, agent: 'a' }), script: (v) => buildEvent(hookJson({ agent_id: v, agent_type: 'a' }), 1, 'u') },
    { name: 'agent', server: (v) => ({ ...validEvent, agent_id: 'a', agent: v }), script: (v) => buildEvent(hookJson({ agent_id: 'a', agent_type: v }), 1, 'u') },
    { name: 'tool', server: (v) => ({ ...validEvent, tool: v }), script: (v) => buildEvent(hookJson({ tool_name: v }), 1, 'u') },
    { name: 'file', server: (v) => ({ ...validEvent, file: v }), script: (v) => buildEvent(hookJson({ tool_input: { file_path: v } }), 1, 'u') },
    { name: 'notification', server: (v) => ({ ...validEvent, notification: v }), script: (v) => buildEvent(hookJson({ notification_type: v }), 1, 'u') },
    { name: 'transcript', server: (v) => ({ ...validEvent, transcript: v }), script: (v) => buildEvent(hookJson({ transcript_path: v }), 1, 'u') },
  ];

  it.each(fields)('the script limit for $name equals the largest length parseEvent accepts', ({ name, server, script }) => {
    // Probe the server definition: largest accepted length (all limits are below 2000).
    let max = 0;
    while (max < 2000 && parseEvent(server('x'.repeat(max + 1))).ok) max += 1;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(2000);
    // At the limit: the script keeps the value and the real parseEvent accepts the built event.
    const atLimit = script('x'.repeat(max));
    expect(atLimit, `${name} at ${max}`).not.toBeNull();
    expect(parseEvent(atLimit)).toMatchObject({ ok: true });
    expect((atLimit as unknown as Record<string, unknown>)[name]).toBe('x'.repeat(max));
    // One over: the server rejects it, and the script refuses (required) or omits (optional) it.
    expect(parseEvent(server('x'.repeat(max + 1))).ok).toBe(false);
    const over = script('x'.repeat(max + 1));
    const kept = over === null ? undefined : (over as unknown as Record<string, unknown>)[name];
    expect(kept).not.toBe('x'.repeat(max + 1));
  });
});

describe('entry point through links', () => {
  /** Copies the script into a temp dir and links to that dir; null when links are forbidden. */
  function linkedScript(): string | null {
    const realDir = path.join(home, 'real');
    fs.mkdirSync(realDir);
    fs.copyFileSync(SCRIPT, path.join(realDir, 'agents-office-hook.mjs'));
    const link = path.join(home, 'link');
    try {
      fs.symlinkSync(realDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return null; // link creation is forbidden on this machine
    }
    return path.join(link, 'agents-office-hook.mjs');
  }

  it('still sends the event when the script is run through a symlink or junction', async (ctx) => {
    const stub = await startStub();
    const script = linkedScript();
    if (script === null) return ctx.skip('creating symlinks or junctions is not permitted on this machine');
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port), { script });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(stub.requests).toHaveLength(1);
  });

  it('crash handlers are also active through a link', async (ctx) => {
    const script = linkedScript();
    if (script === null) return ctx.skip('creating symlinks or junctions is not permitted on this machine');
    const r = await spawnHook(
      JSON.stringify(hookJson()),
      { ...baseEnv(1), AGENTS_OFFICE_HOOK_TEST_CRASH: 'throw' },
      { script },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('token file hardening', () => {
  const stat = (over: { isFile: boolean; size: number }) => () => ({ isFile: () => over.isFile, size: over.size });

  it('does not read a path that is not a regular file (FIFO, device, directory)', () => {
    let reads = 0;
    const token = readToken(
      { AGENTS_OFFICE_HOME: home },
      {
        statSync: stat({ isFile: false, size: 0 }),
        readFileSync: () => {
          reads += 1;
          return TOKEN;
        },
      },
    );
    expect(token).toBeNull();
    expect(reads).toBe(0);
  });

  it('does not read a file larger than 256 bytes', () => {
    let reads = 0;
    const token = readToken(
      { AGENTS_OFFICE_HOME: home },
      {
        statSync: stat({ isFile: true, size: 257 }),
        readFileSync: () => {
          reads += 1;
          return TOKEN;
        },
      },
    );
    expect(token).toBeNull();
    expect(reads).toBe(0);
  });

  it('reads a regular file of 256 bytes or less', () => {
    const token = readToken(
      { AGENTS_OFFICE_HOME: home },
      { statSync: stat({ isFile: true, size: 65 }), readFileSync: () => TOKEN + '\n' },
    );
    expect(token).toBe(TOKEN);
  });

  it('an oversized real file sends nothing and exits 0', async () => {
    const stub = await startStub();
    fs.writeFileSync(path.join(home, 'token'), TOKEN + '\n'.repeat(300));
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('a symlink or junction to a directory in place of the token sends nothing and exits 0', async (ctx) => {
    const stub = await startStub();
    const dir = path.join(home, 'somedir');
    fs.mkdirSync(dir);
    fs.rmSync(path.join(home, 'token'));
    try {
      fs.symlinkSync(dir, path.join(home, 'token'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return ctx.skip('creating symlinks or junctions is not permitted on this machine');
    }
    const r = await spawnHook(JSON.stringify(hookJson()), baseEnv(stub.port));
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(1500);
    expect(stub.requests).toHaveLength(0);
  });
});
