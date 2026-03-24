#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDataRootSource, inspectContainer, runCommand } from "./lib.mjs";

const DEFAULT_CONTAINER_NAME = "slack-codex-broker-real";
const DEFAULT_PROFILE_NAME = "primary";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/ops/auth-profiles.mjs status [--container <name>]",
      "  node scripts/ops/auth-profiles.mjs bootstrap [--container <name>] [--profile <name>] [--refresh-host]",
      "  node scripts/ops/auth-profiles.mjs list [--container <name>]",
      "  node scripts/ops/auth-profiles.mjs import --name <profile> --from <path> [--container <name>] [--activate] [--no-restart]",
      "  node scripts/ops/auth-profiles.mjs import-host --name <profile> [--container <name>] [--activate] [--no-restart]",
      "  node scripts/ops/auth-profiles.mjs use <profile> [--container <name>] [--no-restart]"
    ].join("\n")
  );
}

function requireOption(value, name) {
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const positional = [];
  const options = {
    containerName: DEFAULT_CONTAINER_NAME,
    profileName: undefined,
    sourcePath: undefined,
    activate: false,
    refreshHost: false,
    restart: true
  };

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--container":
        options.containerName = requireOption(args.shift(), "--container");
        break;
      case "--profile":
      case "--name":
        options.profileName = requireOption(args.shift(), arg);
        break;
      case "--from":
        options.sourcePath = requireOption(args.shift(), "--from");
        break;
      case "--activate":
        options.activate = true;
        break;
      case "--refresh-host":
        options.refreshHost = true;
        break;
      case "--no-restart":
        options.restart = false;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  return { command, positional, options };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function sanitizeProfileName(name) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("profile name must not be empty");
  }

  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!normalized) {
    throw new Error(`invalid profile name: ${name}`);
  }

  return normalized;
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function resolvePaths(containerName) {
  const inspect = inspectContainer(containerName);
  const dataRootSource = getDataRootSource(inspect);
  const managedRoot = path.join(dataRootSource, "auth-profiles");
  const dockerRoot = path.join(managedRoot, "docker");
  return {
    containerName,
    dataRootSource,
    managedRoot,
    dockerRoot,
    dockerProfilesRoot: path.join(dockerRoot, "profiles"),
    hostManagedAuthPath: path.join(managedRoot, "host", "auth.json"),
    dockerActivePath: path.join(dockerRoot, "active.json"),
    legacyDockerManagedAuthPath: path.join(dockerRoot, "auth.json"),
    hostAuthPath: path.join(os.homedir(), ".codex", "auth.json"),
    dockerAuthPath: path.join(dataRootSource, "codex-home", "auth.json")
  };
}

function dockerProfilePath(paths, profileName) {
  return path.join(paths.dockerProfilesRoot, `${sanitizeProfileName(profileName)}.json`);
}

async function ensureHostManagedCopy(paths, refreshHost) {
  await ensureDir(path.dirname(paths.hostManagedAuthPath));
  if (!refreshHost && (await fileExists(paths.hostManagedAuthPath))) {
    return false;
  }

  await fs.copyFile(paths.hostAuthPath, paths.hostManagedAuthPath);
  return true;
}

async function migrateLegacyDockerProfile(paths, initialProfileName) {
  const initialProfilePath = dockerProfilePath(paths, initialProfileName);
  await ensureDir(paths.dockerProfilesRoot);

  if (await fileExists(initialProfilePath)) {
    return initialProfilePath;
  }

  if (await fileExists(paths.legacyDockerManagedAuthPath)) {
    await fs.copyFile(paths.legacyDockerManagedAuthPath, initialProfilePath);
    return initialProfilePath;
  }

  await fs.copyFile(paths.dockerAuthPath, initialProfilePath);
  return initialProfilePath;
}

async function ensureActiveDockerProfile(paths, profileName) {
  const targetPath = dockerProfilePath(paths, profileName);
  if (!(await fileExists(targetPath))) {
    throw new Error(`missing docker auth profile: ${profileName}`);
  }

  await ensureDir(path.dirname(paths.dockerActivePath));
  const relativeTarget = path.relative(path.dirname(paths.dockerActivePath), targetPath);
  await fs.rm(paths.dockerActivePath, { force: true, recursive: true });
  await fs.symlink(relativeTarget, paths.dockerActivePath, "file");
  return targetPath;
}

