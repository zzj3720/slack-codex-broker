import {
  profileTitle,
  profileWeeklyQuotaLabel
} from "./auth-profile-display.js";

type SessionRecord = Record<string, any>;

export interface SessionMetaPill {
  readonly key: string;
  readonly label: string;
  readonly tone: string;
  readonly title?: string;
}

export interface SessionQueueState {
  readonly label: string;
  readonly tone: string;
  readonly rank: number;
  readonly detail: string;
}

export function shouldShowSessionState(state: { readonly rank: number }): boolean {
  return state.rank > 10;
}

export function buildChannelLabelById(sessions: readonly SessionRecord[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const channelId = String(session.channelId || "");
    const label = sessionHumanChannelLabel(session);
    if (channelId && label) {
      labels.set(channelId, label);
    }
  }
  return labels;
}

export function resolveSessionChannelLabel(
  session: SessionRecord,
  channelLabelById?: ReadonlyMap<string, string>
): string {
  const channelId = String(session.channelId || "");
  return sessionHumanChannelLabel(session) || (channelId ? channelLabelById?.get(channelId) : undefined) || channelId || "未知频道";
}

export function renderSessionMeta(
  session: SessionRecord,
  authProfileByName: ReadonlyMap<string, SessionRecord>,
  channelLabelById?: ReadonlyMap<string, string>
): SessionMetaPill[] {
  const usage = session.usage || {};
  const pendingDetail = Number(session.openInboundCount || 0)
    ? "待处理 " + (session.openInboundCount || 0) + "（人 " + (session.openHumanInboundCount || 0) + " / 系统 " + (session.openSystemInboundCount || 0) + "）"
    : "";
  const authProfile = session.authProfileName ? authProfileByName.get(String(session.authProfileName)) : null;
  const backgroundJobCount = Number(session.backgroundJobCount || 0);
  const failedJob = sessionFailedJobSummary(session);
  return [
    { key: "channel", label: resolveSessionChannelLabel(session, channelLabelById), tone: "info", title: stringOrUndefined(session.channelId || session.key) },
    session.authBlockedAt ? { key: "auth-blocked", label: "账号待切换", tone: "danger", title: stringOrUndefined(session.authBlockReasonLabel || session.authBlockReason) } : null,
    session.authProfileName ? {
      key: "auth-profile",
      label: authProfile ? profileWeeklyQuotaLabel(authProfile) : "账号已绑定",
      tone: "info",
      title: authProfile ? profileTitle(authProfile) : String(session.authProfileName)
    } : null,
    pendingDetail ? { key: "pending", label: pendingDetail, tone: Number(session.openHumanInboundCount || 0) ? "warn" : "" } : null,
    backgroundJobCount > 0 ? { key: "jobs", label: "Jobs " + backgroundJobCount, tone: Number(session.failedBackgroundJobCount || 0) ? "danger" : (Number(session.runningBackgroundJobCount || 0) ? "good" : ""), title: failedJob?.detail } : null,
    Number(session.failedBackgroundJobCount || 0) ? { key: "failed", label: "失败 " + session.failedBackgroundJobCount, tone: "danger", title: failedJob?.detail } : null,
    { key: "tokens", label: "Token " + formatSessionTokens(usage.totalTokens || 0), tone: "info" }
  ].filter((item): item is SessionMetaPill => Boolean(item));
}

export function sessionQueueState(session: SessionRecord): SessionQueueState {
  if (session.authBlockedAt) {
    return { label: "账号待切换", tone: "danger", rank: 70, detail: String(session.authBlockReasonLabel || session.authBlockReason || "账号不可用") };
  }
  if (Number(session.failedBackgroundJobCount || 0) > 0) {
    const failedJob = sessionFailedJobSummary(session);
    return {
      label: "任务失败",
      tone: "danger",
      rank: 60,
      detail: failedJob?.detail || session.failedBackgroundJobCount + " 个失败任务"
    };
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
    return { label: "有记录", tone: "info", rank: 10, detail: formatSessionTokens(session.usage?.totalTokens || 0) };
  }
  return { label: "空闲", tone: "", rank: 0, detail: "" };
}

export function sessionFailedJobSummary(session: SessionRecord): { readonly label: string; readonly detail: string; readonly title: string } | null {
  const job = firstFailedBackgroundJob(session);
  if (!job) {
    const count = Number(session.failedBackgroundJobCount || 0);
    if (!count) return null;
    const detail = count + " 个失败任务";
    return { label: detail, detail, title: detail };
  }
  const kind = String(job.kind || job.id || "后台任务");
  const reason = String(job.error || job.lastEventSummary || job.status || "").trim();
  const time = String(job.updatedAt || job.completedAt || job.lastEventAt || "").trim();
  const detail = compactText(kind + (reason ? "：" + reason : " 失败"), 140);
  const title = [kind, reason, time].filter(Boolean).join(" · ");
  return {
    label: kind,
    detail,
    title: title || detail
  };
}

export function sessionActivityAt(session: SessionRecord): unknown {
  const candidates = [
    session.lastActivityAt,
    session.lastTurnSignalAt,
    session.lastSlackReplyAt,
    session.activeTurnStartedAt,
    session.usage?.lastTurnAt,
    ...(session.openInbound || []).map((message: Record<string, any>) => message.updatedAt || message.createdAt),
    ...(session.backgroundJobs || []).flatMap(jobActivityTimestamps),
    ...(session.failedBackgroundJobs || []).flatMap(jobActivityTimestamps)
  ];
  const latestMs = newestTimestamp(candidates);
  return candidates.find((value) => timestampMs(value) === latestMs) || session.createdAt || session.updatedAt;
}

export function sessionActivityMs(session: SessionRecord): number {
  return timestampMs(sessionActivityAt(session));
}

function sessionHumanChannelLabel(session: SessionRecord): string | undefined {
  const channelId = String(session.channelId || "");
  const channelName = String(session.channelName || "").trim();
  if (channelName) {
    return formatSlackChannelName(channelName);
  }

  const channelLabel = String(session.channelLabel || "").trim();
  if (channelLabel && channelLabel !== channelId && !looksLikeSlackChannelId(channelLabel)) {
    return channelLabel;
  }

  if (session.channelType === "im") return "私信";
  if (session.channelType === "mpim") return "群聊";
  return undefined;
}

function formatSessionTokens(value: unknown): string {
  const count = Math.max(0, Number(value || 0));
  if (count >= 1000000) return (count / 1000000).toFixed(2).replace(/\.00$/, "") + "M";
  if (count >= 1000) return (count / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(count));
}

function firstFailedBackgroundJob(session: SessionRecord): Record<string, any> | null {
  return (session.failedBackgroundJobs || []).find((job: Record<string, any>) => job.status === "failed") ||
    (session.backgroundJobs || []).find((job: Record<string, any>) => job.status === "failed") ||
    null;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(1, maxLength - 1)).trim() + "…";
}

function shortValue(value: unknown, maxLength: number): string {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(4, maxLength - 5)) + "..." + text.slice(-4);
}

function formatSlackChannelName(channelName: string): string {
  return channelName.startsWith("#") ? channelName : "#" + channelName;
}

function looksLikeSlackChannelId(value: string): boolean {
  return /^[CDG][A-Z0-9]{8,}$/.test(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = String(value || "");
  return text || undefined;
}

function jobActivityTimestamps(job: Record<string, any>): unknown[] {
  return [
    job.lastEventAt,
    job.status === "running" ? null : job.updatedAt,
    job.createdAt
  ];
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: readonly unknown[]): number {
  return values.reduce<number>((latest, value) => Math.max(latest, timestampMs(value)), 0);
}
