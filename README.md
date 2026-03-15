# slack-codex-broker

Minimal Slack-to-Codex bridge for multi-repository workflows.

It connects to Slack over Socket Mode, starts or resumes one Codex app-server thread per Slack thread, and gives each Slack session an isolated workspace directory. The Codex session always starts in that neutral workspace instead of being pinned to a specific repository. If code work is needed, the agent is expected to use a shared `repos/` cache for canonical clones and create any task-specific git worktrees under the current session workspace. Normal thread replies continue the same Codex thread. Sending `-stop` in the thread interrupts the current Codex turn.

On the first `@bot` inside an existing Slack thread, the broker backfills a bounded slice of earlier thread history into Codex. If Codex needs older context than the initial backfill, it can query the broker's local thread-history HTTP API from inside its shell.

## What It Expects

- A Slack app using Socket Mode
- Codex authentication via either:
  - `OPENAI_API_KEY`
  - a mounted `auth.json` plus `CODEX_AUTH_JSON_PATH`

## Slack App Setup

Create a Slack app with:

- Socket Mode enabled
- App-level token with `connections:write`
- Bot token scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history`
  - `files:read` if you want Codex to receive image attachments from Slack messages
  - `files:write` if you want Codex to upload images/files back into Slack threads
  - `users:read` if you want Codex to see Slack display names instead of only raw user IDs

Event subscriptions needed for the current broker flow:

- `app_mention`
- `message.channels`
- `message.im` for direct-message sessions

If you want to support private channels or DMs, add the corresponding `groups:history`, `im:history`, or `mpim:history` scopes plus matching message events.

## Environment

Copy `.env.example` to `.env` and fill in:

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- optional `SLACK_INITIAL_THREAD_HISTORY_COUNT`
- optional `SLACK_HISTORY_API_MAX_LIMIT`
- optional `SESSIONS_ROOT`
- optional `REPOS_ROOT`
- optional `LOG_DIR`
- optional `LOG_LEVEL`
- optional `LOG_RAW_SLACK_EVENTS`
- optional `LOG_RAW_CODEX_RPC`
- optional `LOG_RAW_HTTP_REQUESTS`
- one Codex auth mode
- optional host Codex home mount if you want the container to inherit your global `~/.codex` memory/instructions

## Codex Auth Modes

### 1. API key

Set:

```env
OPENAI_API_KEY=sk-...
```

This is the simplest automation setup.

### 2. Reuse Codex/ChatGPT OAuth

Mount an existing `auth.json` into the container and set:

```env
CODEX_AUTH_JSON_PATH=/auth/auth.json
```

Then add a read-only volume to `docker-compose.yml`:

```yaml
volumes:
  - ~/.codex/auth.json:/auth/auth.json:ro
