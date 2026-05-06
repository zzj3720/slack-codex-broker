import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { AuthPoolService } from "../src/services/auth-pool-service.js";

describe("AuthPoolService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          recursive: true,
          force: true
        })
      )
    );
  });

  it("leases a sticky profile for a session", async () => {
    const { config, profilesRoot } = await createPoolFixture();
    await writeProfile(profilesRoot, "alpha", {
      account_id: "account-alpha",
      access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) + 3600),
      refresh_token: "refresh-alpha"
    });
    await writeProfile(profilesRoot, "bravo", {
      account_id: "account-bravo",
      access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) + 3600),
      refresh_token: "refresh-bravo"
    });
    const pool = new AuthPoolService({
      config
    });

    const first = await pool.leaseForSession("session-1");
    const second = await pool.leaseForSession("session-1");
    first?.release();
    second?.release();

    expect(first?.tokens.profileName).toBeTruthy();
    expect(second?.tokens.profileName).toBe(first?.tokens.profileName);
  });

  it("refreshes a shared profile once and atomically writes rotated tokens", async () => {
    const { config, profilesRoot } = await createPoolFixture();
    await writeProfile(profilesRoot, "alpha", {
      account_id: "account-alpha",
      access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) - 60),
      refresh_token: "old-refresh"
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: jwtWithPlan("pro")
      }), {
        headers: {
          "Content-Type": "application/json"
        }
      })
    );
    const pool = new AuthPoolService({
      config,
      fetch: fetchMock as typeof fetch
    });

    const [left, right] = await Promise.all([
      pool.refreshForPreviousAccount("account-alpha"),
      pool.refreshForPreviousAccount("account-alpha")
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(left.accessToken).toBe("new-access");
    expect(right.accessToken).toBe("new-access");
    expect(left.chatgptPlanType).toBe("pro");
    const written = JSON.parse(await fs.readFile(path.join(profilesRoot, "alpha.json"), "utf8")) as {
      readonly tokens: Record<string, string>;
      readonly last_refresh?: string;
    };
    expect(written.tokens.refresh_token).toBe("new-refresh");
    expect(written.last_refresh).toEqual(expect.any(String));
  });

  async function createPoolFixture() {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auth-pool-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      AUTH_POOL_LB: "on"
    } as NodeJS.ProcessEnv);
    const profilesRoot = path.join(dataRoot, "auth-profiles", "docker", "profiles");
    await fs.mkdir(profilesRoot, {
      recursive: true
    });
    return {
      config,
      profilesRoot
    };
  }
});

async function writeProfile(
  profilesRoot: string,
  name: string,
  tokens: {
    readonly account_id: string;
    readonly access_token: string;
    readonly refresh_token: string;
  }
): Promise<void> {
  await fs.writeFile(
    path.join(profilesRoot, `${name}.json`),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens
    }),
    "utf8"
  );
}

function jwtWithExpiration(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature"
  ].join(".");
}

function jwtWithPlan(plan: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: plan
      }
    })).toString("base64url"),
    "signature"
  ].join(".");
}
