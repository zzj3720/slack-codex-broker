import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "./utils/fs.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type RawStream = "slack-events" | "codex-rpc" | "http-requests";

interface LoggerConfig {
  readonly logDir?: string | undefined;
  readonly level: LogLevel;
  readonly rawSlackEvents: boolean;
  readonly rawCodexRpc: boolean;
  readonly rawHttpRequests: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let currentConfig: LoggerConfig = {
  logDir: undefined,
  level: process.env.DEBUG ? "debug" : "info",
  rawSlackEvents: false,
  rawCodexRpc: false,
  rawHttpRequests: false
};

const writeChains = new Map<string, Promise<void>>();

export function configureLogger(config: LoggerConfig): void {
  currentConfig = config;
}

export function getBrokerLogDirectory(logDir: string): string {
  return path.join(logDir, "broker");
}

export function getSessionLogDirectory(logDir: string, sessionKey: string): string {
  return path.join(logDir, "sessions", encodeKey(sessionKey));
}

export function getJobLogDirectory(logDir: string, jobId: string): string {
  return path.join(logDir, "jobs", encodeKey(jobId));
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    writeLog("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    writeLog("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    writeLog("error", message, meta);
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    writeLog("debug", message, meta);
  },
  raw(stream: RawStream, payload: unknown, meta?: Record<string, unknown>): void {
    if (!isRawStreamEnabled(stream)) {
      return;
    }

    const ts = new Date().toISOString();
    const record = {
      ts,
      type: "raw",
      stream,
      payload,
      meta: sanitizeMeta(meta)
    };
    queueFileWrites(record, meta, path.join("raw", stream, `${getLogBucket(ts)}.jsonl`));
  }
};

function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentConfig.level]) {
    return;
  }

  const ts = new Date().toISOString();
  const sanitizedMeta = sanitizeMeta(meta);
  const payload = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : "";
  process.stdout.write(`${ts} ${level.toUpperCase()} ${message}${payload}\n`);

  const record = {
    ts,
    type: "log",
    level,
    message,
    meta: sanitizedMeta
  };
  queueFileWrites(record, sanitizedMeta, path.join("broker", `${getLogBucket(ts)}.jsonl`));
}

function queueFileWrites(record: Record<string, unknown>, meta: Record<string, unknown> | undefined, relativePath: string): void {
  if (!currentConfig.logDir) {
    return;
  }

  const targets = new Set<string>([path.join(currentConfig.logDir, relativePath)]);
  const sessionKey = resolveSessionKey(meta);
  const jobId = typeof meta?.jobId === "string" ? meta.jobId : undefined;
  const bucket = getLogBucket(String(record.ts));

  if (sessionKey) {
    targets.add(path.join(getSessionLogDirectory(currentConfig.logDir, sessionKey), `${bucket}.jsonl`));
  }

  if (jobId) {
    targets.add(path.join(getJobLogDirectory(currentConfig.logDir, jobId), `${bucket}.jsonl`));
  }

  for (const target of targets) {
    queueAppend(target, `${JSON.stringify(record)}\n`);
  }
}

function queueAppend(filePath: string, content: string): void {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await ensureDir(path.dirname(filePath));
      await fs.appendFile(filePath, content, "utf8");
    })
    .catch((error) => {
      process.stderr.write(
        `${new Date().toISOString()} ERROR Failed to write log file ${filePath} ${String(error)}\n`
      );
    });

  writeChains.set(filePath, next);
}

function resolveSessionKey(meta?: Record<string, unknown>): string | undefined {
  if (!meta) {
    return undefined;
  }

  if (typeof meta.sessionKey === "string" && meta.sessionKey) {
    return meta.sessionKey;
  }

  if (typeof meta.channelId === "string" && typeof meta.rootThreadTs === "string") {
    return `${meta.channelId}:${meta.rootThreadTs}`;
  }

  return undefined;
}

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(meta)) as Record<string, unknown>;
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getLogBucket(timestamp: string): string {
  return timestamp.slice(0, 13).replace("T", "-");
}

function isRawStreamEnabled(stream: RawStream): boolean {
  switch (stream) {
    case "slack-events":
      return currentConfig.rawSlackEvents;
    case "codex-rpc":
      return currentConfig.rawCodexRpc;
    case "http-requests":
      return currentConfig.rawHttpRequests;
  }
}
