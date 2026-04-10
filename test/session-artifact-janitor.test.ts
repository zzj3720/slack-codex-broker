import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionArtifactJanitor } from "../src/services/session-artifact-janitor.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("SessionArtifactJanitor", () => {
  it("removes macOS build artifacts for inactive sessions", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "111.222");
    const buildRoot = path.join(session.workspacePath, "cueboard", "frontend", "macos", ".build", "DerivedData");
    const profrawPath = path.join(session.workspacePath, "cueboard", "frontend", "macos", "default.profraw");
    const xcodebuildLogPath = path.join(session.workspacePath, "cueboard", "frontend", "macos", "xcodebuild.log");
    await fs.mkdir(buildRoot, { recursive: true });
    await fs.writeFile(path.join(buildRoot, "build.db"), "artifact\n", "utf8");
    await fs.writeFile(profrawPath, "profile\n", "utf8");
    await fs.writeFile(xcodebuildLogPath, "log\n", "utf8");

    const now = Date.parse("2026-04-08T10:00:00.000Z");
    await store.patchSession(session.key, {
      updatedAt: "2026-04-08T01:00:00.000Z",
      lastSlackReplyAt: "2026-04-08T01:30:00.000Z"
    });

    const janitor = new SessionArtifactJanitor({
      sessions: manager,
      inactivityTtlMs: 60 * 60 * 1_000,
      cleanupIntervalMs: 0,
      cleanupMaxPerSweep: 10,
      now: () => now
    });

    const result = await janitor.runSweep("test");

    expect(result.cleanedCount).toBe(1);
    await expect(fs.stat(path.join(session.workspacePath, "cueboard"))).resolves.toBeTruthy();
    await expect(fs.access(path.join(session.workspacePath, "cueboard", "frontend", "macos", ".build"))).rejects.toBeTruthy();
    await expect(fs.access(profrawPath)).rejects.toBeTruthy();
    await expect(fs.access(xcodebuildLogPath)).rejects.toBeTruthy();
  });

  it("keeps artifacts for sessions that are still active", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "111.222");
    const buildRoot = path.join(session.workspacePath, "cueboard", "frontend", "macos", ".build");
    await fs.mkdir(buildRoot, { recursive: true });
    await fs.writeFile(path.join(buildRoot, "build.db"), "artifact\n", "utf8");
    await store.patchSession(session.key, {
      updatedAt: "2026-04-08T01:00:00.000Z",
      activeTurnId: "turn-1",
      activeTurnStartedAt: "2026-04-08T09:30:00.000Z"
    });

    const janitor = new SessionArtifactJanitor({
      sessions: manager,
      inactivityTtlMs: 60 * 60 * 1_000,
      cleanupIntervalMs: 0,
      cleanupMaxPerSweep: 10,
      now: () => Date.parse("2026-04-08T10:00:00.000Z")
    });

    const result = await janitor.runSweep("test");

    expect(result.cleanedCount).toBe(0);
    await expect(fs.stat(buildRoot)).resolves.toBeTruthy();
  });

  it("keeps artifacts while a background job is still running", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "111.222");
    const buildRoot = path.join(session.workspacePath, "cueboard", "frontend", "macos", ".build");
    await fs.mkdir(buildRoot, { recursive: true });
    await fs.writeFile(path.join(buildRoot, "build.db"), "artifact\n", "utf8");
    await store.patchSession(session.key, {
      updatedAt: "2026-04-08T01:00:00.000Z"
    });
    await manager.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: "watch_ci",
      shell: "/bin/bash",
      cwd: session.workspacePath,
      scriptPath: path.join(session.workspacePath, "job.sh"),
      restartOnBoot: false,
      status: "running",
      createdAt: "2026-04-08T09:00:00.000Z",
      updatedAt: "2026-04-08T09:30:00.000Z",
      startedAt: "2026-04-08T09:00:00.000Z"
    });

    const janitor = new SessionArtifactJanitor({
      sessions: manager,
      inactivityTtlMs: 60 * 60 * 1_000,
      cleanupIntervalMs: 0,
      cleanupMaxPerSweep: 10,
      now: () => Date.parse("2026-04-08T10:00:00.000Z")
    });

    const result = await janitor.runSweep("test");

    expect(result.cleanedCount).toBe(0);
    await expect(fs.stat(buildRoot)).resolves.toBeTruthy();
  });
});