async function restartContainer(containerName) {
  runCommand("docker", ["restart", containerName]);
  return "container_restart";
}

async function bootstrapProfiles(options) {
  const paths = resolvePaths(options.containerName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.managedRoot, "backups", stamp);
  const initialProfileName = sanitizeProfileName(options.profileName || DEFAULT_PROFILE_NAME);

  const copiedHost = await ensureHostManagedCopy(paths, options.refreshHost);
  const initialProfilePath = await migrateLegacyDockerProfile(paths, initialProfileName);
  await ensureActiveDockerProfile(paths, initialProfileName);

  const hostBackup = await ensureManagedSymlink({
    linkPath: paths.hostAuthPath,
    targetPath: paths.hostManagedAuthPath,
    backupDir,
    backupName: "host-auth.json"
  });
  const dockerBackup = await ensureManagedSymlink({
    linkPath: paths.dockerAuthPath,
    targetPath: paths.dockerActivePath,
    backupDir,
    backupName: "docker-auth.json"
  });

  return {
    ok: true,
    paths,
    copiedHost,
    initialProfileName,
    initialProfilePath,
    hostBackup,
    dockerBackup
  };
}

async function listProfiles(options) {
  const paths = resolvePaths(options.containerName);
  await ensureDir(paths.dockerProfilesRoot);
  const entries = await fs.readdir(paths.dockerProfilesRoot);
  const profiles = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    profiles.push(await pathInfo(path.join(paths.dockerProfilesRoot, entry)));
  }

  let activeProfile = null;
  try {
    const linkTarget = await fs.readlink(paths.dockerActivePath);
    activeProfile = path.basename(linkTarget, ".json");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return {
    containerName: options.containerName,
    managedRoot: paths.managedRoot,
    activeProfile,
    profiles
  };
}

async function importProfile(options) {
  const profileName = sanitizeProfileName(requireOption(options.profileName, "--name"));
  const sourcePath = requireOption(options.sourcePath, "--from");
  const paths = resolvePaths(options.containerName);
  const targetPath = dockerProfilePath(paths, profileName);
  await ensureDir(paths.dockerProfilesRoot);
  await fs.copyFile(sourcePath, targetPath);

  let restartAction = "not_requested";
  if (options.activate) {
    await ensureActiveDockerProfile(paths, profileName);
    if (options.restart) {
      restartAction = await restartContainer(options.containerName);
    }
  }

  return {
    ok: true,
    profileName,
    sourcePath,
    targetPath,
    activated: options.activate,
    restartAction
  };
}

async function importHostProfile(options) {
  return await importProfile({
    ...options,
    sourcePath: path.join(os.homedir(), ".codex", "auth.json")
  });
}

async function useProfile(profileName, options) {
  const normalizedName = sanitizeProfileName(profileName);
  const paths = resolvePaths(options.containerName);
  const targetPath = await ensureActiveDockerProfile(paths, normalizedName);
  let restartAction = "not_requested";
  if (options.restart) {
    restartAction = await restartContainer(options.containerName);
  }

  return {
    ok: true,
    profileName: normalizedName,
    targetPath,
    restartAction
  };
}

async function getStatus(options) {
  const paths = resolvePaths(options.containerName);
  let activeProfile = null;
  try {
    const linkTarget = await fs.readlink(paths.dockerActivePath);
    activeProfile = path.basename(linkTarget, ".json");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return {
    containerName: options.containerName,
    dataRootSource: paths.dataRootSource,
    managedRoot: paths.managedRoot,
    activeDockerProfile: activeProfile,
    hostAuth: await pathInfo(paths.hostAuthPath),
    dockerAuth: await pathInfo(paths.dockerAuthPath),
    hostManagedAuth: await pathInfo(paths.hostManagedAuthPath),
    dockerActiveAuth: await pathInfo(paths.dockerActivePath),
    dockerProfiles: await listProfiles(options)
  };
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
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
    case "list":
      result = await listProfiles(options);
      break;
    case "import":
      result = await importProfile(options);
      break;
    case "import-host":
      result = await importHostProfile(options);
      break;
    case "use":
      result = await useProfile(requireOption(positional[0], "profile"), options);
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
