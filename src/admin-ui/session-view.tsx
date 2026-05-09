import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getAdminStatusSnapshot, subscribeAdminStatus } from "./admin-status-store";
import { stableSessionOrder } from "./session-order";
import { getTimelineEventDisplay, isTimelineEventVisible, statusLabel, type TimelineEvent } from "./timeline-display";

type UiState = {
  readonly adminView: string;
  readonly sessionSearch: string;
  readonly sessionFilter: string;
  readonly selectedSessionKey: string | null;
};

type SessionRecord = Record<string, any>;
type TimelinePayload = { readonly events?: TimelineEvent[]; readonly trace?: Record<string, any> } | TimelineEvent[];

const timelineCache = new Map<string, TimelinePayload>();
const sessionFilters = ["ongoing", "all", "active", "inbound", "jobs", "issues", "usage"];

export function AdminSessionsView(): React.JSX.Element {
  const snapshot = useSyncExternalStore(subscribeAdminStatus, getAdminStatusSnapshot, getAdminStatusSnapshot);
  const status = (snapshot.status || {}) as Record<string, any>;
  const sessions = (status.state?.sessions || []) as SessionRecord[];
  const state = status.state || {};
  const [uiState, setUiState] = useState(loadUiState);
  const query = uiState.sessionSearch.trim().toLowerCase();
  const mode = uiState.sessionFilter;
  const orderRef = useRef<{ viewKey: string; keys: readonly string[] }>({ viewKey: "", keys: [] });

  const filtered = useMemo(() => {
    return sessions
      .filter((session) => sessionMatchesFilter(session, mode, query))
      .sort((left, right) => compareSessionsForMode(mode, left, right));
  }, [mode, query, sessions]);

  const filteredKeys = filtered.map((session) => String(session.key)).join("\u001f");
  const viewKey = mode + "\n" + query;
  const filteredByKey = new Map(filtered.map((session) => [String(session.key), session]));

  orderRef.current = stableSessionOrder(orderRef.current, viewKey, filtered.map((session) => String(session.key)));

  const orderedSessions = orderRef.current.keys
    .map((key) => filteredByKey.get(key))
    .filter((session): session is SessionRecord => Boolean(session));

  const selectedSession = resolveSelectedSession(orderedSessions, uiState.selectedSessionKey);

  useEffect(() => {
    if (selectedSession?.key && selectedSession.key !== uiState.selectedSessionKey) {
      updateSessionUiState({ selectedSessionKey: selectedSession.key });
    }
  }, [filteredKeys, selectedSession?.key, uiState.selectedSessionKey]);

  function updateSessionUiState(patch: Partial<UiState>): void {
    setUiState((previous) => {
      const next = normalizeUiState({ ...loadUiState(), ...previous, ...patch });
      persistUiState(next);
      return next;
    });
  }

  return (
    <div className="session-master-detail">
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">会话索引</div>
          <span className="summary-detail">
            待处理：<span id="session-open-count">{state.openInboundCount || 0}</span>
            （人：<span id="session-human-count">{state.openHumanInboundCount || 0}</span> 系统：
            <span id="session-system-count">{state.openSystemInboundCount || 0}</span>）
          </span>
        </div>
        <div className="toolbar">
          <input
            id="session-search"
            type="search"
            placeholder="筛选会话..."
            value={uiState.sessionSearch}
            onChange={(event) => updateSessionUiState({ sessionSearch: event.target.value })}
          />
          <select
            id="session-filter"
            value={mode}
            onChange={(event) => updateSessionUiState({ sessionFilter: event.target.value })}
          >
            <option value="ongoing">进行中</option>
            <option value="all">全部</option>
            <option value="active">活跃</option>
            <option value="inbound">有待处理消息</option>
            <option value="jobs">有运行任务</option>
            <option value="issues">有问题</option>
            <option value="usage">有消耗记录</option>
          </select>
        </div>
        <div id="sessions-panel" className="session-list">
          {orderedSessions.length ? (
            orderedSessions.map((session) => (
              <SessionRow
                key={session.key}
                session={session}
                selected={selectedSession?.key === session.key}
                onSelect={() => updateSessionUiState({ selectedSessionKey: session.key })}
              />
            ))
          ) : (
            <div className="empty-state">没有匹配的会话</div>
          )}
        </div>
      </section>

      <section className="panel session-detail-panel">
        <div className="panel-head">
          <div className="panel-title">会话详情</div>
        </div>
        <div id="session-detail-panel" className="panel-body">
          {selectedSession ? (
            <SessionDetail key={selectedSession.key} session={selectedSession} refreshVersion={snapshot.version} />
          ) : (
            <div className="empty-state">没有可检查的 session</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SessionRow({ session, selected, onSelect }: {
  readonly session: SessionRecord;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const state = sessionQueueState(session);
  const activityAt = sessionActivityAt(session);
  const primary = sessionPrimaryText(session);
  const first = sessionFirstText(session);
  return (
    <button
      type="button"
      className={"session-row-button session-card session-priority-" + classSafeValue(state.tone, "idle") + (selected ? " active" : "")}
      data-session-key={session.key}
      onClick={onSelect}
    >
      <div className="session-summary">
        <div className="session-line">
          <div className="session-lead" title={primary}>{primary}</div>
          <Badge label={state.label} tone={state.tone} />
          <div className="session-time" title={fmtDateTime(activityAt)}>更新 {fmtRelativeTime(activityAt)}</div>
        </div>
        <div className="session-channel" title={first}>起始：{first}</div>
        <div className="session-meta-line">
          {renderSessionMeta(session).map((pill) => (
            <span key={pill.key} className={"session-meta-pill " + classSafeValue(pill.tone, "")} title={pill.title}>
              {pill.label}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function SessionDetail({ session, refreshVersion }: {
  readonly session: SessionRecord;
  readonly refreshVersion: number;
}): React.JSX.Element {
  const usage = session.usage || {};
  const state = sessionQueueState(session);
  const activityAt = sessionActivityAt(session);
  const primary = sessionPrimaryText(session);
  const first = sessionFirstText(session);
  return (
    <>
      <div className="selected-session-head">
        <div className="selected-session-title">
          <div className="session-detail-title" title={primary}>{primary}</div>
          <div className="session-detail-subtitle" title={first}>起始：{first}</div>
        </div>
        <div className="session-detail-actions">
          <Badge label={state.label} tone={state.tone} />
          {session.threadUrl ? (
            <a className="link-button" href={session.threadUrl} target="_blank" rel="noreferrer">打开 Slack Thread</a>
          ) : null}
        </div>
      </div>
      <div className="session-body">
        <div className="session-detail-summary">
          <Kpi label="频道" value={session.channelLabel || session.channelId || "--"} title={session.channelId} />
          <Kpi label="最近活动" value={fmtRelativeTime(activityAt)} title={fmtDateTime(activityAt)} />
          <Kpi label="待处理" value={(session.openInboundCount || 0) + " 条"} />
          <Kpi label="Jobs" value={(session.backgroundJobCount || 0) + " / 运行 " + (session.runningBackgroundJobCount || 0)} />
          <Kpi label="Token / 轮次" value={fmtTokens(usage.totalTokens || 0) + " / " + (usage.turnCount || 0)} />
        </div>
        <div className="session-inspector">
          <div className="mini-panel trace-panel">
            <div className="mini-title">Agent 活动时间线</div>
            <div className="mini-body">
              <SessionTimeline session={session} refreshVersion={refreshVersion} />
            </div>
          </div>
          <div className="mini-panel">
            <div className="mini-title">Token 消耗</div>
            <div className="mini-body">
              <SessionUsage usage={usage} />
            </div>
          </div>
          <div className="mini-panel">
            <div className="mini-title">消息 / 任务</div>
            <div className="mini-body">
              <InboundTable items={session.openInbound || []} />
              <JobsTable jobs={session.backgroundJobs || []} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SessionTimeline({ session, refreshVersion }: {
  readonly session: SessionRecord;
  readonly refreshVersion: number;
}): React.JSX.Element {
  const sessionKey = String(session.key || "");
  const [payload, setPayload] = useState<TimelinePayload | null>(() => timelineCache.get(sessionKey) || null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = timelineCache.get(sessionKey) || null;
    setPayload(cached);
    setError(null);
    void requestJson("/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/timeline")
      .then((nextPayload) => {
        if (cancelled) return;
        timelineCache.set(sessionKey, nextPayload as TimelinePayload);
        setPayload(nextPayload as TimelinePayload);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, refreshVersion]);

  if (error) return <div className="summary-detail">{error}</div>;
  if (!payload) return <Timeline events={[{ at: session.createdAt, type: "session", title: "已创建" }]} />;
  return <TimelinePayloadView payload={payload} />;
}

function TimelinePayloadView({ payload }: { readonly payload: TimelinePayload }): React.JSX.Element {
  const events = (Array.isArray(payload) ? payload : (payload.events || [])).filter(isTimelineEventVisible);
  const trace = Array.isArray(payload) ? null : payload.trace;
  if (!events.length) return <div className="summary-detail">暂无时间线事件</div>;
  return (
    <>
      {trace ? <TraceSummary trace={trace} /> : null}
      <Timeline events={events} />
    </>
  );
}

function TraceSummary({ trace }: { readonly trace: Record<string, any> }): React.JSX.Element {
  const categories = trace.categories || {};
  const sourceLabelText = trace.source === "broker_db"
    ? "已记录 " + (trace.eventCount || 0) + " 条 Agent 事件"
    : "Trace 读取异常";
  return (
    <div className="trace-summary">
      <Badge label={trace.source || "unknown"} tone={statusTone(trace.source || "unknown")} />
      <span>{sourceLabelText}</span>
      {[
        ["agent_system_prompt", "系统"],
        ["agent_memory", "记忆"],
        ["agent_user_message", "用户"],
        ["agent_runtime_reminder", "提醒"],
        ["agent_assistant_message", "Assistant"],
        ["agent_tool_call", "工具"]
      ].map(([key, label]) => (
        <Badge key={key} label={label + " " + (categories[key] || 0)} tone={statusTone(key)} />
      ))}
    </div>
  );
}

function Timeline({ events }: { readonly events: readonly TimelineEvent[] }): React.JSX.Element {
  return (
    <div className="timeline">
      {events.map((event, index) => (
        <TimelineRow key={timelineEventKey(event, index)} event={event} />
      ))}
    </div>
  );
}

function TimelineRow({ event }: { readonly event: TimelineEvent }): React.JSX.Element {
  const display = getTimelineEventDisplay(event);
  const badgeTone = statusTone(event.status === "failed" || event.status === "error" ? event.status : event.type);
  const meta = [
    event.status ? ("状态 " + statusLabel(event.status)) : "",
    event.role ? ("角色 " + event.role) : "",
    event.toolName ? ("工具 " + event.toolName) : "",
    event.detailTruncated ? "内容已截断" : ""
  ].filter(Boolean).join(" · ");
  return (
    <div className="timeline-event">
      <span>{fmtTime(event.at)}</span>
      <Badge label={display.badgeLabel} tone={badgeTone} />
      <div className="timeline-main">
        <div className="timeline-title"><strong>{display.title}</strong><span>{display.summary}</span></div>
        {meta ? <div className="trace-meta">{meta}</div> : null}
        {event.detail ? (
          <details className="trace-details">
            <summary>查看详情</summary>
            <pre>{event.detail}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function Kpi({ label, value, title }: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}): React.JSX.Element {
  return (
    <div className="session-detail-kpi">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function SessionUsage({ usage }: { readonly usage: Record<string, any> }): React.JSX.Element {
  const exact = Number(usage?.exactTurns || 0);
  const total = Number(usage?.turnCount || 0);
  if (!total) return <div className="summary-detail">这个会话还没有用量记录</div>;
  return (
    <div className="quota-grid">
      <QuotaLine label="总量" value={fmtTokens(usage.totalTokens)} detail={total + " 回合"} />
      <QuotaLine label="输入" value={fmtTokens(usage.inputTokens)} detail={"缓存 " + fmtTokens(usage.cachedInputTokens)} />
      <QuotaLine label="输出" value={fmtTokens(usage.outputTokens)} detail={"推理 " + fmtTokens(usage.reasoningTokens)} />
      <QuotaLine label="精确" value={exact + "/" + total} detail={"缺失 " + (usage.missingTurns || 0)} />
      <div className="summary-detail">最近：{fmtDateTime(usage.lastTurnAt)}</div>
    </div>
  );
}

function QuotaLine({ label, value, detail }: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}): React.JSX.Element {
  return (
    <div className="quota-line">
      <span>{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function InboundTable({ items }: { readonly items: readonly Record<string, any>[] }): React.JSX.Element {
  if (!items.length) return <div className="summary-detail" style={{ marginBottom: 8 }}>没有待处理消息</div>;
  return (
    <table className="table">
      <thead><tr><th>来源</th><th>消息</th></tr></thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={(item.id || item.createdAt || item.textPreview || "") + ":" + index}>
            <td>{sourceLabel(item.source)}</td>
            <td>{item.textPreview || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JobsTable({ jobs }: { readonly jobs: readonly Record<string, any>[] }): React.JSX.Element {
  if (!jobs.length) return <div className="summary-detail">没有任务</div>;
  return (
    <table className="table" style={{ marginTop: 10 }}>
      <thead><tr><th>状态</th><th>类型</th></tr></thead>
      <tbody>
        {jobs.slice(0, 5).map((job, index) => (
          <tr key={(job.id || job.kind || "") + ":" + index}>
            <td><Badge label={job.status || "unknown"} tone={statusTone(job.status)} /></td>
            <td>{job.kind || ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Badge({ label, tone }: { readonly label: unknown; readonly tone?: string }): React.JSX.Element {
  return <span className={"badge " + (tone || statusTone(label))}>{statusLabel(label)}</span>;
}

function sessionMatchesFilter(session: SessionRecord, mode: string, query: string): boolean {
  if (mode === "ongoing" && !session.activeTurnId && !session.openInboundCount && !session.runningBackgroundJobCount && !session.failedBackgroundJobCount) return false;
  if (mode === "active" && !session.activeTurnId) return false;
  if (mode === "inbound" && !session.openInboundCount) return false;
  if (mode === "jobs" && !session.runningBackgroundJobCount) return false;
  if (mode === "issues" && !session.failedBackgroundJobCount) return false;
  if (mode === "usage" && !session.usage?.turnCount) return false;
  if (!query) return true;
  return [session.key, session.channelId, session.channelLabel, session.workspacePath, sessionPrimaryText(session), sessionFirstText(session)]
    .some((value) => String(value || "").toLowerCase().includes(query));
}

function resolveSelectedSession(sessions: readonly SessionRecord[], selectedSessionKey: string | null): SessionRecord | null {
  if (!sessions.length) return null;
  return sessions.find((session) => session.key === selectedSessionKey) || sessions[0] || null;
}

function renderSessionMeta(session: SessionRecord): Array<{ key: string; label: string; tone: string; title?: string }> {
  const usage = session.usage || {};
  const pendingDetail = Number(session.openInboundCount || 0)
    ? "待处理 " + (session.openInboundCount || 0) + "（人 " + (session.openHumanInboundCount || 0) + " / 系统 " + (session.openSystemInboundCount || 0) + "）"
    : "";
  return [
    { key: "channel", label: session.channelLabel || session.channelId || "未知频道", tone: "info", title: session.key },
    pendingDetail ? { key: "pending", label: pendingDetail, tone: Number(session.openHumanInboundCount || 0) ? "warn" : "" } : null,
    { key: "jobs", label: "Jobs " + (session.backgroundJobCount || 0), tone: Number(session.failedBackgroundJobCount || 0) ? "danger" : (Number(session.runningBackgroundJobCount || 0) ? "good" : "") },
    Number(session.failedBackgroundJobCount || 0) ? { key: "failed", label: "失败 " + session.failedBackgroundJobCount, tone: "danger" } : null,
    { key: "turns", label: "轮次 " + (usage.turnCount || 0), tone: "" },
    { key: "tokens", label: "Token " + fmtTokens(usage.totalTokens || 0), tone: "info" }
  ].filter((item): item is { key: string; label: string; tone: string; title?: string } => Boolean(item));
}

function sessionPrimaryText(session: SessionRecord): string {
  return messagePreview(session.lastUserMessage) || summarizeSessionLead(session);
}

function sessionFirstText(session: SessionRecord): string {
  return messagePreview(session.firstUserMessage) || "没有用户消息";
}

function messagePreview(message: Record<string, any> | undefined): string {
  return String(message?.textPreview || message?.text || "").trim();
}

function summarizeSessionLead(session: SessionRecord): string {
  const failedJob = (session.backgroundJobs || []).find((job: Record<string, any>) => job.status === "failed");
  if (failedJob) return "失败任务：" + (failedJob.kind || failedJob.id || "后台任务") + (failedJob.error ? " · " + failedJob.error : "");
  if (session.lastUserMessage) return messagePreview(session.lastUserMessage) || "用户消息";
  if (session.openInbound?.length) return session.openInbound[0].textPreview || "新消息";
  if (session.activeTurnId) {
    const signal = session.lastTurnSignalKind ? statusLabel(session.lastTurnSignalKind) + (session.lastTurnSignalReason ? "：" + session.lastTurnSignalReason : "") : "正在运行";
    return "当前回合：" + shortValue(session.activeTurnId, 18) + " · " + signal;
  }
  if (session.backgroundJobs?.length) {
    const running = session.backgroundJobs.find((job: Record<string, any>) => job.status === "running") || session.backgroundJobs[0];
    return (running.kind || "任务") + "（" + statusLabel(running.status || "?") + "）";
  }
  if (session.lastTurnSignalKind) return statusLabel(session.lastTurnSignalKind) + (session.lastTurnSignalReason ? "：" + session.lastTurnSignalReason : "");
  if (session.usage?.turnCount) return "最近消耗：" + fmtTokens(session.usage.totalTokens || 0) + " · " + (session.usage.turnCount || 0) + " 回合";
  return "空闲";
}

function sessionQueueState(session: SessionRecord): { label: string; tone: string; rank: number; detail: string } {
  if (Number(session.failedBackgroundJobCount || 0) > 0) {
    return { label: "异常", tone: "danger", rank: 60, detail: session.failedBackgroundJobCount + " 个失败任务" };
  }
  if (Number(session.openHumanInboundCount || 0) > 0) {
    return { label: "待人处理", tone: "warn", rank: 50, detail: session.openHumanInboundCount + " 条用户消息" };
  }
  if (Number(session.openInboundCount || 0) > 0) {
    return { label: "待处理", tone: "warn", rank: 40, detail: session.openInboundCount + " 条系统消息" };
  }
  if (session.activeTurnId) {
    return { label: "运行中", tone: "good", rank: 30, detail: shortValue(session.activeTurnId, 18) };
  }
  if (Number(session.runningBackgroundJobCount || 0) > 0) {
    return { label: "后台任务", tone: "good", rank: 20, detail: session.runningBackgroundJobCount + " 个运行任务" };
  }
  if (Number(session.usage?.turnCount || 0) > 0) {
    return { label: "有记录", tone: "info", rank: 10, detail: fmtTokens(session.usage?.totalTokens || 0) };
  }
  return { label: "空闲", tone: "", rank: 0, detail: "" };
}

function compareSessionsForMode(mode: string, left: SessionRecord, right: SessionRecord): number {
  if (mode === "usage") {
    const tokenDelta = Number(right.usage?.totalTokens || 0) - Number(left.usage?.totalTokens || 0);
    if (tokenDelta) return tokenDelta;
  }
  if (mode === "all") {
    const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
    if (activityDelta) return activityDelta;
  }
  const rankDelta = sessionQueueState(right).rank - sessionQueueState(left).rank;
  if (rankDelta) return rankDelta;
  const activityDelta = sessionActivityMs(right) - sessionActivityMs(left);
  if (activityDelta) return activityDelta;
  return String(left.key).localeCompare(String(right.key));
}

function sessionActivityAt(session: SessionRecord): unknown {
  const candidates = [
    session.updatedAt,
    session.lastTurnSignalAt,
    session.lastSlackReplyAt,
    session.activeTurnStartedAt,
    session.usage?.lastTurnAt,
    ...(session.openInbound || []).map((message: Record<string, any>) => message.updatedAt || message.createdAt),
    ...(session.backgroundJobs || []).flatMap((job: Record<string, any>) => [job.lastEventAt, job.heartbeatAt, job.updatedAt, job.createdAt])
  ];
  const latestMs = newestTimestamp(candidates);
  return candidates.find((value) => timestampMs(value) === latestMs) || session.updatedAt || session.createdAt;
}

function sessionActivityMs(session: SessionRecord): number {
  return timestampMs(sessionActivityAt(session));
}

async function requestJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || "请求失败");
  return payload;
}

function loadUiState(): UiState {
  try {
    const raw = window.localStorage.getItem(uiStateStorageKey());
    return raw ? normalizeUiState(JSON.parse(raw)) : defaultUiState();
  } catch {
    return defaultUiState();
  }
}

function persistUiState(next: UiState): void {
  try {
    window.localStorage.setItem(uiStateStorageKey(), JSON.stringify(next));
  } catch {}
}

function uiStateStorageKey(): string {
  return "admin-ui-state:" + window.location.pathname;
}

function defaultUiState(): UiState {
  return { adminView: "sessions", sessionSearch: "", sessionFilter: "ongoing", selectedSessionKey: null };
}

function normalizeUiState(value: unknown): UiState {
  const next = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const adminView = ["sessions", "ops"].includes(String(next.adminView || "")) ? String(next.adminView) : "sessions";
  const sessionFilter = sessionFilters.includes(String(next.sessionFilter || "")) ? String(next.sessionFilter) : "ongoing";
  const sessionSearch = typeof next.sessionSearch === "string" ? next.sessionSearch : "";
  const selectedSessionKey = typeof next.selectedSessionKey === "string" && next.selectedSessionKey ? next.selectedSessionKey : null;
  return { adminView, sessionSearch, sessionFilter, selectedSessionKey };
}

function classSafeValue(value: unknown, fallback: string): string {
  const text = String(value || fallback || "").replace(/[^a-z0-9_-]/gi, "");
  return text || fallback || "";
}

function statusTone(status: unknown): string {
  const value = String(status || "").toLowerCase();
  if (["succeeded", "running", "active", "ok", "completed", "done"].includes(value)) return "good";
  if (["pending", "inflight", "registered", "starting", "idle", "started", "wait"].includes(value)) return "warn";
  if (["failed", "error", "stopped", "cancelled"].includes(value)) return "danger";
  if (["agent_system_prompt", "agent_memory", "agent_runtime_instruction"].includes(value)) return "purple";
  if (["agent_user_message", "agent_assistant_message", "agent_tool_result", "agent_token_count"].includes(value)) return "good";
  if (["agent_runtime_reminder", "agent_tool_call", "agent_turn_started"].includes(value)) return "warn";
  if (value.startsWith("agent_")) return "info";
  if (["deploy", "rollback"].includes(value)) return "info";
  return "";
}

function sourceLabel(value: unknown): string {
  const labels: Record<string, string> = {
    app_mention: "提及",
    direct_message: "私信",
    thread_reply: "线程回复",
    background_job_event: "后台任务事件",
    unexpected_turn_stop: "异常停止"
  };
  return labels[String(value || "")] || String(value || "");
}

function timelineEventKey(event: TimelineEvent, index: number): string {
  return [event.id, event.at, event.type, event.callId, event.turnId, event.toolName, event.title, event.summary]
    .filter(Boolean)
    .join("\u001f") || "event-" + index;
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: readonly unknown[]): number {
  return values.reduce((latest, value) => Math.max(latest, timestampMs(value)), 0);
}

function fmtTime(value: unknown): string {
  if (!value) return "--";
  try {
    const date = new Date(String(value));
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return hours + ":" + minutes + ":" + seconds;
  } catch {
    return String(value);
  }
}

function fmtDateTime(value: unknown): string {
  if (!value) return "--";
  try {
    const date = new Date(String(value));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return year + "-" + month + "-" + day + " " + hours + ":" + minutes + ":" + seconds;
  } catch {
    return String(value);
  }
}

function fmtRelativeTime(value: unknown): string {
  const ms = timestampMs(value);
  if (!ms) return "--";
  const delta = Date.now() - ms;
  if (delta < 0) return fmtTime(value);
  if (delta < 45000) return "刚刚";
  if (delta < 3600000) return Math.max(1, Math.round(delta / 60000)) + " 分钟前";
  if (delta < 86400000) return Math.round(delta / 3600000) + " 小时前";
  if (delta < 604800000) return Math.round(delta / 86400000) + " 天前";
  return fmtDateTime(value);
}

function fmtTokens(value: unknown): string {
  const count = Math.max(0, Number(value || 0));
  if (count >= 1000000) return (count / 1000000).toFixed(2).replace(/\.00$/, "") + "M";
  if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(count));
}

function shortValue(value: unknown, maxLength: number): string {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(4, maxLength - 5)) + "..." + text.slice(-4);
}
