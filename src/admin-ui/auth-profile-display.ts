type AuthProfileRecord = Record<string, any>;

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

export function profileOptionLabel(profile: AuthProfileRecord): string {
  return [profileDisplayLabel(profile), profileQuotaLabel(profile)]
    .filter(Boolean)
    .join(" · ");
}

export function profileTitle(profile: AuthProfileRecord): string {
  const internalName = readString(profile.name);
  return [profileOptionLabel(profile), internalName ? `内部标识 ${internalName}` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function profileIsSelectable(profile: AuthProfileRecord): boolean {
  return profile.account?.ok !== false && profile.rateLimits?.ok !== false;
}

export function profileQuotaLabel(profile: AuthProfileRecord): string {
  const rateLimits = profile.rateLimits || {};
  if (rateLimits.ok === false) {
    return "不可用";
  }

  const limits = rateLimits.rateLimits || {};
  const primary = remainingPercent(limits.primary?.usedPercent);
  const secondary = remainingPercent(limits.secondary?.usedPercent);
  const parts = [];
  if (primary !== null) parts.push("短窗 " + Math.round(primary) + "%");
  if (secondary !== null) parts.push("周 " + Math.round(secondary) + "%");
  return parts.length ? parts.join(" / ") : "额度未知";
}

function remainingPercent(usedPercent: unknown): number | null {
  const used = Number(usedPercent);
  if (!Number.isFinite(used)) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - used));
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
