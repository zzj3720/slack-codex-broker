type Listener = () => void;

export interface AdminStatusSnapshot {
  readonly status: unknown;
  readonly version: number;
}

export interface AdminRealtimeEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly scope: "global" | "session";
  readonly sessionKey?: string | null | undefined;
  readonly entityId?: string | null | undefined;
  readonly payload?: unknown;
  readonly createdAt: string;
  readonly session?: Record<string, unknown> | null | undefined;
  readonly timelineEvent?: Record<string, unknown> | undefined;
  readonly trace?: Record<string, unknown> | undefined;
  readonly operation?: Record<string, unknown> | undefined;
  readonly auditEvent?: Record<string, unknown> | undefined;
}

export interface TimelineSnapshot {
  readonly payload: unknown;
  readonly version: number;
}

let snapshot: AdminStatusSnapshot = { status: null, version: 0 };
let lastEventSequence = 0;
let realtimeSource: EventSource | null = null;
const emptyTimelineSnapshot: TimelineSnapshot = { payload: null, version: 0 };
const listeners = new Set<Listener>();
const timelineSnapshots = new Map<string, TimelineSnapshot>();
const timelineListeners = new Map<string, Set<Listener>>();

export function publishAdminStatus(status: unknown): void {
  if (statusIncludesSessionSnapshot(status)) {
    lastEventSequence = Math.max(lastEventSequence, readRealtimeCursor(status));
  }
  snapshot = {
    status: mergeAdminStatusSnapshot(snapshot.status, status),
    version: snapshot.version + 1
  };
  listeners.forEach((listener) => listener());
}

export function applyAdminRealtimeEvent(event: AdminRealtimeEvent): void {
  const eventSequence = readEventSequence(event);
  if (eventSequence > 0 && lastEventSequence >= eventSequence) {
    return;
  }

  lastEventSequence = Math.max(lastEventSequence, eventSequence);
  snapshot = {
    status: applyAdminRealtimeEventToStatus(snapshot.status, event),
    version: snapshot.version + 1
  };
  publishTimelineRealtimeEvent(event);
  listeners.forEach((listener) => listener());
}

export function connectAdminRealtime(): () => void {
  if (typeof EventSource === "undefined") {
    return () => {};
  }
  if (realtimeSource) {
    return () => {};
  }

  const source = new EventSource("/admin/api/events?after=" + encodeURIComponent(String(lastEventSequence)));
  realtimeSource = source;
  source.addEventListener("admin-event", (message) => {
    try {
      const payload = JSON.parse((message as MessageEvent).data) as { readonly event?: AdminRealtimeEvent };
      if (payload.event) {
        applyAdminRealtimeEvent(payload.event);
      }
    } catch {
      // The connection will keep running; the next event can still be applied.
    }
  });
  source.addEventListener("error", () => {
    if (source.readyState === EventSource.CLOSED && realtimeSource === source) {
      realtimeSource = null;
    }
  });

  return () => {
    if (realtimeSource === source) {
      realtimeSource = null;
    }
    source.close();
  };
}

export function subscribeAdminStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAdminStatusSnapshot(): AdminStatusSnapshot {
  return snapshot;
}

export function publishTimelinePayload(sessionKey: string, payload: unknown): void {
  const previous = timelineSnapshots.get(sessionKey);
  timelineSnapshots.set(sessionKey, {
    payload,
    version: (previous?.version ?? 0) + 1
  });
  notifyTimelineListeners(sessionKey);
}

export function publishTimelineRealtimeEvent(event: AdminRealtimeEvent): void {
  const sessionKey = String(event.sessionKey || "");
  if (!sessionKey || !event.timelineEvent) {
    return;
  }
  const previous = timelineSnapshots.get(sessionKey);
  if (!previous) {
    return;
  }
  timelineSnapshots.set(sessionKey, {
    payload: applyTimelineRealtimeEvent(previous.payload, event),
    version: previous.version + 1
  });
  notifyTimelineListeners(sessionKey);
}

export function subscribeTimeline(sessionKey: string, listener: Listener): () => void {
  let listenersForSession = timelineListeners.get(sessionKey);
  if (!listenersForSession) {
    listenersForSession = new Set();
    timelineListeners.set(sessionKey, listenersForSession);
  }
  listenersForSession.add(listener);
  return () => {
    listenersForSession?.delete(listener);
    if (listenersForSession?.size === 0) {
      timelineListeners.delete(sessionKey);
    }
  };
}

export function getTimelineSnapshot(sessionKey: string): TimelineSnapshot {
  return timelineSnapshots.get(sessionKey) ?? emptyTimelineSnapshot;
}

