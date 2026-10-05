# Spec FEAT-001a: Event pipeline: hooks, local server, persistence, live stream

| Field | Value |
|-------|-------|
| Ticket | FEAT-001a |
| PRD | docs/ddw/prd/prd-FEAT-001a.md |
| Tier | FEATURE |
| Date | 2026-10-04 |
| Spec loops | 2 |
| Loops since last human decision | 0 |

## Summary

A Node 22 and TypeScript service receives events from a Claude Code hook script over local HTTP, validates them with a single shared definition (zod), stores them in an encrypted SQLite database, derives each agent's stage and task with a pure function, reads token usage incrementally from the session transcripts, and pushes every change to browsers through Server-Sent Events. The hook script runs as an async command hook and filters at the source, so no prompt text, code or file contents leave Claude Code. The server listens only on loopback, rejects requests from other origins and requires a secret auth token that lives in a file only the local user can read; browsers obtain access once through a pairing route that sets an HttpOnly cookie. The database key lives in a second file with the same protection. Terms follow the PRD: boss, agent, session, task, stage. "Auth token" means the secret that protects the server; "token usage" means the model tokens an agent consumes.

Decision recorded (user, 2026-10-04): protect the service against other users of the same machine and encrypt personal data at rest, instead of accepting those two risks. This added Block 8 and Block 9 and changed Blocks 1, 2, 4, 6 and 7.

## Coverage: PRD → blocks

| Requirement | Covered by |
|---|---|
| FR-01 | Block 4 |
| FR-02 | Block 1, Block 4 |
| FR-03 | Block 1, Block 2, Block 4 |
| FR-04 | Block 1, Block 2, Block 4 |
| FR-05 | Block 3 |
| FR-06 | Block 3 |
| FR-07 | Block 5 |
| FR-08 | Block 3 |
| FR-09 | Block 2 |
| FR-10 | Block 6 |
| FR-11 | Block 4 |
| FR-12 | Block 7 |
| FR-13 | Block 4, Block 6, Block 9 |
| FR-14 | Block 7, Block 8 |
| FR-15 | Block 9 |
| FR-16 | Block 2, Block 8 |
| NFR-01 | Strategy: the ingest handler applies the pure reducer in memory and commits one SQLite transaction, then broadcasts at once; token usage reading runs after the response and never blocks it. An integration test measures POST-to-stream latency over 200 events and asserts p95 below 300 ms. |
| NFR-02 | Strategy: the hook script uses only Node built-ins, aborts its request after 800 ms and is registered as an async command hook so Claude Code never waits for it. A test runs the script 50 times against a local stub and asserts p95 below 200 ms. |
| NFR-03 | Strategy: better-sqlite3-multiple-ciphers prepared statements in WAL mode, one transaction per event. A load test sends 50 events per second for 10 seconds and asserts that all 500 rows are stored. |
| NFR-04 | Strategy: vitest.config.ts sets v8 coverage thresholds of 80 for lines, branches and functions, so `pnpm test --coverage` fails below the floor. |
| NFR-05 | Strategy: the auth token and the database key come from `crypto.randomBytes(32)` and are stored as 64 hexadecimal characters; a test decodes both files, asserts 32 bytes each and asserts that two fresh data directories get different values. |

## Dependencies between blocks

Execution order: Block 1, then Block 8 (needs only Block 1), then Block 2 (needs Blocks 1 and 8) and Block 3 (needs Block 1), then Block 9 (needs Blocks 1 and 8), then Block 4 (needs Blocks 1, 2, 3 and 9), then Block 5 and Block 6 (both need Block 4 and its bus; Block 5 also needs Block 3 for the open task), then Block 7 (needs Blocks 4 and 8 to be tested end to end). Block numbers 8 and 9 were added after review and keep their numbers so earlier references stay valid.

## Block 1 — Scaffold and shared event definition

**Files**
- `package.json` (new) — pnpm project with scripts dev, build and test; dependencies express, better-sqlite3-multiple-ciphers and zod; dev dependencies typescript, tsx, vitest and @vitest/coverage-v8.
- `tsconfig.json` (new) — strict TypeScript, ES modules, Node 22 target.
- `vitest.config.ts` (new) — v8 coverage with thresholds of 80 for lines, branches and functions.
- `src/shared/events.ts` (new) — the single definition of an event, the Stage list and the inferred types, imported by server, hook tests and later by the frontend.
- `src/shared/events.test.ts` (new) — tests of the definition.

