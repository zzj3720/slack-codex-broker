# Session GitHub PR Identity

## Goal

Use the Slack user who starts a broker session as the preferred GitHub identity
for PR creation from that session.

The session starter is the first human Slack user who causes the broker to create
the session by mentioning the bot or sending a direct message. Later thread
participants do not change the session starter.

## Non-Goals

- Do not replace the existing commit co-author system.
- Do not expose GitHub tokens to the agent prompt, trace, logs, or session UI.
- Do not make an unbound GitHub account block session startup.
- Do not silently fall back to the default GitHub account when a bound starter
  token is revoked or lacks access.

## Current State

The broker already tracks Slack session workspaces and can resolve a workspace
back to a session. It also has a Slack user to GitHub author mapping for commit
co-author trailers. That mapping is not a GitHub account credential and cannot
control the GitHub account used by `gh pr create`.

The PR author is determined by the GitHub token used by the `gh` command. The
correct control point is therefore broker-managed GitHub credentials, not prompt
guidance or git commit author configuration.

## Data Model

`SlackSessionRecord` gains:

- `initiatorUserId`: Slack user id that started the session.
- `initiatorMessageTs`: Slack message timestamp that started the session.
- `initiatorCapturedAt`: timestamp when the broker recorded the initiator.

GitHub OAuth binding records are keyed by Slack user id:

- `slackUserId`
- `githubLogin`
- `githubUserId`
- `token`
- `scopes`
- `createdAt`
- `updatedAt`
- `lastValidatedAt`
- `revokedAt`

The default GitHub PR identity is configured separately and is visible to users
when a session starter is unbound.

## Session Link Behavior

When the broker posts the session detail link:

- If the starter has a valid GitHub OAuth binding, the link message can stay
  compact.
- If the starter is not bound, the link message must say that PRs will use the
  default GitHub account and include a binding link.
- This reminder is sent at session startup, not delayed until PR creation.
- The reminder is sent once with the session link and must not repeat every turn.

Example:

```text
Session 页面：https://...

当前发起人还没有绑定 GitHub 账号。
不绑定时，后续创建 PR 会使用默认账号 zzj3720。
绑定 GitHub：https://.../session/<key>/github/bind
```

## OAuth Flow

The session page exposes a GitHub identity panel. For an unbound starter it shows
the starter, the default GitHub account, and a bind action.

Binding uses GitHub device code OAuth:

1. Start device flow.
2. Show verification URL and user code.
3. Poll for completion.
4. Verify the resulting token against GitHub `/user`.
5. Persist the token under the Slack starter user id.
6. Refresh the session page state.

## Runtime PR Identity Resolution

The Codex app-server runtime receives a broker-managed `gh` wrapper before the
real `gh` in `PATH`.

The wrapper:

1. Resolves `cwd` to a Slack session through the broker.
2. Resolves the session starter's GitHub binding.
3. Uses the starter token when present and valid.
4. Uses the default GitHub token only when the starter is unbound.
5. Blocks when the starter has a binding but that token is invalid or lacks
   access.
6. Execs the real `gh` with `GH_TOKEN` set.

The wrapper must never print or log tokens.

## Acceptance Criteria

- A first `@bot` from `U_A` creates a session whose initiator remains `U_A`.
- A later thread reply from `U_B` does not change the initiator.
- The session link message includes an unbound GitHub warning and bind link when
  `U_A` has no binding.
- The session link message does not include the warning when `U_A` is bound.
- Device code OAuth can bind `U_A` to a GitHub login.
- Running `gh` inside the session workspace uses `U_A`'s token when bound.
- Running `gh` inside the session workspace uses the default token when `U_A` is
  unbound and the default is available.
- A revoked or invalid bound token blocks instead of silently using the default.
- Existing commit co-author behavior continues to work.
