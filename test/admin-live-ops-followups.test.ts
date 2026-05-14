import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("admin live operations followups", () => {
  it("documents the live-preview, recovery, loading, and cleanup acceptance criteria", async () => {
    const doc = await fs.readFile(new URL("../docs/admin-live-ops-followups.md", import.meta.url), "utf8");

    expect(doc).toContain("Local admin UI preview against the live admin API must be one command.");
    expect(doc).toContain("Slack missed-message recovery must be a bounded safety net");
    expect(doc).toContain("fetch `/admin/api/sessions`");
    expect(doc).toContain("old Git-worktree deployment shape");
    expect(doc).toContain("The remote preview script contains no port-killing logic.");
  });

  it("provides a one-command local admin preview wired to the live API tunnel", async () => {
    const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = await fs.readFile(new URL("../scripts/dev/admin-remote.mjs", import.meta.url), "utf8");
    const viteConfig = await fs.readFile(new URL("../vite.config.ts", import.meta.url), "utf8");

    expect(packageJson.scripts?.["dev:admin:remote"]).toBe("node scripts/dev/admin-remote.mjs");
    expect(script).toContain("ADMIN_API_PROXY_ORIGIN");
    expect(script).toContain("ExitOnForwardFailure=yes");
    expect(script).toContain("waitForReady");
    expect(script).toContain("/readyz");
    expect(script).not.toContain("lsof");
    expect(script).not.toContain("kill -");
    expect(script).not.toContain("xargs");
    expect(viteConfig).toContain("request.resume()");
  });
});