**Logic**
Define `OfficeEvent` once with zod: version, timestamp, hook name, the four identifiers (user, project, session, agent) and the optional tool, file, notification and transcript fields. Parsing strips every field that is not listed, which is how content never reaches storage. Export `Stage` as the six stages (Thinking, Reading, Editing, Running, Waiting, Done) and the `parseEvent` helper that returns either the clean event or the path of the first invalid field.

**Data model**
`OfficeEvent` fields, with type and constraints:
- `v` — literal 1, required.
- `ts` — integer greater than 0, milliseconds since epoch, required.
- `hook` — one of SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, SubagentStart, SubagentStop, Stop, SessionEnd; required.
- `user` — string, 1 to 64 characters, required.
- `project` — string, 1 to 128 characters, required.
- `session` — string, 1 to 128 characters, required.
- `agent_id` — string up to 128 characters or null (null means the boss), required.
- `agent` — string, 1 to 64 characters, required; the literal "boss" when agent_id is null.
- `tool` — string up to 64 characters, nullable, default absent.
- `file` — string up to 1024 characters, nullable, default absent.
- `notification` — string up to 32 characters, nullable, default absent.
- `transcript` — string up to 1024 characters, nullable, default absent.

**Input validation**
Every field is checked for type, maximum length and allowed values as listed in the data model. Unknown fields are discarded, not rejected, so a newer hook script never breaks an older server.

**Error handling**
- A required field is missing: parsing fails and names the field path.
- A field has the wrong type: parsing fails and names the field path.
- The hook name is not in the supported list: parsing fails as invalid.

**Required tests**
- [ ] a valid minimal event parses and keeps only the allowed fields — validates AC-05
- [ ] an event with extra fields such as `tool_input` and `prompt` has them discarded — validates AC-07
- [ ] an event missing `session` fails with an error naming `session` — validates AC-03, AC-06
- [ ] an event with `ts` as a string fails with an error naming `ts` — validates AC-03
- [ ] an event with an unknown hook name is invalid — validates AC-03

**Completion criterion**
`pnpm test --coverage` runs `events.test.ts` green with the coverage thresholds configured, and `pnpm build` compiles with no type errors.

## Block 2 — Encrypted persistence in SQLite

**Files**
- `src/server/db.ts` (new) — opens the encrypted database with the key from Block 8, applies migrations, exposes prepared statements, `addTokens` and a health flag.
- `src/server/migrations/001-init.sql` (new) — creates the tables and indexes.
- `src/server/db.test.ts` (new) — tests against in-memory and temporary databases.

**Logic**
The path defaults to `~/.agents-office/office.db` and can be overridden with `AGENTS_OFFICE_DB`. The module asks Block 8 for the key, telling it whether the database file already exists, and applies the key (SQLCipher-compatible cipher of better-sqlite3-multiple-ciphers) before any other statement. It then enables WAL mode, applies the migration when `PRAGMA user_version` is 0 and stores `user_version` 1. Each ingested event is written in one transaction together with its agent and task changes. When the database cannot be opened or a write fails, the module marks itself unavailable and every write throws `DbUnavailableError`; the next call tries to reopen once. A wrong key never creates a replacement database.

