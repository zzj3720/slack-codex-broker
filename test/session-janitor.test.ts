import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionJanitor } from "../src/services/session-janitor.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

const NOW_ISO = "2026-04-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const TTL_MS = 24 * 60 * 60 * 1_000;
const STALE_ISO = new Date(NOW_MS - TTL_MS - 60_000).toISOString();
const RECENT_ISO = new Date(NOW_MS - 60_000).toISOString();

describe("SessionJanitor", () => {
  it("cleans finalized inactive sessions and their persisted artifacts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-jobs-"));
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-logs-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();

    const staleSession = await sessions.ensureSession("C123", "111.222");
    const keepSession = await sessions.ensureSession("C123", "333.444");

    await fs.writeFile(path.join(staleSession.workspacePath, "notes.txt"), "cleanup me");
    const staleJobDir = path.join(jobsRoot, "job-stale");
    await fs.mkdir(staleJobDir, { recursive: true });
    await fs.writeFile(path.join(staleJobDir, "run.sh"), "#!/bin/sh\n");

    await sessions.upsertInboundMessage({
      key: `${staleSession.key}:inbound`,
      sessionKey: staleSession.key,
      channelId: staleSession.channelId,
      rootThreadTs: staleSession.rootThreadTs,
      messageTs: "111.300",
      source: "thread_reply",
      userId: "U123",
      text: "done",
      status: "done",
      createdAt: STALE_ISO,
      updatedAt: STALE_ISO
    });
    await sessions.upsertBackgroundJob({
      id: "job-stale",
      token: "token-stale",
      sessionKey: staleSession.key,
      channelId: staleSession.channelId,
      rootThreadTs: staleSession.rootThreadTs,
      kind: "watch_ci",
      shell: "/bin/sh",
      cwd: staleSession.workspacePath,
      scriptPath: path.join(staleJobDir, "run.sh"),
      restartOnBoot: false,
      status: "completed",
      createdAt: STALE_ISO,
      updatedAt: STALE_ISO,
      completedAt: STALE_ISO
    });
    await store.patchSession(staleSession.key, {
      updatedAt: STALE_ISO,
      lastSlackReplyAt: STALE_ISO,
      lastTurnSignalKind: "final",
      lastTurnSignalAt: STALE_ISO,
      lastTurnSignalTurnId: "turn-stale"
    });

    await sessions.upsertBackgroundJob({
      id: "job-running",
      token: "token-running",
      sessionKey: keepSession.key,
      channelId: keepSession.channelId,
      rootThreadTs: keepSession.rootThreadTs,
      kind: "watch_ci",
      shell: "/bin/sh",
      cwd: keepSession.workspacePath,
      scriptPath: path.join(jobsRoot, "job-running", "run.sh"),
      restartOnBoot: true,
      status: "running",
      createdAt: RECENT_ISO,
      updatedAt: RECENT_ISO,
      startedAt: RECENT_ISO
    });
    await store.patchSession(keepSession.key, {
      updatedAt: STALE_ISO,
      lastTurnSignalKind: "final",
      lastTurnSignalAt: STALE_ISO,
      lastTurnSignalTurnId: "turn-keep"
    });

    await fs.mkdir(path.join(logDir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(logDir, "jobs"), { recursive: true });
    await fs.writeFile(path.join(logDir, "sessions", encodeKey(staleSession.key) + ".jsonl"), "session-log\n");
    await fs.writeFile(path.join(logDir, "jobs", encodeKey("job-stale") + ".jsonl"), "job-log\n");

    const janitor = new SessionJanitor({
      sessions,
      sessionsRoot,
      jobsRoot,
      logDir,
      inactivityTtlMs: TTL_MS,
      cleanupIntervalMs: 60_000,
      cleanupMaxPerSweep: 10,
      now: () => NOW_MS
    });

    const result = await janitor.runSweep("test");

    expect(result.cleanedSessionKeys).toEqual([staleSession.key]);
    expect(sessions.getSession(staleSession.channelId, staleSession.rootThreadTs)).toBeUndefined();
    expect(sessions.getBackgroundJob("job-stale")).toBeUndefined();
    expect(
      sessions.listInboundMessages({
        channelId: staleSession.channelId,
        rootThreadTs: staleSession.rootThreadTs
      })
    ).toEqual([]);
    await expect(fs.access(path.dirname(staleSession.workspacePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(staleJobDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(logDir, "sessions", encodeKey(staleSession.key) + ".jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(logDir, "jobs", encodeKey("job-stale") + ".jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    expect(sessions.getSession(keepSession.channelId, keepSession.rootThreadTs)).toBeTruthy();
    expect(sessions.getBackgroundJob("job-running")).toBeTruthy();
  });

  it("does not clean sessions without a final or block signal", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-jobs-"));
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-logs-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();

    const waitSession = await sessions.ensureSession("C999", "111.222");
    await store.patchSession(waitSession.key, {
      updatedAt: STALE_ISO,
      lastTurnSignalKind: "wait",
      lastTurnSignalAt: STALE_ISO,
      lastTurnSignalTurnId: "turn-wait"
    });

    const janitor = new SessionJanitor({
      sessions,
      sessionsRoot,
      jobsRoot,
      logDir,
      inactivityTtlMs: TTL_MS,
      cleanupIntervalMs: 60_000,
      cleanupMaxPerSweep: 10,
      now: () => NOW_MS
    });

    const result = await janitor.runSweep("test");

    expect(result.cleanedCount).toBe(0);
    expect(sessions.getSession(waitSession.channelId, waitSession.rootThreadTs)).toBeTruthy();
  });
});

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
