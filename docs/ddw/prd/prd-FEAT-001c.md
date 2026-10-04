# PRD FEAT-001c: Global history

| Field | Value |
|-------|-------|
| Ticket | FEAT-001c |
| Tracker | none |
| Date | 2026-10-04 |
| PRD loops | 0 |
| Loops since last human decision | 0 |

## Context and Problem

The event pipeline (FEAT-001a) stores every task of every agent, but the user has no way to review what each agent did over time. The user wants a history across all projects, not only the current one. Terms (agent, task, session) are defined in prd-FEAT-001a.md.

## Goals

- Review what every agent did, in any project, with when, how long and how many tokens.
- Narrow the list by agent and by project.

## Functional Requirements

- FR-01: The history view must list the tasks of all agents across all projects, newest first.
- FR-02: Each entry must show the start date and time, the agent, the project, the paths of the files touched, the duration and the tokens used.
- FR-03: The history view must filter entries by agent.
- FR-04: The history view must filter entries by project.
- FR-05: The history view must paginate entries.
- FR-06: The server must expose the history through an HTTP endpoint that accepts agent, project and page parameters.

## Non-Functional Requirements

- NFR-01: The history endpoint must respond within 300 ms (p95) with 10,000 stored tasks.
- NFR-02: The history view must show its first page within 1 second of opening, with 10,000 stored tasks.
- NFR-03: Line, branch and function coverage of new code must each be at least 80%.

## Acceptance Criteria

- AC-01 (FR-01): WHEN the user opens the history view, THE view SHALL show the 50 most recent tasks, newest first.
- AC-02 (FR-01): IF there are no stored tasks, THEN THE view SHALL show the text "No history yet".
- AC-03 (FR-02): THE view SHALL show for each task the start date and time, agent, project, file paths, duration and token total.
- AC-04 (FR-02): WHEN a task touched no files, THE view SHALL show a dash in the files column.
- AC-05 (FR-02): WHILE a task is open, THE view SHALL list it with the status "In progress".
- AC-06 (FR-03): WHEN the user selects an agent in the filter, THE view SHALL show only that agent's tasks.
- AC-07 (FR-04): WHEN the user selects a project in the filter, THE view SHALL show only that project's tasks.
- AC-08 (FR-04): WHEN the user sets both the agent filter and the project filter, THE view SHALL show only tasks that match both.
- AC-09 (FR-04): IF no task matches the filters, THEN THE view SHALL show the text "No tasks match these filters".
- AC-10 (FR-05): WHEN more than 50 tasks match, THE view SHALL show pagination controls and load the next 50 on request.
- AC-11 (FR-06): WHEN a client requests the history endpoint with valid parameters, THE server SHALL respond with the matching tasks as JSON.
- AC-12 (FR-06): IF a parameter is invalid, such as a page below 1 or a non-numeric page, THEN THE server SHALL respond with status 400 naming the parameter.
- AC-13 (FR-06): IF the requested page is beyond the last page, THEN THE server SHALL respond with status 200 and an empty list.

## Out of Scope

- Live refresh of the list while the view is open. The user reloads to see new tasks.
- Free-text search, export, charts and totals.
- Deleting or editing entries.
- File contents or code. Only paths are shown.
- Login and several users.

## Risks and Mitigations

- The history grows without limit. Mitigation: pagination now; retention is a later ticket.
- Assumptions the user has not confirmed yet: page size 50, open tasks listed as In progress, no live refresh, and every number in the non-functional requirements.

## Dependencies

- FEAT-001a: the stored tasks and events.
- React, Vite, Express and SQLite.
- Vitest.
