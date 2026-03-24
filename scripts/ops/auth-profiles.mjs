#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDataRootSource, inspectContainer, runCommand } from "./lib.mjs";

const DEFAULT_CONTAINER_NAME = "slack-codex-broker-real";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/ops/auth-profiles.mjs status [--container <name>]",
      "  node scripts/ops/auth-profiles.mjs bootstrap [--container <name>] [--refresh]",
      "  node scripts/ops/auth-profiles.mjs copy host-to-docker [--container <name>] [--no-restart]",
      "  node scripts/ops/auth-profiles.mjs copy docker-to-host [--container <name>]"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  let direction;
  if (command === "copy") {
    direction = args.shift();
  }

  const options = {
    containerName: DEFAULT_CONTAINER_NAME,
    refresh: false,
    restart: true
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--container":
        options.containerName = args.shift();
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--no-restart":
        options.restart = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, direction, options };
}

async function pathInfo(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    const base = {
      path: filePath,
      exists: true,
      isSymlink: stat.isSymbolicLink()
    };
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(filePath);
      const resolvedTarget = path.resolve(path.dirname(filePath), linkTarget);
      const targetStat = await fs.stat(filePath);
      return {
        ...base,
        linkTarget,
        resolvedTarget,
        size: targetStat.size,
        mtime: targetStat.mtime.toISOString()
      };
    }

    return {
      ...base,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        path: filePath,
        exists: false
      };
    }

    throw error;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function backupFileIfNeeded(filePath, backupDir, backupName) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  await ensureDir(backupDir);
  const backupPath = path.join(backupDir, backupName ?? path.basename(filePath));
  await fs.cp(filePath, backupPath, { dereference: false, force: true, recursive: true });
  return backupPath;
}

async function ensureManagedCopy({ sourcePath, targetPath, refresh }) {
  await ensureDir(path.dirname(targetPath));
  if (!refresh) {
    try {
      await fs.access(targetPath);
      return false;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function ensureManagedSymlink({ linkPath, targetPath, backupDir, backupName }) {
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  let current;
  try {
    current = await fs.lstat(linkPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  if (current?.isSymbolicLink()) {
    const linkTarget = await fs.readlink(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), linkTarget);
    if (resolvedTarget === path.resolve(targetPath)) {
      return null;
    }
  }

  const backupPath = await backupFileIfNeeded(linkPath, backupDir, backupName);
  await fs.rm(linkPath, { force: true, recursive: true });
  await fs.symlink(relativeTarget, linkPath, "file");
  return backupPath;
}

function resolvePaths(containerName) {
  const inspect = inspectContainer(containerName);
  const dataRootSource = getDataRootSource(inspect);
  const managedRoot = path.join(dataRootSource, "auth-profiles");
  return {
    containerName,
    dataRootSource,
    managedRoot,
    managedHostAuthPath: path.join(managedRoot, "host", "auth.json"),
    managedDockerAuthPath: path.join(managedRoot, "docker", "auth.json"),
    hostAuthPath: path.join(os.homedir(), ".codex", "auth.json"),
    dockerAuthPath: path.join(dataRootSource, "codex-home", "auth.json")
  };
}

async function bootstrapProfiles(options) {
  const paths = resolvePaths(options.containerName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.managedRoot, "backups", stamp);

  const copiedHost = await ensureManagedCopy({
    sourcePath: paths.hostAuthPath,
    targetPath: paths.managedHostAuthPath,
    refresh: options.refresh
  });
  const copiedDocker = await ensureManagedCopy({
    sourcePath: paths.dockerAuthPath,
    targetPath: paths.managedDockerAuthPath,
    refresh: options.refresh
  });

  const hostBackup = await ensureManagedSymlink({
    linkPath: paths.hostAuthPath,
    targetPath: paths.managedHostAuthPath,
    backupDir,
    backupName: "host-auth.json"
  });
  const dockerBackup = await ensureManagedSymlink({
    linkPath: paths.dockerAuthPath,
    targetPath: paths.managedDockerAuthPath,
    backupDir,
    backupName: "docker-auth.json"
  });

  return {
    ok: true,
    copiedHost,
    copiedDocker,
    hostBackup,
    dockerBackup,
    paths
  };
}

async function copyProfile(direction, options) {
  const paths = resolvePaths(options.containerName);
  if (direction !== "host-to-docker" && direction !== "docker-to-host") {
    throw new Error(`Unsupported direction: ${direction}`);
  }

  const sourcePath =
    direction === "host-to-docker" ? paths.managedHostAuthPath : paths.managedDockerAuthPath;
  const targetPath =
    direction === "host-to-docker" ? paths.managedDockerAuthPath : paths.managedHostAuthPath;

  await fs.copyFile(sourcePath, targetPath);

  let restartAction = "not_requested";
  if (direction === "host-to-docker" && options.restart) {
    runCommand("docker", ["restart", options.containerName]);
    restartAction = "container_restart";
  }

  return {
    ok: true,
    direction,
    sourcePath,
    targetPath,
    restartAction
  };
}

async function getStatus(options) {
  const paths = resolvePaths(options.containerName);
  return {
    containerName: options.containerName,
    dataRootSource: paths.dataRootSource,
    managedRoot: paths.managedRoot,
    hostAuth: await pathInfo(paths.hostAuthPath),
    dockerAuth: await pathInfo(paths.dockerAuthPath),
    managedHostAuth: await pathInfo(paths.managedHostAuthPath),
    managedDockerAuth: await pathInfo(paths.managedDockerAuthPath)
  };
}

async function main() {
  const { command, direction, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  let result;
  switch (command) {
    case "status":
      result = await getStatus(options);
      break;
    case "bootstrap":
      result = await bootstrapProfiles(options);
      break;
    case "copy":
      result = await copyProfile(direction, options);
      break;
    default:
      usage();
      process.exitCode = 1;
      return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
