# Admin Live Operations Followups

## Goal

Make the post-npm-deployment admin workflow usable and safe in day-to-day
operations.

This batch covers four concrete gaps:

1. Local admin UI preview against the live admin API must be one command.
2. Slack missed-message recovery must be a bounded safety net, not a 15-second
   scan that can wake many sessions and hit Slack 429 repeatedly.
3. The React admin shell must keep showing the session index even when overview
   or logs are slow.
4. The old Git-worktree deployment shape must stop being the active runtime
   contract after npm package deployment is stable.

## Current State

The npm split deployment is live: admin and worker run from separate installed
package release directories and `current-admin` / `current-worker` symlinks.

Remaining problems:

- `pnpm dev:admin-ui` only starts Vite. It does not establish a live API tunnel
  or set `ADMIN_API_PROXY_ORIGIN`, so a local preview can render without data.
- The Vite development proxy reads request bodies with `data` / `end` handlers.
  For body-less GET requests it must resume the incoming request stream, or the
  forwarded API request can hang.
- Missed Slack thread recovery runs on the active-turn reconciler cadence by
  default. In production that meant scanning many candidate sessions roughly
  every 15 seconds. When Slack responds with 429, the worker currently treats it
  as a normal failure and will try the same broad scan again on the next
  interval.
- The admin shell already fetches `/admin/api/sessions` before overview and logs.
  That ordering is part of the required contract because overview and logs are
  secondary data.
- The live machine still has old Git-worktree release symlinks around for
  rollback context. Those links must not be the active deploy path.

## Target Design

### Local Live Preview

`pnpm dev:admin:remote` starts a local admin UI on `127.0.0.1:5173` and connects
it to the live admin API through a local SSH tunnel.

Defaults:

