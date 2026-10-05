# Agents Office

A local dashboard that shows Claude Code subagents as characters working in an animated office. Claude Code hooks send events to a local server, which stores them and streams them live to the browser.

## Stack

| Field | Value |
|-------|-------|
| Language | TypeScript, Node 22 |
| Server | Express |
| Live updates | Server-Sent Events (SSE) |
| Storage | SQLite, encrypted at rest (`better-sqlite3-multiple-ciphers`) |
| Frontend | React + Vite, office rendered in 3D with Three.js via `@react-three/fiber` |
| Tests | Vitest |
| Package manager | pnpm |
| Security-sensitive paths | The event ingestion endpoint (receives data from outside the app), the token file and the database key file |

## Commands

To be filled in once the project is scaffolded (install, dev, build, test).

## Architecture conventions

- Event types are defined once and shared by server and frontend.
- Every event carries `user`, `project`, `session` and `agent` identifiers, even in the local version.
- Events contain action, tool, file path and token usage only. Never prompt, code or file contents.
- The 3D office animation loop (`useFrame`) never drives React state. React renders the surrounding panels only.
- All incoming events are validated against a schema before being stored.
- `src/shared/*` and `src/server/state.ts` perform no I/O.
- HTTP modules (`app.ts`, `auth.ts`, `stream.ts`) contain no SQL. Only `db.ts` talks to SQLite, only `secrets.ts` reads or writes the secret files, and only `tokens.ts` reads transcripts.
- SQL uses bound parameters only.
- The auth token and the database key are never logged, placed in a URL or sent in a response.

## Code conventions

- TypeScript in strict mode with ES modules. No `any` without a comment explaining why.
- No `console.log` in server code except startup and shutdown messages in `main.ts`.

## What NOT to do in this project

- Do not store, forward or stream prompt text, code or file contents.
- Do not add CORS headers or accept an Origin other than the server's own.
- Do not listen on any interface other than 127.0.0.1 and ::1.

## Testing

Vitest for server and shared logic. Test behavior (event in, state out), not implementation details.
