# Admin Session Performance

## Goal

The admin session surface should behave like a live agent session UI, not a
database dump. The first screen must be fast even when there are hundreds of
sessions and each session has hundreds or thousands of trace events.

## Current State

The React shell loads `/admin/api/sessions` first, then renders the selected
session and loads `/admin/api/sessions/:key/timeline`.

The remaining problems are data-contract problems:

- session summaries still derive token usage from raw turn usage records at read
  time;
- timeline reads return a full session slice instead of a latest page with a
  cursor;
- trace statistics are derived by scanning the fetched timeline payload;
- the detail page has no explicit "load older" path, so one old or large
  session can make the first usable view slow.

## Target Design

- `/admin/api/sessions` returns session list summaries only. It must not read
  agent trace events, and it must not aggregate raw turn usage records for every
  request.
- Read-only admin endpoints must not call `SessionManager.load()` or touch every
  session workspace directory. Startup and session creation own directory
  creation; read paths must stay DB-only.
- Token usage and trace composition used by session UI are stored as redundant
  per-session summaries when usage or trace rows are written.
- `/admin/api/sessions/:key/timeline` reads from newest to oldest with a bounded
  limit. The response includes a cursor for loading older events.
- The initial timeline page is the newest page across visible timeline events.
  Synthetic state events such as session creation, current inbound messages,
  background jobs, and turn signals are session metadata and must not be injected
  into the paginated agent timeline.
- The first timeline page is rendered in chronological order inside that page,
  but it is obtained by reading the newest rows first.
- The React detail view fetches only the selected session's first timeline page.
  It starts with a small latest page and prepends older pages only when the user
  asks for more.
- Realtime events append to the loaded timeline page without forcing a full
  timeline reload.
- Read-heavy admin API responses include `Server-Timing` and
  `X-Admin-Duration-Ms` so browser/network tooling can show whether the backend
  or frontend is slow.

## Acceptance Criteria

- `listSessionSummaries()` can run without `listAgentTraceEvents()` and without
  raw `listAgentTurnUsage()` aggregation.
- `listSessionSummaries()` and the initial session timeline request do not call
  `SessionManager.load()` on the read path.
- `GET /admin/api/sessions/:key/timeline?limit=50` returns at most 50 visible
  timeline events plus pagination metadata.
- The first page contains only the newest agent trace events. Synthetic session
  state is exposed through the session summary payload, not as timeline rows.
- `before_sequence` loads older trace rows and does not reread the newest page.
- Timeline responses include trace summary data from the per-session redundant
  summary, not from the current page size.
- The React session detail initial request includes a bounded `limit`.
- The React session detail has an explicit `加载更早活动` action when the API says
  older activity exists.
- Timeline, sessions, overview, usage, and status responses expose backend
  duration headers for request-level tracing.
- `pnpm test` and `pnpm build` pass.
