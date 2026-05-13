import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_DATABASE_FILENAME,
  STATE_STORE_BUSY_TIMEOUT_MS,
  StateStore
} from "../src/store/state-store.js";

describe("StateStore", () => {
  it("does not rerun migrations on repeated load calls", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    const lockConnection = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
    lockConnection.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = Date.now();
      await expect(store.load()).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      lockConnection.exec("ROLLBACK");
      lockConnection.close();
      store.close();
    }
  }, STATE_STORE_BUSY_TIMEOUT_MS + 1_000);

  it("waits for short-lived startup write locks before running migrations", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    await fs.mkdir(stateDir, { recursive: true });

    const locker = spawn(process.execPath, ["-e", LOCK_DATABASE_SCRIPT], {
      env: {
        ...process.env,
        DB_PATH: path.join(stateDir, STATE_DATABASE_FILENAME)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      await waitForOutput(locker, "locked");

      const store = new StateStore(stateDir, sessionsRoot);
      try {
        const startedAt = Date.now();
        await expect(store.load()).resolves.toBeUndefined();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      } finally {
        store.close();
      }
    } finally {
      if (locker.exitCode === null) {
        locker.kill();
      }
    }
  }, STATE_STORE_BUSY_TIMEOUT_MS + 1_000);

  it("persists sessions and processed events in the SQLite database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await Promise.all([
      store.markProcessedEvent("EvA"),
      store.markProcessedEvent("EvB"),
      store.upsertSession({
        key: "C123:111.222",
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/tmp/sessions/C123-111.222/workspace",
        createdAt: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z"
      })
    ]);
    store.close();

    await expect(fs.access(path.join(stateDir, STATE_DATABASE_FILENAME))).resolves.toBeUndefined();

    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.hasProcessedEvent("EvB")).toBe(true);
    expect(reloaded.getSession("C123:111.222")).toEqual(expect.objectContaining({
      key: "C123:111.222"
    }));
    reloaded.close();
  });

  it("persists pending Slack events until they are processed", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await store.enqueueSlackEvent("EvA", {
      event_id: "EvA",
      event: {
        type: "message",
        channel: "C123",
        thread_ts: "111.222",
        ts: "111.223",
        user: "U123",
        text: "hello"
      }
    });

    expect(store.listPendingSlackEvents()).toEqual([
      expect.objectContaining({
        eventId: "EvA",
        status: "pending",
        payload: expect.objectContaining({
          event_id: "EvA"
        })
      })
    ]);

    store.close();
    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.listPendingSlackEvents()).toHaveLength(1);

    await reloaded.markSlackEventProcessed("EvA");
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.listPendingSlackEvents()).toHaveLength(0);
    reloaded.close();
  });

  it("deletes session state transactionally with inbound messages and background jobs", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });
    await store.upsertInboundMessage({
      key: "inbound-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z"
    });
    await store.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "watch_ci",
      shell: "sh",
      cwd: "/tmp/sessions/C123-111.222/workspace",
      scriptPath: "/tmp/jobs/job-1/run.sh",
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-03-15T00:00:02.000Z",
      updatedAt: "2026-03-15T00:00:02.000Z"
    });

    await expect(store.deleteSession("C123:111.222")).resolves.toBe(true);

    expect(store.getSession("C123:111.222")).toBeUndefined();
    expect(store.listInboundMessages({ sessionKey: "C123:111.222" })).toHaveLength(0);
    expect(store.listBackgroundJobs({ sessionKey: "C123:111.222" })).toHaveLength(0);
    store.close();
  });

  it("persists agent turn token usage and cascades it with the owning session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-usage-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });

    await store.upsertAgentTurnUsage({
      turnId: "turn-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      agentSessionId: "thread-1",
      status: "completed",
      source: "exact",
      model: "gpt-5.5",
      effort: "xhigh",
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 450,
      reasoningTokens: 75,
      totalTokens: 1725,
      rawUsage: {
        total_tokens: 1725
      },
      startedAt: "2026-03-15T00:00:01.000Z",
      completedAt: "2026-03-15T00:00:09.000Z",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:09.000Z"
    });

    expect(store.listAgentTurnUsage()).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        sessionKey: "C123:111.222",
        source: "exact",
        totalTokens: 1725,
        rawUsage: {
          total_tokens: 1725
        }
      })
    ]);

    await store.deleteSession("C123:111.222");
    expect(store.listAgentTurnUsage()).toHaveLength(0);
    store.close();
  });

  it("persists agent trace events and cascades them with the owning session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-agent-trace-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });

    await store.upsertAgentTraceEvent({
      id: "trace-1",
      sessionKey: "C123:111.222",
      source: "broker",
      type: "agent_user_message",
      at: "2026-03-15T00:00:01.000Z",
      sequence: 1,
      title: "用户消息",
      summary: "hello",
      detail: "hello",
      status: "received",
      role: "user",
      turnId: "turn-1",
      metadata: {
        sample: true
      },
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z"
    });

    expect(store.listAgentTraceEvents("C123:111.222")).toEqual([
      expect.objectContaining({
        id: "trace-1",
        sessionKey: "C123:111.222",
        source: "broker",
        type: "agent_user_message",
        summary: "hello",
        metadata: {
          sample: true
        }
      })
    ]);

    await store.deleteSession("C123:111.222");
    expect(store.listAgentTraceEvents("C123:111.222")).toHaveLength(0);
    store.close();
  });

  it("persists historical agent activity bindings when the current session runtime changes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-agent-bindings-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      agentSessionId: "thread-current",
      activeTurnId: "turn-current"
    });
    expect(store.getSessionKeyForAgentActivity({
      agentSessionId: "thread-current",
      turnId: "turn-current"
    })).toBe("C123:111.222");
    await store.bindAgentSession({
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      agentSessionId: "thread-old",
      at: "2026-03-15T00:00:01.000Z"
    });
    await store.bindAgentTurn({
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      agentSessionId: "thread-old",
      turnId: "turn-old",
      at: "2026-03-15T00:00:02.000Z"
    });

    expect(store.getSessionKeyForAgentActivity({
      agentSessionId: "thread-old"
    })).toBe("C123:111.222");
    expect(store.getSessionKeyForAgentActivity({
      turnId: "turn-old"
    })).toBe("C123:111.222");

    await store.patchSession("C123:111.222", {
      agentSessionId: "thread-new",
      activeTurnId: "turn-new"
    });
    expect(store.getSessionKeyForAgentActivity({
      agentSessionId: "thread-old",
      turnId: "turn-old"
    })).toBe("C123:111.222");

    await store.deleteSession("C123:111.222");
    expect(store.getSessionKeyForAgentActivity({
      agentSessionId: "thread-old",
      turnId: "turn-old"
    })).toBeUndefined();
    store.close();
  });

  it("records explicit schema migrations and does not treat ad hoc DDL as the migration state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-migrations-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    store.close();

    const database = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
    try {
      const rows = database
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number; name: string }>;

      expect(rows).toEqual([
        {
          version: 1,
          name: "initial_sqlite_state"
        },
        {
          version: 2,
          name: "admin_operations"
        },
        {
          version: 3,
          name: "agent_turn_usage"
        },
        {
          version: 4,
          name: "agent_trace_events"
        },
        {
          version: 5,
          name: "agent_schema_repair"
        },
        {
          version: 6,
          name: "session_agent_schema_repair"
        },
        {
          version: 7,
          name: "session_channel_metadata"
        },
        {
          version: 8,
          name: "inbound_mentioned_users"
        },
        {
          version: 9,
          name: "admin_realtime_events"
        },
        {
          version: 10,
          name: "session_page_link_announcement"
        },
        {
          version: 11,
          name: "session_auth_profile_binding"
        },
        {
          version: 12,
          name: "agent_activity_bindings"
        },
        {
          version: CURRENT_STATE_SCHEMA_VERSION,
          name: "session_initiator"
        }
      ]);
    } finally {
      database.close();
    }
  });

  it("persists inbound Slack mention identities", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-mentions-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z"
    });
    await store.upsertInboundMessage({
      key: "inbound-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "<@U234> follow up",
      mentionedUserIds: ["U234"],
      mentionedUsers: [
        {
          userId: "U234",
          mention: "<@U234>",
          username: "mock-user-234",
          displayName: "Mock Display 234",
          realName: "Mock User 234"
        }
      ],
      status: "pending",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z"
    });

    expect(store.listInboundMessages({ sessionKey: "C123:111.222" })).toEqual([
      expect.objectContaining({
        text: "<@U234> follow up",
        mentionedUserIds: ["U234"],
        mentionedUsers: [
          expect.objectContaining({
            userId: "U234",
            displayName: "Mock Display 234"
          })
        ]
      })
    ]);
    store.close();
  });

  it("migrates old session Codex thread ids into agent session ids", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-old-session-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    await fs.mkdir(stateDir, { recursive: true });

    const database = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO schema_migrations (version, name, applied_at) VALUES
          (1, 'initial_sqlite_state', '2026-03-15T00:00:00.000Z'),
          (2, 'admin_operations', '2026-03-15T00:00:00.000Z'),
          (3, 'codex_turn_usage', '2026-03-15T00:00:00.000Z');

        CREATE TABLE sessions (
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          codex_thread_id TEXT,
          active_turn_id TEXT,
          active_turn_started_at TEXT,
          last_observed_message_ts TEXT,
          last_delivered_message_ts TEXT,
          last_slack_reply_at TEXT,
          last_progress_reminder_at TEXT,
          last_turn_signal_turn_id TEXT,
          last_turn_signal_kind TEXT,
          last_turn_signal_reason TEXT,
          last_turn_signal_at TEXT,
          co_author_candidate_user_ids TEXT,
          co_author_candidate_revision INTEGER,
          co_author_confirmed_user_ids TEXT,
          co_author_confirmed_revision INTEGER,
          co_author_ignore_missing_revision INTEGER,
          co_author_prompt_revision INTEGER,
          co_author_prompted_at TEXT,
          UNIQUE(channel_id, root_thread_ts)
        );

        INSERT INTO sessions (
          key, channel_id, root_thread_ts, workspace_path, created_at, updated_at, codex_thread_id
        ) VALUES (
          'C123:111.222', 'C123', '111.222', '/tmp/workspace',
          '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z', 'thread-old'
        );
      `);
    } finally {
      database.close();
    }

    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    expect(store.getSession("C123:111.222")).toEqual(expect.objectContaining({
      agentSessionId: "thread-old"
    }));

    await expect(store.patchSession("C123:111.222", {
      updatedAt: "2026-03-15T00:00:01.000Z"
    })).resolves.toEqual(expect.objectContaining({
      agentSessionId: "thread-old"
    }));
    store.close();
  });

  it("migrates the old turn usage table into the agent schema and removes the old table", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-old-usage-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    await fs.mkdir(stateDir, { recursive: true });

    const database = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        INSERT INTO schema_migrations (version, name, applied_at) VALUES
          (1, 'initial_sqlite_state', '2026-03-15T00:00:00.000Z'),
          (2, 'admin_operations', '2026-03-15T00:00:00.000Z'),
          (3, 'agent_turn_usage', '2026-03-15T00:00:00.000Z'),
          (4, 'agent_trace_events', '2026-03-15T00:00:00.000Z');

        CREATE TABLE sessions (
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          agent_session_id TEXT,
          active_turn_id TEXT,
          active_turn_started_at TEXT,
          last_observed_message_ts TEXT,
          last_delivered_message_ts TEXT,
          last_slack_reply_at TEXT,
          last_progress_reminder_at TEXT,
          last_turn_signal_turn_id TEXT,
          last_turn_signal_kind TEXT,
          last_turn_signal_reason TEXT,
          last_turn_signal_at TEXT,
          co_author_candidate_user_ids TEXT,
          co_author_candidate_revision INTEGER,
          co_author_confirmed_user_ids TEXT,
          co_author_confirmed_revision INTEGER,
          co_author_ignore_missing_revision INTEGER,
          co_author_prompt_revision INTEGER,
          co_author_prompted_at TEXT
        );

        INSERT INTO sessions (
          key, channel_id, root_thread_ts, workspace_path, created_at, updated_at
        ) VALUES (
          'C123:111.222', 'C123', '111.222', '/tmp/workspace',
          '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z'
        );

        CREATE TABLE codex_turn_usage (
          turn_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          codex_thread_id TEXT,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          model TEXT,
          effort TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          raw_usage TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO codex_turn_usage (
          turn_id, session_key, channel_id, root_thread_ts, codex_thread_id,
          status, source, model, effort,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
          raw_usage, started_at, completed_at, created_at, updated_at
        ) VALUES (
          'turn-1', 'C123:111.222', 'C123', '111.222', 'thread-1',
          'completed', 'exact', 'gpt-5.5', 'xhigh',
          1200, 300, 450, 75, 1725,
          '{"total_tokens":1725}',
          '2026-03-15T00:00:01.000Z',
          '2026-03-15T00:00:09.000Z',
          '2026-03-15T00:00:01.000Z',
          '2026-03-15T00:00:09.000Z'
        );
      `);
    } finally {
      database.close();
    }

    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    expect(store.listAgentTurnUsage()).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        agentSessionId: "thread-1",
        totalTokens: 1725
      })
    ]);
    store.close();

    const migrated = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
    try {
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_turn_usage'").get()).toBeUndefined();
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_turn_usage'").get()).toBeTruthy();
    } finally {
      migrated.close();
    }
  });
});

const LOCK_DATABASE_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");

const database = new DatabaseSync(process.env.DB_PATH);
database.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER); BEGIN IMMEDIATE; INSERT INTO lock_probe (id) VALUES (1);");
process.stdout.write("locked\\n");
setTimeout(() => {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}, 350);
`;

function waitForOutput(child: ChildProcessByStdio<null, Readable, Readable>, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output ${marker}. stdout=${stdout} stderr=${stderr}`));
    }, 2_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited before ${marker}: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
