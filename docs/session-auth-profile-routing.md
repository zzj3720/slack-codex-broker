# Session auth profile routing

## Goal

Each Slack session must bind to one managed Codex auth profile.

New sessions automatically select the usable profile with the most remaining Codex quota. After a session is bound, the broker must keep using that profile. If the bound profile becomes unavailable, the broker must not automatically switch to another profile. It must stop dispatch for that session, preserve pending Slack input, post one Slack message with the session page link, and wait for a human to switch the session profile from the session page.

## Current State

The broker already manages auth profiles under `.data/auth-profiles/docker/profiles`. `AuthProfileService` can list profiles, probe account and quota state, and change the global active profile.

The agent runtime is currently global. A worker process creates one Codex app-server runtime with one `CODEX_HOME/auth.json`. Admin profile activation changes the global active auth and restarts the worker runtime. That is not session binding. It is unsafe for concurrent sessions because one session can change the auth identity used by another.

## Target Model

The worker owns an auth-profile runtime pool:

- one Codex runtime per auth profile,
- one isolated `CODEX_HOME` per runtime,
- one `auth.json` per runtime copied from the bound profile,
- one app-server port per runtime,
- one `AppServerClient` per runtime.

The session row stores:

- `auth_profile_name`,
- `auth_profile_bound_at`,
- `auth_blocked_at`,
- `auth_block_reason`,
- `auth_blocked_notice_posted_at`.

The broker routes every agent operation through the runtime selected by `session.authProfileName`.

## Profile Selection

New session selection uses probed profile snapshots:

- exclude profiles whose account or rate limit probe failed,
- exclude profiles whose primary or secondary Codex limit is exhausted,
- rank by effective remaining quota,
- use deterministic tie breaking.

Effective remaining quota is the conservative minimum of known primary and secondary remaining percentages. Missing windows are treated as 100 percent remaining for that window because some account types may omit one window.

## Bound Session Failure

Before dispatching a pending Slack input into Codex, the worker checks the bound profile. If the profile is unavailable:

- do not start or steer a Codex turn,
- leave inbound messages in `pending`,
- clear `active_turn_id`,
- set auth blocked fields on the session,
- record an agent trace event,
- post one Slack notice with the session link.

The notice is idempotent for one blocked state. Repeated Slack messages while the session remains blocked must not spam the thread.

## Manual Recovery

The session page exposes the current auth binding and available profile list. A user can choose a usable profile and click `切换并继续处理`.

The admin action must:

- validate the selected profile exists and is usable,
- update the session auth binding,
- clear auth blocked fields,
- reset `agent_session_id` because the old app-server thread belongs to a different profile runtime,
- record an agent trace event,
- ask the worker to resume pending dispatch for that session.

Admin is a separate process in deployment, so resuming work cannot be an in-process call. The admin process calls a local worker HTTP endpoint after updating the shared state database.

## Acceptance Criteria

- A new session automatically binds to the usable profile with the most effective remaining quota.
- Existing sessions keep their bound profile even when another profile later has more quota.
- If the bound profile is unavailable, the broker does not auto-switch.
- The pending Slack input remains pending while auth is blocked.
- Slack receives exactly one blocked notice per blocked state, with the session page link.
- The session page shows the current binding, blocked reason, profile candidates, and a `切换并继续处理` action.
- Manual switch clears the blocked state, resets stale agent runtime state, and resumes pending dispatch through the newly selected profile runtime.
- Slack behavior is unchanged for healthy sessions.
