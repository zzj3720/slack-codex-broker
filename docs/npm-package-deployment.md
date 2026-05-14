# NPM Package Deployment

## Goal

Ship broker releases as built npm packages, with separate admin and worker
release units.

Production must not be a build machine. CI or a release workstation builds the
TypeScript and admin assets, stages runtime-only package directories, and
publishes versioned npm artifacts. The live admin process only chooses a package
target and version, installs that version into a versioned release directory,
switches that target's `current` symlink, and restarts only the affected launchd
service.

## Current State

The old release path was Git based:

- the live machine kept a repository clone;
- admin fetched refs from that clone;
- deploy created a Git worktree under `releases/<sha>`;
- deploy ran `pnpm install`, `pnpm build`, then `pnpm install --prod` on the
  live machine;
- rollback could resolve an arbitrary Git ref and build it if that release was
  not already present.

The first npm refactor still used one package as the release unit. That was safer
than Git worktrees, but it coupled admin UI releases and worker runtime releases:
an admin-only UI change still activated the worker package path, and a worker
deploy also implied an admin package change.

## Target Design

The release units are scoped npm packages under the `agent-session-broker` npm
organization:

- `@agent-session-broker/admin` contains the admin HTTP entry point, admin UI
  assets, and the launchd helpers needed by the admin service.
- `@agent-session-broker/worker` contains the worker entry point and the launchd
  helpers needed by the worker service.

The root package is a private build workspace. It must not be published as the
runtime artifact.

1. `pnpm build` creates `dist/` with server code, copied prompt assets, and the
   built admin UI.
2. `pnpm release:stage` creates runtime-only package directories for admin and
   worker from explicit package templates.
3. `pnpm release:pack` packs both staged package directories.
4. CI always builds, tests, stages, and packs both artifacts for the checked
   commit.
5. The npm publish workflow publishes both packages to npm for versioned
   releases.
6. The admin deployment service reads candidate versions from each target's
   package registry entry.
7. Deploy requires `{ target, version }` where target is `admin` or `worker`.
8. Admin deploy installs `@agent-session-broker/admin@<version>` into
   `<service-root>/releases/admin/npm-<version>/`, switches the admin current
   symlink, and restarts only the admin launchd service.
9. Worker deploy installs `@agent-session-broker/worker@<version>` into
   `<service-root>/releases/worker/npm-<version>/`, switches the worker current
   symlink, restarts only the worker launchd service, and waits for worker
   readiness.
10. Rollback requires a target and only activates a release already installed
    locally for that target. It never fetches source or builds a missing version
    during rollback.

Package contents are runtime-only:

- package metadata;
- `dist/src/`;
- `dist/admin-ui/` only for the admin package;
- launchd helper scripts needed by installed services;
- direct script dependencies needed by exported package binaries;
- README and license.

Source files, tests, local state, generated preview data, and private operator
configuration are not part of either package.

## Publish Workflow

Npm publication is a release operation, not a side effect of every push.

- Pull requests and pushes run CI build, test, stage, and pack.
- Versioned release tags and manual dispatch run the npm publish workflow.
- The publish workflow installs dependencies from the lockfile, builds, tests,
  stages both package directories, packs both artifacts for inspection, then runs
  `npm publish` for both staged package directories.
- The workflow uses `NPM_TOKEN` from GitHub Actions secrets and does not store
  npm credentials in the repository.
- The workflow requests GitHub OIDC permission and publishes with npm
  provenance.

## Public Boundary

Open-source metadata must point at the public repository. Tests and fixtures may
use reserved example identities, but must not encode real operator emails,
accounts, hosts, domains, or tokens as negative assertions.

The right test shape is to assert the expected public structure: package files,
repository metadata, deployment commands, and UI labels. Avoid tests like
"repository does not contain X" where `X` is a real private value.

## Admin UX

The publish panel selects target and package version, not free-form refs or main
commits.

- The target selector chooses admin or worker.
- The version selector lists recent package versions returned for the selected
  target.
- The deploy request sends `{ target, version }`.
- The recent release list is grouped by target.
- Each rollback button activates that already-installed target release.

## Acceptance Criteria

- The root `package.json` is private and acts as the build workspace.
- Admin package metadata names `@agent-session-broker/admin`.
- Worker package metadata names `@agent-session-broker/worker`.
- Package staging creates runtime-only directories for both packages.
- CI builds, tests, stages, and packs both npm artifacts.
- `.github/workflows/npm-publish.yml` publishes both scoped packages from
  versioned release tags or manual dispatch using `NPM_TOKEN`.
- Admin deployment status reports admin and worker package targets separately.
- Admin publish UI selects target and package version.
- `/admin/api/deploy` requires target and package version.
- `/admin/api/rollback` requires target and uses an optional package version.
- `ReleaseDeploymentService.deploy` does not run Git fetch/worktree commands.
- `ReleaseDeploymentService.deploy` does not run `pnpm install` or
  `pnpm build` on the live host.
- `ReleaseDeploymentService.rollback` only uses local installed releases for
  the requested target.
- Admin launchd runs through the admin current symlink.
- Worker launchd runs through the worker current symlink.
- Bootstrap preserves explicit operator runtime configuration for logging,
  cleanup, GitHub PR fallback, and API/OAuth settings instead of silently
  rewriting those values to defaults.
- Regression tests avoid private-string negative assertions.
- `pnpm test` and `pnpm build` pass.
