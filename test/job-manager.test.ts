import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/services/session-manager.js";
import { JobManager } from "../src/services/job-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("JobManager", () => {
  it("registers a broker-managed script job and forwards emitted events", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-jobs-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-repos-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();
    const session = await sessions.ensureSession("C123", "111.222");
    await fs.mkdir(session.workspacePath, { recursive: true });

    const seenEvents: Array<{ payload: { summary: string; jobId: string; eventKind: string } }> = [];
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      onEvent: async (event) => {
        seenEvents.push({
          payload: {
            summary: event.payload.summary,
            jobId: event.payload.jobId,
            eventKind: event.payload.eventKind
          }
        });
      }
    });

    const job = await jobs.registerJob({
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "watch_ci",
      script: "#!/usr/bin/env bash\nsleep 30"
    });

    expect(job.status).toBe("running");
    expect(job.scriptPath).toContain(job.id);

    await jobs.emitJobEvent(job.id, job.token, {
      eventKind: "state_changed",
      summary: "CI turned green."
    });

    expect(seenEvents).toEqual([
      {
        payload: {
          summary: "CI turned green.",
          jobId: job.id,
          eventKind: "state_changed"
        }
      }
    ]);

    await jobs.cancelJob(job.id, job.token);
    await jobs.stop();
  });

  it("does not cancel restartable jobs during broker shutdown", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-jobs-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-repos-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "222.333");

    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      onEvent: async () => {}
    });

    const job = await jobs.registerJob({
      channelId: "C123",
      rootThreadTs: "222.333",
      kind: "watch_ci",
      script: "#!/usr/bin/env bash\nsleep 30"
    });

    expect(job.status).toBe("running");
    await jobs.stop();

    expect(sessions.getBackgroundJob(job.id)).toMatchObject({
      id: job.id,
      status: "running",
      restartOnBoot: true
    });
  });

  it("suppresses stale job events after the session already recorded final", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const jobsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-jobs-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const reposRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-repos-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();
    const session = await sessions.ensureSession("C123", "333.444");
    await fs.mkdir(session.workspacePath, { recursive: true });

    const seenEvents: Array<{ payload: { summary: string; jobId: string; eventKind: string } }> = [];
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      onEvent: async (event) => {
        seenEvents.push({
          payload: {
            summary: event.payload.summary,
            jobId: event.payload.jobId,
            eventKind: event.payload.eventKind
          }
        });
      }
    });

    const job = await jobs.registerJob({
      channelId: "C123",
      rootThreadTs: "333.444",
      kind: "watch_ci",
      script: "#!/usr/bin/env bash\nsleep 30"
    });

    await sessions.recordTurnSignal("C123", "333.444", {
      turnId: "turn-final",
      kind: "final",
      occurredAt: new Date(Date.now() + 1_000).toISOString()
    });

    await jobs.emitJobEvent(job.id, job.token, {
      eventKind: "state_changed",
      summary: "already merged"
    });

    expect(seenEvents).toEqual([]);
    expect(sessions.getBackgroundJob(job.id)).toMatchObject({
      id: job.id,
      status: "cancelled",
      lastEventKind: "state_changed",
      lastEventSummary: "already merged"
    });

    await jobs.stop();
  });
});
