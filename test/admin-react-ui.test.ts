import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url);
const adminUiRoot = new URL("../src/admin-ui/", import.meta.url);

describe("admin React UI architecture", () => {
  it("documents the full React ownership target and acceptance criteria", async () => {
    const doc = await fs.readFile(new URL("../docs/admin-react-ui.md", import.meta.url), "utf8");
    expect(doc).toContain("Make the admin frontend a single React application.");
    expect(doc).toContain("No business UI may use `getElementById`, `querySelector`, or `innerHTML`");
    expect(doc).toContain("GitHub account work continues in React");
    expect(doc).toContain("`pnpm test` and `pnpm build` pass");
  });

  it("does not ship or import the legacy imperative admin client", async () => {
    await expect(fs.access(new URL("../src/admin-ui/admin-legacy.js", import.meta.url))).rejects.toThrow();

    const main = await fs.readFile(new URL("../src/admin-ui/main.tsx", import.meta.url), "utf8");
    expect(main).not.toContain("admin-legacy");
    expect(main).not.toContain("initAdminPage");
    expect(main).not.toContain("dangerouslySetInnerHTML");
    expect(main).not.toContain("renderAdminShellHtml");
    expect(main).not.toContain("session-react-root");
  });

  it("renders the shell as React components instead of an injected HTML string", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("export function AdminShell");
    expect(shell).not.toContain("renderAdminShellHtml");
    expect(shell).not.toContain("return `");
    expect(shell).not.toContain("dangerouslySetInnerHTML");
  });

  it("bootstraps from lightweight control-plane APIs instead of the monolithic status endpoint", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("const nextStatus = await loadAdminSessionsStatus()");
    expect(shell).toContain("void loadAdminOverview()");
    expect(shell.indexOf("const nextStatus = await loadAdminSessionsStatus()")).toBeLessThan(
      shell.indexOf("void loadAdminOverview()")
    );
    expect(shell).toContain('requestJson("/admin/api/sessions", { timeoutMs: 15_000 })');
    expect(shell).toContain('requestJson("/admin/api/overview", { timeoutMs: 8_000 })');
    expect(shell).toContain('requestJson("/admin/api/logs?limit=40", { timeoutMs: 5_000 })');
    expect(shell).not.toContain('requestJson("/admin/api/status")');
  });

  it("opens realtime only after the initial session cursor is published", async () => {
    const shell = await readAdminShellSource();
    expect(shell).toContain("let disconnectRealtime");
    expect(shell).not.toContain("const disconnect = connectAdminRealtime()");
    expect(shell.indexOf("publishAdminStatus(nextStatus)")).toBeLessThan(shell.indexOf("connectAdminRealtime()"));
  });

  it("binds GitHub OAuth from existing Slack account rows instead of adding Slack ids", async () => {
    const shell = await readAdminShellSource();
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    expect(shell).toContain("startGitHubAccountDeviceAuthorization");
    expect(shell).toContain("githubAccountDeviceStartApiPath");
    expect(sessionView).toContain("GitHubBindPage");
    expect(sessionView).toContain("readGitHubBindSessionKey");
    expect(sessionView).toContain("github-bind-page");
    expect(sessionView.indexOf("readGitHubBindSessionKey")).toBeLessThan(sessionView.indexOf("readPermalinkSessionKey"));
    expect(shell).toContain("绑定 GitHub");
    expect(shell).toContain("重新绑定 GitHub");
    expect(shell).toContain("默认 PR 账号");
    expect(shell).toContain("选择默认 PR GitHub 账号");
    expect(shell).toContain("设为默认 PR");
    expect(shell).toContain("buildFallbackGitHubAccounts");
    expect(shell).toContain("firstUserMessage");
    expect(shell).toContain("lastUserMessage");
    expect(shell).toContain("normalizeSlackIdentity");
    expect(shell).not.toContain("GitHub 未绑定");
    expect(shell).not.toContain('onEdit("", "")');
    expect(shell).not.toContain("Slack 用户 ID（U123...）");
    expect(shell).not.toContain("GitHubAuthorDialog");
    expect(shell).not.toContain("编辑作者");
    expect(shell).not.toContain("Commit 作者：姓名 <email@example.com>");
    expect(shell).not.toContain("历史 Commit 作者");
  });

  it("keeps session auth profile action detailed without expanding dense quota labels", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    const authProfileDisplay = await fs.readFile(new URL("auth-profile-display.ts", adminUiRoot), "utf8");
    expect(authProfileDisplay).toContain("export function profileSessionActionLabel");
    expect(sessionView).toContain("profileSessionActionLabel(currentProfile)");
    expect(sessionView).toContain('className={"auth-profile-detail-button " + (blocked ? "danger" : "")}');
  });

  it("opens Slack threads through a backend permalink resolver", async () => {
    const sessionView = await fs.readFile(new URL("session-view.tsx", adminUiRoot), "utf8");
    expect(sessionView).toContain("openSlackThread");
    expect(sessionView).toContain("slackThreadUrlApiPath");
    expect(sessionView).toContain("window.open");
    expect(sessionView).toContain("Slack Thread 跳转失败");
    expect(sessionView).not.toContain('href={session.threadUrl}');
  });

  it("prefers backend GitHub account identities over session fallback rows", async () => {
    const shell = await readAdminShellSource();
    expect(shell.indexOf("const accounts = status.githubAccounts?.accounts")).toBeLessThan(
      shell.indexOf("const fallback = buildFallbackGitHubAccounts(status)")
    );
  });

  it("keeps business UI free of imperative DOM rendering and event binding", async () => {
    const files = await listAdminUiSourceFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const relativePath = path.relative(repoRoot.pathname, file);
      if (relativePath.endsWith("src/admin-ui/main.tsx")) {
        continue;
      }
      const source = await fs.readFile(file, "utf8");
      for (const forbidden of ["getElementById", "querySelector", "innerHTML"]) {
        if (source.includes(forbidden)) {
          offenders.push(`${relativePath}:${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function readAdminShellSource(): Promise<string> {
  for (const candidate of ["admin-shell.tsx", "admin-shell.ts"]) {
    try {
      return await fs.readFile(new URL(candidate, adminUiRoot), "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  throw new Error("admin-shell source is missing");
}

async function listAdminUiSourceFiles(): Promise<string[]> {
  const entries = await fs.readdir(adminUiRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name))
    .map((entry) => path.join(adminUiRoot.pathname, entry.name))
    .sort();
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
