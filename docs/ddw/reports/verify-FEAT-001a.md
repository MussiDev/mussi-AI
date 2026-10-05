# Verification FEAT-001a

| Field | Value |
|---|---|
| Module | Event pipeline: `src/shared/events.ts`, `src/server/*`, `hooks/agents-office-hook.mjs` |
| PRD | `docs/ddw/prd/prd-FEAT-001a.md` (16 FR, 5 NFR, 41 AC; amended twice) |
| Spec | `docs/ddw/specs/spec-FEAT-001a.md` (9 blocks, 87 required-test bullets; amended twice) |
| Line coverage | 98.8% |
| Branch coverage | 93.84% |
| Function coverage | 98.3% |
| Coverage floor | 80% for lines, branches and functions (docs/ddw/prd/prd-FEAT-001a.md NFR-04; thresholds in vitest.config.ts) |
| Lint | no linter is configured in package.json; type check `tsc --noEmit` (`pnpm build`) is clean |

Method: three independent verifiers (agents that did not write the code, read-only) split the work: AC-01 to AC-20, AC-21 to AC-41 with the NFRs, and the spec blocks with quality and numbers. Each criterion was traced to the implementing function and to the test that verifies the behavior, and the test files were run by the verifiers. The numbers are the account of runs made in this session (`pnpm test --coverage`: 9 files, 467 passed, 5 skipped, 0 failing); DDW does not run the suite and this report does not prove that it passes.

