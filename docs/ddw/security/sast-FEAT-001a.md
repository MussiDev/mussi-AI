# SAST report FEAT-001a: Event pipeline: hooks, local server, persistence, live stream

| Field | Value |
|-------|-------|
| Ticket | FEAT-001a |
| Tier | FEATURE |
| Date | 2026-10-05 |
| Scope | `src/server/*`, `src/shared/events.ts`, `hooks/agents-office-hook.mjs`, `docs/install-hooks.md`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore`; test files and fixtures were scanned for real credentials |
| Method | Read by the security auditor agent over the whole scope, plus `pnpm audit` (pnpm 11.9.0, Node v24.13.1); code state is the commit that fixed the one finding below |

DDW does not scan code: this report is a model reading the source. The receipt attests that the report is complete, not that the code is secure.

## Categories

- ✅ F-SAST-01 hardcoded secrets: no secret literal in `src/` or `hooks/`; no `.env`, key, token, database or state file was ever committed (`git ls-files` and `git log --all`); `.gitignore` covers `node_modules/`, `dist/`, `*.db`, `.ddw-state.json`, `.env*` (`.gitignore:1-10`).
- ✅ F-SAST-02 SQL injection: every statement in `src/server/db.ts:122-155` uses prepared `?` or `@name` bindings; the only interpolated SQL is the constant `user_version = ${SCHEMA_VERSION}` (`src/server/db.ts:226`), a module-level integer that PRAGMA cannot bind; the key goes through `raw.key(Buffer)` (`src/server/db.ts:200-201`); the migration is a static file.
- ✅ F-SAST-03 OS command injection: no `child_process`, `exec` or `spawn` in production code; the only `spawn` is in the test `hooks/agents-office-hook.test.ts`, which launches the hook script.
- ✅ F-SAST-04 insecure deserialization: every `JSON.parse` result is validated before use (`src/shared/events.ts:27-56` through zod, `src/server/auth.ts:65-74` for the pairing body, `src/server/tokens.ts:271-285` for transcript lines, `hooks/agents-office-hook.mjs` through `buildEvent`); no `eval`, `Function`, `vm`, dynamic `import` or `require`.
- ✅ F-SAST-05 path traversal: production paths are confined: the data directory must resolve inside the home directory (`src/server/secrets.ts:40-53`), transcripts must be real-path inside the projects directory, end in `.jsonl` and be regular files (`src/server/tokens.ts:176-196`), session and agent ids in subagent paths must match `^[A-Za-z0-9_-]{1,128}$`, the migration path is fixed, and the hook reads only `<dir>/token`; the `AGENTS_OFFICE_DB` variable is discussed under the low items below.
- ✅ F-SAST-06 XSS: the server produces only JSON and `text/event-stream`; `x-powered-by` is disabled; the 404 and 500 bodies are fixed; no input is reflected (`src/server/app.ts:40,118-143`); SSE data goes through `JSON.stringify`, which escapes newlines so frames cannot be injected (`src/server/stream.ts:85-86`).
- ✅ F-SAST-07 SSRF: the hook posts to the literal `http://127.0.0.1:<port>/events`; only the port can change and it is validated as an integer from 1 to 65535; scheme, host and path are fixed; `redirect: 'manual'` is set (`hooks/agents-office-hook.mjs:30,174-180`).
- ✅ F-SAST-08 broken cryptography: token, key and session id come from `crypto.randomBytes(32)`; comparison uses `timingSafeEqual` after a regex and length check; the database uses the SQLCipher cipher set before the key; no MD5, SHA1 or `Math.random` (`src/server/secrets.ts:96,127-132`, `src/server/auth.ts:76`, `src/server/db.ts:200-201`).
- ✅ F-SAST-09 debug mode in production: the server has no debug flag and sends no stack trace to clients (`src/server/app.ts:124-143`); the hook script keeps a test-only crash switch (`hooks/agents-office-hook.mjs:233-257`) whose only effects are a throw or a rejected promise that the silent handlers turn into exit 0, and which cannot change host, port, token or payload; it is documented under the low items below because the tests need it to exercise the real entry point.
- ✅ F-SAST-10 logging sensitive data: refusals log only the method, a fixed route label and the status (`src/server/app.ts:41-54`); no token, key, header, body, prompt or transcript content is logged; the one raw-error log, the database outage line, was found and FIXED in commit b987d6e: it now writes only the error name (`src/server/db.ts:246-249`), proven by a test that asserts the line contains neither the directory nor anything but `Database unavailable: <ErrorName>` (`src/server/db.test.ts:405-409`).
- ✅ F-SAST-11 unrestricted upload: no upload and no request-driven file write; writes are limited to the token and key files (mode 0600, flag `wx`) and the SQLite database (`src/server/secrets.ts:98`, `src/server/db.ts:197`).
- ✅ F-SAST-12 missing CSRF protection: the Host must be exactly `127.0.0.1`, `localhost` or `[::1]` plus the real port (defeats DNS rebinding); an Origin, if present, must equal the server's own; no CORS header is sent; both POST routes require `application/json`; the cookie is HttpOnly and SameSite=Strict and the Bearer token is not ambient (`src/server/app.ts:60-86`, `src/server/auth.ts:82`).
- ✅ F-SAST-13 Critical or High CVE in a dependency: `pnpm audit` reported "No known vulnerabilities found"; resolved versions are express 5.2.1, better-sqlite3-multiple-ciphers 13.0.3 and zod 4.6.5 (`pnpm-lock.yaml:532,638,1064`); this is a database lookup, not an independent review of those versions.
- ✅ F-SAST-14 incomplete input validation: the event body is validated by zod with type and length bounds, a 64 KB limit and a JSON content type (`src/shared/events.ts:27-43`); the pairing body is limited to 1 KB with a strict 64-hex token (`src/server/auth.ts:17-18,65-74`); Bearer and cookie values are strict regexes; `AGENTS_OFFICE_PORT` is validated (`src/server/main.ts:56-64`); transcript lines are validated per field; the hook validates every field and never truncates.
- ✅ F-SAST-15 insecure error handling: clients only see fixed bodies (`forbidden`, `unauthorized`, `invalid_event` with a field path, `database_unavailable`, `internal_error`) and the 500 handler never returns or logs error text (`src/server/app.ts:124-143`); paths appear only in startup messages on the local console.
- ✅ F-SAST-16 Medium CVE in a dependency: the same `pnpm audit` run reported zero known vulnerabilities of any severity (`pnpm-lock.yaml:532,638,1064`).
- ✅ F-SAST-17 unsafe function: no `eval` or `Function`; every regex in production code is anchored or linear and fixed (`/^\d+$/`, the 64-hex patterns, the safe-segment pattern, the path-separator splits), none applied to unbounded attacker text; the hook caps stdin at 1 MB and the tracker allocates at most 8 MB per read (`src/server/tokens.ts:310-318`, `hooks/agents-office-hook.mjs:34,102`).

