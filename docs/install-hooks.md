# Installing the Agents Office hook

The hook script `hooks/agents-office-hook.mjs` forwards Claude Code hook events to the local Agents Office server. It uses only Node built-ins (Node 22 or newer, for the global `fetch`).

## What it sends, and what it never sends

Sent, per event: `v`, `ts`, `hook`, `user` (your OS username), `project` (base name of the working directory), `session`, `agent_id`, `agent`, and when present `tool`, `file` (a file PATH only), `notification` and `transcript` (the transcript PATH).

Never read or sent: prompt text, tool outputs, assistant messages, file contents, or any other part of `tool_input` besides the path. The server also strips unknown fields.

The script is fire-and-forget: it prints nothing, always exits 0, and gives up after 800 ms. A stopped or slow server never affects Claude Code.

## 1. Start the server

From the repository root:

```
pnpm dev
```

The server listens on `127.0.0.1:4317` and prints the path of its token file at startup (default `~/.agents-office/token`, 64 hexadecimal characters, created on first start). The token itself is never printed.

## 2. Register the hook in Claude Code

Edit your user-level settings (`~/.claude/settings.json`) and add the hooks below, replacing the path with the absolute path of this repository. On Windows, escape backslashes in JSON:
`node \"C:\\Users\\you\\code\\mussi-AI\\hooks\\agents-office-hook.mjs\"`.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"/abs/path/to/hooks/agents-office-hook.mjs\"", "async": true, "timeout": 5 }] }
    ]
  }
}
```

If you already have a `hooks` section, merge these entries into it instead of replacing it. Double-check the structure against the official Claude Code hooks reference for your version, since the settings format can change.

## 3. Verify

With the server running, start a short Claude Code session and watch the live stream. The token is read from the file so it never appears on a command line or in your shell history.

Bash (curl 7.55 or newer, which reads the header from stdin with `-H @-`):

```
printf 'Authorization: Bearer %s\n' "$(cat ~/.agents-office/token)" | curl -N -H @- http://127.0.0.1:4317/stream
```

PowerShell (the token stays in a variable, is not echoed, and reaches curl through stdin, not the command line):

```
$t = (Get-Content "$HOME\.agents-office\token" -Raw).Trim()
"Authorization: Bearer $t" | curl.exe -N -H "@-" http://127.0.0.1:4317/stream
```

You should see a snapshot first, then events as the session runs. If you changed `AGENTS_OFFICE_HOME`, use that directory instead of `~/.agents-office`.

## Pairing a browser

A browser pairs by sending `POST /pair` with a JSON body holding the token; the server answers by setting an HttpOnly cookie that authenticates later requests. Read the token from the file instead of typing it:

```
printf '{"token":"%s"}' "$(cat ~/.agents-office/token)" | curl -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/pair -i
```

Never put the token in a URL or query string: the server ignores it there, and URLs end up in proxy logs and shell history. Do not paste the token into chat, tickets or screenshots, and do not commit the data directory.

## Environment variables

| Variable | Meaning | Default |
|----------|---------|---------|
| `AGENTS_OFFICE_PORT` | Server port; the hook sends to `127.0.0.1` on this port (integer 1-65535) | `4317` |
| `AGENTS_OFFICE_HOME` | Data directory holding `token` (and the database key). The server enforces at startup that it is inside your home directory; the hook does not check this, it only reads a 64-hex token from the path it is given and sends it only to `127.0.0.1` | `~/.agents-office` |
| `AGENTS_OFFICE_DB` | Path of the SQLite database file (server only; the hook does not use it) | inside the data directory |

The hook always targets `127.0.0.1`; the host cannot be changed through the environment. If you change the port or data directory, set the same variables in the environment where Claude Code runs.

Proxies: if you opt in to Node's environment proxy support (`NODE_USE_ENV_PROXY=1` together with `HTTP_PROXY`), include `127.0.0.1` in `NO_PROXY`; otherwise the hook's request, which carries the auth token, would be sent through the proxy.

## Troubleshooting

- The server answers 401: the token file the hook reads is not the server's token. Check `AGENTS_OFFICE_HOME` is the same for both.
- Nothing arrives: the server is not running, the port differs, the path in `settings.json` is wrong (use an absolute path, escape backslashes on Windows), or the token file is missing or not exactly 64 hexadecimal characters. The hook stays silent in all these cases by design.
- Check the hook by hand: `echo '{"hook_event_name":"Stop","session_id":"s","cwd":"/tmp/demo"}' | node hooks/agents-office-hook.mjs` should print nothing and exit 0, and the event should appear in the stream.

## Status of verification

The script is covered by automated tests against a stub server (`hooks/agents-office-hook.test.ts`). An end-to-end run in a real Claude Code session has not been verified; do the three steps above to confirm it on your machine.
