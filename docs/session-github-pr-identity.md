# Session GitHub PR Identity

## Goal

Use the Slack user who starts a broker session as the preferred GitHub identity
for PR creation from that session.

The session starter is the first human Slack user who causes the broker to create
the session by mentioning the bot or sending a direct message. Later thread
participants do not change the session starter.

## Non-Goals

- Do not remove commit co-author trailers.
- Do not expose GitHub tokens to the agent prompt, trace, logs, or session UI.
- Do not make an unbound GitHub account block session startup.
- Do not silently fall back to the default GitHub account when a bound starter
  token is revoked or lacks access.

## Current State

The broker already tracks Slack session workspaces and can resolve a workspace
back to a session. Older Slack user to GitHub author mappings may still exist on
disk as orphan migration data, but they are not GitHub credentials and must not
drive admin account management or commit co-author resolution.

The PR author is determined by the GitHub token used by the `gh` command. The
correct control point is therefore broker-managed GitHub credentials, not prompt
guidance or git commit author configuration.

Before this change, admin exposed the co-author mapping as `GitHub 作者映射`,
the OAuth PR binding as session-local state, and the default PR token as env.
That split makes the operator reason about the same Slack person in three
places. The admin surface should instead manage `GitHub 账号`: one Slack user row
that shows OAuth binding state and whether it is the default PR account.

## Data Model

`SlackSessionRecord` gains:

- `initiatorUserId`: Slack user id that started the session.
- `initiatorMessageTs`: Slack message timestamp that started the session.
- `initiatorCapturedAt`: timestamp when the broker recorded the initiator.

GitHub OAuth binding records are keyed by Slack user id:

- `slackUserId`
- `githubLogin`
- `githubUserId`
- `githubEmail`
- `githubName`
- `token`
- `scopes`
- `createdAt`
- `updatedAt`
- `lastValidatedAt`
- `revokedAt`

GitHub account rows in admin are keyed by Slack user id and combine:

- Slack identity (`userId`, display name, username, real name, email).
- GitHub OAuth binding (`githubLogin`, `githubUserId`, scopes, binding
  timestamps, revoked timestamp, GitHub email).
- Default PR account flag.

The default GitHub PR identity is persisted as a selected Slack user id. It can
only point at an existing non-revoked OAuth binding. The legacy env default
token remains a migration fallback when no bound default is selected, but the
admin UI should not make env tokens look like normal managed accounts.

## Admin Account Management

The old `GitHub 作者映射` panel becomes `GitHub 账号`.

This panel is React-owned. The legacy admin DOM script must not render the
GitHub account list, bind GitHub account buttons, or mutate that panel with
`innerHTML`.

For each Slack user row, admin shows:

- the Slack user identity;
- whether a GitHub OAuth account is bound;
- the bound GitHub login when present;
- the GitHub email from OAuth when present;
- whether this row is the default PR account.

Admin actions:

- bind or rebind GitHub OAuth for an existing Slack user row;
- set the default PR account to a bound, non-revoked GitHub OAuth account.

The default PR account selector is a top-level control in the GitHub account
panel. It must not be hidden as a row-only secondary action, because operators
need an obvious place to inspect and change the global fallback account.

Admin must not expose an "add Slack id" form. Slack user ids are runtime
identity, not operator-entered account data. The operator chooses an existing
Slack user row and starts OAuth from that row.

OAuth is the source of GitHub login and GitHub email. Admin must not ask the
operator to type an email for the GitHub account. Existing co-author mappings are
deprecated for this admin surface. They must not create GitHub account rows,
appear as "history" metadata, or provide editable email/account information here.

The session page bind action and the admin row bind action both start a GitHub
CLI login automatically. A `/github/bind` session deep link renders a dedicated
binding page instead of the full session inspector. That page only handles the
GitHub binding flow: show the session starter binding status, start device-code
OAuth, show the verification URL and user code, poll completion, and provide a
link back to the session page. The broker must use an isolated `GH_CONFIG_DIR`
for each pending bind so the login does not read or overwrite the machine's
global GitHub CLI account.

## Session Link Behavior

When the broker posts the session detail link:

- If the starter has a valid GitHub OAuth binding, the link message can stay
  compact.
- If the starter is not bound, the link message must include a binding link.
- If a default GitHub account is configured, the unbound warning must say PRs
  will use that default account.
- If no default GitHub account is configured, the unbound warning must say PR
  creation does not have a usable GitHub PR account until binding is completed.
- This reminder is sent at session startup, not delayed until PR creation.
- The reminder is sent once with the session link and must not repeat every turn.

Example:

```text
Session 页面：https://...

当前发起人还没有绑定 GitHub 账号。
不绑定时，后续创建 PR 会使用默认账号 default-bot。
绑定 GitHub：https://.../session/<key>/github/bind
```

Without a default GitHub account:

```text
Session 页面：https://...

当前发起人还没有绑定 GitHub 账号。
当前没有默认 GitHub PR 账号，创建 PR 前需要先绑定。
绑定 GitHub：https://.../session/<key>/github/bind
```

## Binding Flow