## Low and informational items (each with its disposition; none blocks)

These are documented, not suppressions: no Medium, High or Critical finding is open.

- Low, accepted: `AGENTS_OFFICE_DB` (`src/server/db.ts:109`) can point the database file outside the home directory, unlike `AGENTS_OFFICE_HOME`. It is set only by the process environment of the user who runs the server, it is allowed by the spec ("overridden with AGENTS_OFFICE_DB"), the file is encrypted, and it is the same trust boundary as the accepted risk R-15. Optional later hardening: apply the same inside-home check.
- Low, accepted: the hook keeps the test-only crash switch `AGENTS_OFFICE_HOOK_TEST_CRASH` (`hooks/agents-office-hook.mjs:233-257`). Anyone who can set the hook's environment is inside R-15 and the only outcome is a silent exit 0. Alternative later: require `NODE_ENV=test` as well.
- Low, fixed: the database outage log line carried raw error text (`src/server/db.ts:248`), fixed in commit b987d6e and covered by a test.
- Informational, fixed: `.gitignore` had no `.env*` rule; added. The proxy-environment note for the hook (Node 24 can route `fetch` through `HTTP_PROXY` when `NODE_USE_ENV_PROXY=1`, which would send the token to the proxy) was added to `docs/install-hooks.md`.
- Informational, accepted: unbounded growth reachable only by authenticated callers (per-session maps in `src/server/tokens.ts:113,119-121` released only on session end, no retention of the events table, no cap on stream clients, a stream snapshot that is the full history; TODO at `src/server/stream.ts:99`); to be handled in a retention or hardening ticket.
- Informational, accepted: an authenticated event with a far-future `ts` makes later events of that agent stale (`src/server/state.ts:105`), and `agent_id` equal to `boss` or empty maps onto the boss row (`src/server/ingest.ts:62`); integrity edge cases that need a valid token and that the hook never produces.
- Informational, accepted: the session cookie has no `Secure` flag or `Max-Age` (plain HTTP loopback, session cookie) and cookies are not port-isolated (`src/server/auth.ts:82`); the database file is created with the default umask (`src/server/db.ts:197`) inside the 0700 data directory and is encrypted; the server's secret reader has no size cap, unlike the hook's 256-byte cap (`src/server/secrets.ts:87`); no security headers are set because the server returns no HTML.

## Suppressions

None.

## Dependencies

`pnpm audit`: no known vulnerabilities of any severity. The build-script allow-list in `pnpm-workspace.yaml` permits only `better-sqlite3-multiple-ciphers` and denies `esbuild`; the lock file shows no git, tarball or URL dependency sources.

Result: PASSED
