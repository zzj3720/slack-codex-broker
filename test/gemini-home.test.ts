import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncGeminiHome } from "../src/services/codex/gemini-home.js";

const tmpRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map(async (directory) => {
      await fs.rm(directory, {
        force: true,
        recursive: true
      });
    })
  );
});

describe("syncGeminiHome", () => {
  it("copies only the minimal Gemini auth snapshot into the runtime home", async () => {
    const sourceHome = await makeTempDir("gemini-home-source-");
    const runtimeHome = await makeTempDir("gemini-runtime-home-");

    await fs.writeFile(path.join(sourceHome, "settings.json"), "{\"selectedAuthType\":\"oauth-personal\"}\n");
    await fs.writeFile(path.join(sourceHome, "oauth_creds.json"), "{\"refresh_token\":\"test\"}\n");
    await fs.writeFile(path.join(sourceHome, "google_accounts.json"), "{\"email\":\"user@example.com\"}\n");
    await fs.writeFile(path.join(sourceHome, "projects.json"), "{\"last\":\"ignored\"}\n");
    await fs.mkdir(path.join(sourceHome, "history"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "history", "log.txt"), "ignored\n");

    await syncGeminiHome({
      runtimeHomePath: runtimeHome,
      hostGeminiHomePath: sourceHome
    });

    expect(await fs.readFile(path.join(runtimeHome, ".gemini", "settings.json"), "utf8")).toContain(
      "selectedAuthType"
    );
    expect(await fs.readFile(path.join(runtimeHome, ".gemini", "oauth_creds.json"), "utf8")).toContain(
      "refresh_token"
    );
    expect(await fs.readFile(path.join(runtimeHome, ".gemini", "google_accounts.json"), "utf8")).toContain(
      "user@example.com"
    );
    await expect(fs.access(path.join(runtimeHome, ".gemini", "projects.json"))).rejects.toThrow();
    await expect(fs.access(path.join(runtimeHome, ".gemini", "history"))).rejects.toThrow();
  });

  it("removes stale mirrored Gemini auth files when they disappear from the source", async () => {
    const sourceHome = await makeTempDir("gemini-home-source-");
    const runtimeHome = await makeTempDir("gemini-runtime-home-");

    await fs.writeFile(path.join(sourceHome, "settings.json"), "{\"selectedAuthType\":\"oauth-personal\"}\n");
    await fs.writeFile(path.join(sourceHome, "oauth_creds.json"), "{\"refresh_token\":\"test\"}\n");

    await syncGeminiHome({
      runtimeHomePath: runtimeHome,
      hostGeminiHomePath: sourceHome
    });

    await fs.rm(path.join(sourceHome, "oauth_creds.json"));
    await syncGeminiHome({
      runtimeHomePath: runtimeHome,
      hostGeminiHomePath: sourceHome
    });

    await expect(fs.access(path.join(runtimeHome, ".gemini", "oauth_creds.json"))).rejects.toThrow();
  });

  it("does not copy Gemini auth files onto themselves when the runtime HOME is the source HOME", async () => {
    const runtimeHome = await makeTempDir("gemini-runtime-home-");
    const geminiHome = path.join(runtimeHome, ".gemini");
    await fs.mkdir(geminiHome, { recursive: true });
    await fs.writeFile(path.join(geminiHome, "settings.json"), "{\"selectedAuthType\":\"oauth-personal\"}\n");

    await expect(syncGeminiHome({
      runtimeHomePath: runtimeHome,
      hostGeminiHomePath: geminiHome
    })).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(geminiHome, "settings.json"), "utf8")).resolves.toContain(
      "selectedAuthType"
    );
  });
});
