# Threat model FEAT-001a: Event pipeline: hooks, local server, persistence, live stream

| Field | Value |
|-------|-------|
| Ticket | FEAT-001a |
| Spec | docs/ddw/specs/spec-FEAT-001a.md |
| Tier | FEATURE |
| Date | 2026-10-04 |

## Components

The pure modules `src/server/state.ts` and `src/server/bus.ts` take no data from outside the process and perform no I/O, so they are analyzed through `src/server/ingest.ts`, which feeds them.

| Component | Source in the spec |
|---|---|
| `hooks/agents-office-hook.mjs` | Block 7 |
| `src/shared/events.ts` | Block 1 |
| `src/server/secrets.ts` | Block 8 |
| `src/server/auth.ts` | Block 9 |
| `src/server/app.ts` | Block 4, Block 6 |
| `src/server/ingest.ts` | Block 4 |
| `src/server/main.ts` | Block 4 |
| `src/server/db.ts` | Block 2 |
| `src/server/tokens.ts` | Block 5 |
| `src/server/stream.ts` | Block 6 |

## Trust boundaries

- Claude Code process → hook script: the hook JSON on stdin carries prompts, tool inputs and tool outputs, which can contain code and secrets; the script is the only place that reads them.
- Hook script → server: an HTTP request to `POST /events` on 127.0.0.1 carrying only the allowed fields and the auth token.
- Web pages in the user's browser → server: any page can try to reach `127.0.0.1` on the server's port with cross-origin requests or through DNS rebinding.
- Other operating system users on the same machine → server and data directory: loopback is shared by every local user, and the data directory holds the auth token, the database key and the database.
- Paired browser → server: a browser that presented the auth token holds an `ao_session` cookie and reads `GET /stream`.
- Server → transcript files: the `transcript` path inside an event is chosen by the sender, and the server opens files in `~/.claude/projects` from it.
- Server → SQLite file: the encrypted database file `~/.agents-office/office.db` lives in the user's profile directory.
- Server → browser clients: `GET /stream` sends agent state as Server-Sent Events to clients that passed the checks.

## STRIDE analysis

### `hooks/agents-office-hook.mjs`
- **Spoofing:** the script reads `os.userInfo().username` and the hook JSON from its parent process; another local process can run the same script, but without the auth token its requests are refused by the server (R-05).
- **Tampering:** the script builds the outgoing event field by field from a fixed list, so a crafted hook JSON cannot add fields to what is sent (R-03).
- **Repudiation:** the script keeps no log; the events it sends are stored by the server with their timestamp and identifiers.
- **Information Disclosure:** it reads `tool_input` and `tool_output` in memory but forwards only the file path string, and it reads the auth token from its file without printing or logging it (R-03, R-12).
- **Denial of Service:** it runs as an async command hook with an 800 ms abort and always exits 0, so a dead or slow server, or a missing token file, cannot block Claude Code (R-09).
- **Elevation of Privilege:** it runs with the user's own rights and executes nothing taken from the hook JSON.

### `src/shared/events.ts`
- **Spoofing:** `user`, `project` and `agent` are self-declared by the sender and the definition cannot authenticate them; the history is an activity log, not proof of identity, and only holders of the auth token can send events.
- **Tampering:** the definition strips unknown fields and enforces types and maximum lengths, so a crafted event cannot smuggle content or oversized values into storage (R-03, R-04).
- **Repudiation:** the module only validates; recording the event with its timestamp is done by `db.ts`.
- **Information Disclosure:** the list of allowed fields is the privacy contract: no field can carry prompt text, code or file contents (R-03).
- **Denial of Service:** every string has a maximum length, so the cost of parsing one event is bounded (R-04).
- **Elevation of Privilege:** event fields are treated as data only and never executed or interpreted as code.

