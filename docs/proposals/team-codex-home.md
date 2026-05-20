# Team Codex Home Plan

## Goal

Separate OpenAI authentication/quota profiles from long-lived team-level Codex behavior. Auth profiles should only determine which `auth.json`/quota is used; all profiles should share one canonical memory/config/tooling home.

## Current state

- Each auth profile gets its own runtime root under `.data/auth-profile-runtimes/<profile>/`.
- Each profile's app-server runs with:
  - `CODEX_HOME=.data/auth-profile-runtimes/<profile>/codex-home`
  - `HOME=.data/auth-profile-runtimes/<profile>/runtime-home`
- `CodexBroker` reads personal memory from `<CODEX_HOME>/AGENT.md` and injects it into Slack base instructions as `Personal long-lived memory from ~/.codex/AGENT.md`.
- `runtime-home/.codex/AGENT.md` symlinks back to the profile-local `codex-home/AGENT.md`.
- `syncUserCodexHome()` keeps `AGENT.md` and `AGENTS.md` detached, so once copied into a profile they drift independently.

Observed on the current machine: auth profiles have different `AGENT.md` files, and at least one profile has different `config.toml`. That means memory/config are currently isolated by auth profile, not by team or Slack user.

## Proposed state

Add a team-level Codex home:

- `CODEX_TEAM_HOME` env var, defaulting to `.data/team-codex-home`.
- Shared entries live in `CODEX_TEAM_HOME`:
  - `AGENT.md`
  - `AGENTS.md`
  - `memory.md`
  - `config.toml`
  - `memories/`
  - `rules/`
  - `skills/`
  - `superpowers/`
  - `vendor_imports/`
- Per-profile `CODEX_HOME` remains the app-server home, but those shared entries are symlinked to `CODEX_TEAM_HOME`.
- Per-profile state remains local to the auth profile:
  - `auth.json`
  - logs/state/cache/session files
  - generated images/model cache/runtime scratch files
- `CodexBroker` reads personal memory from `CODEX_TEAM_HOME/AGENT.md`, not the profile-local home.
- `runtime-home/.codex/AGENT.md` points at the same team-level `AGENT.md`.

## Migration stance

The historical profile data migration is intentionally out of band. The broker runtime should not contain one-off candidate scanning, backup, merge, or migration marker code.

Operationally, an owner can seed `CODEX_TEAM_HOME` once before or during rollout by reviewing current profile homes, copying the chosen canonical files/directories into the team home, and backing up old profile-local files outside the application code path. After that, the application only enforces the shared-home contract by creating missing empty team files/directories and linking profile shared entries to them.

If `CODEX_TEAM_HOME` is still empty while an existing profile/source home has shared content, the runtime preserves the legacy local-copy behavior instead of linking the profile to an empty team home. This keeps a missed one-off seed from erasing existing memory/config on startup.

## Acceptance criteria

- `CODEX_TEAM_HOME` is configurable and documented.
- Different auth profiles resolve shared entries through the same team home.
- `auth.json` and runtime state remain per-profile and are never linked to the team home.
- `CodexBroker` injects personal memory from the team home.
- If the team home is not seeded, existing profile/source memory is preserved and not replaced by empty team files.
- Updating `CODEX_TEAM_HOME/AGENT.md` is visible to all profiles without editing profile-local files.
- Tests cover team-home symlink cutover and memory path selection.
