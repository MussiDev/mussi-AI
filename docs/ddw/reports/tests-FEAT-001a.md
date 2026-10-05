# Test run FEAT-001a

| Field | Value |
|---|---|
| Runner | Vitest 5.0.3 with v8 coverage |
| Command | `pnpm test --coverage` (runs `vitest run --coverage`) |
| Total | 472 |
| Passed | 467 |
| Failed | 0 |
| Skipped | 5 |
| Line coverage | 98.8% |
| Branch coverage | 93.84% |
| Function coverage | 98.3% |
| Coverage floor | 80% for lines, branches and functions (docs/ddw/prd/prd-FEAT-001a.md NFR-04; enforced by the thresholds in vitest.config.ts) |
| Lint | no linter is configured in package.json; type check `pnpm build` (`tsc --noEmit`) finished with 0 errors |

The run was made on 2026-10-05 over the whole suite: 9 test files (`src/server/*.test.ts`, `src/shared/events.test.ts` and `hooks/agents-office-hook.test.ts`), about 30 seconds. Coverage is measured over `src/**`; the hook script under `hooks/` is outside the configured coverage include and is exercised by 61 tests that import it and spawn it. The numbers are the account of the run made by the implementer and the orchestrator; the command above reproduces them.

## Failures
(none)

## Skips
- `src/server/secrets.test.ts` > loadOrCreateToken > sets directory 0700 and file 0600 (AC-33): skipped because Windows has no POSIX mode bits; the same refusal logic is covered on every platform by the pure function tests of `assertSecureMode`.
- `src/server/secrets.test.ts` > loadOrCreateToken > refuses a token file with group/other bits: skipped because Windows has no POSIX mode bits (reason in the test name); covered everywhere by `assertSecureMode`.
- `src/server/secrets.test.ts` > loadOrCreateToken > refuses a data directory with group/other bits: skipped because Windows has no POSIX mode bits (reason in the test name); covered everywhere by `assertSecureMode`.
- `src/server/secrets.test.ts` > loadKey > sets the key file to 0600 (AC-38): skipped because Windows has no POSIX mode bits (reason in the test name); covered everywhere by `assertSecureMode`.
- `src/server/secrets.test.ts` > loadKey > refuses a key file with group/other bits: skipped because Windows has no POSIX mode bits (reason in the test name); covered everywhere by `assertSecureMode`.

## Known gaps in this evidence
- The five skipped tests run only on Linux or macOS; no CI exists, so the real-filesystem mode checks have never run in this repository.
- The comparison of the token usage reader against a real transcript (second half of the Block 5 completion criterion) and the end-to-end check with a real Claude Code session (second half of the Block 7 completion criterion) were not run: reading the user's real transcripts and starting a server from the shell were denied by the permission system and were not worked around.
- The latency figures (stream update p95 of about 1 to 2 ms, hook script p95 of about 75 ms) were measured on one machine, sequentially, against local stubs.
