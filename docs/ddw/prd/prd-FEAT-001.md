# Parent PRD: Local agents office: hooks, server, live view

| Metric | Value |
|--------|-------|
| Ticket | FEAT-001 |
| Date | 2026-10-04 |
| Status | Split |

## Sub-tickets

| Sub-ticket | Title | PRD | Dependencies | Status |
|---|---|---|---|---|
| FEAT-001a | Event pipeline: hooks, local server, persistence, live stream | prd-FEAT-001a.md | none | active |
| FEAT-001b | 3D agents office | prd-FEAT-001b.md | depends on a | pending |
| FEAT-001c | Global history | prd-FEAT-001c.md | depends on a | pending |
| FEAT-001d | Create specialists from the web | prd-FEAT-001d.md | depends on a | pending |

## Suggested implementation order

a → b → c → d

## Original context

The user runs Claude Code sessions with specialist subagents (for example a frontend developer) and wants to see them working as characters in a 3D office: which agent is active, in which stage, for how long and with how many tokens. They also want a global history of what each agent did across all projects, and the ability to create specialists from the web, either permanent (global) or for a single session. The first version runs locally for one user. A later version for the user's company (login, several users) is out of scope for this ticket and its sub-tickets, but every event carries user, project, session and agent identifiers so that version does not force a redesign.
