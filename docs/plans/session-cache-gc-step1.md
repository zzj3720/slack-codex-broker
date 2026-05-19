# Session cache GC Step 1 plan

## Goal

Add a safe broker-side GC pass for rebuildable session-local caches so historical Slack sessions stop accumulating Xcode and frontend dependency artifacts.

## Current state

- The broker already has `DiskPressureCleanupService`, but it is oriented around old logs and whole inactive-session deletion under disk pressure.
- macOS Cueboard sessions leave large rebuildable artifacts in `frontend/macos/.build/DerivedData`.
- Web sessions can leave Yarn `node_modules` under `web/` or `workers/`.
- Yarn 4 already uses a user/global download cache in observed sessions, so Step 1 should not change Yarn or pnpm behavior.

## Proposed Step 1 behavior

- Keep cleanup safe by default:
  - `DISK_CLEANUP_DRY_RUN=true` by default.
  - Session cache TTL defaults to 7 days.
  - Disk waterline thresholds remain configurable.
- Clean only rebuildable cache artifacts in inactive/unprotected sessions:
  - `frontend/macos/.build/DerivedData` on Darwin only.
  - `web/node_modules` and `workers/node_modules` after TTL.
  - Small generated build files such as `xcodebuild.log` and `default.profraw` after TTL.
- Skip sessions considered active/protected by broker state:
  - active turn present;
  - pending/inflight inbound message;
  - registered/running background job.
- Preserve observability:
  - Each candidate/delete emits a structured log event including `sessionKey`, `path`, `bytes`, `dryRun`, and action.
- Do not implement shared SwiftPM cache in this PR.

## Acceptance criteria

- Unit tests cover dry-run default, TTL, skip active/protected sessions, Darwin-only Xcode cache cleanup, real deletion, and structured logging fields.
- Config tests cover the new dry-run/session cache TTL settings.
- Manual dry-run can list candidates without deleting files.