### `src/server/secrets.ts`
- **Spoofing:** the auth token is the only proof of being a legitimate client; it is 256 bits from a secure random generator and compared in constant time, so it cannot be guessed or measured out (R-11).
- **Tampering:** an existing secret file is never overwritten, and a file whose content is not 64 hexadecimal characters stops the startup instead of being silently replaced.
- **Repudiation:** startup refusals name the file and the reason, leaving a visible record of why the server did not start.
- **Information Disclosure:** the token and the key are stored as files in a directory with mode 0700 and files with mode 0600 on POSIX, a looser mode is refused, and on Windows the directory must lie inside the user profile so that its permissions apply; the server prints the token's path and never its value (R-12, R-14).
- **Denial of Service:** a missing key with an existing database stops the server with an error instead of creating a new key, so data is not made unreadable by accident.
- **Elevation of Privilege:** the data directory must resolve inside the user's home, so an environment override cannot point the secrets into a location with weaker permissions (R-14).

### `src/server/auth.ts`
- **Spoofing:** every protected request needs the Bearer auth token or a cookie created by pairing; the pairing route accepts the token only in a request body and never in a URL, and the cookie holds a random session id, not the token (R-05, R-12).
- **Tampering:** the cookie is HttpOnly and SameSite=Strict and the pairing route refuses any Origin other than the server's own, so another site cannot make the browser pair or act on its behalf (R-13).
- **Repudiation:** failed pairing and authentication attempts are answered with 401 and logged without the submitted value.
- **Information Disclosure:** the 401 body carries a fixed code and says nothing about which part was wrong; the session map holds only random ids (R-12).
- **Denial of Service:** the session map is capped at 50 entries and the pairing body at 1 KB, so repeated pairing cannot grow memory without bound (R-04).
- **Elevation of Privilege:** a pairing cookie grants only the same read access to the stream and the same event route as the token; there is no higher tier and the cookie is lost on restart.

### `src/server/app.ts`
- **Spoofing:** a web page could try to post forged events or read the stream; the Host must be loopback, an Origin other than the server's own is refused, the content type must be application/json and no CORS header is ever sent (R-01).
- **Tampering:** the JSON body is limited to 64 KB and the routes are only `POST /events`, `GET /stream` and `POST /pair`, so there is no route that changes server settings or files.
- **Repudiation:** rejected requests are answered with a status code and logged without their bodies, so refusals leave a trace without storing content.
- **Information Disclosure:** error bodies carry only a short code and the invalid field path, never stack traces, tokens or event content.
- **Denial of Service:** the body limit and the single-purpose routes bound the work per request, and the checks run in a fixed cheap-first order (R-04).
- **Elevation of Privilege:** no route runs commands or reads files chosen by the caller, so there is nothing to escalate to; the server runs with the user's rights.

### `src/server/ingest.ts`
- **Spoofing:** the identifiers are stored as declared; the ingest step does not trust them for any decision other than grouping.
- **Tampering:** events are parsed with the Block 1 definition before any write, and every statement uses bound parameters, so event fields cannot alter SQL (R-08).
- **Repudiation:** every accepted event is stored with its timestamp, hook name and identifiers before the 202 response, giving a record of what the server accepted.
- **Information Disclosure:** only the cleaned event reaches storage and the bus, so content that slipped past the hook script is discarded here (R-03).
- **Denial of Service:** work per event is one transaction on prepared statements; an out-of-order event cannot trigger extra work (R-07).
- **Elevation of Privilege:** the step only writes rows and emits notifications; it never runs a command or opens a path taken from the event.

### `src/server/main.ts`
- **Spoofing:** the server binds 127.0.0.1 and ::1 only, so a remote host cannot reach it and cannot pretend to be a local client.
- **Tampering:** configuration comes from environment variables (port, database path, data directory) that the user controls; the data directory is validated against the home directory and the server cannot change them at runtime.
- **Repudiation:** startup errors, such as a port already in use or an invalid secret, are printed with the port or file name before exit, leaving a visible record.
- **Information Disclosure:** the listener exposes nothing beyond the three routes; if ::1 is unavailable the server logs it and stays on 127.0.0.1.
- **Denial of Service:** a port already in use ends the process with a clear message instead of retrying forever.
- **Elevation of Privilege:** the process runs as the invoking user and does not request extra rights.

