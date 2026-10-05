# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- FEAT-001a: event pipeline for the Agents Office. A Claude Code hook script (`hooks/agents-office-hook.mjs`) posts the minimal event of every hook (identifiers, tool, file path, never prompt text, tool output or file contents) to a local server that listens only on `127.0.0.1` and `::1`.
- FEAT-001a: access control. Every request needs a secret auth token (a 256-bit random value in a file only the local user can read) or a pairing cookie that a browser obtains once with `POST /pair`; Host and Origin are checked on every route and no CORS header is sent.
- FEAT-001a: events, sessions, agents and tasks are stored in a SQLite database encrypted at rest with a 256-bit key kept in a separate file.
- FEAT-001a: each agent's stage (Thinking, Reading, Editing, Running, Waiting, Done) and each task's start and end are derived from the events; a task opens only on an event that starts work, so an idle notification cannot create a phantom task.
- FEAT-001a: token usage per task is read incrementally from the session transcripts (four counters, each message counted once, nothing else kept) after the response has been sent.
- FEAT-001a: live Server-Sent Events stream (`GET /stream`): a snapshot of every agent with its latest task, then an update only when something changes.
- FEAT-001a: installation guide (`docs/install-hooks.md`).

Not included yet: the 3D office (FEAT-001b), the global history view (FEAT-001c) and creating specialists from the web (FEAT-001d).
