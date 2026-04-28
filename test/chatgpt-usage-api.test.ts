import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readChatGptUsageSnapshot } from "../src/services/codex/chatgpt-usage-api.js";

describe("readChatGptUsageSnapshot", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          recursive: true,
          force: true
        })
      )
    );
  });

  it("refreshes before usage when the access token is expired", async () => {
    const authJsonPath = await writeAuthJson({
      tokens: {
        access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) - 60),
        refresh_token: "old-refresh",
        account_id: "account-1"
      }
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://auth.openai.com/oauth/token") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "old-refresh"
        });
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          id_token: "new-id"
        });
      }

      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-access");
      return jsonResponse(usagePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await readChatGptUsageSnapshot(authJsonPath);

    expect(snapshot.account.email).toBe("bot@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const written = JSON.parse(await fs.readFile(authJsonPath, "utf8")) as {
      readonly tokens: Record<string, string>;
      readonly last_refresh?: string;
    };
    expect(written.tokens).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      id_token: "new-id",
      account_id: "account-1"
    });
    expect(written.last_refresh).toEqual(expect.any(String));
  });

  it("falls back to one forced refresh on a usage 401", async () => {
    const authJsonPath = await writeAuthJson({
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        account_id: "account-1"
      }
    });
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://auth.openai.com/oauth/token") {
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh"
        });
      }

      usageCalls += 1;
      if (usageCalls === 1) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer old-access");
        return new Response("expired", { status: 401 });
      }

      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer new-access");
      return jsonResponse(usagePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    await readChatGptUsageSnapshot(authJsonPath);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const written = JSON.parse(await fs.readFile(authJsonPath, "utf8")) as {
      readonly tokens: Record<string, string>;
    };
    expect(written.tokens.refresh_token).toBe("new-refresh");
  });

  it("preserves an active auth.json symlink when writing refreshed tokens", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-auth-symlink-"));
    tempDirs.push(directory);
    const profilePath = path.join(directory, "profile.json");
    const linkPath = path.join(directory, "auth.json");
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        tokens: {
          access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) - 60),
          refresh_token: "old-refresh",
          account_id: "account-1"
        }
      }),
      "utf8"
    );
    await fs.symlink(path.basename(profilePath), linkPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = input.toString();
        if (url === "https://auth.openai.com/oauth/token") {
          return jsonResponse({
            access_token: "new-access",
            refresh_token: "new-refresh"
          });
        }

        return jsonResponse(usagePayload());
      })
    );

    await readChatGptUsageSnapshot(linkPath);

    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(await fs.readFile(profilePath, "utf8")) as {
      readonly tokens: Record<string, string>;
    };
    expect(written.tokens.access_token).toBe("new-access");
  });

  async function writeAuthJson(content: Record<string, unknown>): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-auth-"));
    tempDirs.push(directory);
    const authJsonPath = path.join(directory, "auth.json");
    await fs.writeFile(authJsonPath, JSON.stringify(content), "utf8");
    return authJsonPath;
  }
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function usagePayload() {
  return {
    email: "bot@example.com",
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18_000,
        reset_at: 1_777_777_777
      }
    },
    additional_rate_limits: []
  };
}

function jwtWithExpiration(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature"
  ].join(".");
}
