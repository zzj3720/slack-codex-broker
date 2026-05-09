#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    delayMs: 250,
    domain: undefined,
    label: undefined,
    logFile: undefined,
    plist: undefined,
    reason: "launchd restart"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--delay-ms":
        options.delayMs = Number(argv[index + 1]);
        index += 1;
        break;
      case "--domain":
        options.domain = argv[index + 1];
        index += 1;
        break;
      case "--label":
        options.label = argv[index + 1];
        index += 1;
        break;
      case "--log-file":
        options.logFile = argv[index + 1];
        index += 1;
        break;
      case "--plist":
        options.plist = argv[index + 1];
        index += 1;
        break;
      case "--reason":
        options.reason = argv[index + 1];
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/ops/macos-launchd-restart.mjs --domain <domain> --plist <path> --label <label> [--delay-ms <ms>] [--log-file <path>] [--reason <text>]");
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.domain) {
    throw new Error("Missing required argument: --domain");
  }
  if (!options.label) {
    throw new Error("Missing required argument: --label");
  }
  if (!options.plist) {
    throw new Error("Missing required argument: --plist");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("Invalid --delay-ms");
  }

  return options;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendLog(logFile, message) {
  if (!logFile) {
    return;
  }

  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Logging must not decide whether launchd restart proceeds.
  }
}

async function runCommand(command, args) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        code: -1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr
      });
    });
  });
}

function summarize(result) {
  return [result.stdout, result.stderr].join("\n").trim().replace(/\s+/g, " ").slice(0, 500);
}

const options = parseArgs(process.argv.slice(2));
const serviceTarget = `${options.domain}/${options.label}`;

await appendLog(options.logFile, `starting ${options.reason}: ${serviceTarget} via ${options.plist}`);
await sleep(options.delayMs);

const bootout = await runCommand("launchctl", ["bootout", options.domain, options.plist]);
await appendLog(options.logFile, `bootout code=${bootout.code}${summarize(bootout) ? ` output=${summarize(bootout)}` : ""}`);
await sleep(150);

let loaded = false;
let lastBootstrap = null;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const bootstrap = await runCommand("launchctl", ["bootstrap", options.domain, options.plist]);
  lastBootstrap = bootstrap;
  await appendLog(options.logFile, `bootstrap attempt=${attempt} code=${bootstrap.code}${summarize(bootstrap) ? ` output=${summarize(bootstrap)}` : ""}`);
  if (bootstrap.code === 0) {
    loaded = true;
    break;
  }

  const printed = await runCommand("launchctl", ["print", serviceTarget]);
  if (printed.code === 0) {
    loaded = true;
    await appendLog(options.logFile, "bootstrap failed but service is already loaded");
    break;
  }

  await sleep(250 * attempt);
}

if (!loaded) {
  await appendLog(options.logFile, `failed to bootstrap ${serviceTarget}${lastBootstrap ? `: ${summarize(lastBootstrap)}` : ""}`);
  process.exit(1);
}

const kickstart = await runCommand("launchctl", ["kickstart", "-k", serviceTarget]);
await appendLog(options.logFile, `kickstart code=${kickstart.code}${summarize(kickstart) ? ` output=${summarize(kickstart)}` : ""}`);
process.exit(kickstart.code === 0 ? 0 : 1);
