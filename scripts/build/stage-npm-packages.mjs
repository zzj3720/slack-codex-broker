#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const stageRoot = path.join(repoRoot, "artifacts", "npm-packages");

const packageTargets = [
  {
    source: path.join(repoRoot, "packages", "admin"),
    destination: path.join(stageRoot, "admin"),
    includeAdminUi: true,
    scripts: [
      "lib.mjs",
      "macos-bootstrap.mjs",
      "macos-launchd-launcher.mjs",
      "macos-launchd-restart.mjs"
    ]
  },
  {
    source: path.join(repoRoot, "packages", "worker"),
    destination: path.join(stageRoot, "worker"),
    includeAdminUi: false,
    scripts: [
      "macos-launchd-launcher.mjs",
      "macos-launchd-restart.mjs"
    ]
  }
];

await fs.rm(stageRoot, { force: true, recursive: true });

for (const target of packageTargets) {
  await stagePackage(target);
}

async function stagePackage(target) {
  await fs.mkdir(target.destination, { recursive: true });
  await copyFile(path.join(target.source, "package.json"), path.join(target.destination, "package.json"));
  await copyFile(path.join(repoRoot, "README.md"), path.join(target.destination, "README.md"));
  await copyFile(path.join(repoRoot, "LICENSE"), path.join(target.destination, "LICENSE"));
  await copyDirectory(path.join(repoRoot, "dist", "src"), path.join(target.destination, "dist", "src"));
  if (target.includeAdminUi) {
    await copyDirectory(path.join(repoRoot, "dist", "admin-ui"), path.join(target.destination, "dist", "admin-ui"));
  }
  for (const script of target.scripts) {
    await copyFile(
      path.join(repoRoot, "scripts", "ops", script),
      path.join(target.destination, "scripts", "ops", script)
    );
  }
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyDirectory(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}
