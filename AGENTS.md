# Agents Office

A local dashboard that shows Claude Code subagents as characters working in an animated office. Claude Code hooks send events to a local server, which stores them and streams them live to the browser.

## Stack

| Field | Value |
|-------|-------|
| Language | TypeScript, Node 22 |
| Server | Express |
| Live updates | Server-Sent Events (SSE) |
| Storage | SQLite (`better-sqlite3`) |
| Frontend | React + Vite, office rendered in 3D with Three.js via `@react-three/fiber` |
| Tests | Vitest |
| Package manager | pnpm |
| Security-sensitive paths | The event ingestion endpoint (receives data from outside the app) |

## Commands

To be filled in once the project is scaffolded (install, dev, build, test).

## Conventions

- Event types are defined once and shared by server and frontend.
- Every event carries `user`, `project`, `session` and `agent` identifiers, even in the local version.
- Events contain action, tool, file path and token usage only. Never prompt, code or file contents.
- The 3D office animation loop (`useFrame`) never drives React state. React renders the surrounding panels only.
- All incoming events are validated against a schema before being stored.

## Testing

Vitest for server and shared logic. Test behavior (event in, state out), not implementation details.