## Acceptance criteria
- ✅ AC-01 — `ingest.test.ts` valid event with a valid auth token returns 202 and is stored with its identifiers (`app.ts:ingest`).
- ✅ AC-02 — `ingest.test.ts` a body that is not JSON returns 400 `invalid_json` and stores nothing (`app.ts:finalHandler`).
- ✅ AC-03 — `ingest.test.ts` missing `session` and wrong-type `ts` return 422 naming the field; `events.test.ts` rejects a string `ts` (`events.ts:parseEvent`). Note: over HTTP only `ts` is exercised as the wrong type.
- ✅ AC-04 — `ingest.test.ts` a 70 KB body returns 413 `too_large` and stores nothing (`app.ts` 64 KB parser).
- ✅ AC-05 — `ingest.test.ts` and `db.test.ts` read user, project, session and agent back from the encrypted database (`ingest.ts:store`).
- ⚠️ AC-06 — `ingest.test.ts` missing `session` returns 422; `events.test.ts` empty `user`, `project`, `agent`. Only `session` is tested as omitted; the code is one generic required-field check, so this is a coverage gap and not a defect.
- ✅ AC-07 — `ingest.test.ts` extra fields are stored nowhere (dump of all four tables); `events.test.ts` discards `tool_input` and `prompt` (`events.ts:OfficeEvent`).
- ✅ AC-08 — `ingest.test.ts` file-edit event stores the path and no edited text; `db.test.ts` no content column (`ingest.ts:store`).
- ✅ AC-09 — `state.test.ts` Read, Grep and Glob set Reading (`state.ts:preToolStage`).
- ✅ AC-10 — `state.test.ts` Edit, Write and NotebookEdit set Editing (`state.ts:preToolStage`).
- ✅ AC-11 — `state.test.ts` Bash, unlisted tools, empty and missing tool set Running (`state.ts:preToolStage`).
- ✅ AC-12 — `state.test.ts` PostToolUse and PostToolUseFailure set Thinking (`state.ts:stageFor`). Note: the "has not stopped" qualifier has no explicit test.
- ✅ AC-13 — `state.test.ts` registers an unknown agent and applies the event; `ingest.test.ts` persists a never-seen subagent (`state.ts:applyEvent`, `ingest.ts:applyToAgent`).
- ✅ AC-14 — `state.test.ts` PermissionRequest and permission_prompt set Waiting (`state.ts:stageFor`). Note: unit level only; no HTTP test persists Waiting.
- ✅ AC-15 — `state.test.ts` Stop and SubagentStop set Done; `ingest.test.ts` persisted stage is Done after Stop (`state.ts:stageFor`).
- ✅ AC-16 — `tokens.test.ts` four counters summed, same message id once, only new lines on a second read, subagent file resolved, final delta on stop; `ingest.test.ts` wires the tracker end to end (`tokens.ts:collect`).
- ✅ AC-17 — `tokens.test.ts` transcript text never reaches the database, the bus, the logs or an exception (`tokens.ts:parseChunk`, `readUsage`).
- ✅ AC-18 — `tokens.test.ts` missing file keeps the total and flags the task; path outside the projects directory, non-`.jsonl` file and invalid lines are skipped and flagged (`tokens.ts:collect`, `flag`).
- ✅ AC-19 — `state.test.ts` every start-of-work event opens a task after Done and for an unknown agent; `ingest.test.ts` task rows with start 4000 (`state.ts:applyEvent`).
- ✅ AC-20 — `state.test.ts` Done closes the task at the event time; `ingest.test.ts` reads start 1000 and end 2000 from the database (`state.ts:applyEvent`, `db.ts:closeTask`).
- ⚠️ AC-21 — `db.test.ts` serves events and tasks written before closing after reopening it (`db.ts:connect`). Note: events are only counted; a closed task, its end time and its tokens are not read back, and no restart goes through `startServer`.
- ✅ AC-22 — `ingest.test.ts` 503 with nothing stored; `db.test.ts` handle marked unavailable and one log line carrying only the exception class name (`db.ts:ensure` and the handle's unavailable-marking method).
- ✅ AC-23 — `stream.test.ts` snapshot first and then the later changes to a client with a valid token (`stream.ts:handler`).
- ✅ AC-24 — `stream.test.ts` stage, token total and task start and end changes reach every connected client; token counters flow from the real tracker (`stream.ts:onStreamAgentChanged`).
- ✅ AC-25 — `stream.test.ts` a disconnected client is released while the other keeps receiving; a client whose write throws is dropped (`stream.ts:drop`).
- ✅ AC-26 — `ingest.test.ts` connection through the LAN address is refused; `::1` answers; `::1` fallback keeps 127.0.0.1 (`main.ts:startServer`). Note: those two real-network tests skip themselves on hosts without a LAN address or without `::1`; both ran.
- ⚠️ AC-27 — `ingest.test.ts` a port already in use returns exit code 1 with a message naming the port (`main.ts:startServer`, `runMain`). Note: the real `process.exit` call (`main.ts:156-161`) is excluded from coverage and never executed by a test.
- ✅ AC-28 — `agents-office-hook.test.ts` an edit hook JSON sends exactly the allowed fields; the real `parseEvent` accepts all 11 hooks for boss and subagent (`agents-office-hook.mjs:buildEvent`).
- ✅ AC-29 — `agents-office-hook.test.ts` server down exits 0 within 1 second with no output; a server that never answers; three injected crashes (`agents-office-hook.mjs:run`, safety timer).
- ✅ AC-30 — `agents-office-hook.test.ts` markers planted in prompt, tool response, content, old string and command never appear in body, URL or headers (`agents-office-hook.mjs:buildEvent`).
- ✅ AC-31 — `ingest.test.ts`, `stream.test.ts` and `auth.test.ts` a valid Bearer token is processed on both routes (`auth.ts:middleware`).
- ✅ AC-32 — `ingest.test.ts` and `stream.test.ts` no token, wrong token and unknown cookie return 401 with nothing stored or streamed (`auth.ts:middleware`).
- ⚠️ AC-33 — `secrets.test.ts` token file created with 64 hex characters; directory 0700 and file 0600 checked only by a POSIX test that is skipped on this Windows machine (`secrets.ts:loadOrCreateToken`). Note: on Windows protection relies on the inherited profile ACL and is not tested; `assertSecureMode` is covered on every platform by pure tests.
- ✅ AC-34 — `agents-office-hook.test.ts` exact Bearer token from the token file, no Origin header, loopback host only (`agents-office-hook.mjs:readToken`, `run`).
- ✅ AC-35 — `agents-office-hook.test.ts` missing, malformed, directory and oversized token files send nothing and exit 0 (`agents-office-hook.mjs:readToken`).
- ✅ AC-36 — `auth.test.ts` and `stream.test.ts` pairing answers 204 with an HttpOnly SameSite=Strict cookie different from the token, and the cookie opens the stream (`auth.ts:pairHandler`).
- ✅ AC-37 — `auth.test.ts` and `ingest.test.ts` an invalid token gets 401, no cookie and no session (`auth.ts:pairHandler`).
- ⚠️ AC-38 — `db.test.ts` the database is unreadable without the key and readable with it; `secrets.test.ts` key file created with 64 hex characters; key file mode checked only by a POSIX test skipped on this machine (`db.ts:connect`, `secrets.ts:loadKey`). Note: same Windows gap as AC-33.
- ✅ AC-39 — `db.test.ts` and `ingest.test.ts` missing key with an existing database and a wrong key both refuse to start naming the key file and create nothing new (`secrets.ts:loadKey`, `db.ts:connect`).
- ✅ AC-40 — `db.test.ts` user, project and path text absent from the database and WAL bytes, with a control on an unencrypted database proving the search can find them (`db.ts:connect`).
- ✅ AC-41 — `state.test.ts` and `ingest.test.ts` idle and other notifications, SessionStart, SubagentStart, Stop, SubagentStop and SessionEnd never open a task; the next prompt starts at its own time (`state.ts:applyEvent`).

## Non-functional requirements
- ✅ NFR-01 — stream update latency: `stream.test.ts` p95 0.83 ms over 200 events, and 1.26 ms with the token tracker and a real transcript (limit 300 ms); measured on one machine against loopback with one client.
- ✅ NFR-02 — hook runtime: `agents-office-hook.test.ts` p95 58.7 ms and 60.9 ms over 50 spawned runs (limit 200 ms), against a local stub and not the real server.
- ✅ NFR-03 — 50 events per second: `ingest.test.ts` 500 of 500 events answered 202 and stored in about 10.2 seconds, paced; `db.test.ts` 500 inserts in transactions.
- ✅ NFR-04 — coverage floor: project lines 98.8%, branches 93.84%, functions 98.3%; no source file under 80% on any metric.
- ⚠️ NFR-05 — 256-bit secrets: `secrets.test.ts` 64 hex characters decoding to 32 bytes and different tokens in two fresh directories. Note: the use of a cryptographically secure generator is not testable; replacing `randomBytes` with a weak generator would still pass.

## Spec blocks
- ✅ Block 1 — scaffold and shared event definition: all files present; data model, limits and parse helper match; 5 required tests present.
- ✅ Block 2 — encrypted persistence: four tables and their indexes, key applied first, WAL, `user_version`, unavailable handling; all required tests present.
- ✅ Block 3 — stage derivation: pure reducer, AC-41 rule, stale handling, unsupported hooks ignored; all required tests present including the two added after the amendment.
- ✅ Block 4 — loopback ingestion service: guard order, one transaction per event, bus, loopback listeners, startup validation; all 15 required tests present.
- ✅ Block 5 — token usage tracking: cursor, 8 MB cap, dedupe by message id, path guard, deferred reads, release on session end; all required tests present.
- ⚠️ Block 6 — live stream: all contract points and required tests present. Deviations: entries carry the additive fields `is_boss`, `project` and `session_ended_at`, `task` is the latest task open or closed, and the snapshot is the whole stored history (tracked as `TODO(FEAT-001b)`).
- ⚠️ Block 7 — hook script and guide: all files and required tests present. Deviations: a subagent whose hook JSON has no `agent_type` is sent as `agent` "agent" (the spec says "boss" when `agent_type` is absent, which applies to boss events and is kept); the shipped script contains a test-only crash switch.
- ⚠️ Block 8 — secrets files: all files and required tests present. Deviations: the signatures are `tokenMatches(expected, candidate)` and `loadKey(dataDir, { dbExists })`; five POSIX mode tests are skipped on Windows.
- ✅ Block 9 — access control and pairing: Bearer or cookie middleware, pairing route, 50-session cap, cookie flags, 400, 401, 413 and 415 paths; all required tests present.

## Tests
- ✅ Spec tests: the spec lists 87 required-test bullets; all 87 are matched to an existing test and the suite has no failing test. Two matches are loose because they are the POSIX-only mode tests (skipped on Windows, covered on every platform by the pure `assertSecureMode` tests).
- ✅ Sad-path tests: every input surface has a test with invalid input: the event route (401, 400, 413, 415, 403, 422, 503), the pairing route (401, 400, 413, 415, foreign Origin), the stream route (401, 403, 503, token in the query string ignored), malformed Authorization headers and cookies, the hook's stdin (invalid JSON, empty, oversized, never closing) and its environment (port, token file), and the transcript reader (invalid lines, missing file, path outside the directory, hostile ids). Only `AGENTS_OFFICE_DB` has just happy-path tests plus one indirect unwritable-path test.
- ✅ Skipped tests: 5, all in `src/server/secrets.test.ts`, each marked "POSIX only: Windows has no mode bits".

## Coverage by file (lines, branches, functions)
`app.ts` 100, 95, 100; `auth.ts` 100, 100, 100; `bus.ts` 100, 100, 100; `db.ts` 98.85, 93.1, 100; `ingest.ts` 100, 100, 100; `main.ts` 100, 95.65, 94.11; `secrets.ts` 100, 93.02, 100; `state.ts` 100, 100, 100; `stream.ts` 99.06, 83.33, 95.65; `tokens.ts` 96.9, 92.15, 97.36; `src/shared/events.ts` 100, 100, 100. The hook script under `hooks/` is outside the coverage include and is exercised by 61 tests (about 65% of its lines in process, the rest only through spawned processes). Only `stream.ts` branches fall between 80% and 90%.

## Warnings (reported, none blocks)
- Dead or test-only code in production files: `IS_WINDOWS` unused in `secrets.ts:21`; `ApplyResult.registered` in `state.ts:22` never read by production code; `listSessions`, `isAvailable` in `db.ts`, `clientCount` and `trackedAgents` in `stream.ts`, `sessionCount` in `auth.ts`, `flush` and `stats` in `tokens.ts`, `describeError` in `main.ts`, and `STAGES` in `events.ts` are used only by tests or kept for FEAT-001b; `injectCrash` and the `AGENTS_OFFICE_HOOK_TEST_CRASH` switch in the hook script (`agents-office-hook.mjs:226-257`) exist only for tests. No commented-out code and no unused imports.
- Fragile tests: a real-clock pacing loop for the 10 second load test (`ingest.test.ts:478-482`); fixed sleeps of 20 to 120 ms used to assert that nothing else arrives (`ingest.test.ts:1075`, `stream.test.ts:477,492,918,935,1115`); p95 latency limits on the real clock (`stream.test.ts:467,1007`, `agents-office-hook.test.ts:560`); wall-clock bounds of 1 to 2 seconds on spawned processes; tests that depend on the machine's LAN address and on `::1` (they self-skip with a reason); timestamps derived from `Date.now()`. No fixed ports and no order dependence.
- Evidence weaker than it looks: AC-33 and AC-38 file permissions were never exercised on a POSIX system; AC-21 reads back less than it should after a reopen; AC-27 leaves the real `process.exit` untested; AC-06 omits only `session`; NFR-05 cannot prove a CSPRNG; NFR-02 is timed against a stub.
- Deviations from the spec text, all recorded in the block summaries above and in the commits: additive stream fields, latest task in the stream, the `tokenMatches` and `loadKey` signatures, the agent name for a subagent without a type, the 500 `internal_error` default, and the extra files `hooks/agents-office-hook.d.mts`, `pnpm-workspace.yaml` and `src/server/sqlite-types.d.ts`.
- The "tests written first" practice rests on the implementers' reports in this session: every commit adds code and tests together, so git history cannot show that the tests came first.

## Not verified
- The comparison of the token usage reader against a real transcript and the run of a real Claude Code session against the running server (second halves of the Block 5 and Block 7 completion criteria) were not done: they need reading the user's real transcripts and starting a server, which the permission system denied and which were not worked around.
- The five POSIX permission tests have never run in this repository; there is no CI.

Result: PASSED
