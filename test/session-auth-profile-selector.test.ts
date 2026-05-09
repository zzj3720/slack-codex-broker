import { describe, expect, it } from "vitest";

import {
  evaluateAuthProfile,
  selectBestAuthProfile
} from "../src/services/session-auth-profile-selector.js";
import type { AuthProfileSummary, AuthProfilesStatus } from "../src/services/auth-profile-service.js";

describe("session auth profile selector", () => {
  const now = new Date("2026-05-09T00:00:00.000Z");

  it("selects the usable profile with the highest weekly quota velocity", () => {
    const status = profileStatus([
      profile("low", {
        primaryUsed: 5,
        secondaryUsed: 90
      }),
      profile("best", {
        primaryUsed: 25,
        secondaryUsed: 20
      }),
      profile("invalid", {
        rateLimitsOk: false
      }),
      profile("exhausted", {
        primaryUsed: 100,
        secondaryUsed: 1
      })
    ]);

    expect(selectBestAuthProfile(status, { now })?.name).toBe("best");
  });

  it("still treats a lower quota bound profile as usable without auto-switching it here", () => {
    const status = profileStatus([
      profile("bound", {
        primaryUsed: 60,
        secondaryUsed: 50
      }),
      profile("bigger", {
        primaryUsed: 1,
        secondaryUsed: 2
      })
    ]);

    expect(evaluateAuthProfile(status.profiles[0]!, { now }).usable).toBe(true);
    expect(selectBestAuthProfile(status, { now })?.name).toBe("bigger");
  });

  it("prefers weekly quota that refreshes sooner when remaining quota is equal", () => {
    const oneDay = Math.floor((now.getTime() + 24 * 60 * 60 * 1000) / 1000);
    const sevenDays = Math.floor((now.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);
    const status = profileStatus([
      profile("later-refresh", {
        primaryUsed: 0,
        secondaryUsed: 50,
        secondaryResetsAt: sevenDays
      }),
      profile("sooner-refresh", {
        primaryUsed: 0,
        secondaryUsed: 50,
        secondaryResetsAt: oneDay
      })
    ]);

    const later = evaluateAuthProfile(status.profiles[0]!, { now });
    const sooner = evaluateAuthProfile(status.profiles[1]!, { now });
    expect(later.weightedWeeklyQuotaScore).toBeCloseTo(0.5);
    expect(sooner.weightedWeeklyQuotaScore).toBeCloseTo(3.5);
    expect(selectBestAuthProfile(status, { now })?.name).toBe("sooner-refresh");
  });

  it("normalizes weighted weekly quota to a full week baseline", () => {
    const halfWeek = Math.floor((now.getTime() + 3.5 * 24 * 60 * 60 * 1000) / 1000);
    const fullWeek = Math.floor((now.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);

    expect(evaluateAuthProfile(profile("full-week", {
      primaryUsed: 0,
      secondaryUsed: 0,
      secondaryResetsAt: fullWeek
    }), { now }).weightedWeeklyQuotaScore).toBeCloseTo(1);
    expect(evaluateAuthProfile(profile("half-quota-half-week", {
      primaryUsed: 0,
      secondaryUsed: 50,
      secondaryResetsAt: halfWeek
    }), { now }).weightedWeeklyQuotaScore).toBeCloseTo(1);
    expect(evaluateAuthProfile(profile("full-quota-half-week", {
      primaryUsed: 0,
      secondaryUsed: 0,
      secondaryResetsAt: halfWeek
    }), { now }).weightedWeeklyQuotaScore).toBeCloseTo(2);
  });

  it("marks a profile unavailable when either quota window is exhausted", () => {
    expect(evaluateAuthProfile(profile("primary-empty", {
      primaryUsed: 100,
      secondaryUsed: 0
    }))).toMatchObject({
      usable: false,
      reason: "primary_quota_exhausted"
    });

    expect(evaluateAuthProfile(profile("secondary-empty", {
      primaryUsed: 0,
      secondaryUsed: 100
    }))).toMatchObject({
      usable: false,
      reason: "secondary_quota_exhausted"
    });
  });
});

function profileStatus(profiles: readonly AuthProfileSummary[]): AuthProfilesStatus {
  return {
    managedRoot: "/tmp/auth-profiles",
    profilesRoot: "/tmp/auth-profiles/docker/profiles",
    activeProfile: profiles[0]?.name ?? null,
    activeAuthPath: "/tmp/codex-home/auth.json",
    profiles
  };
}

function profile(
  name: string,
  options: {
    readonly primaryUsed?: number | undefined;
    readonly secondaryUsed?: number | undefined;
    readonly secondaryResetsAt?: number | undefined;
    readonly rateLimitsOk?: boolean | undefined;
  } = {}
): AuthProfileSummary {
  const rateLimitsOk = options.rateLimitsOk ?? true;
  return {
    name,
    path: `/tmp/auth-profiles/docker/profiles/${name}.json`,
    active: false,
    source: "probe",
    checkedAt: "2026-05-09T00:00:00.000Z",
    account: {
      ok: true,
      account: {
        email: `${name}@example.com`,
        type: "chatgpt",
        planType: "pro"
      },
      requiresOpenaiAuth: false
    },
    rateLimits: rateLimitsOk
      ? {
          ok: true,
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: options.primaryUsed ?? 0,
              windowDurationMins: 300,
              resetsAt: 1_779_000_000
            },
            secondary: {
              usedPercent: options.secondaryUsed ?? 0,
              windowDurationMins: 10_080,
              resetsAt: options.secondaryResetsAt ?? 1_780_000_000
            },
            credits: null,
            planType: "pro"
          },
          rateLimitsByLimitId: {}
        }
      : {
          ok: false,
          error: "refresh_token_reused"
        }
  };
}
