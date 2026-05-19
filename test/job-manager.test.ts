import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/services/session-manager.js";
import { JobManager } from "../src/services/job-manager.js";
import { StateStore } from "../src/store/state-store.js";
import type { PersistedBackgroundJob } from "../src/types.js";
import { resolveRuntimeToolPath } from "../src/utils/runtime-paths.js";

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

  it("automatically cancels jobs that exceed the runtime limit", async () => {
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
    const session = await sessions.ensureSession("C123", "111.333");
    await fs.mkdir(session.workspacePath, { recursive: true });
    const childPidPath = path.join(session.workspacePath, "child.pid");

    const seenEvents: Array<{ payload: { summary: string; jobId: string; eventKind: string } }> = [];
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      maxRuntimeMs: 100,
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
      rootThreadTs: "111.333",
      kind: "watch_ci",
      script: `#!/usr/bin/env bash\nsleep 30 &\necho $! > ${shellQuote(childPidPath)}\nwait`
    });

    const childPid = Number(await waitForFileContents(childPidPath));
    const timedOut = await waitForJobStatus(sessions, job.id, "cancelled");
    expect(timedOut.cancelledAt).toEqual(expect.any(String));
    expect(timedOut.completedAt).toEqual(expect.any(String));
    expect(timedOut.error).toContain("runtime limit");
    await waitForProcessExit(childPid);
    expect(seenEvents).toEqual([
      {
        payload: {
          summary: expect.stringContaining("runtime limit"),
          jobId: job.id,
          eventKind: "job_cancelled"
        }
      }
    ]);

    await jobs.stop();
  });

  it("cancels restartable jobs that are already past the runtime limit on startup", async () => {
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
    const session = await sessions.ensureSession("C123", "111.444");
    await fs.mkdir(session.workspacePath, { recursive: true });
    const jobDir = path.join(jobsRoot, "expired-job");
    const scriptPath = path.join(jobDir, "run.sh");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });

    await sessions.upsertBackgroundJob({
      id: "expired-job",
      token: "job-token",
      sessionKey: session.key,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: "watch_ci",
      shell: "bash",
      cwd: session.workspacePath,
      scriptPath,
      restartOnBoot: true,
      status: "running",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date(Date.now() - 1_000).toISOString()
    });

    const seenEvents: string[] = [];
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      maxRuntimeMs: 100,
      onEvent: async (event) => {
        seenEvents.push(event.payload.eventKind);
      }
    });

    await jobs.start();

    expect(sessions.getBackgroundJob("expired-job")).toMatchObject({
      id: "expired-job",
      status: "cancelled",
      cancelledAt: expect.any(String),
      completedAt: expect.any(String),
      error: expect.stringContaining("runtime limit")
    });
    expect(seenEvents).toEqual(["job_cancelled"]);

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

  it("lets admin cancel a session-owned job without exposing the job token", async () => {
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
    const session = await sessions.ensureSession("C123", "444.555");
    await fs.mkdir(session.workspacePath, { recursive: true });

    const seenEvents: string[] = [];
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      onEvent: async (event) => {
        seenEvents.push(event.payload.eventKind);
      }
    });

    const job = await jobs.registerJob({
      channelId: "C123",
      rootThreadTs: "444.555",
      kind: "watch_ci",
      script: "#!/usr/bin/env bash\nsleep 30"
    });

    await expect(jobs.cancelJobFromAdmin(job.id, {
      sessionKey: "C999:000.000"
    })).rejects.toThrow("job_session_mismatch");

    const cancelled = await jobs.cancelJobFromAdmin(job.id, {
      sessionKey: session.key
    });

    expect(cancelled).toMatchObject({
      id: job.id,
      sessionKey: session.key,
      status: "cancelled",
      cancelledAt: expect.any(String),
      completedAt: expect.any(String)
    });
    expect(seenEvents).toEqual([]);
    await expect(jobs.cancelJobFromAdmin(job.id, {
      sessionKey: session.key
    })).rejects.toThrow("job_not_cancellable:cancelled");

    await jobs.stop();
  });

  it("injects a runtime-relative helper path into background jobs", async () => {
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
    const session = await sessions.ensureSession("C123", "444.555");
    await fs.mkdir(session.workspacePath, { recursive: true });

    const capturePath = path.join(session.workspacePath, "helper-path.txt");
    const jobs = new JobManager({
      sessions,
      jobsRoot,
      reposRoot,
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      onEvent: async () => {}
    });

    const job = await jobs.registerJob({
      channelId: "C123",
      rootThreadTs: "444.555",
      kind: "watch_ci",
      script: `#!/usr/bin/env bash\nprintf '%s' \"$BROKER_JOB_HELPER\" > ${shellQuote(capturePath)}\nsleep 30`
    });

    const helperPath = await waitForFileContents(capturePath);
    expect(helperPath).toBe(resolveRuntimeToolPath("job-callback.js"));
    expect(helperPath.startsWith("/app/")).toBe(false);

    await jobs.cancelJob(job.id, job.token);
    await jobs.stop();
  });
});

async function waitForFileContents(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForJobStatus(
  sessions: SessionManager,
  jobId: string,
  status: string
): Promise<PersistedBackgroundJob> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = sessions.getBackgroundJob(jobId);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${jobId} to become ${status}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
