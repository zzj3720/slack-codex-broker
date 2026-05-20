import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getPersonalMemoryPath,
  syncUserCodexHome
} from "../src/services/codex/codex-home.js";

const tmpRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map(async (directory) => {
      await fs.rm(directory, { force: true, recursive: true });
    })
  );
});

describe("team Codex home", () => {
  it("links profile shared entries to the configured team home while leaving auth state profile-local", async () => {
    const root = await makeTempDir("team-codex-home-e2e-");
    const sourceHome = path.join(root, "host-codex-home");
    const profileHome = path.join(root, "profile", "codex-home");
    const runtimeHome = path.join(root, "profile", "runtime-home");
    const teamHome = path.join(root, "team-codex-home");

    await fs.mkdir(path.join(sourceHome, "skills"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "AGENT.md"), "host memory should not migrate\n");
    await fs.writeFile(path.join(sourceHome, "skills", "SKILL.md"), "host skill should not migrate\n");

    await fs.mkdir(path.join(teamHome, "skills", "shared"), { recursive: true });
    await fs.writeFile(path.join(teamHome, "AGENT.md"), "team memory\n");
    await fs.writeFile(path.join(teamHome, "AGENTS.md"), "team agents\n");
    await fs.writeFile(path.join(teamHome, "config.toml"), "model = \"gpt-5.5\"\n");
    await fs.writeFile(path.join(teamHome, "skills", "shared", "SKILL.md"), "team skill\n");

    await fs.mkdir(profileHome, { recursive: true });
    await fs.writeFile(path.join(profileHome, "AGENT.md"), "stale profile memory\n");
    await fs.writeFile(path.join(profileHome, "auth.json"), "{\"profile\":\"one\"}\n");

    await syncUserCodexHome({
      codexHome: profileHome,
      hostCodexHomePath: sourceHome,
      runtimeHomePath: runtimeHome,
      teamCodexHomePath: teamHome
    });

    expect(await fs.readFile(path.join(profileHome, "AGENT.md"), "utf8")).toBe("team memory\n");
    expect(await fs.readFile(path.join(profileHome, "AGENTS.md"), "utf8")).toBe("team agents\n");
    expect(await fs.readFile(path.join(profileHome, "config.toml"), "utf8")).toBe("model = \"gpt-5.5\"\n");
    expect(await fs.readFile(path.join(profileHome, "skills", "shared", "SKILL.md"), "utf8")).toBe("team skill\n");
    expect(await fs.readFile(path.join(teamHome, "AGENT.md"), "utf8")).toBe("team memory\n");
    expect(await fs.readFile(path.join(profileHome, "auth.json"), "utf8")).toBe("{\"profile\":\"one\"}\n");

    expect((await fs.lstat(path.join(profileHome, "AGENT.md"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(profileHome, "config.toml"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(profileHome, "skills"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(profileHome, "auth.json"))).isSymbolicLink()).toBe(false);

    const runtimeAgentPath = path.join(runtimeHome, ".codex", "AGENT.md");
    expect((await fs.lstat(runtimeAgentPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(runtimeAgentPath), await fs.readlink(runtimeAgentPath))).toBe(
      path.join(teamHome, "AGENT.md")
    );
  });

  it("initializes an empty team home without importing existing host/profile memory", async () => {
    const root = await makeTempDir("team-codex-home-empty-");
    const sourceHome = path.join(root, "empty-host-codex-home");
    const profileHome = path.join(root, "profile", "codex-home");
    const teamHome = path.join(root, "team-codex-home");

    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(profileHome, { recursive: true });

    await syncUserCodexHome({
      codexHome: profileHome,
      hostCodexHomePath: sourceHome,
      teamCodexHomePath: teamHome
    });

    expect(await fs.readFile(path.join(teamHome, "AGENT.md"), "utf8")).toBe("");
    expect(await fs.readFile(path.join(profileHome, "AGENT.md"), "utf8")).toBe("");
    expect((await fs.lstat(path.join(profileHome, "AGENT.md"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(teamHome, "skills"))).isDirectory()).toBe(true);
  });

  it("does not cut over to an empty team home when existing shared content needs one-off seeding", async () => {
    const root = await makeTempDir("team-codex-home-unseeded-");
    const sourceHome = path.join(root, "host-codex-home");
    const profileHome = path.join(root, "profile", "codex-home");
    const runtimeHome = path.join(root, "profile", "runtime-home");
    const teamHome = path.join(root, "team-codex-home");

    await fs.mkdir(sourceHome, { recursive: true });
    await fs.writeFile(path.join(sourceHome, "AGENT.md"), "host memory should be preserved\n");
    await fs.writeFile(path.join(sourceHome, "config.toml"), "model = \"gpt-5\"\n");

    await syncUserCodexHome({
      codexHome: profileHome,
      hostCodexHomePath: sourceHome,
      runtimeHomePath: runtimeHome,
      teamCodexHomePath: teamHome
    });

    expect(await fs.readFile(path.join(profileHome, "AGENT.md"), "utf8")).toBe("host memory should be preserved\n");
    expect(await fs.readFile(path.join(profileHome, "config.toml"), "utf8")).toBe("model = \"gpt-5\"\n");
    expect((await fs.lstat(path.join(profileHome, "AGENT.md"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(profileHome, "config.toml"))).isSymbolicLink()).toBe(false);

    const runtimeAgentPath = path.join(runtimeHome, ".codex", "AGENT.md");
    expect(path.resolve(path.dirname(runtimeAgentPath), await fs.readlink(runtimeAgentPath))).toBe(
      path.join(profileHome, "AGENT.md")
    );
    await expect(fs.access(path.join(teamHome, "AGENT.md"))).rejects.toThrow();
  });

  it("uses the team home as the personal-memory source when one is configured", async () => {
    const codexHome = await makeTempDir("profile-codex-home-");
    const teamHome = await makeTempDir("team-codex-home-");

    expect(getPersonalMemoryPath(codexHome)).toBe(path.join(codexHome, "AGENT.md"));
    expect(getPersonalMemoryPath(codexHome, { teamCodexHomePath: teamHome })).toBe(
      path.join(teamHome, "AGENT.md")
    );
  });
});
