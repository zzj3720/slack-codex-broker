# Session delete API plan

## Goal
Add a broker admin API that can stop and delete one Slack/Codex session by session key.

## Current state
- Admin APIs can reset a session and cancel a single background job.
- Worker APIs can reset/resume a session and cancel an individual job from admin.
- `SessionManager.deleteSessionByKey` already removes persisted session state and the session workspace.
- Disk-pressure cleanup already removes session/job log artifacts, but only for inactive cleanup.

## Proposed changes
1. Add an admin route: `DELETE /admin/api/sessions/:sessionKey`.
2. Add an internal worker route: `DELETE /slack/sessions/:sessionKey`.
3. Add worker-side session deletion that:
   - clears queued runtime work,
   - interrupts any active turn,
   - marks pending/inflight inbound messages done,
   - clears assistant status,
   - deletes session state/workspace.
4. Add admin orchestration that:
   - finds the session and related background jobs,
   - best-effort cancels any registered/running jobs through the worker job cancel API and records per-job failures,
   - asks the worker to stop/delete the session,
   - removes session/job log and job working-directory artifacts after checking each path stays under managed roots,
   - records an admin operation/audit event.

## If we do not change it
Operators must keep using reset/cancel/cleanup internals manually, which leaves no single safe API to remove a bad or obsolete session.

## After the change
An authorized admin caller can delete a specific session in one request without waiting for disk cleanup and without leaving active turns or running broker-managed jobs behind.

## Acceptance criteria
- API returns `ok: true` with the deleted session key, cancelled job count, and worker delete result.
- Missing session returns a failed admin operation/error with HTTP 404.
- Active turns are interrupted before state deletion.
- Registered/running jobs for the session are best-effort cancelled before deletion; cancel failures are included in the response.
- Session state, workspace, session logs, job logs, and job directories are removed.
- Tests cover admin route forwarding and end-to-end admin-to-worker deletion behavior.
