# Keep thread initiator GitHub PR identity with shared HOME

## Goal

Slack broker Codex sessions should keep using the Slack thread initiator's bound GitHub account for `gh pr create` and related GitHub operations, even when the runtime uses the shared VM `HOME` for app/runtime files.

## Current state

- Auth profile runtimes now intentionally use the VM `HOME` so Codex/Gemini can share durable user-level files.
- The broker-provided `gh` wrapper resolves a token from `/slack/github-token/resolve` based on the current session workspace and injects it as `GH_TOKEN`.
- The shared VM `HOME` can also contain a normal GitHub CLI login at `~/.config/gh/hosts.yml` and git credential helpers in `~/.gitconfig`.
- If a session command bypasses the wrapper or a git credential lookup reads the shared `gh` config, PRs can be created with the shared HOME account instead of the thread initiator account.

## Proposed changes

1. Keep the shared runtime `HOME`; do not revert to per-profile HOME.
2. Give each auth-profile runtime an isolated broker-managed `GH_CONFIG_DIR` next to its `codex-home`.
3. Start Codex app-server and broker-managed git/codex setup commands with global GitHub token env stripped and the isolated `GH_CONFIG_DIR` set.
4. Add session git credential config through environment entries so GitHub credential requests reset shared HOME helpers and route through the broker `gh` wrapper (`gh auth git-credential`).
5. Keep the existing broker `gh` wrapper behavior: resolve the token from the session workspace and pass only that token to real `gh`.
6. Forward stdin through the `gh` wrapper so `git credential` helper calls can pass credential input through to real `gh`.
7. Include GitHub's `workflow` OAuth scope in new PR identity bindings so fork syncs and branch pushes that contain upstream workflow-file history can succeed.

## If we do not change it

The shared HOME account can leak into PR creation or git credential flows, causing PRs to be authored by the wrong GitHub account even when the Slack initiator has a valid binding.

## After the change

- `HOME` remains shared for runtime/user files.
- `CODEX_HOME` remains per auth profile.
- Direct real `gh` calls no longer see the shared HOME login by default from a broker session.
- `gh` on PATH continues to use the broker wrapper and the thread initiator token.
- Direct git credential requests for GitHub use the broker wrapper token instead of shared HOME credentials.
- New GitHub PR identity bindings request `workflow`; existing bindings that lack it may need to rebind before they can update stale forks containing workflow changes.

## Acceptance criteria

- Tests prove app-server env keeps shared `HOME`, per-profile `CODEX_HOME`, isolated `GH_CONFIG_DIR`, and no global GitHub token env.
- Tests prove git setup env includes the same isolated `GH_CONFIG_DIR` and overrides GitHub credential helpers to use broker `gh`.
- Tests prove the `gh` wrapper still injects only the broker-resolved token into real `gh` while preserving the isolated `GH_CONFIG_DIR` and forwarding stdin.
- Manual validation in this session shows a Slack session workspace resolves `pengx17` through broker `gh`, direct real `gh` cannot read shared credentials when `GH_CONFIG_DIR` is isolated, and git credential helper input reaches real `gh` through the wrapper.
