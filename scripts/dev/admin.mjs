#!/usr/bin/env node

import { spawn } from "node:child_process";

const adminUiPort = process.env.ADMIN_UI_DEV_PORT || "5173";
const adminUiOrigin = process.env.ADMIN_UI_DEV_ORIGIN || `http://127.0.0.1:${adminUiPort}`;

const children = [
  spawn("pnpm", ["exec", "vp", "dev", "--host", "127.0.0.1", "--port", adminUiPort, "--strictPort"], {
    env: process.env,
    stdio: "inherit"
  }),
  spawn("pnpm", ["exec", "tsx", "watch", "src/admin-index.ts"], {
    env: {
      ...process.env,
      ADMIN_UI_DEV_ORIGIN: adminUiOrigin
    },
    stdio: "inherit"
  })
];

let exiting = false;

function stopAll(signal = "SIGTERM") {
  if (exiting) {
    return;
  }
  exiting = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!exiting && code !== 0) {
      stopAll();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
});
process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});
