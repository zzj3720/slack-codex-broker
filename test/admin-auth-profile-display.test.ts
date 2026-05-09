import { describe, expect, it } from "vitest";

import {
  profileAccountLabel,
  profileDisplayLabel,
  profileOptionLabel,
  profileQuotaLabel,
  profileTitle,
  profileWeeklyQuotaLabel
} from "../src/admin-ui/auth-profile-display.js";

describe("admin auth profile display", () => {
  it("uses the account identity instead of the internal profile name", () => {
    const now = new Date("2026-05-09T00:00:00.000Z");
    const sevenDays = Math.floor((now.getTime() + 7 * 24 * 60 * 60 * 1000) / 1000);
    const profile = authProfile({
      name: "575d9997-db66-4b21-979d-4d3b9597b36e",
      email: "hejiachen@toeverything.info",
      planType: "prolite",
      primaryUsed: 4,
      secondaryUsed: 36,
      secondaryResetsAt: sevenDays
    });

    expect(profileAccountLabel(profile)).toBe("hejiachen@toeverything.info");
    expect(profileDisplayLabel(profile)).toBe("hejiachen@toeverything.info · Pro Lite");
    expect(profileQuotaLabel(profile, { now })).toBe("64% | 0.64");
    expect(profileWeeklyQuotaLabel(profile, { now })).toBe("64% | 0.64");
    expect(profileOptionLabel(profile, { now })).toBe("hejiachen@toeverything.info · Pro Lite · 64% | 0.64");
    expect(profileTitle(profile, { now })).toContain("内部标识 575d9997-db66-4b21-979d-4d3b9597b36e");
  });

  it("shows weighted weekly quota normalized by reset time", () => {
    const now = new Date("2026-05-09T00:00:00.000Z");
    const daysFromNow = (days: number) => Math.floor((now.getTime() + days * 24 * 60 * 60 * 1000) / 1000);

    expect(profileWeeklyQuotaLabel(authProfile({
      name: "full-week",
      email: "full@example.com",
      planType: "pro",
      primaryUsed: 0,
      secondaryUsed: 0,
      secondaryResetsAt: daysFromNow(7)
    }), { now })).toBe("100% | 1");

    expect(profileWeeklyQuotaLabel(authProfile({
      name: "half-half-week",
      email: "half@example.com",
      planType: "pro",
      primaryUsed: 0,
      secondaryUsed: 50,
      secondaryResetsAt: daysFromNow(3.5)
    }), { now })).toBe("50% | 1");

    expect(profileWeeklyQuotaLabel(authProfile({
      name: "full-half-week",
      email: "fast@example.com",
      planType: "pro",
      primaryUsed: 0,
      secondaryUsed: 0,
      secondaryResetsAt: daysFromNow(3.5)
    }), { now })).toBe("100% | 2");

    expect(profileWeeklyQuotaLabel(authProfile({
      name: "slow",
      email: "slow@example.com",
      planType: "pro",
      primaryUsed: 0,
      secondaryUsed: 43,
      secondaryResetsAt: daysFromNow(12)
    }), { now })).toBe("57% | 0.33");
  });

  it("keeps unusable profiles readable without presenting their UUID as the label", () => {
    const profile = {
      name: "39c7bde2-02d0-4cf2-a87e-20374ea71c74",
      account: {
        ok: false,
        error: "refresh_token_reused"
      },
      rateLimits: {
        ok: false,
        error: "refresh_token_reused"
      }
    };

    expect(profileAccountLabel(profile)).toBe("账号不可用");
    expect(profileOptionLabel(profile)).toBe("账号不可用 · 不可用");
  });
});

function authProfile(options: {
  readonly name: string;
  readonly email: string;
  readonly planType: string;
  readonly primaryUsed: number;
  readonly secondaryUsed: number;
  readonly secondaryResetsAt?: number | undefined;
}): Record<string, any> {
  return {
    name: options.name,
    account: {
      ok: true,
      account: {
        email: options.email,
        type: "chatgpt",
        planType: options.planType
      },
      requiresOpenaiAuth: false
    },
    rateLimits: {
      ok: true,
      rateLimits: {
        primary: {
          usedPercent: options.primaryUsed,
          windowDurationMins: 300,
          resetsAt: 1_779_000_000
        },
        secondary: {
          usedPercent: options.secondaryUsed,
          windowDurationMins: 10_080,
          resetsAt: options.secondaryResetsAt ?? 1_780_000_000
        }
      },
      rateLimitsByLimitId: {}
    }
  };
}