- SSH host: `admin@100.67.4.27`
- SSH proxy command:
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale nc %h %p`
- local API tunnel: `127.0.0.1:3000 -> 127.0.0.1:3000`
- Vite admin UI: `127.0.0.1:5173`

The script may reuse an existing local API tunnel if `/readyz` already answers.
It must not kill processes by port. In particular, it must never use
`lsof -ti -iTCP:<port> | xargs kill`.

### Slack Missed-Message Recovery

Missed-message recovery is a fallback for socket gaps and reconnects. It should
not be the normal way to discover every message.

Rules:

- The default periodic recovery interval is minutes, not seconds.
- `socket_ready` recovery still runs after socket connection.
- Periodic recovery respects the configured interval for tests and controlled
  deployments.
- A Slack 429 from `conversations.replies` pauses the recovery scan immediately.
- The worker uses Slack `Retry-After` when available and otherwise exponential
  bounded backoff.
- During backoff, periodic recovery skips work instead of repeating the same
  broad API scan.
- One rate-limited thread check must not wake additional sessions in the same
  recovery pass.

### Admin Shell Loading

The React shell treats the session index as the primary page data:

1. fetch `/admin/api/sessions`;
2. publish it immediately;
3. open realtime from that cursor;
4. fetch `/admin/api/overview` and `/admin/api/logs` as secondary data.

If overview or logs are slow or unavailable, the session list must still be
visible and usable.

### Deployment Shape Cleanup

The npm package shape is the active runtime contract:

- admin deploy/rollback targets `@agent-session-broker/admin`;
- worker deploy/rollback targets `@agent-session-broker/worker`;
- launchd points at `current-admin` and `current-worker`;
- old root-level Git-worktree `current` / `previous` symlinks are legacy rollback
  artifacts only, not the deploy source of truth.

Cleanup must preserve the ability to roll back the newly deployed npm package
versions. It may archive or rename obsolete Git-worktree pointers, but must not
delete runtime state or secrets.

## Acceptance Criteria

- `docs/admin-live-ops-followups.md` records this goal and these acceptance
  criteria.
- `package.json` exposes `dev:admin:remote`.
- `scripts/dev/admin-remote.mjs` starts or reuses the SSH tunnel, waits for live
  `/readyz`, then starts Vite with `ADMIN_API_PROXY_ORIGIN`.
- The remote preview script contains no port-killing logic.
- The Vite dev proxy resumes body-less requests so `/admin/api/sessions` and
  `/admin/api/overview` complete through the proxy.
- `SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS` defaults to at least five minutes.
- Slack API 429 errors carry retry-after metadata.
- Missed-message recovery stops the current scan on Slack 429 and skips further
  periodic scans until the backoff expires.
- Admin React bootstrap continues to publish `/admin/api/sessions` before
  overview/logs.
- The live deployment is verified after the changes.
- Obsolete Git-worktree symlinks are no longer presented as active runtime
  symlinks after package deployment verification.
- `pnpm test` and `pnpm build` pass.

## Worker Startup Readiness

The worker must not require old session recovery to finish before it becomes
observable and able to accept fresh Slack work.

Production failure this protects against:

- The worker process can be alive under launchd while `127.0.0.1:3001/readyz`
  is closed.
- The blocking section is startup recovery: persisted active turn reconciliation,
  missed-message recovery, pending dispatch recovery, or synthetic message
  recovery.
- A single slow or stuck Codex turn snapshot read can keep the HTTP server from
  listening and delay Slack Socket Mode startup, making the bot look dead even
  though launchd shows the process as running.

Target behavior:

- Load state and run the cheap startup disk cleanup.
- Start the worker HTTP server before Slack/runtime recovery so `/readyz` can
  prove the process is reachable.
- Start Slack Socket Mode without waiting for old active-turn reconciliation.
- Run startup recovery in the background, log failures, and keep periodic
  reconciliation responsible for later cleanup.
- If a hard dependency such as Slack auth or agent runtime startup fails before
  Socket Mode can start, fail the worker process so launchd can restart it.

Additional acceptance:

- A test with a persisted active turn whose runtime snapshot read never resolves
  must show `SlackConversationService.start()` returning promptly.
- A regression test must keep worker HTTP listen before `bridge.start()`.
- Live verification must show admin `/readyz`, worker `/readyz`, current worker
  version, and a recent Slack Socket Mode connection after deploy.

## Worker SQLite Write Path

The worker must not let high-frequency trace or usage writes make the process
look dead. The worker still uses SQLite as the runtime source of truth, but each
incoming agent event must update derived data with bounded work.

Production failure this protects against:

- The worker process remains alive and `3001` keeps listening, but `/readyz`
  times out because the Node main thread is busy inside synchronous SQLite work.
- Slack Socket Mode reconnects and job callbacks are delayed behind the same
  synchronous write path, so the bot appears hung.
- A trace event write rebuilds a whole session summary by scanning every trace
  event for that session, and every admin event append also runs retention
  cleanup over the whole `admin_events` table.

Target behavior:

- A trace event write updates `agent_session_trace_summaries` incrementally from
  the inserted or updated event instead of rescanning the whole session.
- Admin realtime event retention is pruned in bounded batches based on the
  latest sequence, not with a full-table `NOT IN` cleanup on every append.
- `/readyz` remains responsive while active sessions emit many tool/trace
  events.

Additional acceptance:

- A regression test must prove `upsertAgentTraceEvent()` does not execute a
  whole-session `SELECT ... FROM agent_trace_events WHERE session_key = ?`.
- A regression test must prove admin event retention is not pruned for every
  appended admin event.
- `pnpm test` and `pnpm build` pass before deployment.

## Worker Hot Path Performance

The worker must preserve Slack behavior while removing redundant work from the
hot path. This section is explicitly not a behavior change: bot/app messages,
release notifications, thread replies, persisted Slack events, and recovery
passes must keep the same semantics.

Production failure this protects against:

- The active-turn reconciler is timer-driven. If one pass is still reading
  Codex app-server state or doing missed-message recovery, the next timer tick
  can start another identical pass over the same active sessions.
- Every processed Slack event currently prunes `processed_events` with a
  `NOT IN (SELECT ... LIMIT 2000)` cleanup.
- Every completed Slack event currently prunes `slack_events` with a
  `NOT IN (SELECT ... LIMIT 2000)` cleanup.

Target behavior:

- Active-turn reconcile timer ticks are coalesced: at most one live reconcile
  pass runs at a time.
- A coalesced timer tick does not cancel, skip, or reinterpret Slack work; it
  only avoids starting duplicate reconciliation while the previous equivalent
  pass is still running.
- `processed_events` retention runs in bounded batches using the monotonic
  sequence column, not with a full-table `NOT IN` cleanup on every event.
- completed `slack_events` retention runs in bounded batches using indexed
  timestamp ordering, not with a full-table `NOT IN` cleanup on every event.
- No filtering is added for bot/app Slack messages. If a message was supposed
  to wake an agent before this change, it must still wake an agent after this
  change.

Additional acceptance:

- A regression test must prove live active-turn reconciliation has a reentry
  guard.
- A regression test must prove processed Slack event retention is batched and
  does not use hot-path `NOT IN` cleanup.
- A regression test must prove completed Slack event retention is batched and
  does not use hot-path `NOT IN` cleanup.
- Existing Slack conversation behavior tests still pass.
- `pnpm test` and `pnpm build` pass before deployment.
