import { formatWeeklyQuotaDisplay } from "../auth-profile-quota.js";

type AuthProfileRecord = Record<string, any>;
interface QuotaLabelOptions {
  readonly now?: Date | number | string | undefined;
}

export function profileAccountLabel(profile: AuthProfileRecord): string {
  const accountStatus = profile.account || {};
  if (accountStatus.ok === false) {
    return "账号不可用";
  }

  const account = accountStatus.account || {};
  return readString(account.email) ||
    readString(account.name) ||
    readString(account.id) ||
    "未知账号";
}

export function profilePlanLabel(profile: AuthProfileRecord): string {
  const accountStatus = profile.account || {};
  if (accountStatus.ok === false) {
    return "";
  }

  const account = accountStatus.account || {};
  const plan = readString(account.planType) || readString(account.type);
  if (!plan) {
    return "";
  }

  if (plan === "prolite") return "Pro Lite";
  if (plan === "pro") return "Pro";
  if (plan === "chatgpt") return "ChatGPT";
  return plan;
}

export function profileDisplayLabel(profile: AuthProfileRecord): string {
  return [profileAccountLabel(profile), profilePlanLabel(profile)]
    .filter(Boolean)
    .join(" · ");
}

export function profileOptionLabel(profile: AuthProfileRecord, options: QuotaLabelOptions = {}): string {
  return [profileDisplayLabel(profile), profileQuotaLabel(profile, options)]
    .filter(Boolean)
    .join(" · ");
}

export function profileTitle(profile: AuthProfileRecord, options: QuotaLabelOptions = {}): string {
  const internalName = readString(profile.name);
  return [profileOptionLabel(profile, options), internalName ? `内部标识 ${internalName}` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function profileIsSelectable(profile: AuthProfileRecord): boolean {
  return profile.account?.ok !== false && profile.rateLimits?.ok !== false;
}

export function profileQuotaLabel(profile: AuthProfileRecord, options: QuotaLabelOptions = {}): string {
  const rateLimits = profile.rateLimits || {};
  if (rateLimits.ok === false) {
    return "不可用";
  }

  const limits = rateLimits.rateLimits || {};
  const label = formatWeeklyQuotaDisplay({
    usedPercent: limits.secondary?.usedPercent,
    resetsAt: limits.secondary?.resetsAt,
    now: options.now
  });
  return label ?? "周额度未知";
}

export function profileWeeklyQuotaLabel(profile: AuthProfileRecord, options: QuotaLabelOptions = {}): string {
  const rateLimits = profile.rateLimits || {};
  if (rateLimits.ok === false) {
    return "不可用";
  }

  const limits = rateLimits.rateLimits || {};
  return formatWeeklyQuotaDisplay({
    usedPercent: limits.secondary?.usedPercent,
    resetsAt: limits.secondary?.resetsAt,
    now: options.now
  }) ?? "周额度未知";
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
