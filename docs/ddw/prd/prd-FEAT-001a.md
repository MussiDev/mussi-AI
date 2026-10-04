# PRD FEAT-001a: Event pipeline: hooks, local server, persistence, live stream

| Field | Value |
|-------|-------|
| Ticket | FEAT-001a |
| Tracker | none |
| Date | 2026-10-04 |
| PRD loops | 0 |
| Loops since last human decision | 0 |

## Context and Problem

Claude Code sessions and their subagents run on the user's machine, and nothing records which agent is doing what, in which stage, for how long and with how many tokens. The 3D office (FEAT-001b), the global history (FEAT-001c) and specialist creation (FEAT-001d) all need that data first. This ticket delivers it as a local service with no 3D interface.

Terms used in all FEAT-001 PRDs: **boss** is the main Claude Code session; **agent** is the boss or any subagent; **session** is one Claude Code run in one project; **task** is the work of one agent from its first event after being idle until it reaches Done; **stage** is one of Thinking, Reading, Editing, Running, Waiting, Done.

## Goals

- Every action of every agent in every local Claude Code session reaches the local server in under one second.
- The server derives each agent's stage, token usage and task times, and keeps a persistent record.
- Any client can subscribe to live updates.
- No prompt text, code or file contents are ever stored.

## Functional Requirements

- FR-01: The server must expose an HTTP endpoint on the local machine that receives one event per request from Claude Code hooks.
- FR-02: The server must validate each event against a schema and must reject events that do not match it.
- FR-03: The server must store the user, project, session and agent identifiers with every event.
- FR-04: The server must store only the action, tool name, file path, token counts and identifiers of an event, and must not store prompt text, code or file contents.
- FR-05: The server must derive the working stage of each agent (Thinking, Reading, Editing, Running) from the events it receives.
- FR-06: The server must derive the Waiting and Done stages of each agent from the events it receives.
- FR-07: The server must track the tokens each agent uses in each task.
- FR-08: The server must record the start time and end time of each task.
- FR-09: The server must persist events and tasks in SQLite so they survive a server restart.
- FR-10: The server must push every stage, token and task-time change to connected clients through Server-Sent Events.
- FR-11: The server must listen only on the loopback interface.
- FR-12: The project must provide a hook script and install instructions that send events to the server without blocking Claude Code.

## Non-Functional Requirements

- NFR-01: The server must emit a stream update within 300 ms (p95) of receiving the event that caused it.
- NFR-02: The hook script must complete in under 200 ms (p95) per invocation when the server is running.
- NFR-03: The server must accept 50 events per second without losing any.
- NFR-04: Line, branch and function coverage of new code must each be at least 80%.

## Acceptance Criteria

- AC-01 (FR-01): WHEN a hook script sends a valid event by HTTP POST to the events endpoint, THE server SHALL respond with status 202.
- AC-02 (FR-01): IF the request body is not valid JSON, THEN THE server SHALL respond with status 400 and store nothing.
- AC-03 (FR-02): IF an event lacks a required field or carries a field of the wrong type, THEN THE server SHALL respond with status 422 naming the invalid field and store nothing.
- AC-04 (FR-02): IF an event body is larger than 64 KB, THEN THE server SHALL respond with status 413 and store nothing.
- AC-05 (FR-03): WHEN a valid event is stored, THE server SHALL record the user, project, session and agent identifiers with it.
- AC-06 (FR-03): IF an event arrives without one of the four identifiers, THEN THE server SHALL respond with status 422 and store nothing.
- AC-07 (FR-04): IF an event carries fields outside the allowed list, THEN THE server SHALL discard those fields before storing the event.
- AC-08 (FR-04): WHEN an event describes a file edit, THE server SHALL store the file path and SHALL NOT store the edited text.
- AC-09 (FR-05): WHEN a pre-tool event arrives for Read, Grep or Glob, THE server SHALL set the agent's stage to Reading.
- AC-10 (FR-05): WHEN a pre-tool event arrives for Edit, Write or NotebookEdit, THE server SHALL set the agent's stage to Editing.
- AC-11 (FR-05): WHEN a pre-tool event arrives for Bash or for any tool not listed in AC-09 or AC-10, THE server SHALL set the agent's stage to Running.
- AC-12 (FR-05): WHEN a tool-finished event arrives for an agent that has not stopped, THE server SHALL set the agent's stage to Thinking.
- AC-13 (FR-05): IF an event references an agent not seen before, THEN THE server SHALL register that agent and apply the event to it.
- AC-14 (FR-06): WHEN a notification event reports that an agent waits for user approval, THE server SHALL set the agent's stage to Waiting.
- AC-15 (FR-06): WHEN a stop event arrives for an agent, THE server SHALL set the agent's stage to Done.
- AC-16 (FR-07): WHEN a tool finishes or an agent stops, THE server SHALL add the token usage recorded since the previous reading to the task's token total.
- AC-17 (FR-07): THE server SHALL read only token usage figures from the session transcript.
- AC-18 (FR-07): IF token usage cannot be read for an event, THEN THE server SHALL keep the previous token total and flag the task as tokens-incomplete.
- AC-19 (FR-08): WHEN an agent sends its first event after being Done or after being unknown, THE server SHALL open a new task with that event's time as start time.
- AC-20 (FR-08): WHEN an agent reaches Done, THE server SHALL record that time as the task's end time.
- AC-21 (FR-09): WHEN the server restarts, THE server SHALL serve every event and task stored before the restart.
- AC-22 (FR-09): IF the database cannot be opened or written, THEN THE server SHALL log the error and respond with status 503 to event requests.
- AC-23 (FR-10): WHEN a client connects to the stream endpoint, THE server SHALL send the current state of all agents and then every later change.
- AC-24 (FR-10): WHEN an agent's stage, token total or task time changes, THE server SHALL send an update to every connected client.
- AC-25 (FR-10): IF a client disconnects, THEN THE server SHALL release that client's resources and keep serving the others.
- AC-26 (FR-11): THE server SHALL accept connections only on 127.0.0.1 and ::1.
- AC-27 (FR-11): IF the configured port is already in use, THEN THE server SHALL exit with a message naming the port.
- AC-28 (FR-12): WHEN Claude Code fires a configured hook, THE hook script SHALL post an event containing only the allowed fields.
- AC-29 (FR-12): IF the server is unreachable, THEN THE hook script SHALL exit with status 0 within 1 second so Claude Code continues unaffected.
- AC-30 (FR-12): THE hook script SHALL NOT forward prompt text or file contents.

## Out of Scope

- Any 3D or visual interface (FEAT-001b).
- The history view and its query endpoint (FEAT-001c).
- Creating specialists (FEAT-001d).
- Login, several users and a shared server. Only the identifiers are stored now.
- Money cost. Only token counts are tracked.
- Retention and deletion of stored data.

## Risks and Mitigations

- Hook payloads differ from what this PRD assumes (field names, subagent identification, transcript location). Mitigation: PLAN starts by checking the current Claude Code hook documentation and records the real payloads in the spec.
- A web page open in the user's browser can post fake events to a localhost server. Mitigation: the threat model in PLAN covers this and the spec defines the protection.
- Hooks run on every tool call, so a slow script slows Claude Code. Mitigation: NFR-02 and AC-29.
- Assumptions the user has not confirmed yet: the user identifier is the operating system username; the project identifier is the name of the working directory; the 64 KB limit, the unmapped-tool rule in AC-11 and every number in the non-functional requirements.

## Dependencies

- Claude Code hooks and session transcripts, as the source of events and token usage.
- Node.js 22, Express, SQLite through better-sqlite3, and Vitest.