### `src/server/db.ts`
- **Spoofing:** the database trusts rows written by the ingest step; nothing else writes to it, and opening it requires the key from the key file.
- **Tampering:** the file lives in the user's profile directory and is encrypted, so editing it without the key corrupts it rather than altering readable rows; writes use one transaction per event and prepared statements (R-06, R-08).
- **Repudiation:** the events table keeps every accepted event with timestamp and identifiers and rows are never updated in place, so history can be checked later.
- **Information Disclosure:** the file is encrypted at rest with a 256-bit key and no column can hold prompt text, code or file contents, so a copied file reveals nothing readable (R-03, R-06).
- **Denial of Service:** WAL mode and a transaction per event keep writes cheap; a failed write marks the module unavailable instead of crashing the server, and a wrong key stops startup without creating a new database.
- **Elevation of Privilege:** the SQL layer exposes no function that loads extensions or runs external commands, and migrations are fixed text shipped with the code.

### `src/server/tokens.ts`
- **Spoofing:** the `transcript` path comes from the event and could be forged to point at another file; the path must resolve inside `~/.claude/projects` and end with `.jsonl` (R-02).
- **Tampering:** the module only reads files and never writes to a transcript.
- **Repudiation:** a read that fails flags the task as tokens-incomplete, so missing data is recorded instead of silently hidden.
- **Information Disclosure:** the transcript holds the full conversation, so the module parses each line and keeps only four numeric usage fields; the parsed line is discarded and no text is retained (R-02, R-03).
- **Denial of Service:** each read is capped at 8 MB from a saved offset and stops at the last complete newline, so a huge or growing file cannot block the server (R-04).
- **Elevation of Privilege:** it follows no links outside the allowed directory because the path is resolved with realpath before the check, and it executes nothing it reads.

### `src/server/stream.ts`
- **Spoofing:** any client reaching the port needs the auth token or the pairing cookie, and the Host and Origin checks stop web pages from other origins; no CORS header lets them read the response (R-01, R-05).
- **Tampering:** the stream is read-only for clients; no message from a client changes server state.
- **Repudiation:** connections and disconnections are not recorded because the stream carries no decisions; the state it shows comes from stored events.
- **Information Disclosure:** messages carry agent names, stage, project names, token counts and timestamps, never contents, and the snapshot goes only to a client that passed every check.
- **Denial of Service:** a client whose write fails or that disconnects is dropped, and idle connections get a keep-alive comment every 15 seconds, so dead clients do not accumulate (R-04).
- **Elevation of Privilege:** the stream exposes no operation, so a subscriber cannot cause anything other than receiving data.

## Data classification

| Data | Class | At rest | In transit |
|---|---|---|---|
| `user` (operating system username) | PII | stored in `events.user` and `sessions.user`; the whole database file is encrypted with a 256-bit key through a SQLCipher-compatible cipher | plain HTTP on 127.0.0.1 and ::1 only, never leaving the machine, and only with the auth token |
| `file` and `project` (paths and folder names) | PII | stored in `events.file` and `events.project`, inside the encrypted database file | plain HTTP on loopback only, with the auth token |
| `transcript` (path of the transcript file) | PII | stored in `sessions.transcript`, inside the encrypted database file | plain HTTP on loopback only, with the auth token |
| `session`, `agent`, `tool` and token usage counters | public | stored in plain columns, inside the encrypted database file | plain HTTP on loopback only |
| auth token | credentials | stored as 64 hexadecimal characters in the `token` file, not encrypted because it is the root secret, protected by file mode 0600 on POSIX and by the user profile permissions on Windows | sent only to 127.0.0.1 in the Authorization header or once in the pairing body; never in a URL, a log or a response |
| database key | credentials | stored as 64 hexadecimal characters in the `db.key` file, not encrypted because it is the root secret, with the same file protection | never transmitted; read only inside the server process |
| pairing session id (cookie) | credentials | held only in server memory and cleared on restart | sent only to loopback in an HttpOnly cookie |
| prompt text, tool inputs and outputs, file contents, transcript text | credentials | never stored: dropped by the hook script and again by the event definition | never sent: the hook script does not forward them |

## Risks and mitigations

