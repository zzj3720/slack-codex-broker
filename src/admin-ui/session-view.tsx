import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  profileDisplayLabel,
  profileIsSelectable,
  profileOptionLabel,
  profileQuotaLabel,
  profileTitle
} from "./auth-profile-display";
import {
  getAdminStatusSnapshot,
  getTimelineSnapshot,
  publishTimelinePayload,
  subscribeAdminStatus,
  subscribeTimeline
} from "./admin-status-store";
import { stableSessionOrder } from "./session-order";
import {
  buildChannelLabelById,
  renderSessionMeta,
  resolveSessionChannelLabel,
  sessionActivityAt,
  sessionActivityMs,
  shouldShowSessionState
} from "./session-row-display";
import { getTimelineEventDisplay, isTimelineEventVisible, statusLabel, type TimelineEvent } from "./timeline-display";

type UiState = {
  readonly adminView: string;
  readonly sessionSearch: string;
  readonly sessionFilter: string;
  readonly selectedSessionKey: string | null;
};

type SessionRecord = Record<string, any>;
type TimelinePayload = {
  readonly events?: TimelineEvent[];
  readonly trace?: Record<string, any>;
  readonly session?: SessionRecord;
} | TimelineEvent[];

const sessionFilters = ["ongoing", "all", "active", "inbound", "jobs", "issues", "usage"];
const AUTO_AUTH_PROFILE_VALUE = "__auto_auth_profile__";