**Data model**
- `sessions` — `id` TEXT primary key; `user` TEXT not null; `project` TEXT not null; `transcript` TEXT nullable; `started_at` INTEGER not null; `ended_at` INTEGER nullable.
- `agents` — `session` TEXT not null, foreign key to `sessions.id`; `agent_key` TEXT not null ("boss" or the agent id); `name` TEXT not null; `is_boss` INTEGER not null default 0; `stage` TEXT not null default 'Thinking'; `last_ts` INTEGER not null; primary key (`session`, `agent_key`).
- `tasks` — `id` INTEGER primary key autoincrement; `session` and `agent_key` not null, foreign key to `agents`; `started_at` INTEGER not null; `ended_at` INTEGER nullable; `tokens_input`, `tokens_output`, `tokens_cache_creation`, `tokens_cache_read` INTEGER not null default 0; `tokens_incomplete` INTEGER not null default 0; index on (`session`, `agent_key`, `ended_at`); index on `started_at`.
- `events` — `id` INTEGER primary key autoincrement; `task_id` INTEGER nullable, foreign key to `tasks.id`; `ts` INTEGER not null; `hook` TEXT not null; `user`, `project`, `session`, `agent_key`, `agent_name` TEXT not null; `tool`, `file`, `notification` TEXT nullable; index on (`session`, `agent_key`, `ts`); index on `task_id`. No column can hold prompt text, code or file contents.

**Input validation**
Statements use bound parameters only, never string concatenation. Values come from events already validated by Block 1. `user_version` must be an integer no greater than the version this code knows.

**Error handling**
- The database cannot be opened or written: log the error once, mark the module unavailable and throw `DbUnavailableError` on writes.
- A write fails midway: the transaction rolls back and the error is raised, leaving no partial event.
- The database has a newer `user_version` than this code knows: refuse to start with an error naming the version.
- The key is wrong for an existing database: refuse to start with an error naming the key file and create no new database.

**Required tests**
- [ ] events and tasks written before closing the database are served after reopening it — validates AC-21
- [ ] events store the user, project, session and agent identifiers — validates AC-05
- [ ] inserting an event with extra fields leaves no content in any column — validates AC-07, AC-08
- [ ] a new database is encrypted with the key from the key file — validates AC-38
- [ ] the database file contains no readable user, project or path text when its bytes are searched as plain text — validates AC-40
- [ ] opening a database at an unwritable path marks it unavailable and writes fail with DbUnavailableError — validates AC-22
- [ ] a write that fails midway (injected error) rolls back and leaves no partial event — validates AC-22
- [ ] a database with a newer `user_version` is invalid and startup fails with an error naming the version
- [ ] a wrong key refuses to open the database with an error naming the key file and creates no new database — validates AC-39

**Completion criterion**
`db.test.ts` passes, including the reopen and plain-text search tests, and a database created by the migration has exactly the four tables and the indexes listed above.

## Block 3 — Stage derivation and task lifecycle

**Files**
- `src/server/state.ts` (new) — pure function `applyEvent(agent, event)` returning the new agent state, the task change and a `stale` flag.
- `src/server/state.test.ts` (new) — one test per rule.

**Logic**
The function has no I/O. Rules: Read, Grep and Glob before a tool call set Reading; Edit, Write and NotebookEdit set Editing; Bash and every other tool set Running; a finished tool (PostToolUse or PostToolUseFailure) and UserPromptSubmit set Thinking; PermissionRequest and a Notification of type `permission_prompt` set Waiting; Stop (boss) and SubagentStop (agent) set Done; SessionEnd sets Done for every agent of the session through the caller. SessionStart and SubagentStart change no stage. The first event of an agent with no open task, other than Stop, SubagentStop, SessionEnd and SessionStart, registers the agent if unknown and opens a task with that event's `ts` as start. Done closes the task with that `ts` as end; the next event after Done opens a new task. An event whose `ts` is older than the agent's `last_ts` leaves the stage unchanged and is flagged stale, because async hooks can arrive out of order.

**Input validation**
Events reach the function already validated by Block 1. The function treats `ts` as a non-negative integer and ignores any hook name outside the supported list.

**Error handling**
- An out-of-order event (older `ts`): stage unchanged, the event is still stored and flagged stale.
- An event whose hook carries no stage meaning (SessionStart, SubagentStart): no stage change.
- A Done event for an agent with no open task: no task is created.

