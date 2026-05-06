import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureLogger, flushLoggerForTests, logger } from "../src/logger.js";

describe("logger raw payload limits", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    configureLogger({
      level: "info",
      rawSlackEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false
    });
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
  });

  it("truncates oversized raw log payloads before writing them", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-logs-"));
    tempDirs.push(logDir);
    configureLogger({
      logDir,
      level: "info",
      rawSlackEvents: true,
      rawCodexRpc: false,
      rawHttpRequests: false,
      rawMaxBytes: 120
    });

    logger.raw("slack-events", {
      text: "x".repeat(1_000)
    });
    await flushLoggerForTests();

    const rawDir = path.join(logDir, "raw", "slack-events");
    const files = await fs.readdir(rawDir);
    const content = await fs.readFile(path.join(rawDir, files[0]!), "utf8");
    const record = JSON.parse(content.trim()) as {
      payload: {
        truncated: boolean;
        originalBytes: number;
        preview: string;
      };
    };

    expect(record.payload.truncated).toBe(true);
    expect(record.payload.originalBytes).toBeGreaterThan(120);
    expect(record.payload.preview.length).toBeLessThan(140);
  });
});
