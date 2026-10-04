# PRD FEAT-001d: Create specialists from the web

| Field | Value |
|-------|-------|
| Ticket | FEAT-001d |
| Tracker | none |
| Date | 2026-10-04 |
| PRD loops | 0 |
| Loops since last human decision | 0 |

## Context and Problem

Specialists are Claude Code subagents. Today the user creates one by writing a definition file by hand. The user wants to create specialists from the web, choosing between a permanent specialist, available in every project, and a session-only specialist that disappears when its session ends. Terms (agent, session) are defined in prd-FEAT-001a.md.

## Goals

- Create a specialist from a web form without touching files by hand.
- Choose permanent or session-only at creation time.
- Keep the write access of the web to the user's files minimal and safe.

## Functional Requirements

- FR-01: The web must provide a form to create a specialist with a name, a role description and instructions.
- FR-02: The form must require choosing Permanent or Session-only.
- FR-03: The server must save a permanent specialist as a user-level Claude Code subagent definition, available to every project.
- FR-04: The form must let the user pick the target session, from the active sessions, when Session-only is chosen.
- FR-05: The server must make a session-only specialist stop existing when its session ends and leave no persistent definition.
- FR-06: The server must validate the name, the role description and the instructions before writing anything.
- FR-07: The server must accept specialist creation requests only from the office's own web page.
- FR-08: The server must confirm the creation to the user, naming the specialist and where it lives.

## Non-Functional Requirements

- NFR-01: The name must be at most 64 characters and the instructions at most 20,000 characters.
- NFR-02: The server must complete a creation request within 500 ms (p95).
- NFR-03: Line, branch and function coverage of new code must each be at least 80%.

## Acceptance Criteria

- AC-01 (FR-01): WHEN the user submits the form with a valid name, role description and instructions, THE server SHALL create the specialist.
- AC-02 (FR-02): IF the form is submitted without choosing Permanent or Session-only, THEN THE form SHALL block the submission and show a message.
- AC-03 (FR-03): WHEN a permanent specialist is created, THE server SHALL write its definition in the user-level Claude Code agents directory under the specialist's name.
- AC-04 (FR-03): IF a permanent specialist with the same name already exists, THEN THE server SHALL respond with status 409 and leave the existing definition unchanged.
- AC-05 (FR-04): WHILE Session-only is selected, THE form SHALL list the active sessions and require one to be chosen.
- AC-06 (FR-04): IF there is no active session, THEN THE form SHALL disable Session-only and say that no session is active.
- AC-07 (FR-05): WHEN the target session ends, THE server SHALL ensure no persistent definition of the session-only specialist remains.
- AC-08 (FR-05): IF the server stops before the target session ends, THEN THE server SHALL remove any leftover definition of session-only specialists on its next start.
- AC-09 (FR-06): IF the name contains characters other than lowercase letters, digits and hyphens, THEN THE server SHALL respond with status 422 and write nothing.
- AC-10 (FR-06): IF the name resolves to a path outside the agents directory, THEN THE server SHALL respond with status 422 and write nothing.
- AC-11 (FR-06): IF the name is longer than 64 characters or the instructions are longer than 20,000 characters, THEN THE server SHALL respond with status 422 and write nothing.
- AC-12 (FR-07): IF a creation request comes from an origin other than the office's own web page, THEN THE server SHALL respond with status 403 and write nothing.
- AC-13 (FR-08): WHEN a specialist is created, THE form SHALL show its name and either the path of its definition (permanent) or the session it belongs to (session-only).

## Out of Scope

- Editing, deleting or listing existing specialists from the web.
- Specialists per project.
- Choosing the model or the tools of a specialist. Claude Code defaults apply.
- Login and several users.
- The visual appearance of a new specialist in the office (FEAT-001b shows it once it works).

## Risks and Mitigations

- The web writes files in the user's home directory, which is a high-risk capability. Mitigation: name validation (AC-09, AC-10), origin check (AC-12), loopback only (FEAT-001a) and a dedicated threat model in PLAN. The agents directory is added to the security-sensitive paths in AGENTS.md when this ticket starts.
- It is not verified that a running Claude Code session can receive a new subagent from outside. Mitigation: PLAN begins with a check against the current Claude Code documentation. If it is not possible, the user decides between launching sessions from the office or limiting session-only specialists to sessions started afterwards.
- Assumptions the user has not confirmed yet: the user picks the target session from the active sessions, the 64 and 20,000 character limits, and every number in the non-functional requirements.

## Dependencies

- FEAT-001a: the server and the list of active sessions.
- The Claude Code user-level agents directory and its subagent definition format.
- React, Vite, Express and Vitest.