**Required tests**
- [ ] a pre-tool event for Read, Grep or Glob sets Reading — validates AC-09
- [ ] a pre-tool event for Edit, Write or NotebookEdit sets Editing — validates AC-10
- [ ] a pre-tool event for Bash or an unlisted tool sets Running — validates AC-11
- [ ] a finished-tool event for an agent that has not stopped sets Thinking — validates AC-12
- [ ] the first event of an unknown agent registers it and applies the event — validates AC-13
- [ ] a PermissionRequest or a permission_prompt notification sets Waiting — validates AC-14
- [ ] Stop and SubagentStop set Done — validates AC-15
- [ ] the first event after Done or from an unknown agent opens a task with that event's time as start — validates AC-19
- [ ] reaching Done records the event's time as the task's end time — validates AC-20
- [ ] an out-of-order event is invalid for the stage: stage unchanged and flagged stale
- [ ] SessionStart and SubagentStart cause no stage change (missing stage meaning)
- [ ] a Done event for an agent with no open task creates no task and raises no error

**Completion criterion**
`state.test.ts` passes, and the module imports nothing that performs I/O (verified by importing it alone in the test).

## Block 4 — Event ingestion service on loopback

**Files**
- `src/server/app.ts` (new) — Express app: 64 KB JSON limit, Host and Origin guards, the auth middleware and pairing router from Block 9, Content-Type guard, `POST /events`, error handler.
- `src/server/ingest.ts` (new) — parses with Block 1, writes with Block 2, applies Block 3, emits changes on the bus.
- `src/server/bus.ts` (new) — typed emitter with `agentChanged`, `toolFinished`, `agentStopped` and `sessionEnded`, used by Blocks 5 and 6.
- `src/server/main.ts` (new) — start sequence: load the auth token and the database key (Block 8), open the database (Block 2), then listen on 127.0.0.1 and ::1 on the port from `AGENTS_OFFICE_PORT` (default 4317); exits with a message when the port is in use or a secret is invalid.
- `src/server/ingest.test.ts` (new) — HTTP-level tests with supertest-style requests against the app.

**Logic**
Guards run in a fixed order: Host and Origin (403), auth token (401), content type (415), body size (413), JSON parse (400), validation (422). The handler then stores the event and applies the reducer inside one database transaction, answers 202 and emits on the bus. Listening binds 127.0.0.1 and ::1 only; if ::1 is unavailable the server logs that and keeps 127.0.0.1. No CORS headers are sent. The allowed Host values are `127.0.0.1:PORT`, `localhost:PORT` and `[::1]:PORT`; an Origin header is accepted only when it equals the server's own origin, so pages from other sites are refused.

**API contract**
- Method + path: `POST /events`
- Request: header `Authorization: Bearer <auth token>`; header `Content-Type: application/json`; body is an `OfficeEvent` as defined in Block 1 (`v`, `ts`, `hook`, `user`, `project`, `session`, `agent_id`, `agent`, optional `tool`, `file`, `notification`, `transcript`); body at most 64 KB; no `Origin` header, or one equal to the server's own origin.
- Response: status 202 with `{"ok": true}`.
- Error codes: 400 `{"error":"invalid_json"}`; 401 `{"error":"unauthorized"}`; 403 `{"error":"forbidden"}`; 413 `{"error":"too_large"}`; 415 `{"error":"unsupported_media_type"}`; 422 `{"error":"invalid_event","field":"<path>"}`; 503 `{"error":"database_unavailable"}`.
- Auth: the auth token, sent as a Bearer header or as the pairing cookie; the server also listens on loopback only and applies the Host and Origin checks.

**Input validation**
Body must be JSON of at most 64 KB; fields are validated by Block 1 (type, maximum length, allowed values); unknown fields are discarded; the Host header must be in the allowed list; the Origin header must be absent or equal to the server's own origin; the Authorization header must match `Bearer` followed by 64 hexadecimal characters.

**Error handling**
- The body is not valid JSON: 400, nothing stored.
- The body is larger than 64 KB: 413, nothing stored.
- The content type is not application/json: 415, nothing stored.
- The auth token is absent or wrong: 401, nothing stored.
- The Origin is another site or the Host is not loopback: 403, nothing stored.
- The event fails validation (wrong type, missing field or missing identifier): 422 naming the field, nothing stored.
- The database is unavailable: 503, the event is not stored.
- The configured port is already in use: startup fails with a message naming the port and the process exits with status 1.