| ID | Risk | STRIDE | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R-01 | A web page open in the browser posts forged events or reads the stream, by cross-origin request or DNS rebinding | S | M | M | auth token required, Content-Type must be application/json, an Origin other than the server's own is refused, Host must be loopback, no CORS headers (Blocks 4, 6 and 9) |
| R-02 | A forged `transcript` path makes the server read an arbitrary local file | I | L | H | realpath must be inside `~/.claude/projects` and end with `.jsonl`, 8 MB read cap, only numeric usage fields kept (Block 5) |
| R-03 | Prompt text, code or secrets reach storage or the stream | I | M | H | the hook script forwards a fixed field list, the event definition strips everything else, no column can hold content (Blocks 1, 2 and 7) |
| R-04 | Oversized or malformed events exhaust memory, disk or connections | D | M | M | 64 KB body limit, 1 KB pairing body, session map capped at 50, maximum lengths on every field, 8 MB transcript reads, dead stream clients dropped (Blocks 1, 4, 5, 6 and 9) |
| R-05 | Another operating system user on the same machine sends events, floods the server or reads the stream | S | M | M | every protected route requires the auth token or the pairing cookie; the token file is protected by file mode or the user profile permissions (Blocks 8 and 9) |
| R-06 | A copied database file, from a backup, a sync folder or a stolen disk, exposes the username, project names and paths | I | M | M | the database is encrypted at rest with a 256-bit key kept in a separate protected file, and the server refuses to run with a wrong key (Blocks 2 and 8) |
| R-07 | Events arrive out of order because hooks are async and the office shows a wrong stage | T | H | L | each event carries `ts` and the reducer ignores stage changes older than the agent's last event (Block 3) |
| R-08 | Event fields alter SQL statements | T | L | H | bound parameters only and validated fields (Blocks 1 and 2) |
| R-09 | The hook script slows or breaks tool calls in Claude Code | D | M | M | async command hook, 800 ms abort, always exit 0, also when the token file is missing (Block 7) |
| R-10 | An agent name or file path containing markup is rendered as HTML by a client | T | M | M | the server sends JSON text only; FEAT-001b must render these values as text, never as HTML |
| R-11 | The auth token is guessed or measured out through comparison timing | S | L | H | 256 bits from a secure random generator and a constant-time comparison (Block 8) |
| R-12 | The auth token leaks through logs, URLs, error bodies or the hook script output | I | M | H | the token is never logged, never placed in a URL or query string, never echoed in a response, and the pairing cookie holds a separate session id (Blocks 7, 8 and 9) |
| R-13 | A cross-site request makes a paired browser act on the server | T | L | M | the cookie is HttpOnly and SameSite=Strict and requests with another Origin are refused (Blocks 4 and 9) |
| R-14 | The token or key files end up readable by other users because of wrong permissions or a data directory outside the profile | I | L | H | mode 0700 and 0600 with refusal of looser modes on POSIX, and a data directory that must lie inside the user's home so the Windows profile permissions apply (Block 8) |
| R-15 | A process running as the same user, or an administrator, reads the auth token, the database key and the database | I | L | M | accepted, see the Accepted risks section |

## Accepted risks

### R-15
- **Accepted by:** Joako (the user), in chat on 2026-10-04, stating that the acceptance holds only because MVP 1 is for the user alone.
- **Justification:** any secret stored for a local single-user tool can be read by a process running as that same user, so no control in this ticket can remove the risk; MVP 1 runs only on the user's own machine and is used only by the user.
- **Review conditions:** revisit before any version used by other people or by the company (shared server or several users), and immediately if the data directory is moved outside the user's home directory.

## Supply chain

New runtime dependencies are express, better-sqlite3-multiple-ciphers (a native module and a maintained fork of better-sqlite3 with a smaller community than the upstream project) and zod; development dependencies are typescript, tsx, vitest and @vitest/coverage-v8. Versions are pinned by the pnpm lockfile and the SAST step in CODE scans them for known vulnerabilities. The native module runs code at install time, so it is installed only from the official registry.

## Availability

The server is local and single-purpose, so availability matters only for the user's own session. The denial-of-service vectors are the oversized body, a flood of events and a hung hook: the first is bounded by the 64 KB limit, the second by the auth token requirement and by WAL transactions on prepared statements (NFR-03 requires 50 events per second), and the third by the async hook with an 800 ms abort. Losing the key file makes the stored data unreadable, which is why the server refuses to start in that case instead of replacing it.
