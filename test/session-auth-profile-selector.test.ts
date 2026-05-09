import { describe, expect, it } from "vitest";

import {
  evaluateAuthProfile,
  selectBestAuthProfile
} from "../src/services/session-auth-profile-selector.js";
import type { AuthProfileSummary, AuthProfilesStatus } from "../src/services/auth-profile-service.js";

describe("session auth profile selector", () => {
  it("selects the usable profile with the highest conservative remaining quota", () => {
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

    expect(selectBestAuthProfile(status)?.name).toBe("best");
  });

  it("keeps a usable bound profile even when another profile has more quota", () => {
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

    expect(evaluateAuthProfile(status.profiles[0]!).usable).toBe(true);
    expect(selectBestAuthProfile(status)?.name).toBe("bigger");
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
              resetsAt: 1_780_000_000
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