The session detail page may expose a compact GitHub identity action for admins,
but the user-facing bind link must land on the dedicated bind page. For an
unbound starter it shows the starter, the default GitHub account, and the binding
flow without the session timeline, auth profile switcher, reset button, token
statistics, jobs, or debug panels.

Binding uses GitHub CLI:

1. Create an isolated temporary `GH_CONFIG_DIR`.
2. Run `gh auth login --web --git-protocol https --skip-ssh-key` in that
   isolated directory.
3. Parse the one-time code and verification URL from `gh` output.
4. Show the verification URL and user code in the session page.
5. Poll the `gh auth login` process for completion.
6. After success, read the active login with `gh auth status --json hosts` and
   the token with `gh auth token`.
7. Verify the resulting token against GitHub `/user`.
8. Read the GitHub primary email from OAuth-backed GitHub API data.
9. Persist the token, login, user id, scopes, and email under the Slack starter
   user id.
10. Delete the temporary `GH_CONFIG_DIR`.
11. Refresh the binding page state and show the bound GitHub login.

The broker must never run this flow against the global `gh` config, because
binding one Slack user must not mutate the server's operator account.

The broker may run all auth-profile app-servers with the VM operator `HOME`.
That shared `HOME` is acceptable because GitHub PR identity must not be read
from global `gh` state. Device-code OAuth uses a temporary `GH_CONFIG_DIR` and
app-server children must not inherit `GH_TOKEN` or `GITHUB_TOKEN`.

## Runtime GitHub Identity Resolution

The Codex app-server runtime receives a broker-managed `gh` wrapper before the
real `gh` in `PATH`.

The wrapper:

1. Resolves `cwd` to a Slack session through the broker.
2. Resolves the session starter's GitHub binding.
3. Uses the starter token when present and valid.
4. Uses the selected default bound account when the starter is unbound.
5. Uses the legacy env default token only when no selected default bound account
   exists.
6. Blocks when the starter has a binding but that token is invalid or lacks
   access.
7. Blocks when a selected default bound account becomes revoked or invalid
   instead of silently using the legacy env fallback.
8. Execs the real `gh` with `GH_TOKEN` set.

The wrapper must never print or log tokens.

The wrapper must also remove inherited `GH_TOKEN` and `GITHUB_TOKEN` before it
execs the real `gh`, then set `GH_TOKEN` to the token resolved for the current
session. This keeps shared VM `HOME` compatible with different threads using
different GitHub PR accounts.

## Commit Co-Authors

Commit co-author trailers use the same Slack user GitHub OAuth binding. The
broker no longer accepts or writes manual `Name <email>` author mappings for
this path.

When a Slack participant is selected as a co-author:

- If that Slack user has a valid GitHub OAuth binding with a GitHub email, the
  broker appends `Co-authored-by: <GitHub name or login> <GitHub email>`.
- If the binding is missing, revoked, or has no email, the participant is
  unresolved and is skipped unless the session is configured to wait for user
  input.
- The Slack co-author modal lets users choose participants and whether to skip
  unresolved participants. It must not include manual GitHub author text inputs.
- The configure endpoint accepts current-session contributors by Slack user id,
  @mention, display name, real name, username, or email. It must reject legacy
  `github_author` mappings and tell callers to bind GitHub OAuth instead.

## Acceptance Criteria

- A first `@bot` from `U_A` creates a session whose initiator remains `U_A`.
- A later thread reply from `U_B` does not change the initiator.
- The session link message includes an unbound GitHub warning and bind link when
  `U_A` has no binding.
- The bind link opens a dedicated GitHub binding page, not the full session
  timeline/detail view.
- The session link message still includes the unbound GitHub warning and bind
  link when no default GitHub account is configured.
- The session link message does not include the warning when `U_A` is bound.
- Device code OAuth can bind `U_A` to a GitHub login.
- Device code OAuth stores the GitHub email from GitHub API data.
- Admin shows a unified GitHub account row for `U_A` containing Slack identity
  and OAuth binding state.
- Admin does not show a global "新增" GitHub account button.
- Admin does not allow editing the Slack user id when binding GitHub.
- Admin does not show legacy Commit 作者 metadata in GitHub account rows.
- Admin can bind or rebind GitHub OAuth from an existing Slack user row.
- Admin can set the default PR account only to a bound, non-revoked GitHub
  OAuth account.
- Admin exposes the default PR account as a visible top-level selector in the
  GitHub account panel.
- Running `gh` inside the session workspace uses `U_A`'s token when bound.
- Running `gh` inside the session workspace uses the selected default bound
  account when `U_A` is unbound and that default is available.
- Running `gh` inside the session workspace uses the legacy env default token
  only when `U_A` is unbound and no selected default bound account exists.
- Sharing the VM operator `HOME` across auth-profile app-servers does not change
  PR identity selection.
- Global `GH_TOKEN`/`GITHUB_TOKEN` values are not visible to app-server or
  device-code child processes.
- A revoked or invalid bound token blocks instead of silently using the default.
- A revoked or invalid selected default account blocks instead of silently using
  the legacy env fallback.
- Commit co-author trailers are generated from the selected Slack users'
  GitHub OAuth bindings.
- The co-author Slack modal does not render manual `Name <email>` inputs.
- The co-author configure endpoint rejects legacy `github_author` mappings.