export function AdminSessionsView(): React.JSX.Element {
  const permalinkSessionKey = readPermalinkSessionKey();
  if (permalinkSessionKey) {
    return <SessionPermalinkView sessionKey={permalinkSessionKey} />;
  }

  const snapshot = useSyncExternalStore(subscribeAdminStatus, getAdminStatusSnapshot, getAdminStatusSnapshot);
  const status = (snapshot.status || {}) as Record<string, any>;
  const sessions = (status.state?.sessions || []) as SessionRecord[];
  const state = status.state || {};
  const authProfiles = (status.authProfiles?.profiles || []) as SessionRecord[];
  const authProfileByName = useMemo(
    () => new Map(authProfiles.map((profile) => [String(profile.name), profile])),
    [authProfiles]
  );
  const channelLabelById = useMemo(() => buildChannelLabelById(sessions), [sessions]);
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
                authProfileByName={authProfileByName}
                channelLabelById={channelLabelById}
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
            <SessionDetail key={selectedSession.key} session={selectedSession} />
          ) : (
            <div className="empty-state">没有可检查的 session</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SessionPermalinkView({ sessionKey }: { readonly sessionKey: string }): React.JSX.Element {
  const snapshot = useSyncExternalStore(subscribeAdminStatus, getAdminStatusSnapshot, getAdminStatusSnapshot);
  const sessions = ((snapshot.status || {}) as Record<string, any>).state?.sessions || [];
  const realtimeSession = (sessions as SessionRecord[]).find((session) => session.key === sessionKey) || null;
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey)
  );
  const timelinePayload = timelineSnapshot.payload as TimelinePayload | null;
  const [fetchedSession, setFetchedSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = realtimeSession || fetchedSession || (Array.isArray(timelinePayload) ? null : timelinePayload?.session) || null;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void requestJson(sessionTimelineApiPath(sessionKey))
      .then((nextPayload) => {
        if (cancelled) return;
        const payload = nextPayload as TimelinePayload;
        publishTimelinePayload(sessionKey, payload);
        if (!Array.isArray(payload) && payload.session) {
          setFetchedSession(payload.session);
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  return (
    <div className="session-permalink-layout">
      <section className="session-detail-panel session-permalink-panel">
        <div className="panel-body">
          {error ? (
            <div className="empty-state">{error}</div>
          ) : session ? (
            <SessionDetail key={session.key} session={session} isPermalink />
          ) : (
            <div className="empty-state">正在加载会话</div>
          )}
        </div>
      </section>
    </div>
  );
}

function SessionRow({ session, selected, authProfileByName, channelLabelById, onSelect }: {
  readonly session: SessionRecord;
  readonly selected: boolean;
  readonly authProfileByName: ReadonlyMap<string, SessionRecord>;
  readonly channelLabelById?: ReadonlyMap<string, string>;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const state = sessionQueueState(session);
  const activityAt = sessionActivityAt(session);
  const primary = sessionPrimaryText(session);
  const first = sessionFirstText(session);
  const stateBadge = shouldShowSessionState(state) ? <Badge label={state.label} tone={state.tone} /> : null;
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
          {stateBadge}
          <div className="session-time" title={fmtDateTime(activityAt)}>{fmtRelativeTime(activityAt)}</div>
        </div>
        <div className="session-channel" title={first}>{first}</div>
        <div className="session-meta-line">
          {renderSessionMeta(session, authProfileByName, channelLabelById).map((pill) => (
            <span key={pill.key} className={"session-meta-pill " + classSafeValue(pill.tone, "")} title={pill.title}>
              {pill.label}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function SessionDetail({ session, isPermalink = false }: {
  readonly session: SessionRecord;
  readonly isPermalink?: boolean;
}): React.JSX.Element {
  const snapshot = useSyncExternalStore(subscribeAdminStatus, getAdminStatusSnapshot, getAdminStatusSnapshot);
  const authProfiles = (((snapshot.status || {}) as Record<string, any>).authProfiles?.profiles || []) as SessionRecord[];
  const sessions = (((snapshot.status || {}) as Record<string, any>).state?.sessions || []) as SessionRecord[];
  const channelLabelById = buildChannelLabelById([...sessions, session]);
  const channelLabel = resolveSessionChannelLabel(session, channelLabelById);
  const usage = session.usage || {};
  const state = sessionQueueState(session);
  const activityAt = sessionActivityAt(session);
  const primary = sessionPrimaryText(session);
  const first = sessionFirstText(session);
  const openInbound = Number(session.openInboundCount || 0);
  const openHumanInbound = Number(session.openHumanInboundCount || 0);
  const openSystemInbound = Number(session.openSystemInboundCount || 0);
  const runningJobs = Number(session.runningBackgroundJobCount || 0);
  const totalJobs = Number(session.backgroundJobCount || 0);
  const failedJobs = Number(session.failedBackgroundJobCount || 0);
  const hasMessagesOrJobs = openInbound > 0 || totalJobs > 0;
  const currentProfile = authProfiles.find((profile) => profile.name === session.authProfileName);
  return (
    <>
      <div className="selected-session-head session-detail-toolbar">
        <div className="session-detail-main">
          <div className="session-detail-title-row">
            <div className="session-detail-title" title={primary}>{primary}</div>
            {shouldShowSessionState(state) ? <Badge label={state.label} tone={state.tone} /> : null}
            <span className="session-time" title={fmtDateTime(activityAt)}>{fmtRelativeTime(activityAt)}</span>
          </div>
          <div className="session-detail-subtitle" title={first}>{first}</div>
        </div>
      </div>
      <div className="session-body">
        <div className="session-inspector">
          <div className="mini-panel trace-panel session-timeline-panel">
            <div className="mini-title">Agent 活动时间线</div>
            <div className="mini-body">
              <SessionTimeline session={session} />
            </div>
          </div>
          <div className="session-side-column">
            <div className="mini-panel">
              <div className="mini-title">操作</div>
              <div className="mini-body">
                <SessionActions
                  session={session}
                  profiles={authProfiles}
                  currentProfile={currentProfile}
                  isPermalink={isPermalink}
                />
              </div>
            </div>
            <SessionRuntimePanel
              session={session}
              state={state}
              openInbound={openInbound}
              openHumanInbound={openHumanInbound}
              openSystemInbound={openSystemInbound}
              totalJobs={totalJobs}
              runningJobs={runningJobs}
              failedJobs={failedJobs}
            />
            <div className="mini-panel">
              <div className="mini-title">Token 消耗</div>
              <div className="mini-body">
                <SessionUsagePanel sessionKey={String(session.key || "")} usage={usage} />
              </div>
            </div>
            {hasMessagesOrJobs ? (
              <div className="mini-panel">
                <div className="mini-title">消息 / 任务</div>
                <div className="mini-body">
                  <InboundTable items={session.openInbound || []} />
                  <JobsTable jobs={session.backgroundJobs || []} />
                </div>
              </div>
            ) : null}
            <div className="mini-panel">
              <div className="mini-title">活动构成</div>
              <div className="mini-body">
                <SessionTraceStats sessionKey={String(session.key || "")} />
              </div>
            </div>
            <div className="mini-panel">
              <div className="mini-title">调试信息</div>
              <div className="mini-body">
                <SessionDebugPanel
                  session={session}
                  channelLabel={channelLabel}
                  channelTitle={String(session.channelId || "")}
                  activityAt={activityAt}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SessionActions({ session, profiles, currentProfile, isPermalink }: {
  readonly session: SessionRecord;
  readonly profiles: readonly SessionRecord[];
  readonly currentProfile?: SessionRecord | undefined;
  readonly isPermalink: boolean;
}): React.JSX.Element {
  return (
    <div className="side-action-stack">
      <AuthProfilePanel session={session} profiles={profiles} currentProfile={currentProfile} />
      <GitHubIdentityPanel session={session} />
      <SessionResetButton session={session} />
      <div className="side-link-grid">
        {!isPermalink ? (
          <a className="link-button" href={adminSessionPath(String(session.key || ""))}>打开 Session 页面</a>
        ) : (
          <a className="link-button" href="/admin">返回会话索引</a>
        )}
        {session.threadUrl ? (
          <a className="link-button" href={session.threadUrl} target="_blank" rel="noreferrer">打开 Slack Thread</a>
        ) : null}
      </div>
    </div>
  );
}

function GitHubIdentityPanel({ session }: {
  readonly session: SessionRecord;
}): React.JSX.Element {
  const sessionKey = String(session.key || "");
  const [identity, setIdentity] = useState<Record<string, any> | null>(null);
  const [device, setDevice] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const autoStartRef = useRef(false);
  const shouldAutoStart = typeof window !== "undefined" && window.location.pathname.endsWith("/github/bind");
  const binding = identity?.binding || {};
  const defaultAccount = identity?.defaultAccount || {};

  async function refreshIdentity(): Promise<Record<string, any> | null> {
    if (!sessionKey) {
      return null;
    }
    const payload = await requestJson(githubIdentityApiPath(sessionKey)) as Record<string, any>;
    const nextIdentity = payload.identity as Record<string, any>;
    setIdentity(nextIdentity);
    return nextIdentity;
  }

  async function startDeviceAuthorization(): Promise<void> {
    if (!sessionKey || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const payload = await requestJson(githubDeviceStartApiPath(sessionKey), {
        method: "POST"
      }) as Record<string, any>;
      setDevice(payload.device as Record<string, any>);
      setMessage("打开 GitHub 设备码页面，输入下面的代码完成绑定。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setIdentity(null);
    setDevice(null);
    setMessage(null);
    autoStartRef.current = false;
    void refreshIdentity()
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!shouldAutoStart || autoStartRef.current || !identity || binding.state !== "unbound") {
      return;
    }
    autoStartRef.current = true;
    void startDeviceAuthorization();
  }, [shouldAutoStart, identity, binding.state]);

  useEffect(() => {
    if (!device?.id) {
      return;
    }
    let cancelled = false;
    let timeout: number | undefined;
    async function poll(): Promise<void> {
      try {
        const payload = await requestJson(githubDevicePollApiPath(String(device.id))) as Record<string, any>;
        const result = payload.result as Record<string, any>;
        if (cancelled) return;
        if (result.status === "completed") {
          setDevice(null);
          setMessage("GitHub 账号已绑定。");
          await refreshIdentity();
          return;
        }
        if (result.status === "expired") {
          setMessage("设备码已过期，请重新发起绑定。");
          setDevice(null);
          return;
        }
        if (result.status === "failed") {
          setMessage(String(result.error || "绑定失败"));
          setDevice(null);
          return;
        }
        timeout = window.setTimeout(
          () => { void poll(); },
          Math.max(1, Number(result.retryAfterSeconds || device.intervalSeconds || 5)) * 1000
        );
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      }
    }
    timeout = window.setTimeout(() => { void poll(); }, 800);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [device?.id]);

  return (
    <div className="github-identity-panel">
      {identity ? (
        <div className="meta-list">
          {binding.state === "bound" ? (
            <MetaLine label="PR 账号" value={String(binding.githubLogin || "--")} tone="good" />
          ) : binding.state === "revoked" ? (
            <MetaLine label="PR 账号" value="绑定失效" detail={String(binding.githubLogin || "")} tone="danger" />
          ) : binding.state === "unbound" && defaultAccount.available ? (
            <MetaLine label="PR 默认" value={String(defaultAccount.githubLogin || "--")} detail="发起人未绑定" tone="warn" />
          ) : binding.state === "unbound" ? (
            <MetaLine label="PR 账号" value="未绑定" detail="没有默认账号" tone="danger" />
          ) : (
            <MetaLine label="PR 账号" value="未记录发起人" tone="danger" />
          )}
        </div>
      ) : (
        <div className="summary-detail">GitHub 绑定状态加载中</div>
      )}
      {binding.state === "unbound" || binding.state === "revoked" ? (
        <button
          type="button"
          className="link-button github-bind-button"
          disabled={busy || !sessionKey}
          onClick={() => { void startDeviceAuthorization(); }}
        >
          {busy ? "正在发起绑定" : "绑定发起人的 GitHub"}
        </button>
      ) : null}
      {device ? (
        <div className="device-code-panel">
          <div className="device-code-label">GitHub 设备码</div>
          <div className="code-block">{String(device.userCode || "")}</div>
          <a className="link-button" href={String(device.verificationUriComplete || device.verificationUri || "https://github.com/login/device")} target="_blank" rel="noreferrer">
            打开 GitHub 验证页
          </a>
        </div>
      ) : null}
      {message ? <div className="summary-detail">{message}</div> : null}
    </div>
  );
}

function SessionResetButton({ session }: {
  readonly session: SessionRecord;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sessionKey = String(session.key || "");

  async function resetSession(): Promise<void> {
    if (!sessionKey) {
      return;
    }
    const confirmed = window.confirm([
      "确认重置这个 Session？",
      "会清空旧 agent history、结束当前回合、丢弃待处理队列，并用当前 Slack thread 上下文重新唤起 bot。"
    ].join("\n"));
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await requestJson("/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/reset", {
        method: "POST"
      });
      const timelinePayload = await requestJson(sessionTimelineApiPath(sessionKey));
      publishTimelinePayload(sessionKey, timelinePayload as TimelinePayload);
      setMessage("已重置，正在重新唤起 bot");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="session-reset-action">
      <button
        type="button"
        className="danger"
        disabled={busy || !sessionKey}
        onClick={() => { void resetSession(); }}
      >
        {busy ? "正在重置" : "重置 Session"}
      </button>
      {message ? <div className="summary-detail">{message}</div> : null}
    </div>
  );
}

function SessionRuntimePanel({ session, state, openInbound, openHumanInbound, openSystemInbound, totalJobs, runningJobs, failedJobs }: {
  readonly session: SessionRecord;
  readonly state: { readonly label: string; readonly tone: string; readonly rank: number; readonly detail: string };
  readonly openInbound: number;
  readonly openHumanInbound: number;
  readonly openSystemInbound: number;
  readonly totalJobs: number;
  readonly runningJobs: number;
  readonly failedJobs: number;
}): React.JSX.Element {
  const rows = [
    session.activeTurnId ? {
      label: "回合",
      value: "运行中",
      detail: shortValue(session.activeTurnId, 18),
      tone: "good"
    } : null,
    shouldShowSessionState(state) ? {
      label: "状态",
      value: state.label,
      detail: state.detail,
      tone: state.tone
    } : null,
    openInbound > 0 ? {
      label: "待处理",
      value: openInbound + " 条",
      detail: "人 " + openHumanInbound + " / 系统 " + openSystemInbound,
      tone: openHumanInbound > 0 ? "warn" : undefined
    } : null,
    runningJobs > 0 ? {
      label: "运行任务",
      value: String(runningJobs),
      detail: totalJobs + " 个任务",
      tone: "good"
    } : null,
    failedJobs > 0 ? {
      label: "失败任务",
      value: String(failedJobs),
      detail: totalJobs + " 个任务",
      tone: "danger"
    } : null
  ].filter((row): row is { label: string; value: string; detail?: string; tone?: string } => Boolean(row));
  if (!rows.length) return <></>;
  return (
    <div className="mini-panel">
      <div className="mini-title">运行状态</div>
      <div className="mini-body">
        <div className="meta-list">
          {rows.map((row) => (
            <MetaLine key={row.label} label={row.label} value={row.value} detail={row.detail} tone={row.tone} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MetaLine({ label, value, detail, title, tone }: {
  readonly title?: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone?: string;
}): React.JSX.Element {
  return (
    <div className={"meta-line " + classSafeValue(tone, "")}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
      {detail ? <em title={detail}>{detail}</em> : null}
    </div>
  );
}

function SessionDebugPanel({ session, channelLabel, channelTitle, activityAt }: {
  readonly session: SessionRecord;
  readonly channelLabel: string;
  readonly channelTitle: string;
  readonly activityAt: unknown;
}): React.JSX.Element {
  return (
    <details className="side-disclosure">
      <summary>展开调试信息</summary>
      <div className="meta-list">
        <MetaLine label="频道" value={channelLabel} title={channelTitle} />
        <MetaLine label="最近活动" value={fmtRelativeTime(activityAt)} detail={fmtDateTime(activityAt)} />
        <MetaLine label="Root TS" value={String(session.rootThreadTs || "--")} />
        <MetaLine label="Agent" value={shortValue(session.agentSessionId || "--", 28)} title={String(session.agentSessionId || "")} />
        <MetaLine label="Session" value={shortValue(session.key || "--", 28)} title={String(session.key || "")} />
        {session.activeTurnId ? (
          <MetaLine label="Turn" value={shortValue(session.activeTurnId, 28)} title={String(session.activeTurnId)} />
        ) : null}
        {session.authProfileName ? (
          <MetaLine label="Auth" value={shortValue(session.authProfileName, 28)} title={String(session.authProfileName)} />
        ) : null}
      </div>
    </details>
  );
}

function SessionTraceStats({ sessionKey }: { readonly sessionKey: string }): React.JSX.Element {
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey)
  );
  const payload = timelineSnapshot.payload as TimelinePayload | null;
  const trace = payload && !Array.isArray(payload) ? payload.trace : null;
  if (!trace) return <div className="summary-detail">活动构成加载中</div>;
  return <TraceSummary trace={trace} />;
}

function SessionTimeline({ session }: {
  readonly session: SessionRecord;
}): React.JSX.Element {
  const sessionKey = String(session.key || "");
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey)
  );
  const payload = timelineSnapshot.payload as TimelinePayload | null;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void requestJson(sessionTimelineApiPath(sessionKey))
      .then((nextPayload) => {
        if (cancelled) return;
        publishTimelinePayload(sessionKey, nextPayload as TimelinePayload);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  if (error) return <div className="summary-detail">{error}</div>;
  if (!payload) return <Timeline events={[{ at: session.createdAt, type: "session", title: "已创建" }]} />;
  return <TimelinePayloadView payload={payload} />;
}

function AuthProfilePanel({ session, profiles, currentProfile: providedCurrentProfile }: {
  readonly session: SessionRecord;
  readonly profiles: readonly SessionRecord[];
  readonly currentProfile?: SessionRecord | undefined;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [selected, setSelected] = useState(() => initialAuthProfileSelection(session));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const currentProfile = providedCurrentProfile ?? profiles.find((profile) => profile.name === session.authProfileName);
  const currentLabel = currentProfile
    ? profileDisplayLabel(currentProfile)
    : (session.authProfileName ? "账号状态加载中" : "未绑定");
  const blocked = Boolean(session.authBlockedAt);
  const compactLabel = currentProfile ? profileQuotaLabel(currentProfile) : (blocked ? "账号不可用" : "账号");

  useEffect(() => {
    setSelected(initialAuthProfileSelection(session));
    setMessage(null);
  }, [session.key, session.authProfileName, session.authBlockedAt]);

  function openDialog(): void {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
      return;
    }
    dialog.setAttribute("open", "");
  }

  function closeDialog(): void {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog.removeAttribute("open");
  }

  async function switchProfile(): Promise<void> {
    const autoSelected = selected === AUTO_AUTH_PROFILE_VALUE;
    if (!autoSelected && (!selected || selected === session.authProfileName)) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await requestJson("/admin/api/sessions/" + encodeURIComponent(String(session.key || "")) + "/auth-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(autoSelected ? { mode: "auto" } : { name: selected })
      });
      const timelinePayload = await requestJson(sessionTimelineApiPath(String(session.key || "")));
      publishTimelinePayload(String(session.key || ""), timelinePayload as TimelinePayload);
      setMessage(autoSelected ? "已自动分配，正在恢复待处理消息" : "已切换，正在恢复待处理消息");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-profile-panel">
      <button
        type="button"
        className={"auth-profile-compact-button " + (blocked ? "danger" : "")}
        title={currentProfile ? profileTitle(currentProfile) : currentLabel}
        onClick={openDialog}
      >
        {compactLabel}
      </button>
      <dialog ref={dialogRef} className="auth-profile-dialog">
        <div className="modal-content">
          <div className="modal-heading">
            <div className="panel-title">账号操作</div>
            <div className="summary-detail" title={currentProfile ? profileTitle(currentProfile) : currentLabel}>{currentLabel}</div>
          </div>
          {currentProfile ? (
            <div className="auth-profile-dialog-current">
              <span>额度</span>
              <strong>{profileQuotaLabel(currentProfile)}</strong>
            </div>
          ) : null}
          {blocked ? (
            <div className="auth-profile-blocked">
              <Badge label="等待手动切换" tone="danger" />
              <span>{session.authBlockReasonLabel || session.authBlockReason || "账号不可用"}</span>
            </div>
          ) : null}
          <div className="auth-profile-switcher">
            <span className="auth-profile-label">切换到</span>
            <select
              value={selected}
              title={currentProfile ? profileTitle(currentProfile) : currentLabel}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">选择账号</option>
              <option value={AUTO_AUTH_PROFILE_VALUE}>自动分配（按额度规则）</option>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name} disabled={!profileIsSelectable(profile)}>
                  {profileOptionLabel(profile)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="link-button"
              disabled={busy || (selected !== AUTO_AUTH_PROFILE_VALUE && (!selected || selected === session.authProfileName))}
              onClick={() => { void switchProfile(); }}
            >
              {selected === AUTO_AUTH_PROFILE_VALUE ? "自动分配并继续处理" : "切换并继续处理"}
            </button>
          </div>
          {message ? <div className="summary-detail">{message}</div> : null}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={closeDialog}>关闭</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

function initialAuthProfileSelection(session: SessionRecord): string {
  return session.authBlockedAt ? AUTO_AUTH_PROFILE_VALUE : String(session.authProfileName || "");
}

function TimelinePayloadView({ payload }: { readonly payload: TimelinePayload }): React.JSX.Element {
  const events = (Array.isArray(payload) ? payload : (payload.events || [])).filter(isTimelineEventVisible);
  if (!events.length) return <div className="summary-detail">暂无时间线事件</div>;
  return <Timeline events={events} />;
}

function TraceSummary({ trace }: { readonly trace: Record<string, any> }): React.JSX.Element {
  const categories = trace.categories || {};
  const eventCount = Number(trace.eventCount || 0);
  const items = [
    ["agent_system_prompt", "系统"],
    ["agent_memory", "记忆"],
    ["agent_user_message", "用户"],
    ["agent_runtime_reminder", "提醒"],
    ["agent_assistant_message", "助手"],
    ["agent_tool_call", "工具"]
  ];
  const summary = [
    ["agent_user_message", "用户"],
    ["agent_assistant_message", "助手"],
    ["agent_tool_call", "工具"]
  ]
    .map(([key, label]) => label + " " + Number(categories[key] || 0))
    .join(" · ");
  return (
    <details className="side-disclosure">
      <summary title={summary}>{summary}</summary>
      <div className="trace-stat-panel">
        <div className="trace-stat-head">
          <strong>{eventCount}</strong>
          <span>条 Agent 事件</span>
        </div>
        <div className="trace-stat-grid">
          {items.map(([key, label]) => (
            <div key={key} className={"trace-stat " + classSafeValue(statusTone(key), "")}>
              <span>{label}</span>
              <strong>{Number(categories[key] || 0)}</strong>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function Timeline({ events }: { readonly events: readonly TimelineEvent[] }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldFollowRef.current) {
      updateFollowState();
      return;
    }
    container.scrollTop = container.scrollHeight;
    updateFollowState();
  }, [events.length]);

  function updateFollowState(): void {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    shouldFollowRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
  }

  return (
    <div className="timeline" ref={containerRef} onScroll={updateFollowState} onMouseEnter={updateFollowState}>
      {events.map((event, index) => (
        <TimelineRow key={timelineEventKey(event, index)} event={event} />
      ))}
    </div>
  );
}

function TimelineRow({ event }: { readonly event: TimelineEvent }): React.JSX.Element {
  const display = getTimelineEventDisplay(event);
  const badgeTone = statusTone(event.status === "failed" || event.status === "error" ? event.status : event.type);
  const isCommandEvent = event.toolName === "exec_command";
  const meta = [
    event.status ? ("状态 " + statusLabel(event.status)) : "",
    !isCommandEvent && event.role ? ("角色 " + event.role) : "",
    !isCommandEvent && event.toolName ? ("工具 " + event.toolName) : "",
    event.detailTruncated ? "内容已截断" : ""
  ].filter(Boolean).join(" · ");
  return (
    <div className="timeline-event">
      <span>{fmtTime(event.at)}</span>
      <Badge label={display.badgeLabel} tone={badgeTone} />
      <div className="timeline-main">
        <div className={"timeline-title" + (display.summary ? "" : " timeline-title-single")}>
          <strong title={display.title}>{display.title}</strong>
          {display.summary ? <span title={display.summary}>{display.summary}</span> : null}
        </div>
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

function SessionUsagePanel({ sessionKey, usage }: {
  readonly sessionKey: string;
  readonly usage: Record<string, any>;
}): React.JSX.Element {
  const timelineSnapshot = useSyncExternalStore(
    (listener) => subscribeTimeline(sessionKey, listener),
    () => getTimelineSnapshot(sessionKey),
    () => getTimelineSnapshot(sessionKey)
  );
  const payload = timelineSnapshot.payload as TimelinePayload | null;
  const trace = payload && !Array.isArray(payload) ? payload.trace : null;
  return <SessionUsage usage={usage} modelRequestCount={Number(trace?.modelRequestCount || 0)} />;
}

function SessionUsage({ usage, modelRequestCount }: {
  readonly usage: Record<string, any>;
  readonly modelRequestCount: number;
}): React.JSX.Element {
  const exact = Number(usage?.exactTurns || 0);
  const total = Number(usage?.turnCount || 0);
  const totalTokens = Number(usage?.totalTokens || 0);
  const inputTokens = Number(usage?.inputTokens || 0);
  const cachedInputTokens = Number(usage?.cachedInputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const reasoningTokens = Number(usage?.reasoningTokens || 0);
  const missingTurns = Number(usage?.missingTurns || 0);
  const estimatedTurns = Number(usage?.estimatedTurns || 0);
  const cacheHitRate = inputTokens > 0 ? cachedInputTokens / inputTokens : null;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const generatedTokens = outputTokens + reasoningTokens;
  const exactRate = total > 0 ? exact / total : 0;
  const totalDetail = modelRequestCount > 0
    ? total + " 个 Slack 回合 · " + modelRequestCount + " 次模型请求"
    : total + " 个 Slack 回合";
  if (!total) return <div className="summary-detail">这个会话还没有用量记录</div>;
  return (
    <div className="quota-grid">
      <UsageMetric label="总消耗" value={fmtTokens(totalTokens)} detail={totalDetail} />
      <UsageMetric label="非缓存输入" value={fmtTokens(uncachedInputTokens)} detail={"缓存覆盖 " + (cacheHitRate === null ? "无输入" : fmtPercent(cacheHitRate))} />
      <UsageMetric label="生成 Token" value={fmtTokens(generatedTokens)} detail={"输出 " + fmtTokens(outputTokens) + " · 推理 " + fmtTokens(reasoningTokens)} />
      {missingTurns || estimatedTurns ? (
        <UsageMetric label="记录完整度" value={fmtPercent(exactRate)} detail={"估算 " + estimatedTurns + " · 缺失 " + missingTurns} />
      ) : null}
      <details className="usage-raw-details">
        <summary>原始计数</summary>
        <div className="usage-raw-grid">
          <QuotaLine label="输入" value={fmtTokens(inputTokens)} detail={"缓存 " + fmtTokens(cachedInputTokens)} />
          <QuotaLine label="非缓存" value={fmtTokens(uncachedInputTokens)} detail={"缓存覆盖 " + (cacheHitRate === null ? "无输入" : fmtPercent(cacheHitRate))} />
          <QuotaLine label="输出" value={fmtTokens(outputTokens)} detail={"推理 " + fmtTokens(reasoningTokens)} />
          <QuotaLine label="记录" value={exact + "/" + total} detail={"估算 " + estimatedTurns + " · 缺失 " + missingTurns} />
          {usage.model || usage.effort ? (
            <QuotaLine label="模型" value={String(usage.model || "未知")} detail={String(usage.effort || "默认")} />
          ) : null}
        </div>
      </details>
    </div>
  );
}

function UsageMetric({ label, value, detail }: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}): React.JSX.Element {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      <em title={detail}>{detail}</em>
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
  if (mode === "issues" && !session.failedBackgroundJobCount && !session.authBlockedAt) return false;
  if (mode === "usage" && !session.usage?.turnCount) return false;
  if (!query) return true;
  return [session.key, session.channelId, session.channelLabel, session.workspacePath, sessionPrimaryText(session), sessionFirstText(session)]
    .some((value) => String(value || "").toLowerCase().includes(query));
}

function resolveSelectedSession(sessions: readonly SessionRecord[], selectedSessionKey: string | null): SessionRecord | null {
  if (!sessions.length) return null;
  return sessions.find((session) => session.key === selectedSessionKey) || sessions[0] || null;
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
  if (session.authBlockedAt) {
    return { label: "账号待切换", tone: "danger", rank: 70, detail: session.authBlockReasonLabel || session.authBlockReason || "账号不可用" };
  }
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

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText || "请求失败");
  return payload;
}

function sessionTimelineApiPath(sessionKey: string): string {
  return "/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/timeline";
}

function githubIdentityApiPath(sessionKey: string): string {
  return "/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/github-identity";
}

function githubDeviceStartApiPath(sessionKey: string): string {
  return "/admin/api/sessions/" + encodeURIComponent(sessionKey) + "/github-oauth/device/start";
}

function githubDevicePollApiPath(deviceAuthorizationId: string): string {
  return "/admin/api/github-oauth/device/" + encodeURIComponent(deviceAuthorizationId);
}

function adminSessionPath(sessionKey: string): string {
  return "/admin/sessions/" + encodeURIComponent(sessionKey);
}

function readPermalinkSessionKey(): string | null {
  const prefix = "/admin/sessions/";
  if (!window.location.pathname.startsWith(prefix)) {
    return null;
  }
  const encoded = window.location.pathname.slice(prefix.length).split("/")[0] || "";
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
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
  if (["failed", "error", "stopped", "cancelled", "blocked"].includes(value)) return "danger";
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
    unexpected_turn_stop: "异常停止",
    admin_session_reset: "Session 重置"
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

function fmtPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const percent = Math.max(0, Math.min(999, value * 100));
  if (percent >= 10) return Math.round(percent) + "%";
  return percent.toFixed(1).replace(/\.0$/, "") + "%";
}

function shortValue(value: unknown, maxLength: number): string {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(4, maxLength - 5)) + "..." + text.slice(-4);
}
