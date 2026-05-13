# Admin React UI

## Goal

Make the admin frontend a single React application.

All business UI must be rendered and updated by React components. The admin page
can still use a tiny DOM bootstrap to read `#admin-config`, find `#admin-root`,
and mount React. After that, navigation, quota display, session views, operation
views, deploy and rollback controls, auth profile management, GitHub account
management, logs, operation records, realtime updates, and dialogs are all
React-owned.

## Current State

Before this change the page is split:

- `main.tsx` mounts a React root.
- `admin-shell.ts` returns a large HTML string.
- `main.tsx` injects that string with `dangerouslySetInnerHTML`.
- `admin-legacy.js` imports `initAdminPage`, finds elements by id, binds events
  with `querySelector`, and renders most operation UI through `innerHTML`.
- The session list/detail is React, but it receives global status from the
  legacy script.

That split is the wrong boundary. It gives the page two owners, makes state
refresh order fragile, and makes feature work like GitHub account management
harder because new UI must choose between React state and imperative DOM writes.

## Target Design

`main.tsx` mounts one React app:

1. Read bootstrap config from `#admin-config`.
2. Mount `<AdminShell />` into `#admin-root`.
3. Mark session permalink body class from React/bootstrap only.

`AdminShell` owns:

- top navigation;
- top quota strip;
- initial status loading;
- realtime event connection;
- status store publication;
- session page;
- operations page;
- dialogs.

Status data flows through a React hook backed by `admin-status-store`:

- initial load fetches `/admin/api/sessions` first and publishes the session
  index immediately;
- `/admin/api/overview` is loaded after the session index, with bounded runtime
  probes, so account quota, auth profile, GitHub, or deploy status reads cannot
  keep the whole admin page blank;
- `/admin/api/overview` must not scan the full inbound-message history; Slack
  account rows are composed in React from the already loaded session summaries
  plus OAuth bindings;
- `/admin/api/overview` resolves Slack user ids for GitHub account rows through
  Slack `users.info` with bounded timeout. Raw Slack ids are only a fallback
  when Slack profile lookup fails;
- token usage aggregation stays behind the dedicated usage/session resources
  instead of running during overview bootstrap;
- recent logs load from `/admin/api/logs` after the first shell state is
  published, so logs cannot block the session index;
- successful mutating operations publish the returned `status`;
- realtime events go through `connectAdminRealtime`, but only after the initial
  session index publishes its realtime cursor, so a page load does not replay
  the retained event log from sequence 0;
- realtime SSE treats a zero cursor as "start at the current tail" instead of
  replaying the full retained event log;
- realtime `trace.append` events stream the new timeline item only. They must
  not recompute full session summaries or trace aggregates for every replayed
  event;
- the session detail "打开 Slack Thread" action resolves a real Slack message
  permalink from the backend before opening it. It must not rely on a
  client-side or backend hand-built `slack.com/app_redirect` URL, because that
  redirect does not reliably land inside the thread view;
- components read status with `useSyncExternalStore`.

No business UI may use `getElementById`, `querySelector`, or `innerHTML` for
rendering or event binding. Event handlers must be React props. Dialog state must
be React state and refs, not global DOM lookup.

## Admin Operations Page

The operations page must preserve existing behavior:

- publish and rollback show deployment status and run preflight confirmation;
- auth profiles list current accounts, quota, and deletion;
- adding auth profiles prefers device-code OAuth and keeps auth.json as the
  fallback;
- operation records and audit records remain visible;
- GitHub accounts show Slack identity, commit author mapping, OAuth binding
  state, default PR account state, and actions;
- GitHub accounts prefer the backend `githubAccounts.accounts` result after
  overview loads. The session-derived fallback is only for the initial shell
  before overview data arrives;
- logs and service information remain visible.

## GitHub Account Management

After the React migration, GitHub account work continues in React:

- the old author mapping panel is presented as `GitHub 账号`;
- each row merges Slack identity, commit co-author mapping, OAuth PR binding,
  and default PR account flag;
- the old manual commit-author editing path is not shown; rows bind existing
  Slack users to GitHub OAuth identities;
- setting the default PR account only accepts a bound non-revoked OAuth account.

## Acceptance Criteria

- `src/admin-ui/admin-legacy.js` is gone or not imported by the app.
- `main.tsx` does not import `initAdminPage`.
- `main.tsx` does not use `dangerouslySetInnerHTML`.
- `admin-shell` exports React components, not an HTML string renderer.
- Business UI files do not use `getElementById`, `querySelector`, or
  `innerHTML` for rendering or event binding.
- `/admin` still serves one app shell and the production Vite assets.
- `/admin/sessions/:key` still deep links into the session React view.
- `/admin/sessions/:key/github/bind` renders a dedicated GitHub binding page
  that only handles OAuth binding and does not render the session timeline or
  operation side panels.
- Session list/detail behavior remains unchanged.
- Operations page behavior remains unchanged.
- A slow or stuck runtime status probe returns a bounded error object instead of
  blocking `/admin/api/overview` or `/admin/api/status`.
- `/admin/api/overview` and mutating operation responses do not require an
  unbounded `inbound_messages` read.
- `/admin/api/overview` uses Slack `users.info` to resolve GitHub account row
  names without falling back to raw Slack ids when the API can resolve them.
- The GitHub account panel uses backend account identities once overview has
  loaded, instead of overwriting them with session-derived fallback rows.
- The React shell connects realtime only after publishing the initial
  `/admin/api/sessions` cursor.
- `/admin/api/events?after=0` does not replay retained history; it waits for
  events created after the stream opens.
- `/admin/api/events` does not recompute full session summaries or trace
  aggregates for every `trace.append` event.
- Clicking `打开 Slack Thread` calls a session-specific admin API that resolves
  Slack's permalink for `channelId + rootThreadTs`, then opens that permalink.
  If permalink resolution fails, the UI shows the error instead of silently
  opening the old `slack.com/app_redirect` fallback.
- `pnpm test` and `pnpm build` pass.
