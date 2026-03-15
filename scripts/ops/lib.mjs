#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..", "..");

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
  const sessionsDir = path.join(dataRootSource, "state", "sessions");
  try {
    const entries = await fsp.readdir(sessionsDir);
    let activeCount = 0;
    let sessionCount = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      sessionCount += 1;
      const record = JSON.parse(await fsp.readFile(path.join(sessionsDir, entry), "utf8"));
      if (record.activeTurnId) {
        activeCount += 1;
      }
    }

    return {
      activeCount,
      sessionCount
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        activeCount: 0,
        sessionCount: 0
      };
    }

    throw error;
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
        "  '/app/.data/state/sessions',",
        "  '/app/.data/state/inbound-messages',",
        "  '/app/.data/state/background-jobs',",
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
