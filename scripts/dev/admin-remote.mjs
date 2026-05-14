#!/usr/bin/env node

import { spawn } from "node:child_process";

const sshHost = process.env.ADMIN_REMOTE_SSH_HOST || "admin@100.67.4.27";
const sshProxyCommand =
  process.env.ADMIN_REMOTE_SSH_PROXY_COMMAND ||
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale nc %h %p";
const localApiPort = process.env.ADMIN_REMOTE_LOCAL_API_PORT || "3000";
const remoteApiPort = process.env.ADMIN_REMOTE_API_PORT || "3000";
const adminUiPort = process.env.ADMIN_UI_DEV_PORT || "5173";
const apiOrigin = process.env.ADMIN_API_PROXY_ORIGIN || `http://127.0.0.1:${localApiPort}`;
const readyUrl = `${apiOrigin}/readyz`;
const children = [];
let stopping = false;

main().catch((error) => {
  console.error(`[admin-remote] ${error instanceof Error ? error.message : String(error)}`);
  stopAll("SIGTERM");
  process.exitCode = 1;
});

async function main() {
  if (await isReady(readyUrl)) {
    console.log(`[admin-remote] reusing local API tunnel at ${apiOrigin}`);
  } else {
    spawnManaged("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      `ProxyCommand=${sshProxyCommand}`,
      "-N",
      "-L",
      `127.0.0.1:${localApiPort}:127.0.0.1:${remoteApiPort}`,
      sshHost
    ]);
    await waitForReady(readyUrl, 15_000);
  }

  console.log(`[admin-remote] admin UI: http://127.0.0.1:${adminUiPort}/admin/`);
  console.log(`[admin-remote] proxying /admin/api to ${apiOrigin}`);
  spawnManaged("pnpm", ["exec", "vp", "dev", "--host", "127.0.0.1", "--port", adminUiPort, "--strictPort"], {
    env: {
      ...process.env,
      ADMIN_API_PROXY_ORIGIN: apiOrigin,
      ADMIN_UI_DEV_PORT: adminUiPort
    }
  });
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    stopAll("SIGTERM");
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.on("error", (error) => {
    if (stopping) {
      return;
    }
    console.error(`[admin-remote] failed to start ${command}: ${error.message}`);
    stopAll("SIGTERM");
    process.exitCode = 1;
  });
  return child;
}

async function waitForReady(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isReady(url)) {
      return;
    }
    await delay(300);
  }
  throw new Error(`live admin API did not become ready at ${url}`);
}

async function isReady(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopAll(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
});
process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});