**Required tests**
- [ ] a valid event with a valid auth token returns 202 and is stored with its identifiers — validates AC-01, AC-05, AC-31
- [ ] a request with no auth token returns 401 and stores nothing — validates AC-32
- [ ] a request with a wrong auth token returns 401 and stores nothing — validates AC-32
- [ ] a body that is not JSON returns 400 and stores nothing — validates AC-02
- [ ] a body over 64 KB returns a 413 error and stores nothing — validates AC-04
- [ ] a text/plain body returns a 415 error and stores nothing (cross-origin simple request)
- [ ] a request with the Origin of another site or a foreign Host returns 403 forbidden and stores nothing — validates AC-26
- [ ] an event missing `session` returns 422 naming the field — validates AC-03, AC-06
- [ ] an event with `ts` of the wrong type returns 422 invalid_event — validates AC-03
- [ ] an event with extra fields stores none of them — validates AC-07
- [ ] a file-edit event stores the path and no edited text — validates AC-08
- [ ] with the database unavailable the service returns a 503 error and stores nothing — validates AC-22
- [ ] a connection through a non-loopback address fails — validates AC-26
- [ ] starting on a port already in use fails with an error naming the port — validates AC-27
- [ ] an event stream of 50 events per second for 10 seconds stores all 500 events — validates NFR-03

**Completion criterion**
`ingest.test.ts` passes, `pnpm dev` starts the server on 127.0.0.1:4317 and a manual POST with a valid event and the auth token returns 202 while the same POST without the token returns 401.

## Block 5 — Token usage tracking from transcripts

**Files**
- `src/server/tokens.ts` (new) — incremental transcript reader and path guard.
- `src/server/tokens.test.ts` (new) — tests with fixtures.
- `src/server/fixtures/transcript-sample.jsonl` (new) — hand-written lines carrying numbers only, no text.

**Logic**
On `toolFinished` and `agentStopped` from the bus, resolve the transcript file: for the boss, the session's `transcript` path; for a subagent, `<directory of the transcript>/<session>/subagents/agent-<agent_id>.jsonl` (layout and `agentId` equal to the file suffix verified on this machine against real transcripts). Read from the saved byte offset up to the last complete newline, at most 8 MB per read. For each line of type `assistant` with `message.usage`, collect `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` keyed by `message.id`: the same id appears on several lines with identical usage (163 lines for 74 ids in a real transcript), so each id counts once. Add the delta to the agent's open task through `addTokens`, move the offset and emit `agentChanged`. Only these numeric fields are kept from a parsed line. The total reported to clients is the sum of the four counters, which stay separate in storage.

**Input validation**
The path must resolve, after realpath, inside `~/.claude/projects` and end with `.jsonl`. Each line must parse as JSON and each usage value must be a non-negative integer.

**Error handling**
- The path is outside the allowed directory or not `.jsonl`: the file is not read and the task is flagged tokens-incomplete.
- The file is missing or unreadable: nothing is added and the task is flagged tokens-incomplete.
- A line is not valid JSON or a usage value is not a non-negative integer: the line is skipped and the task is flagged tokens-incomplete.
- The last line has no newline yet: it stays unread until it is complete.

**Required tests**
- [ ] the four counters of assistant lines are summed into the open task — validates AC-16
- [ ] several lines with the same message id count once — validates AC-16
- [ ] a second read adds only the new lines since the saved offset — validates AC-16
- [ ] the subagent file is resolved from the agent id and the session directory — validates AC-16
- [ ] the result of a read contains numbers only and no text from the transcript — validates AC-17
- [ ] an invalid path (outside the projects directory or not .jsonl) is not read and flags tokens-incomplete — validates AC-18
- [ ] a missing transcript file leaves the total unchanged and flags tokens-incomplete — validates AC-18
- [ ] a line that is not JSON, or has a negative usage value, is skipped as invalid and flags tokens-incomplete — validates AC-18
- [ ] a partial last line is not counted until its newline arrives, with no error

**Completion criterion**
`tokens.test.ts` passes and, against a real transcript copied locally, the summed counters match a manual count of distinct message ids.

## Block 6 — Live stream with Server-Sent Events