```

At startup the broker copies that file into its own `CODEX_HOME`/data directory and uses it to authenticate the embedded Codex app-server.

If you want the broker to drop stale OAuth MCP entries that exist in your host config but are not logged in inside the container, set:

```env
CODEX_DISABLED_MCP_SERVERS=notion
```

This only removes those MCP servers from the broker's container-local Codex config. It does not modify your host `~/.codex/config.toml`.

## Reuse Global Codex Memory

If you want the containerized Codex to see your global `~/.codex` files such as:

- `AGENT.md`
- `AGENTS.md`
- `memory.md`
- `memories/`
- `skills/`
- `superpowers/`

mount your host Codex home and point the runtime at it:

```env
CODEX_HOST_HOME_PATH=/Users/you/.codex
CODEX_HOST_HOME_PATH_HOST=/Users/you/.codex
HOST_AGENTS_PATH_HOST=/Users/you/.agents
HOST_AGENTS_CONTAINER_PATH=/Users/you/.agents
```

Recommended behavior:

- `AGENT.md` is the broker's canonical personal memory file; it is bootstrapped once from your host `~/.codex/AGENT.md` if present, then persisted inside the broker state
- new Slack sessions inject that personal memory once at `thread/start`; later turns reuse the existing session context instead of re-sending it
- the runtime shell path `~/.codex/AGENT.md` is wired back to the broker-managed personal memory file, so agent-written memory updates persist without touching your host home directly
- `AGENTS.md` is bootstrapped from your host `~/.codex` once and then lives independently inside the broker container state, so host and broker instructions can diverge
- `memory.md` is still linked back to your host `~/.codex`, so durable notes continue to persist across restarts
- directories like `skills/` and `superpowers/` are copied into the container `CODEX_HOME`
- `HOST_AGENTS_PATH_HOST` plus `HOST_AGENTS_CONTAINER_PATH` lets relative skill symlinks like `../../.agents/...` resolve correctly during that copy
- if your host skills contain relative symlinks, set `CODEX_HOST_HOME_PATH` to the same absolute path as the host so those symlinks keep resolving inside the container

This keeps personal memory on the familiar `~/.codex/AGENT.md` path inside the broker runtime, while allowing broker-specific repo instructions (`AGENTS.md`) to fork away from your personal host setup without sharing the container's sqlite/log/session state.

## Run With Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The container image:

- uses Node 22
- installs `git`
- installs `gh`
- installs `rg` via `ripgrep`
- installs the Codex CLI globally via `@openai/codex`
- runs the broker with `node dist/src/index.js`

## Runtime Layout

Inside the container:

- broker state lives under `/app/.data`
- Codex state defaults to `/app/.data/codex-home`
- session workspaces default to `/app/.data/sessions/<channel-thread>/workspace`
- shared canonical repositories live under `/app/.data/repos`
- structured logs default to `/app/.data/logs`

## Logging

The broker now keeps a layered JSONL log set intended for postmortem debugging.

Default layout under `LOG_DIR`:

- `broker.jsonl`
  Global structured application log for every `info` / `warn` / `error` / `debug` event.
- `sessions/<session-key>.jsonl`
  Per-session fan-out log. Useful when one Slack thread goes bad and you want only its history.
- `jobs/<job-id>.jsonl`
  Per-background-job fan-out log.
- `raw/slack-events.jsonl`
  Raw Socket Mode envelopes from Slack.
- `raw/codex-rpc.jsonl`
  Raw Codex app-server RPC requests, responses, and notifications.
- `raw/http-requests.jsonl`
  Raw local broker HTTP traffic for `/slack/*` and `/jobs/*`.

Supported environment knobs:

- `LOG_LEVEL=debug|info|warn|error`
- `LOG_RAW_SLACK_EVENTS=true|false`
- `LOG_RAW_CODEX_RPC=true|false`
- `LOG_RAW_HTTP_REQUESTS=true|false`

Notes:

- Raw logs are intentionally verbose and can grow quickly during long sessions.
- `/slack/post-file` request logging redacts inline `content_base64` payloads into a size marker instead of writing the full blob.
- Session and job log files are written independently, so one noisy thread no longer forces the entire broker state or log history into one giant file.

## Current Interaction Model

- First `@bot ...` in a thread: create or resume the session, ensure the session workspace exists, send the message to Codex
- First `@bot ...` inside an already active human thread: also backfill the most recent earlier thread messages before that mention
- Later plain thread replies: continue the same Codex thread
- Direct message root message: create a session keyed by that DM thread and send it to Codex
- `-stop`: interrupt the current Codex turn
- If the task needs code, Codex should use `/app/.data/repos` for canonical clones and create any worktrees or task directories inside the current session workspace

## Slack Thread History API

The broker exposes a local-only helper endpoint on the same port as the health check:

```bash
curl "http://127.0.0.1:3000/slack/thread-history?channel_id=C123&thread_ts=111.222&before_ts=111.223&limit=20&format=text"
```

Query params:

- `channel_id` (required)
- `thread_ts` (required)
- `before_ts` (optional, exclusive upper bound)
- `limit` (optional, clamped by `SLACK_HISTORY_API_MAX_LIMIT`)
- `channel_type` (optional)
- `format=text|json` (default `json`)

This is meant for Codex itself to pull older Slack context when the initial backfill window is not enough.

## Slack Post APIs

The broker exposes two local-only delivery endpoints for Codex:

### Post text

```bash
curl -sS -X POST http://127.0.0.1:3000/slack/post-message \
  -H 'content-type: application/json' \
  -d '{"channel_id":"C123","thread_ts":"111.222","text":"working on it"}'
```

### Upload a local image or file

```bash
curl -sS -X POST http://127.0.0.1:3000/slack/post-file \
  -H 'content-type: application/json' \
  -d '{"channel_id":"C123","thread_ts":"111.222","file_path":"/absolute/path/to/report.png","initial_comment":"latest screenshot"}'
```

`/slack/post-file` accepts either:

- `file_path` pointing at a local file visible to the broker process
- or `content_base64` plus `filename`

Optional fields:

- `title`
- `initial_comment` (or `text` as an alias)
- `alt_text`
- `snippet_type`
- `content_type`

## Notes

- This compose file is intentionally minimal and does not pre-mount or pre-select any single target repository.
- The runtime image already includes `gh`, `git`, and `rg`.
- The broker no longer manages repo selection or git worktree naming. That is now an agent-level responsibility inside the shared `repos/` cache and the current session workspace.

## GitHub Support

If you want Codex to push branches or open PRs with `gh`:

- set `GH_TOKEN` (and optionally `GITHUB_TOKEN`) to a token with `repo` scope
- mount an SSH agent socket if your repo remote uses `git@github.com:...`

Example:

```env
GH_TOKEN=gho_***
SSH_AUTH_SOCK_HOST=/run/host-services/ssh-auth.sock
SSH_AUTH_SOCK_CONTAINER=/ssh-agent
```

The runtime image includes `gh`, exports your GitHub token to the process environment, and configures git to:

- use `gh auth git-credential` as the credential helper
- rewrite `git@github.com:...` remotes to `https://github.com/...`

That means `gh` and ordinary `git push` can both work with a GitHub token, even if the checked-out repo still uses an SSH-style origin URL.

## License

[MIT](LICENSE)