export function mergeAdminStatusSnapshot(currentStatus: unknown, incomingStatus: unknown): unknown {
  if (!incomingStatus || typeof incomingStatus !== "object" || Array.isArray(incomingStatus)) {
    return incomingStatus;
  }

  const current = currentStatus && typeof currentStatus === "object" && !Array.isArray(currentStatus)
    ? currentStatus as Record<string, any>
    : {};
  const incoming = incomingStatus as Record<string, any>;
  const currentState = current.state && typeof current.state === "object" && !Array.isArray(current.state)
    ? current.state as Record<string, any>
    : {};
  const incomingState = incoming.state && typeof incoming.state === "object" && !Array.isArray(incoming.state)
    ? incoming.state as Record<string, any>
    : {};
  const currentSessions = Array.isArray(currentState.sessions) ? currentState.sessions : [];
  const incomingHasSessions = Array.isArray(incomingState.sessions);
  const currentRealtime = current.realtime && typeof current.realtime === "object" && !Array.isArray(current.realtime)
    ? current.realtime as Record<string, unknown>
    : {};
  const incomingRealtime = incoming.realtime && typeof incoming.realtime === "object" && !Array.isArray(incoming.realtime)
    ? incoming.realtime as Record<string, unknown>
    : {};
  const mergedState: Record<string, unknown> = {
    ...currentState,
    ...incomingState,
    sessions: incomingHasSessions ? incomingState.sessions : currentSessions
  };

  if (!incomingHasSessions && currentSessions.length > 0) {
    for (const key of sessionDerivedStateKeys) {
      if (currentState[key] !== undefined) {
        mergedState[key] = currentState[key];
      }
    }
  }

  return {
    ...current,
    ...incoming,
    realtime: incomingHasSessions || Object.keys(currentRealtime).length === 0
      ? {
        ...currentRealtime,
        ...incomingRealtime
      }
      : currentRealtime,
    state: mergedState
  };
}

export function applyAdminRealtimeEventToStatus(status: unknown, event: AdminRealtimeEvent): unknown {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return status;
  }

  const current = status as Record<string, any>;
  const next: Record<string, any> = {
    ...current,
    realtime: {
      ...(current.realtime || {}),
      cursor: Math.max(Number(current.realtime?.cursor || 0), Number(event.sequence || 0))
    }
  };

  if (event.session !== undefined || event.kind === "session.delete") {
    const state = current.state && typeof current.state === "object" ? current.state : {};
    const sessions = Array.isArray(state.sessions) ? state.sessions as Array<Record<string, unknown>> : [];
    const nextSessions = event.kind === "session.delete"
      ? sessions.filter((session) => String(session.key || "") !== String(event.sessionKey || event.entityId || ""))
      : upsertSessionSummary(sessions, event.session);
    next.state = {
      ...state,
      sessions: nextSessions,
      ...summarizeSessionCounts(nextSessions)
    };
  }

  if (event.operation) {
    next.operations = upsertById(Array.isArray(current.operations) ? current.operations : [], event.operation, "id").slice(0, 10);
  }
  if (event.auditEvent) {
    next.auditEvents = prependUnique(Array.isArray(current.auditEvents) ? current.auditEvents : [], event.auditEvent, "id").slice(0, 10);
  }

  return next;
}

export function applyTimelineRealtimeEvent(payload: unknown, event: AdminRealtimeEvent): unknown {
  if (!event.timelineEvent) {
    return payload;
  }

  const current = Array.isArray(payload)
    ? { events: payload, trace: null }
    : (payload && typeof payload === "object" ? payload as Record<string, any> : { events: [] });
  const events = Array.isArray(current.events) ? current.events as Array<Record<string, unknown>> : [];
  const nextEvents = appendUniqueTimelineEvent(events, event.timelineEvent);

  if (Array.isArray(payload)) {
    return nextEvents;
  }

  return {
    ...current,
    events: nextEvents,
    trace: event.trace || summarizeTraceFromEvents(nextEvents)
  };
}

function upsertSessionSummary(
  sessions: readonly Record<string, unknown>[],
  session: Record<string, unknown> | null | undefined
): Array<Record<string, unknown>> {
  if (!session?.key) {
    return [...sessions];
  }
  const key = String(session.key);
  let replaced = false;
  const next = sessions.map((existing) => {
    if (String(existing.key || "") !== key) {
      return existing;
    }
    replaced = true;
    return mergeSessionSummary(existing, session);
  });
  if (!replaced) {
    next.push(session);
  }
  return next;
}

function mergeSessionSummary(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...existing,
    ...incoming,
    usage: mergeNestedObject(existing.usage, incoming.usage)
  };
}

function mergeNestedObject(current: unknown, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return incoming ?? current;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return incoming;
  }
  return {
    ...(current as Record<string, unknown>),
    ...(incoming as Record<string, unknown>)
  };
}

