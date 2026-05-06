#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..", "..");
const STATE_DATABASE_FILENAME = "broker.sqlite";

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

export function runCommand(command, args, options = {}) {
  const {
    capture = false,
    cwd = repoRoot,
    env = undefined,
    input = undefined
  } = options;

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    input,
    stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit"
  });

  if (result.status !== 0) {
    const details = capture
      ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(
      `Command failed (${result.status ?? "null"}): ${formatCommand(command, args)}${
        details ? `\n${details}` : ""
      }`
    );
  }

  return capture ? result.stdout.trim() : "";
}

export function inspectContainer(containerName) {
  const raw = runCommand("docker", ["inspect", containerName], { capture: true });
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Container ${containerName} not found`);
  }

  return parsed[0];
}

export function getDataRootSource(inspect) {
  const mount = (inspect.Mounts ?? []).find((item) => item.Destination === "/app/.data");
  if (!mount?.Source) {
    throw new Error("Could not resolve /app/.data mount source from container inspect");
  }

  return mount.Source;
}

export function getPublishedPort(inspect, containerPort = "3000/tcp") {
  const bindings =
    inspect.NetworkSettings?.Ports?.[containerPort] ?? inspect.HostConfig?.PortBindings?.[containerPort];
  const firstBinding = Array.isArray(bindings) ? bindings[0] : undefined;
  if (!firstBinding?.HostPort) {
    throw new Error(`Could not resolve published port for ${containerPort}`);
  }

  return Number(firstBinding.HostPort);
}

export async function readSessionStatsFromHost(dataRootSource) {
  const dbPath = path.join(dataRootSource, "state", STATE_DATABASE_FILENAME);
  if (!fs.existsSync(dbPath)) {
    return {
      activeCount: 0,
      sessionCount: 0
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS sessionCount,
        SUM(CASE WHEN active_turn_id IS NOT NULL THEN 1 ELSE 0 END) AS activeCount
      FROM sessions
    `).get();
    return {
      activeCount: Number(row?.activeCount ?? 0),
      sessionCount: Number(row?.sessionCount ?? 0)
    };
  } finally {
    db.close();
  }
}

function toMountArg(mount) {
  const type = mount.Type ?? "bind";
  const source = type === "volume" ? mount.Name ?? mount.Source : mount.Source;
  if (!source || !mount.Destination) {
    throw new Error(`Unsupported mount: ${JSON.stringify(mount)}`);
  }

  const parts = [`type=${type}`, `src=${source}`, `dst=${mount.Destination}`];
  if (mount.RW === false) {
    parts.push("readonly");
  }

  return `--mount=${parts.join(",")}`;
}

function toPortArgs(inspect) {
  const bindings = inspect.HostConfig?.PortBindings ?? {};
  return Object.entries(bindings).flatMap(([containerPort, hostBindings]) => {
    if (!Array.isArray(hostBindings)) {
      return [];
    }

    const containerPortNumber = containerPort.split("/")[0];
    return hostBindings.map((binding) => {
      const prefix = binding.HostIp ? `${binding.HostIp}:` : "";
      return `-p=${prefix}${binding.HostPort}:${containerPortNumber}`;
    });
  });
}

export async function writeEnvFileFromInspect(inspect, filePath) {
  const ignoredEnvKeys = new Set(["HOSTNAME"]);
  const envLines = (inspect.Config?.Env ?? []).filter((entry) => {
    const [key] = entry.split("=", 1);
    return !ignoredEnvKeys.has(key);
  });
  await fsp.writeFile(filePath, `${envLines.join("\n")}\n`);
}

export function getRestartPolicy(inspect) {
  return inspect.HostConfig?.RestartPolicy?.Name || "unless-stopped";
}

export function getRunArgumentsFromInspect(inspect) {
  return {
    mountArgs: (inspect.Mounts ?? []).map(toMountArg),
    portArgs: toPortArgs(inspect),
    restartPolicy: getRestartPolicy(inspect)
  };
}

export async function createTempEnvFile(inspect) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-rollout-"));
  const envFile = path.join(tempDir, "container.env");
  await writeEnvFileFromInspect(inspect, envFile);
  return {
    envFile,
    cleanup: async () => {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  };
}