**Files**
- `src/server/stream.ts` (new) — hub that registers clients, sends the snapshot and broadcasts bus changes.
- `src/server/app.ts` (modified) — mounts `GET /stream` using the same guards as Block 4.
- `src/server/stream.test.ts` (new) — tests with real SSE clients against the app.

**Logic**
A new client that passes the guards receives one `snapshot` message with every agent and its open task, then one `update` message for each change published on the bus (stage, token total, task start or end). A comment line is sent every 15 seconds to keep idle connections open. A close or a failed write removes the client from the hub and releases its resources. No CORS headers are sent, so pages from other origins cannot read the stream.

**API contract**
- Method + path: `GET /stream`
- Request: header `Accept: text/event-stream`; the auth token as `Authorization: Bearer <auth token>` or the pairing cookie; no body and no query parameters (ignored if present).
- Response: status 200 `text/event-stream`; first message `event: snapshot` with data `{"agents":[...]}`; then `event: update` messages with data `{"session","agent_key","name","stage","task":{"id","started_at","ended_at","tokens":{"input","output","cache_creation","cache_read","total","incomplete"}}}`.
- Error codes: 401 `{"error":"unauthorized"}` when the auth token or cookie is absent or wrong; 403 `{"error":"forbidden"}` when the Origin is another site or the Host is not loopback; 503 `{"error":"database_unavailable"}` when the snapshot cannot be built.
- Auth: the auth token or the pairing cookie from Block 9; the Host and Origin checks of Block 4 apply.

**Input validation**
The Host header must be in the loopback list, the Origin header must be absent or equal to the server's own origin, the credentials must be valid, and any query parameter is ignored.

**Error handling**
- The auth token or cookie is absent or wrong: 401, no stream.
- The Origin is another site or the Host is not loopback: 403, no stream.
- The database is unavailable while building the snapshot: 503 and the connection closes.
- A client disconnects: its resources are released and the other clients are unaffected.
- A write to one client fails: that client is dropped and the others keep receiving updates.

**Required tests**
- [ ] a new client with a valid token receives the snapshot first and then later changes — validates AC-23, AC-31
- [ ] a stage, token total or task-time change reaches every connected client — validates AC-24
- [ ] an update reaches the client within 300 ms of the event, measured over 200 events at p95 — validates NFR-01
- [ ] a client that disconnects releases its resources and the other client keeps receiving updates without error — validates AC-25
- [ ] a client whose write fails (injected error) is dropped and the others keep receiving updates — validates AC-25
- [ ] a request without a token or cookie returns 401 and streams nothing — validates AC-32
- [ ] a request with a foreign Host or the Origin of another site returns 403 forbidden
- [ ] a snapshot that cannot be built because the database is unavailable returns a 503 error

**Completion criterion**
`stream.test.ts` passes and `curl -N -H "Authorization: Bearer <auth token>" http://127.0.0.1:4317/stream` prints the snapshot and then updates while events are sent to the server.

## Block 7 — Hook script and installation instructions

**Files**
- `hooks/agents-office-hook.mjs` (new) — reads the hook JSON from stdin and the auth token from the token file, builds an event with only the allowed fields, sends it to the local server and always exits 0.
- `hooks/agents-office-hook.test.ts` (new) — tests against a stub server.
- `docs/install-hooks.md` (new) — the settings snippet for the user-level Claude Code settings and how to start the server.

**Logic**
Map `hook_event_name` to `hook`, `session_id` to `session`, the base name of `cwd` to `project`, `agent_id` to `agent_id` (null when absent), `agent_type` to `agent` ("boss" when absent), `tool_name` to `tool`, the string value of `tool_input.file_path` or `tool_input.notebook_path` to `file`, `notification_type` to `notification` and `transcript_path` to `transcript`. The user comes from `os.userInfo().username` and `ts` from `Date.now()`. Nothing else is read: `prompt`, `tool_output`, `last_assistant_message`, `message` and the rest of `tool_input` are never forwarded. The script reads the auth token from the `token` file in the data directory (`AGENTS_OFFICE_HOME`, default `~/.agents-office`) and never logs it. It sends an HTTP request with `Content-Type: application/json` and `Authorization: Bearer <auth token>` to the events URL at `127.0.0.1` and the port from `AGENTS_OFFICE_PORT` (default 4317), aborted after 800 ms. The documented configuration registers the script as a command hook with `async: true` and a short timeout for PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, SubagentStart, SubagentStop, Stop, UserPromptSubmit, SessionStart and SessionEnd.

