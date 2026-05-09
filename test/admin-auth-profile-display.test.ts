import { describe, expect, it } from "vitest";

import {
  profileAccountLabel,
  profileDisplayLabel,
  profileOptionLabel,
  profileQuotaLabel,
  profileTitle
} from "../src/admin-ui/auth-profile-display.js";

describe("admin auth profile display", () => {
  it("uses the account identity instead of the internal profile name", () => {
    const profile = authProfile({
      name: "575d9997-db66-4b21-979d-4d3b9597b36e",
      email: "hejiachen@toeverything.info",
      planType: "prolite",
      primaryUsed: 4,
      secondaryUsed: 36
    });

    expect(profileAccountLabel(profile)).toBe("hejiachen@toeverything.info");
    expect(profileDisplayLabel(profile)).toBe("hejiachen@toeverything.info · Pro Lite");
    expect(profileQuotaLabel(profile)).toBe("短窗 96% / 周 64%");
    expect(profileOptionLabel(profile)).toBe("hejiachen@toeverything.info · Pro Lite · 短窗 96% / 周 64%");
    expect(profileTitle(profile)).toContain("内部标识 575d9997-db66-4b21-979d-4d3b9597b36e");
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
          resetsAt: 1_780_000_000
        }
      },
      rateLimitsByLimitId: {}
    }
  };
}
