import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncUserCodexHome } from "../src/services/codex/codex-home.js";

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

describe("syncUserCodexHome", () => {
  it("keeps AGENT.md and AGENTS.md detached while linking memory.md back to the host codex home", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const targetHome = await makeTempDir("codex-home-target-");
    const runtimeHome = await makeTempDir("codex-runtime-home-");

    await fs.writeFile(path.join(sourceHome, "AGENT.md"), "personal memory\n");
    await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "global agent memory\n");
    await fs.writeFile(path.join(sourceHome, "memory.md"), "persistent notes\n");
    await fs.writeFile(path.join(sourceHome, "config.toml"), "model = \"gpt-5\"\n");
    await fs.mkdir(path.join(sourceHome, "skills"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "skills", "README.md"), "skill docs\n");

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome,
      runtimeHomePath: runtimeHome
    });

    expect(await fs.readFile(path.join(targetHome, "AGENT.md"), "utf8")).toBe("personal memory\n");
    expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe("global agent memory\n");
    expect(await fs.readFile(path.join(targetHome, "memory.md"), "utf8")).toBe("persistent notes\n");
    expect(await fs.readFile(path.join(targetHome, "skills", "README.md"), "utf8")).toBe("skill docs\n");
    expect(await fs.readFile(path.join(runtimeHome, ".codex", "AGENT.md"), "utf8")).toBe("personal memory\n");

    const agentStat = await fs.lstat(path.join(targetHome, "AGENT.md"));
    const agentsStat = await fs.lstat(path.join(targetHome, "AGENTS.md"));
    const memoryStat = await fs.lstat(path.join(targetHome, "memory.md"));
    const configStat = await fs.lstat(path.join(targetHome, "config.toml"));
    const skillsStat = await fs.lstat(path.join(targetHome, "skills"));
    const runtimeAgentStat = await fs.lstat(path.join(runtimeHome, ".codex", "AGENT.md"));

    expect(agentStat.isSymbolicLink()).toBe(false);
    expect(agentsStat.isSymbolicLink()).toBe(false);
    expect(memoryStat.isSymbolicLink()).toBe(true);
    expect(configStat.isFile()).toBe(true);
    expect(skillsStat.isDirectory()).toBe(true);
    expect(runtimeAgentStat.isSymbolicLink()).toBe(true);
  });

  it("creates detached AGENT.md and AGENTS.md locally and links memory.md into CODEX_HOME", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const targetHome = await makeTempDir("codex-home-target-");
    const runtimeHome = await makeTempDir("codex-runtime-home-");

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome,
      runtimeHomePath: runtimeHome
    });

    await expect(fs.access(path.join(sourceHome, "AGENT.md"))).rejects.toThrow();
    await expect(fs.access(path.join(sourceHome, "AGENTS.md"))).rejects.toThrow();
    expect(await fs.readFile(path.join(targetHome, "AGENT.md"), "utf8")).toBe("");
    expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe("");
    expect(await fs.readFile(path.join(sourceHome, "memory.md"), "utf8")).toBe("");
    expect(await fs.readFile(path.join(runtimeHome, ".codex", "AGENT.md"), "utf8")).toBe("");

    const agentStat = await fs.lstat(path.join(targetHome, "AGENT.md"));
    const agentsStat = await fs.lstat(path.join(targetHome, "AGENTS.md"));
    const memoryStat = await fs.lstat(path.join(targetHome, "memory.md"));
    const runtimeAgentStat = await fs.lstat(path.join(runtimeHome, ".codex", "AGENT.md"));

    expect(agentStat.isSymbolicLink()).toBe(false);
    expect(agentsStat.isSymbolicLink()).toBe(false);
    expect(memoryStat.isSymbolicLink()).toBe(true);
    expect(runtimeAgentStat.isSymbolicLink()).toBe(true);
  });

  it("breaks an existing AGENTS.md symlink into a local copy without overwriting container edits", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const targetHome = await makeTempDir("codex-home-target-");

    await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "host agents\n");
    await fs.symlink(path.join(sourceHome, "AGENTS.md"), path.join(targetHome, "AGENTS.md"), "file");

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome
    });

    expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe("host agents\n");
    expect((await fs.lstat(path.join(targetHome, "AGENTS.md"))).isSymbolicLink()).toBe(false);

    await fs.writeFile(path.join(targetHome, "AGENTS.md"), "broker-only agents\n");
    await fs.writeFile(path.join(sourceHome, "AGENTS.md"), "host changed\n");

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome
    });

    expect(await fs.readFile(path.join(targetHome, "AGENTS.md"), "utf8")).toBe("broker-only agents\n");
  });

  it("removes stale mirrored entries when the host codex home no longer has them", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const targetHome = await makeTempDir("codex-home-target-");

    await fs.writeFile(path.join(sourceHome, "config.toml"), "before = true\n");
    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome
    });

    await fs.rm(path.join(sourceHome, "config.toml"));
    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome
    });

    await expect(fs.access(path.join(targetHome, "config.toml"))).rejects.toThrow();
  });

  it("dereferences skill symlinks when copying directories", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const externalSkillRoot = await makeTempDir("codex-skill-source-");
    const targetHome = await makeTempDir("codex-home-target-");

    await fs.mkdir(path.join(sourceHome, "skills"), { recursive: true });
    await fs.mkdir(path.join(externalSkillRoot, "linked-skill"), { recursive: true });
    await fs.writeFile(path.join(externalSkillRoot, "linked-skill", "SKILL.md"), "linked skill\n");
    await fs.symlink(
      path.join(externalSkillRoot, "linked-skill"),
      path.join(sourceHome, "skills", "linked-skill"),
      "dir"
    );

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome
    });

    expect(await fs.readFile(path.join(targetHome, "skills", "linked-skill", "SKILL.md"), "utf8")).toBe("linked skill\n");
  });

  it("migrates legacy runtime AGENT.md into the detached broker memory file", async () => {
    const sourceHome = await makeTempDir("codex-home-source-");
    const targetHome = await makeTempDir("codex-home-target-");
    const runtimeHome = await makeTempDir("codex-runtime-home-");
    const legacyHome = await makeTempDir("codex-legacy-home-");

    await fs.mkdir(path.join(legacyHome, ".codex"), { recursive: true });
    await fs.writeFile(path.join(legacyHome, ".codex", "AGENT.md"), "legacy personal memory\n");

    await syncUserCodexHome({
      codexHome: targetHome,
      hostCodexHomePath: sourceHome,
      runtimeHomePath: runtimeHome,
      legacyPersonalMemoryPath: path.join(legacyHome, ".codex", "AGENT.md")
    });

    expect(await fs.readFile(path.join(targetHome, "AGENT.md"), "utf8")).toBe("legacy personal memory\n");
    expect(await fs.readFile(path.join(runtimeHome, ".codex", "AGENT.md"), "utf8")).toBe("legacy personal memory\n");
  });
});