**Input validation**
The text on stdin must be valid JSON with a `hook_event_name` from the supported list; the file path is kept only when it is a string; the token file content must be 64 hexadecimal characters; anything else is dropped.

**Error handling**
- The server is unreachable or slower than 800 ms: the script exits 0 without output.
- The text on stdin is not valid JSON or is empty: the script exits 0 and sends nothing.
- The hook name is not supported: nothing is sent and the script exits 0.
- The token file is missing or unreadable: nothing is sent and the script exits 0.
- An unexpected exception: it is caught and the script exits 0.

**Required tests**
- [ ] a hook JSON for an edit sends only the allowed fields — validates AC-28
- [ ] the script reads the auth token from the token file and sends it in the Authorization header — validates AC-34
- [ ] a hook JSON carrying a prompt, a tool output and file contents never reaches the stub server — validates AC-30
- [ ] with the server down the request ends in a connection error and the script still exits 0 within 1 second — validates AC-29
- [ ] a missing token file makes the script send nothing and exit 0 — validates AC-35
- [ ] invalid JSON on stdin makes the script exit 0 and send nothing
- [ ] an unsupported hook name is invalid: nothing is sent and the exit status is 0
- [ ] an unexpected exception inside the script is caught: exit 0 and no error shown to Claude Code
- [ ] 50 runs against the stub finish with p95 below 200 ms — validates NFR-02

**Completion criterion**
`agents-office-hook.test.ts` passes, and after following `docs/install-hooks.md` a real Claude Code session shows its events arriving at the running server.

## Block 8 — Secrets: auth token and database key files

**Files**
- `src/server/secrets.ts` (new) — creates, reads and checks the auth token file and the database key file in the data directory.
- `src/server/secrets.test.ts` (new) — tests with temporary directories.

**Logic**
The data directory is `~/.agents-office` (override `AGENTS_OFFICE_HOME`) and must resolve inside the user's home directory. It holds the files `token` and `db.key`. A missing file is created with 32 bytes from `crypto.randomBytes`, stored as 64 hexadecimal characters; an existing file is never overwritten. On POSIX systems the directory is created with mode 0700 and the files with mode 0600, and a file with group or other permission bits is refused at read time. On Windows, mode bits do not exist, so protection relies on the user profile directory permissions, which deny other standard users; this is why the directory must live inside the home directory. `tokenMatches(candidate)` compares with `crypto.timingSafeEqual` after checking the length. `loadKey({ dbExists })` returns the key, creating it only when no database exists yet; a missing key with an existing database is an error, because creating a new key would make the stored data unreadable. The server prints the path of the token file at startup and never the token.

**Input validation**
Each secret file must contain exactly 64 hexadecimal characters. The data directory path must resolve inside the user's home directory.

**Error handling**
- A secret file exists but its content is not 64 hexadecimal characters: startup fails with an error naming the file and the file is not overwritten.
- The key file is missing while the database exists: `KeyMissingError` naming the key file, and no new database is created.
- On POSIX, a secret file has group or other permission bits: startup fails with an error naming the file and its mode.
- The data directory resolves outside the user's home directory: startup fails with an error.

**Required tests**
- [ ] the first start creates the token file with 64 hexadecimal characters holding 32 random bytes, and two fresh directories get different tokens — validates AC-33, NFR-05
- [ ] the first start creates the key file the same way when no database exists — validates AC-38, NFR-05
- [ ] on POSIX the directory has mode 0700 and the files mode 0600 (skipped on Windows because it has no mode bits) — validates AC-33, AC-38
- [ ] a second call returns the same token and does not overwrite the file
- [ ] `tokenMatches` accepts the right token and rejects a wrong token and a token of the wrong length — validates AC-31, AC-32
- [ ] a token file with content that is not 64 hexadecimal characters is invalid and startup fails with an error naming the file
- [ ] a missing key file with an existing database throws KeyMissingError naming the key file — validates AC-39
- [ ] on POSIX a secret file with group or other permission bits is refused with an error naming the file and its mode
- [ ] a data directory outside the home directory is invalid and startup fails with an error

