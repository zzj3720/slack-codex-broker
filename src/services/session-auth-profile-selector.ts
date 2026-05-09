import type { AuthProfileSummary, AuthProfilesStatus } from "./auth-profile-service.js";
import {
  daysUntilReset,
  remainingPercent,
  timestampMs,
  weightedWeeklyQuotaScore
} from "../auth-profile-quota.js";

export type AuthProfileUnavailableReason =
  | "profile_not_found"
  | "account_probe_failed"
  | "rate_limits_probe_failed"
  | "primary_quota_exhausted"
  | "secondary_quota_exhausted"
  | "credits_exhausted"
  | "no_usable_auth_profiles";

export interface AuthProfileEvaluation {
  readonly profileName: string;
  readonly usable: boolean;
  readonly reason?: AuthProfileUnavailableReason | undefined;
  readonly effectiveQuotaScore: number;
  readonly primaryRemainingPercent?: number | undefined;
  readonly secondaryRemainingPercent?: number | undefined;
  readonly secondaryRefreshDays?: number | undefined;
  readonly weightedWeeklyQuotaScore?: number | undefined;
}

export function selectBestAuthProfile(
  status: AuthProfilesStatus,
  options: { readonly now?: Date | number | string | undefined } = {}
): AuthProfileSummary | null {
  const nowMs = timestampMs(options.now);
  const candidates = status.profiles
    .map((profile) => ({
      profile,
      evaluation: evaluateAuthProfile(profile, { now: nowMs })
    }))
    .filter((candidate) => candidate.evaluation.usable)
    .sort((left, right) => {
      const scoreDelta = right.evaluation.effectiveQuotaScore - left.evaluation.effectiveQuotaScore;
      if (scoreDelta) {
        return scoreDelta;
      }

      const secondaryDelta =
        (right.evaluation.secondaryRemainingPercent ?? 100) -
        (left.evaluation.secondaryRemainingPercent ?? 100);
      if (secondaryDelta) {
        return secondaryDelta;
      }

      const primaryDelta =
        (right.evaluation.primaryRemainingPercent ?? 100) -
        (left.evaluation.primaryRemainingPercent ?? 100);
      if (primaryDelta) {
        return primaryDelta;
      }

      return left.profile.name.localeCompare(right.profile.name);
    });

  return candidates[0]?.profile ?? null;
}

export function findAuthProfile(status: AuthProfilesStatus, profileName: string): AuthProfileSummary | null {
  return status.profiles.find((profile) => profile.name === profileName) ?? null;
}

export function evaluateAuthProfile(
  profile: AuthProfileSummary,
  options: { readonly now?: Date | number | string | undefined } = {}
): AuthProfileEvaluation {
  if (!profile.account.ok) {
    return unavailable(profile.name, "account_probe_failed");
  }

  if (!profile.rateLimits.ok) {
    return unavailable(profile.name, "rate_limits_probe_failed");
  }

  const limits = profile.rateLimits.rateLimits;
  const primaryRemaining = remainingPercent(limits?.primary?.usedPercent);
  const secondaryRemaining = remainingPercent(limits?.secondary?.usedPercent);
  const secondaryRefreshDays = daysUntilReset(limits?.secondary?.resetsAt, timestampMs(options.now));
  const weightedWeeklyQuota = weightedWeeklyQuotaScore(secondaryRemaining, secondaryRefreshDays);
  const credits = limits?.credits;

  if (primaryRemaining !== undefined && primaryRemaining <= 0) {
    return unavailable(profile.name, "primary_quota_exhausted", {
      primaryRemainingPercent: primaryRemaining,
      secondaryRemainingPercent: secondaryRemaining
    });
  }

  if (secondaryRemaining !== undefined && secondaryRemaining <= 0) {
    return unavailable(profile.name, "secondary_quota_exhausted", {
      primaryRemainingPercent: primaryRemaining,
      secondaryRemainingPercent: secondaryRemaining
    });
  }

  if (credits && !credits.unlimited && credits.hasCredits === false) {
    return unavailable(profile.name, "credits_exhausted", {
      primaryRemainingPercent: primaryRemaining,
      secondaryRemainingPercent: secondaryRemaining
    });
  }

  return {
    profileName: profile.name,
    usable: true,
    effectiveQuotaScore:
      weightedWeeklyQuota ??
      (secondaryRemaining !== undefined ? secondaryRemaining / 100 : undefined) ??
      (primaryRemaining !== undefined ? primaryRemaining / 100 : undefined) ??
      1,
    primaryRemainingPercent: primaryRemaining,
    secondaryRemainingPercent: secondaryRemaining,
    secondaryRefreshDays,
    weightedWeeklyQuotaScore: weightedWeeklyQuota
  };
}

export function authProfileReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "profile_not_found":
      return "绑定的账号不存在";
    case "account_probe_failed":
      return "账号状态读取失败";
    case "rate_limits_probe_failed":
      return "额度状态读取失败";
    case "primary_quota_exhausted":
      return "当前额度已耗尽";
    case "secondary_quota_exhausted":
      return "周额度已耗尽";
    case "credits_exhausted":
      return "账号 credits 不可用";
    case "no_usable_auth_profiles":
      return "没有可用账号";
    default:
      return reason || "账号不可用";
  }
}

function unavailable(
  profileName: string,
  reason: AuthProfileUnavailableReason,
  partial?: {
    readonly primaryRemainingPercent?: number | undefined;
    readonly secondaryRemainingPercent?: number | undefined;
  }
): AuthProfileEvaluation {
  return {
    profileName,
    usable: false,
    reason,
    effectiveQuotaScore: 0,
    primaryRemainingPercent: partial?.primaryRemainingPercent,
    secondaryRemainingPercent: partial?.secondaryRemainingPercent
  };
}
