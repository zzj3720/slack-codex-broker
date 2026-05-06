import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store.js";
import { SessionManager } from "../src/services/session-manager.js";

describe("SessionManager", () => {
  it("creates and persists a new session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "111.222");

    expect(session.workspacePath).toBe(path.join(sessionsRoot, "C123-111-222", "workspace"));

    const reloadedStore = new StateStore(stateDir, sessionsRoot);
    const reloadedManager = new SessionManager({
      stateStore: reloadedStore,
      sessionsRoot
    });
    await reloadedManager.load();

    expect(reloadedManager.getSession("C123", "111.222")?.key).toBe("C123:111.222");
  });

  it("updates codex thread and active turn metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    await manager.ensureSession("C123", "111.222");
    await manager.setCodexThreadId("C123", "111.222", "thread-1");
    const updated = await manager.setActiveTurnId("C123", "111.222", "turn-1");

    expect(updated.codexThreadId).toBe("thread-1");
    expect(updated.activeTurnId).toBe("turn-1");
    expect(updated.activeTurnStartedAt).toBeTruthy();
    expect(updated.lastProgressReminderAt).toBeUndefined();

    const cleared = await manager.setActiveTurnId("C123", "111.222", undefined);
    expect(cleared.activeTurnId).toBeUndefined();
    expect(cleared.activeTurnStartedAt).toBeUndefined();
  });

  it("persists observed and delivered cursors plus inbound queue state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    await manager.ensureSession("C123", "111.222");
    await manager.setLastObservedMessageTs("C123", "111.222", "111.225");
    await manager.setLastDeliveredMessageTs("C123", "111.222", "111.224");
    await manager.upsertInboundMessage({
      key: "C123:111.222:111.225",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.225",
      source: "thread_reply",
      userId: "U123",
      text: "latest update",
      status: "pending",
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z"
    });
    await manager.updateInboundMessagesForBatch("C123", "111.222", ["111.225"], {
      status: "inflight",
      batchId: "turn-1"
    });

    const reloadedStore = new StateStore(stateDir, sessionsRoot);
    const reloadedManager = new SessionManager({
      stateStore: reloadedStore,
      sessionsRoot
    });
    await reloadedManager.load();

    const session = reloadedManager.getSession("C123", "111.222");
    expect(session?.lastObservedMessageTs).toBe("111.225");
    expect(session?.lastDeliveredMessageTs).toBe("111.224");
    expect(reloadedManager.getLatestInboundMessageTs("C123", "111.222")).toBe("111.225");
    expect(
      reloadedManager.listInboundMessages({
        channelId: "C123",
        rootThreadTs: "111.222",
        status: "inflight",
        batchId: "turn-1"
      })
    ).toHaveLength(1);
  });

  it("persists background job metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "111.222");
    await manager.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: "watch_ci",
      shell: "/bin/bash",
      cwd: session.workspacePath,
      scriptPath: "/tmp/jobs/job-1/run.sh",
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      startedAt: "2026-03-14T00:00:01.000Z"
    });

    const reloadedStore = new StateStore(stateDir, sessionsRoot);
    const reloadedManager = new SessionManager({
      stateStore: reloadedStore,
      sessionsRoot
    });
    await reloadedManager.load();

    expect(reloadedManager.getBackgroundJob("job-1")).toMatchObject({
      kind: "watch_ci",
      status: "running",
      sessionKey: "C123:111.222"
    });
  });

  it("deletes the session-owned workspace root with the session record", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    const session = await manager.ensureSession("C123", "333.444");
    const sessionRoot = path.dirname(session.workspacePath);
    await fs.writeFile(path.join(session.workspacePath, "marker.txt"), "owned workspace");

    await expect(manager.deleteSessionByKey(session.key)).resolves.toBe(true);

    expect(manager.getSessionByKey(session.key)).toBeUndefined();
    await expect(fs.access(sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not restore a stale active turn when turn state and turn signal write concurrently", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    await manager.ensureSession("C123", "444.555");
    await manager.setActiveTurnId("C123", "444.555", "turn-1");

    await Promise.all([
      manager.recordTurnSignal("C123", "444.555", {
        turnId: "turn-1",
        kind: "final",
        occurredAt: "2026-03-18T10:00:00.000Z"
      }),
      manager.setActiveTurnId("C123", "444.555", undefined)
    ]);

    expect(manager.getSession("C123", "444.555")).toMatchObject({
      activeTurnId: undefined,
      lastTurnSignalTurnId: "turn-1",
      lastTurnSignalKind: "final",
      lastTurnSignalAt: "2026-03-18T10:00:00.000Z"
    });
  });

  it("persists co-author candidate and confirmed revision state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const manager = new SessionManager({
      stateStore: store,
      sessionsRoot
    });

    await manager.load();
    await manager.ensureSession("C123", "999.000");
    let session = await manager.addCoAuthorCandidates("C123", "999.000", ["U1"]);
    expect(session).toMatchObject({
      coAuthorCandidateUserIds: ["U1"],
      coAuthorCandidateRevision: 1
    });

    session = await manager.confirmCoAuthors("C123", "999.000", {
      userIds: ["U1"],
      candidateRevision: 1,
      ignoreMissing: true
    });
    expect(session).toMatchObject({
      coAuthorConfirmedUserIds: ["U1"],
      coAuthorConfirmedRevision: 1,
      coAuthorIgnoreMissingRevision: 1
    });

    session = await manager.addCoAuthorCandidates("C123", "999.000", ["U2"]);
    expect(session).toMatchObject({
      coAuthorCandidateUserIds: ["U1", "U2"],
      coAuthorCandidateRevision: 2,
      coAuthorConfirmedRevision: 1,
      coAuthorIgnoreMissingRevision: undefined
    });

    const reloadedStore = new StateStore(stateDir, sessionsRoot);
    const reloadedManager = new SessionManager({
      stateStore: reloadedStore,
      sessionsRoot
    });
    await reloadedManager.load();
    expect(reloadedManager.getSession("C123", "999.000")).toMatchObject({
      coAuthorCandidateUserIds: ["U1", "U2"],
      coAuthorCandidateRevision: 2,
      coAuthorConfirmedUserIds: ["U1"],
      coAuthorConfirmedRevision: 1,
      coAuthorIgnoreMissingRevision: undefined
    });
  });
});