function upsertById(
  records: readonly Record<string, unknown>[],
  record: Record<string, unknown>,
  keyName: string
): Array<Record<string, unknown>> {
  const key = String(record[keyName] || "");
  if (!key) {
    return [record, ...records];
  }
  const next = records.filter((item) => String(item[keyName] || "") !== key);
  return [record, ...next];
}

function prependUnique(
  records: readonly Record<string, unknown>[],
  record: Record<string, unknown>,
  keyName: string
): Array<Record<string, unknown>> {
  const key = String(record[keyName] || "");
  return [record, ...records.filter((item) => String(item[keyName] || "") !== key)];
}

function appendUniqueTimelineEvent(
  events: readonly Record<string, unknown>[],
  event: Record<string, unknown>
): Array<Record<string, unknown>> {
  const baseEvents = isToolResultEvent(event)
    ? events.filter((existing) => !isMatchingToolCall(existing, event))
    : events;
  const key = timelineEventIdentity(event);
  if (key && baseEvents.some((existing) => timelineEventIdentity(existing) === key)) {
    return [...baseEvents];
  }
  return [...baseEvents, event];
}

function timelineEventIdentity(event: Record<string, unknown>): string {
  return [
    event.id,
    event.at,
    event.type,
    event.callId,
    event.turnId,
    event.toolName,
    event.title,
    event.summary
  ].filter(Boolean).join("\u001f");
}

function isToolResultEvent(event: Record<string, unknown>): boolean {
  return String(event.type || "") === "agent_tool_result";
}

function isMatchingToolCall(
  existing: Record<string, unknown>,
  result: Record<string, unknown>
): boolean {
  if (String(existing.type || "") !== "agent_tool_call") {
    return false;
  }
  return toolEventKey(existing) !== "" && toolEventKey(existing) === toolEventKey(result);
}

function toolEventKey(event: Record<string, unknown>): string {
  const turnId = String(event.turnId || "");
  const callId = String(event.callId || "");
  const toolName = String(event.toolName || "");
  if (callId) {
    return [turnId, callId].join("\u001f");
  }
  if (!turnId && !toolName) {
    return "";
  }
  return [turnId, toolName].join("\u001f");
}

function summarizeSessionCounts(sessions: readonly Record<string, unknown>[]): Record<string, number> {
  let activeCount = 0;
  let openInboundCount = 0;
  let openHumanInboundCount = 0;
  let openSystemInboundCount = 0;
  let backgroundJobCount = 0;
  let runningBackgroundJobCount = 0;
  let failedBackgroundJobCount = 0;

  for (const session of sessions) {
    if (session.activeTurnId) activeCount += 1;
    openInboundCount += Number(session.openInboundCount || 0);
    openHumanInboundCount += Number(session.openHumanInboundCount || 0);
    openSystemInboundCount += Number(session.openSystemInboundCount || 0);
    backgroundJobCount += Number(session.backgroundJobCount || 0);
    runningBackgroundJobCount += Number(session.runningBackgroundJobCount || 0);
    failedBackgroundJobCount += Number(session.failedBackgroundJobCount || 0);
  }

  return {
    sessionCount: sessions.length,
    activeCount,
    openInboundCount,
    openHumanInboundCount,
    openSystemInboundCount,
    backgroundJobCount,
    runningBackgroundJobCount,
    failedBackgroundJobCount
  };
}

function summarizeTraceFromEvents(events: readonly Record<string, unknown>[]): Record<string, unknown> {
  const categories: Record<string, number> = {};
  for (const event of events) {
    const type = String(event.type || "");
    if (type) {
      categories[type] = (categories[type] || 0) + 1;
    }
  }
  return {
    source: "broker_db",
    eventCount: events.length,
    categories
  };
}

function notifyTimelineListeners(sessionKey: string): void {
  timelineListeners.get(sessionKey)?.forEach((listener) => listener());
}

function readRealtimeCursor(status: unknown): number {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return 0;
  }
  const cursor = Number((status as Record<string, any>).realtime?.cursor || 0);
  return Number.isFinite(cursor) ? cursor : 0;
}

function readEventSequence(event: Pick<AdminRealtimeEvent, "sequence">): number {
  const sequence = Number(event.sequence || 0);
  return Number.isFinite(sequence) ? sequence : 0;
}

function statusIncludesSessionSnapshot(status: unknown): boolean {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return false;
  }
  const state = (status as Record<string, any>).state;
  return Boolean(state && typeof state === "object" && !Array.isArray(state) && Array.isArray(state.sessions));
}

const sessionDerivedStateKeys = [
  "sessionCount",
  "activeCount",
  "openInboundCount",
  "openHumanInboundCount",
  "openSystemInboundCount",
  "backgroundJobCount",
  "runningBackgroundJobCount",
  "failedBackgroundJobCount",
  "activeSessions",
  "openInbound"
];