**Completion criterion**
`secrets.test.ts` passes and, after a first start, `~/.agents-office/token` and `db.key` exist with 64 hexadecimal characters each.

## Block 9 — Access control and browser pairing

**Files**
- `src/server/auth.ts` (new) — middleware that accepts the Bearer auth token or the pairing cookie, and the router for `POST /pair`.
- `src/server/auth.test.ts` (new) — tests with a minimal Express app.

**Logic**
The middleware reads `Authorization: Bearer <64 hexadecimal characters>` and checks it with `tokenMatches` from Block 8, or reads the `ao_session` cookie and looks it up in an in-memory map of pairing sessions. `POST /pair` checks the token from the request body with `tokenMatches`, creates a random session id (32 bytes, hexadecimal), keeps it in the map (at most 50 sessions, oldest dropped first) and answers 204 with `Set-Cookie: ao_session=<id>; HttpOnly; SameSite=Strict; Path=/`. The cookie never contains the auth token, and the map is empty after a restart, so browsers pair again. The router and the middleware are mounted by Block 4.

**API contract**
- Method + path: `POST /pair`
- Request: header `Content-Type: application/json`; body `{"token": "<64 hexadecimal characters>"}`, at most 1 KB; no `Origin` header, or one equal to the server's own origin.
- Response: status 204 with no body and the `Set-Cookie` header described above.
- Error codes: 400 `{"error":"invalid_json"}`; 401 `{"error":"unauthorized"}`; 403 `{"error":"forbidden"}`; 413 `{"error":"too_large"}`; 415 `{"error":"unsupported_media_type"}`.
- Auth: the request body carries the auth token itself; the token is never accepted in a URL or query string.

**Input validation**
The Authorization header must match `Bearer` followed by 64 hexadecimal characters; the cookie value must be 64 hexadecimal characters; the pairing body must be a JSON object with a string `token` of exactly 64 hexadecimal characters and at most 1 KB in size.

**Error handling**
- No auth token or a wrong auth token on a protected route: 401, nothing processed.
- Pairing with a wrong token: 401 and no cookie set.
- The pairing body is not JSON (400), is larger than 1 KB (413) or has another content type (415).
- A cookie unknown to the server, for example from before a restart: 401, so the browser pairs again.

**Required tests**
- [ ] a request with a valid Bearer auth token is let through — validates AC-31
- [ ] a request with no token returns 401 on the events route and on the stream route — validates AC-32
- [ ] a request with a wrong token returns 401 — validates AC-32
- [ ] pairing with the right token answers 204 and sets an HttpOnly cookie with SameSite=Strict, and the cookie value differs from the token — validates AC-36
- [ ] the pairing cookie grants access to the stream route — validates AC-36
- [ ] pairing with an invalid token returns 401 and sets no cookie — validates AC-37
- [ ] a cookie unknown to the server returns 401 — validates AC-32
- [ ] a pairing body that is not JSON returns 400
- [ ] a pairing body larger than 1 KB returns a 413 error
- [ ] a pairing body with a text/plain content type returns a 415 error

**Completion criterion**
`auth.test.ts` passes, and a manual `POST /pair` with the right token returns 204 with the cookie while a wrong token returns 401.

## Final verification

With the server running and the hooks installed, a Claude Code session that asks a subagent to edit a file produces, in order, events whose stages go Thinking, Reading, Editing and Done for that agent, the token usage counters increase, the same changes arrive on `GET /stream` for a client with the auth token or the pairing cookie, and restarting the server keeps every stored task. Requests without the auth token get 401. Searching the database file as plain text finds no user, project or path. `pnpm test --coverage` passes with 80% or more of lines, branches and functions. No stored row and no stream message contains prompt text, code or file contents.

Rollback: the database, the auth token and the database key are new, local and created by this ticket, so reverting the commits and deleting `~/.agents-office` restores the previous state; the migration is forward-only and nothing else depends on it. Deleting `db.key` while keeping `office.db` makes the stored data unreadable, which is why the server refuses to start in that case.