export function dockerExecNode(containerName, source) {
  return runCommand("docker", ["exec", containerName, "node", "-e", source], {
    capture: true
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function retryUntil(label, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastError = undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} did not succeed within ${timeoutMs}ms: ${reason}`);
}

export async function checkContainer(containerName, options = {}) {
  const inspect = inspectContainer(containerName);
  const status = inspect.State?.Status;
  if (status !== "running") {
    throw new Error(`Container ${containerName} is not running (status=${status ?? "unknown"})`);
  }

  const hostPort = getPublishedPort(inspect);
  const healthPayload = await retryUntil(
    "host health check",
    async () => {
      const healthResponse = await fetch(`http://127.0.0.1:${hostPort}/`);
      if (!healthResponse.ok) {
        throw new Error(`Health endpoint returned ${healthResponse.status}`);
      }

      const payload = await healthResponse.json();
      if (!payload?.ok) {
        throw new Error(`Unexpected health payload: ${JSON.stringify(payload)}`);
      }

      return payload;
    },
    options
  );

  const readyPayload = await retryUntil(
    "embedded Codex readyz check",
    async () =>
      dockerExecNode(
        containerName,
        [
          'fetch("http://127.0.0.1:4590/readyz")',
          "  .then(async (response) => {",
          '    const text = await response.text();',
          '    console.log(JSON.stringify({ status: response.status, body: text }));',
          "    if (!response.ok) process.exit(1);",
          "  })",
          "  .catch((error) => {",
          "    console.error(error.stack || String(error));",
          "    process.exit(1);",
          "  });"
        ].join("\n")
      ),
    options
  );

  const fileChecks = JSON.parse(
    dockerExecNode(
      containerName,
      [
        "const fs = require('fs');",
        "const checks = [",
        "  '/app/.data/codex-home/AGENT.md',",
        "  '/app/.data/codex-home/config.toml',",
        "  '/app/.data/runtime-home/.codex/AGENT.md',",
        "  '/app/.data/state/broker.sqlite',",
        "  '/app/.data/repos',",
        "  '/app/.data/sessions'",
        "];",
        "const result = Object.fromEntries(checks.map((item) => [item, fs.existsSync(item)]));",
        "result.runtimeAgentLink = fs.readlinkSync('/app/.data/runtime-home/.codex/AGENT.md');",
        "console.log(JSON.stringify(result));"
      ].join("\n")
    )
  );

  const missing = Object.entries(fileChecks)
    .filter(([key, value]) => key !== "runtimeAgentLink" && value !== true)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing expected runtime paths: ${missing.join(", ")}`);
  }

  await retryUntil(
    "startup log markers",
    async () => {
      const logs = runCommand("docker", ["logs", "--tail", String(options.logsTail ?? 200), containerName], {
        capture: true
      });
      const requiredLogMarkers = [
        "Codex app-server client connected",
        "Connected to Slack Socket Mode",
        "Service booted"
      ];
      const missingMarkers = requiredLogMarkers.filter((marker) => !logs.includes(marker));
      if (missingMarkers.length > 0) {
        throw new Error(`Missing expected log markers: ${missingMarkers.join(", ")}`);
      }
    },
    options
  );

  const dataRootSource = getDataRootSource(inspect);
  const sessionStats = await readSessionStatsFromHost(dataRootSource);

  return {
    containerName,
    hostPort,
    dataRootSource,
    sessionStats,
    healthPayload,
    readyPayload: JSON.parse(readyPayload),
    runtimeAgentLink: fileChecks.runtimeAgentLink
  };
}

export async function writeRolloutMetadata(directory, payload) {
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, "metadata.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

function readDetailedStateFromSqlite(dataRootSource) {
  const dbPath = path.join(dataRootSource, "state", STATE_DATABASE_FILENAME);
  if (!fs.existsSync(dbPath)) {
    return {
      sessions: [],
      inboundMessages: [],
      backgroundJobs: []
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      sessions: db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all().map(sessionFromRow),
      inboundMessages: db.prepare("SELECT * FROM inbound_messages ORDER BY CAST(message_ts AS REAL), message_ts").all().map(inboundMessageFromRow),
      backgroundJobs: db.prepare("SELECT * FROM background_jobs ORDER BY created_at ASC").all().map(backgroundJobFromRow)
    };
  } finally {
    db.close();
  }
}

async function readLastJsonlLines(filePath, limit) {
  if (limit <= 0) {
    return [];
  }

  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readRecentBrokerLogRecords(logsRoot, limit) {
  if (limit <= 0) {
    return [];
  }

  const brokerLogRoot = path.join(logsRoot, "broker");
  const entries = await fsp.readdir(brokerLogRoot, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => {
      const filePath = path.join(brokerLogRoot, entry.name);
      const stat = await fsp.stat(filePath);
      return {
        path: filePath,
        mtimeMs: stat.mtimeMs
      };
    }));
  const chunks = [];
  let recordCount = 0;

  for (const file of files.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
  )) {
    const records = await readLastJsonlLines(file.path, limit);
    chunks.push(records);
    recordCount += records.length;
    if (recordCount >= limit) {
      break;
    }
  }

  return chunks.reverse().flat().slice(-limit);
}

export async function readDetailedStateFromHost(dataRootSource, options = {}) {
  const openInboundLimit = options.openInboundLimit ?? 20;
  const logLineLimit = options.logLineLimit ?? 40;
  const logsRoot = path.join(dataRootSource, "logs");
  const {
    sessions,
    inboundMessages,
    backgroundJobs
  } = readDetailedStateFromSqlite(dataRootSource);

  const activeSessions = sessions
    .filter((session) => session?.activeTurnId)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));

  const openInbound = inboundMessages
    .filter((message) => message?.status === "pending" || message?.status === "inflight")
    .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));

  const brokerLogs = await readRecentBrokerLogRecords(logsRoot, logLineLimit);

  return {
    sessionCount: sessions.length,
    activeCount: activeSessions.length,
    activeSessions,
    openInboundCount: openInbound.length,
    openInbound: openInbound.slice(0, openInboundLimit),
    backgroundJobs: backgroundJobs.sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    ),
    recentBrokerLogs: brokerLogs
  };
}

function sessionFromRow(row) {
  return {
    key: row.key,
    channelId: row.channel_id,
    rootThreadTs: row.root_thread_ts,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    codexThreadId: row.codex_thread_id ?? undefined,
    activeTurnId: row.active_turn_id ?? undefined,
    activeTurnStartedAt: row.active_turn_started_at ?? undefined,
    lastObservedMessageTs: row.last_observed_message_ts ?? undefined,
    lastDeliveredMessageTs: row.last_delivered_message_ts ?? undefined,
    lastSlackReplyAt: row.last_slack_reply_at ?? undefined,
    lastProgressReminderAt: row.last_progress_reminder_at ?? undefined,
    lastTurnSignalTurnId: row.last_turn_signal_turn_id ?? undefined,
    lastTurnSignalKind: row.last_turn_signal_kind ?? undefined,
    lastTurnSignalReason: row.last_turn_signal_reason ?? undefined,
    lastTurnSignalAt: row.last_turn_signal_at ?? undefined,
    coAuthorCandidateUserIds: readJson(row.co_author_candidate_user_ids, undefined),
    coAuthorCandidateRevision: row.co_author_candidate_revision ?? undefined,
    coAuthorConfirmedUserIds: readJson(row.co_author_confirmed_user_ids, undefined),
    coAuthorConfirmedRevision: row.co_author_confirmed_revision ?? undefined,
    coAuthorIgnoreMissingRevision: row.co_author_ignore_missing_revision ?? undefined,
    coAuthorPromptRevision: row.co_author_prompt_revision ?? undefined,
    coAuthorPromptedAt: row.co_author_prompted_at ?? undefined
  };
}

function inboundMessageFromRow(row) {
  return {
    key: row.key,
    sessionKey: row.session_key,
    channelId: row.channel_id,
    channelType: row.channel_type ?? undefined,
    rootThreadTs: row.root_thread_ts,
    messageTs: row.message_ts,
    source: row.source,
    userId: row.user_id,
    text: row.text,
    senderKind: row.sender_kind ?? undefined,
    botId: row.bot_id ?? undefined,
    appId: row.app_id ?? undefined,
    senderUsername: row.sender_username ?? undefined,
    mentionedUserIds: readJson(row.mentioned_user_ids, []),
    contextText: row.context_text ?? undefined,
    images: readJson(row.images, []),
    slackMessage: readJson(row.slack_message, undefined),
    backgroundJob: readJson(row.background_job, undefined),
    unexpectedTurnStop: readJson(row.unexpected_turn_stop, undefined),
    status: row.status,
    batchId: row.batch_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function backgroundJobFromRow(row) {
  return {
    id: row.id,
    token: row.token,
    sessionKey: row.session_key,
    channelId: row.channel_id,
    rootThreadTs: row.root_thread_ts,
    kind: row.kind,
    shell: row.shell,
    cwd: row.cwd,
    scriptPath: row.script_path,
    restartOnBoot: row.restart_on_boot !== 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    lastEventAt: row.last_event_at ?? undefined,
    lastEventKind: row.last_event_kind ?? undefined,
    lastEventSummary: row.last_event_summary ?? undefined
  };
}

function readJson(value, fallback) {
  return typeof value === "string" ? JSON.parse(value) : fallback;
}
