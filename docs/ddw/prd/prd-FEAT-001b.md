# PRD FEAT-001b: 3D agents office

| Field | Value |
|-------|-------|
| Ticket | FEAT-001b |
| Tracker | none |
| Date | 2026-10-04 |
| PRD loops | 0 |
| Loops since last human decision | 0 |

## Context and Problem

With the event pipeline running (FEAT-001a), the data about what each agent does exists but the user cannot see it at a glance. The user wants one 3D office where every active session appears as a boss with its team, and every agent's computer shows what it is doing. Terms (boss, agent, session, task, stage) are defined in prd-FEAT-001a.md.

## Goals

- See in one scene every active session, who works, in which stage, for how long and with how many tokens.
- See an agent editing a file without ever seeing the file's code.

## Functional Requirements

- FR-01: The office must render in the browser one 3D isometric scene with one zone for each active session.
- FR-02: Each zone must contain one boss character and one character for each agent that took part in that session.
- FR-03: Each character must be animated to show its current stage, with one distinct animation per stage (Thinking, Reading, Editing, Running, Waiting, Done).
- FR-04: Each character's desk must have a monitor that shows the name of the file being edited, with a typing animation, and must not show code.
- FR-05: Each monitor must show the agent's current stage, the elapsed time of its task and the tokens used in its task.
- FR-06: The office must update from the live stream without a page reload.
- FR-07: The office must show a connection indicator and reconnect automatically.
- FR-08: The office must remove a session's zone after the session ends.

## Non-Functional Requirements

- NFR-01: The office must render at 30 frames per second or more with 3 sessions and 10 agents in total, on a laptop with integrated graphics.
- NFR-02: The office must reflect a stage change within 1 second (p95) of the server receiving the event.
- NFR-03: The office must show its first render within 3 seconds of page load on localhost.
- NFR-04: Line, branch and function coverage of new non-rendering code must each be at least 80%.

## Acceptance Criteria

- AC-01 (FR-01): WHEN the page loads and the stream reports N active sessions, THE office SHALL render N zones in one scene.
- AC-02 (FR-01): WHILE no session is active, THE office SHALL show an empty office with the text "No active sessions".
- AC-03 (FR-02): WHEN a session reports a boss and K agents, THE office SHALL show K + 1 characters in that zone, each labeled with its agent name.
- AC-04 (FR-02): WHEN an agent not seen before in a session sends its first event, THE office SHALL add its character to that session's zone.
- AC-05 (FR-03): WHEN an agent's stage changes, THE office SHALL play the animation of the new stage.
- AC-06 (FR-03): IF an update names a stage the office has no animation for, THEN THE office SHALL show the character idle and write a warning to the browser console.
- AC-07 (FR-04): WHILE an agent's stage is Editing, THE monitor SHALL show the file name and a typing animation.
- AC-08 (FR-04): THE monitor SHALL NOT show file contents or code.
- AC-09 (FR-05): WHILE a task is open, THE monitor SHALL show the stage, the elapsed time in mm:ss and the token total, refreshed at least once per second.
- AC-10 (FR-05): WHEN an agent reaches Done, THE monitor SHALL freeze the elapsed time and show the final token total.
- AC-11 (FR-06): WHEN the server sends an update, THE office SHALL apply it without reloading the page.
- AC-12 (FR-07): IF the stream connection drops, THEN THE office SHALL show a "disconnected" indicator and retry the connection.
- AC-13 (FR-07): WHEN the connection is restored, THE office SHALL replace its state with the state the server sends and hide the indicator.
- AC-14 (FR-08): WHEN a session ends and all its agents are Done, THE office SHALL remove that session's zone after 30 seconds.

## Out of Scope

- The history view (FEAT-001c) and creating specialists (FEAT-001d).
- Login and several users.
- Camera rotation, zoom and pan. The camera is fixed.
- Imported 3D models. Characters, desks and monitors are built from simple shapes in code.
- Sound.
- Sharing or recording the office.

## Risks and Mitigations

- 3D work grows quickly. Mitigation: simple shapes in code instead of imported models, and a fixed camera.
- Performance on weak hardware. Mitigation: NFR-01, and the animation loop never drives React state (see AGENTS.md).
- Assumptions the user has not confirmed yet: the 30-second removal delay in AC-14, the fixed camera, shapes built in code, a team made of the agents that took part in the session (a newly created specialist appears when it first works), and every number in the non-functional requirements.

## Dependencies

- FEAT-001a: the live stream of agent state.
- React, Vite, Three.js and @react-three/fiber.
- Vitest.
