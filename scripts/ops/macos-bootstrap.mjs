#!/usr/bin/env node

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repoRoot, runCommand } from "./lib.mjs";

const DEFAULT_SERVICE_ROOT = repoRoot;
const DEFAULT_ADMIN_LABEL = "com.zzj3720.slack-codex-broker";
const DEFAULT_WORKER_LABEL = "com.zzj3720.slack-codex-broker.worker";
const DEFAULT_NODE_PATH = "/opt/homebrew/opt/node@24/bin/node";
const DEFAULT_COREPACK_PATH = "/opt/homebrew/opt/node@24/bin/corepack";
const DEFAULT_CODEX_VERSION = "0.114.0";
const DEFAULT_GEMINI_VERSION = "0.33.0";
const DEFAULT_PNPM_VERSION = readDefaultPnpmVersion();
const RELEASE_METADATA_FILENAME = ".broker-release.json";

const CODEX_HOME_FILE_ENTRIES = [
  ".credentials.json",
  ".personality_migration",
  "AGENT.md",
  "AGENTS.md",
  "config.toml",
  "memory.md",
  "models_cache.json"
];

const CODEX_HOME_DIRECTORY_ENTRIES = [
  "memories",
  "rules",
  "skills",
  "superpowers",
  "vendor_imports"
];

const GEMINI_HOME_FILES = [
  "settings.json",
  "oauth_creds.json",
  "google_accounts.json"
];

const BROKER_ENV_PASSTHROUGH_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_API_BASE_URL",
  "SLACK_SOCKET_OPEN_URL",
  "SLACK_INITIAL_THREAD_HISTORY_COUNT",
  "SLACK_HISTORY_API_MAX_LIMIT",
  "SLACK_ACTIVE_TURN_RECONCILE_INTERVAL_MS",
  "SLACK_MISSED_THREAD_RECOVERY_INTERVAL_MS",
  "SLACK_PROGRESS_REMINDER_AFTER_MS",
  "SLACK_PROGRESS_REMINDER_REPEAT_MS",
  "LOG_LEVEL",
  "LOG_RAW_SLACK_EVENTS",
  "LOG_RAW_CODEX_RPC",
  "LOG_RAW_HTTP_REQUESTS",
  "ISOLATED_MCP_SERVERS",
  "CODEX_DISABLED_MCP_SERVERS",
  "CODEX_APP_SERVER_URL",
  "OPENAI_API_KEY",
  "TEMPAD_LINK_SERVICE_URL",
  "GEMINI_HTTP_PROXY",
  "GEMINI_HTTPS_PROXY",
  "GEMINI_ALL_PROXY",
  "BROKER_ADMIN_TOKEN"
];

function readDefaultPnpmVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const packageManager = packageJson.packageManager?.trim();
    if (packageManager?.startsWith("pnpm@")) {
      return packageManager.slice("pnpm@".length);
    }
  } catch {
    // fall back to a pinned version below
  }

  return "10.33.0";
}

function parseArgs(argv) {
  const options = {
    serviceRoot: DEFAULT_SERVICE_ROOT,
    adminLabel: DEFAULT_ADMIN_LABEL,
    workerLabel: DEFAULT_WORKER_LABEL,
    nodePath: DEFAULT_NODE_PATH,
    corepackPath: DEFAULT_COREPACK_PATH,
    pnpmVersion: DEFAULT_PNPM_VERSION,
    codexVersion: DEFAULT_CODEX_VERSION,
    geminiVersion: DEFAULT_GEMINI_VERSION,
    startWorker: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--service-root":
        options.serviceRoot = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case "--label":
        options.adminLabel = argv[index + 1];
        index += 1;
        break;
      case "--worker-label":
        options.workerLabel = argv[index + 1];
        index += 1;
        break;
      case "--node-path":
        options.nodePath = argv[index + 1];
        index += 1;
        break;
      case "--corepack-path":
        options.corepackPath = argv[index + 1];
        index += 1;
        break;
      case "--pnpm-version":
        options.pnpmVersion = argv[index + 1];
        index += 1;
        break;
      case "--codex-version":
        options.codexVersion = argv[index + 1];
        index += 1;
        break;
      case "--gemini-version":
        options.geminiVersion = argv[index + 1];
        index += 1;
        break;
      case "--start-worker":
        options.startWorker = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/ops/macos-bootstrap.mjs [options]",
      "",
      "What it does:",
      "  - expects to run inside the VM's long-lived git clone",
      "  - uses that clone as the stable admin/control repo",
      "  - prepares shared runtime directories under the service root",
      "  - creates a worker release from the current commit under releases/<sha>",
      "  - writes admin/worker launchd plists and env files",
      "  - starts admin immediately; worker is optional",
      "",
      "Notes:",
      "  - preferred flow: git clone on the VM, cd into the repo, then run this script there",
      "  - auth.json is not copied by this script; import auth profiles later through /admin",
      "  - Slack tokens come from the current shell env or an existing config/broker.env",
      "",
      "Options:",
      `  --service-root <path>                Service root, default ${DEFAULT_SERVICE_ROOT}`,
      `  --label <label>                     Admin launchd label, default ${DEFAULT_ADMIN_LABEL}`,
      `  --worker-label <label>              Worker launchd label, default ${DEFAULT_WORKER_LABEL}`,
      "  --start-worker                      Also start the worker after bootstrap",
      "  --node-path <path>                  Node binary for launchd",
      "  --corepack-path <path>              Corepack binary",
      "  --pnpm-version <version>            pnpm version to activate",
      "  --codex-version <version>           codex CLI version to install globally",
      "  --gemini-version <version>          gemini CLI version to install globally"
    ].join("\n")
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    let value = rawValue;
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }

    env[key] = String(value);
  }

  return env;
}

async function fileExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readExistingBrokerEnv(serviceRoot) {
  const envFilePath = path.join(serviceRoot, "config", "broker.env");
  if (!(await fileExists(envFilePath))) {
    return {};
  }

  return parseEnvFile(await fs.readFile(envFilePath, "utf8"));
}

function buildSeedBrokerEnv(existingBrokerEnv) {
  const merged = {};
  for (const key of BROKER_ENV_PASSTHROUGH_KEYS) {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== null && String(fromProcess).length > 0) {
      merged[key] = String(fromProcess);
      continue;
    }

    const fromExisting = existingBrokerEnv[key];
    if (fromExisting !== undefined && fromExisting !== null && String(fromExisting).length > 0) {
      merged[key] = String(fromExisting);
    }
  }

  return merged;
}

function assertRequiredBrokerEnv(seedBrokerEnv) {
  const missing = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"].filter((key) => !seedBrokerEnv[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required broker environment values: ${missing.join(", ")}. ` +
      "Provide them in the current shell env or the existing config/broker.env before bootstrap."
    );
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFileResolved(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) {
    return;
  }

  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function copyDirectoryResolved(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) {
    return;
  }

  await ensureDir(path.dirname(targetPath));
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    dereference: true,
    force: true
  });
}

async function writeTextFile(sourcePath, targetPath, fallback = "") {
  await ensureDir(path.dirname(targetPath));
  if (!(await fileExists(sourcePath))) {
    await fs.writeFile(targetPath, fallback, "utf8");
    return;
  }

  const content = await fs.readFile(sourcePath, "utf8");
  await fs.writeFile(targetPath, content, "utf8");
}

async function ensureRelativeSymlink(linkPath, targetPath) {
  await ensureDir(path.dirname(linkPath));
  await fs.rm(linkPath, { force: true, recursive: true });
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath);
  await fs.symlink(relativeTarget, linkPath, "file");
}

async function buildPortableCodexHome(sourceCodexHome, targetCodexHome, targetDataRoot) {
  await ensureDir(targetCodexHome);

  for (const entry of CODEX_HOME_FILE_ENTRIES) {
    if (entry === "memory.md") {
      await writeTextFile(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry), "");
      continue;
    }

    if (entry === ".credentials.json") {
      continue;
    }

    await copyFileResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

  for (const entry of CODEX_HOME_DIRECTORY_ENTRIES) {
    await copyDirectoryResolved(path.join(sourceCodexHome, entry), path.join(targetCodexHome, entry));
  }

  const activeAuth = path.join(targetDataRoot, "auth-profiles", "docker", "active.json");
  await ensureRelativeSymlink(path.join(targetCodexHome, "auth.json"), activeAuth);
}

async function buildPortableGeminiHome(sourceGeminiHome, targetGeminiHome) {
  if (!(await fileExists(sourceGeminiHome))) {
    return;
  }

  await ensureDir(targetGeminiHome);
  for (const entry of GEMINI_HOME_FILES) {
    await copyFileResolved(path.join(sourceGeminiHome, entry), path.join(targetGeminiHome, entry));
  }
}

async function buildPortableGhConfigHome(sourceGhConfigHome, targetRuntimeHome) {
  if (!(await fileExists(sourceGhConfigHome))) {
    return;
  }

  const targetGhConfigHome = path.join(targetRuntimeHome, ".config", "gh");
  await ensureDir(targetGhConfigHome);
  await copyFileResolved(path.join(sourceGhConfigHome, "config.yml"), path.join(targetGhConfigHome, "config.yml"));
  await copyFileResolved(path.join(sourceGhConfigHome, "hosts.yml"), path.join(targetGhConfigHome, "hosts.yml"));
}

async function initializeRuntimeData(dataRoot) {
  await ensureDir(path.join(dataRoot, "state"));
  await ensureDir(path.join(dataRoot, "jobs"));
  await ensureDir(path.join(dataRoot, "sessions"));
  await ensureDir(path.join(dataRoot, "logs", "raw"));
  await ensureDir(path.join(dataRoot, "logs", "sessions"));
  await ensureDir(path.join(dataRoot, "logs", "jobs"));
  await ensureDir(path.join(dataRoot, "repos"));
  await ensureDir(path.join(dataRoot, "runtime-home"));
  await ensureDir(path.join(dataRoot, "auth-profiles", "docker", "profiles"));
}

function renderEnvFile(env) {
  return (
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n") + "\n"
  );
}

function renderPlist({ label, nodePath, launcherPath, repoRootPath, envFilePath, entryPoint, stdoutPath, stderrPath }) {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${nodePath}</string>`,
    `    <string>${launcherPath}</string>`,
    "    <string>--repo-root</string>",
    `    <string>${repoRootPath}</string>`,
    "    <string>--env-file</string>",
    `    <string>${envFilePath}</string>`,
    "    <string>--entry-point</string>",
    `    <string>${entryPoint}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${repoRootPath}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${stdoutPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${stderrPath}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function buildPaths(serviceRoot, options) {
  const remoteHome = os.homedir();
  return {
    serviceRoot,
    repoRoot: serviceRoot,
    releasesRoot: path.join(serviceRoot, "releases"),
    currentReleasePath: path.join(serviceRoot, "current"),
    previousReleasePath: path.join(serviceRoot, "previous"),
    failedReleasePath: path.join(serviceRoot, "failed"),
    dataRoot: path.join(serviceRoot, ".data"),
    runtimeSupportRoot: path.join(serviceRoot, "runtime-support"),
    codexSupportHome: path.join(serviceRoot, "runtime-support", "codex"),
    geminiSupportHome: path.join(serviceRoot, "runtime-support", "gemini"),
    agentsSupportHome: path.join(serviceRoot, "runtime-support", ".agents"),
    envDir: path.join(serviceRoot, "config"),
    adminEnvFile: path.join(serviceRoot, "config", "admin.env"),
    workerEnvFile: path.join(serviceRoot, "config", "worker.env"),
    logsDir: path.join(serviceRoot, "logs"),
    adminPlistPath: path.join(remoteHome, "Library", "LaunchAgents", `${options.adminLabel}.plist`),
    workerPlistPath: path.join(remoteHome, "Library", "LaunchAgents", `${options.workerLabel}.plist`),
    adminStdoutPath: path.join(serviceRoot, "logs", "admin.launchd.out.log"),
    adminStderrPath: path.join(serviceRoot, "logs", "admin.launchd.err.log"),
    workerStdoutPath: path.join(serviceRoot, "logs", "worker.launchd.out.log"),
    workerStderrPath: path.join(serviceRoot, "logs", "worker.launchd.err.log")
  };
}

function buildReleaseMetadata(revision) {
  return {
    revision,
    shortRevision: revision ? revision.slice(0, 12) : null,
    branch: runCommand("git", ["branch", "--show-current"], { capture: true, cwd: repoRoot }) || null,
    builtAt: new Date().toISOString(),
    builtBy: os.userInfo().username,
    builtFromHost: os.hostname(),
    stateSchemaVersion: 1
  };
}

function buildAdminEnv(paths, options, seedBrokerEnv) {
  return {
    ...seedBrokerEnv,
    NODE_ENV: "production",
    PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin",
    PORT: "3000",
    WORKER_PORT: "3001",
    WORKER_BIND_HOST: "127.0.0.1",
    WORKER_BASE_URL: "http://127.0.0.1:3001",
    BROKER_HTTP_BASE_URL: "http://127.0.0.1:3001",
    SERVICE_NAME: "slack-codex-broker-admin",
    SERVICE_ROOT: paths.serviceRoot,
    DATA_ROOT: paths.dataRoot,
    STATE_DIR: path.join(paths.dataRoot, "state"),
    JOBS_ROOT: path.join(paths.dataRoot, "jobs"),
    SESSIONS_ROOT: path.join(paths.dataRoot, "sessions"),
    REPOS_ROOT: path.join(paths.dataRoot, "repos"),
    LOG_DIR: path.join(paths.dataRoot, "logs"),
    CODEX_HOME: path.join(paths.dataRoot, "codex-home"),
    CODEX_HOST_HOME_PATH: paths.codexSupportHome,
    CODEX_AUTH_JSON_PATH: path.join(paths.dataRoot, "codex-home", "auth.json"),
    GEMINI_HOST_HOME_PATH: paths.geminiSupportHome,
    CODEX_APP_SERVER_PORT: "4590",
    ADMIN_LAUNCHD_LABEL: options.adminLabel,
    WORKER_LAUNCHD_LABEL: options.workerLabel,
    RELEASE_REPO_ROOT: paths.repoRoot,
    RELEASES_ROOT: paths.releasesRoot,
    CURRENT_RELEASE_PATH: paths.currentReleasePath,
    PREVIOUS_RELEASE_PATH: paths.previousReleasePath,
    FAILED_RELEASE_PATH: paths.failedReleasePath,
    WORKER_PLIST_PATH: paths.workerPlistPath
  };
}

function buildWorkerEnv(paths, options, seedBrokerEnv) {
  return {
    ...seedBrokerEnv,
    NODE_ENV: "production",
    PATH: "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin",
    PORT: "3001",
    WORKER_PORT: "3001",
    WORKER_BIND_HOST: "127.0.0.1",
    WORKER_BASE_URL: "http://127.0.0.1:3001",
    BROKER_HTTP_BASE_URL: "http://127.0.0.1:3001",
    SERVICE_NAME: "slack-codex-broker-worker",
    SERVICE_ROOT: paths.serviceRoot,
    DATA_ROOT: paths.dataRoot,
    STATE_DIR: path.join(paths.dataRoot, "state"),
    JOBS_ROOT: path.join(paths.dataRoot, "jobs"),
    SESSIONS_ROOT: path.join(paths.dataRoot, "sessions"),
    REPOS_ROOT: path.join(paths.dataRoot, "repos"),
    LOG_DIR: path.join(paths.dataRoot, "logs"),
    CODEX_HOME: path.join(paths.dataRoot, "codex-home"),
    CODEX_HOST_HOME_PATH: paths.codexSupportHome,
    CODEX_AUTH_JSON_PATH: path.join(paths.dataRoot, "codex-home", "auth.json"),
    GEMINI_HOST_HOME_PATH: paths.geminiSupportHome,
    CODEX_APP_SERVER_PORT: "4590",
    ADMIN_LAUNCHD_LABEL: options.adminLabel,
    WORKER_LAUNCHD_LABEL: options.workerLabel,
    RELEASE_REPO_ROOT: paths.repoRoot,
    RELEASES_ROOT: paths.releasesRoot,
    CURRENT_RELEASE_PATH: paths.currentReleasePath,
    PREVIOUS_RELEASE_PATH: paths.previousReleasePath,
    FAILED_RELEASE_PATH: paths.failedReleasePath,
    BROKER_GEMINI_UI_HELPER: path.join(paths.currentReleasePath, "dist", "src", "tools", "gemini-ui.js")
  };
}

async function installTooling(options) {
  const npmPath = path.join(path.dirname(options.nodePath), "npm");
  runCommand(options.corepackPath, ["enable"]);
  runCommand(options.corepackPath, ["prepare", `pnpm@${options.pnpmVersion}`, "--activate"]);
  runCommand(npmPath, [
    "install",
    "-g",
    "--force",
    `@openai/codex@${options.codexVersion}`,
    `@google/gemini-cli@${options.geminiVersion}`
  ]);
}

async function installRepoAtPath(repoPath, options) {
  runCommand(options.corepackPath, ["pnpm", "install", "--frozen-lockfile"], { cwd: repoPath });
  runCommand(options.corepackPath, ["pnpm", "build"], { cwd: repoPath });
  runCommand(options.corepackPath, ["pnpm", "install", "--prod", "--frozen-lockfile"], { cwd: repoPath });
}

async function prepareSharedHomes(paths) {
  const sourceCodexHome = path.join(os.homedir(), ".codex");
  const sourceGeminiHome = path.join(os.homedir(), ".gemini");
  const sourceGhConfigHome = path.join(os.homedir(), ".config", "gh");
  const sourceAgentsHome = path.join(os.homedir(), ".agents");

  await ensureDir(paths.runtimeSupportRoot);
  await ensureDir(paths.dataRoot);
  await initializeRuntimeData(paths.dataRoot);
  await buildPortableCodexHome(sourceCodexHome, path.join(paths.dataRoot, "codex-home"), paths.dataRoot);
  await buildPortableGeminiHome(sourceGeminiHome, paths.geminiSupportHome);
  await buildPortableGhConfigHome(sourceGhConfigHome, path.join(paths.dataRoot, "runtime-home"));
  await copyDirectoryResolved(sourceAgentsHome, paths.agentsSupportHome);
}

async function ensureInitialWorkerRelease(paths, options) {
  const revision = runCommand("git", ["rev-parse", "HEAD"], { capture: true, cwd: paths.repoRoot });
  const releaseRoot = path.join(paths.releasesRoot, revision);
  await ensureDir(paths.releasesRoot);
  if (!(await fileExists(path.join(releaseRoot, ".git")))) {
    if (await fileExists(releaseRoot)) {
      await fs.rm(releaseRoot, { recursive: true, force: true });
    }
    runCommand("git", ["-C", paths.repoRoot, "worktree", "add", "--detach", releaseRoot, revision]);
  }
  await installRepoAtPath(releaseRoot, options);
  await fs.writeFile(
    path.join(releaseRoot, RELEASE_METADATA_FILENAME),
    `${JSON.stringify(buildReleaseMetadata(revision), null, 2)}\n`,
    "utf8"
  );

  await fs.rm(paths.currentReleasePath, { recursive: true, force: true });
  await fs.symlink(path.relative(path.dirname(paths.currentReleasePath), releaseRoot), paths.currentReleasePath, "dir");
  return {
    revision,
    releaseRoot
  };
}

async function writeLaunchdFiles(paths, options, seedBrokerEnv) {
  const launcherPath = path.join(paths.repoRoot, "scripts", "ops", "macos-launchd-launcher.mjs");
  const adminPlist = renderPlist({
    label: options.adminLabel,
    nodePath: options.nodePath,
    launcherPath,
    repoRootPath: paths.repoRoot,
    envFilePath: paths.adminEnvFile,
    entryPoint: "dist/src/admin-index.js",
    stdoutPath: paths.adminStdoutPath,
    stderrPath: paths.adminStderrPath
  });
  const workerPlist = renderPlist({
    label: options.workerLabel,
    nodePath: options.nodePath,
    launcherPath,
    repoRootPath: paths.currentReleasePath,
    envFilePath: paths.workerEnvFile,
    entryPoint: "dist/src/worker-index.js",
    stdoutPath: paths.workerStdoutPath,
    stderrPath: paths.workerStderrPath
  });

  await ensureDir(path.dirname(paths.adminPlistPath));
  await ensureDir(paths.envDir);
  await fs.writeFile(paths.adminPlistPath, adminPlist, "utf8");
  await fs.writeFile(paths.workerPlistPath, workerPlist, "utf8");
  await fs.writeFile(paths.adminEnvFile, renderEnvFile(buildAdminEnv(paths, options, seedBrokerEnv)), "utf8");
  await fs.writeFile(paths.workerEnvFile, renderEnvFile(buildWorkerEnv(paths, options, seedBrokerEnv)), "utf8");
}

function launchdDomain(label) {
  return `gui/${process.getuid()}/${label}`;
}

function bootout(plistPath) {
  try {
    runCommand("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath]);
  } catch {
    // ignore missing services
  }
}

function bootstrap(plistPath) {
  runCommand("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
}

function kickstart(label) {
  runCommand("launchctl", ["kickstart", "-k", launchdDomain(label)]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = buildPaths(options.serviceRoot, options);
  const existingBrokerEnv = await readExistingBrokerEnv(paths.serviceRoot);
  const seedBrokerEnv = buildSeedBrokerEnv(existingBrokerEnv);
  assertRequiredBrokerEnv(seedBrokerEnv);

  await prepareSharedHomes(paths);
  await installTooling(options);
  await installRepoAtPath(paths.repoRoot, options);
  const initialRelease = await ensureInitialWorkerRelease(paths, options);
  await writeLaunchdFiles(paths, options, seedBrokerEnv);

  bootout(paths.adminPlistPath);
  bootstrap(paths.adminPlistPath);
  kickstart(options.adminLabel);

  if (options.startWorker) {
    bootout(paths.workerPlistPath);
    bootstrap(paths.workerPlistPath);
    kickstart(options.workerLabel);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        serviceRoot: paths.serviceRoot,
        adminPlistPath: paths.adminPlistPath,
        workerPlistPath: paths.workerPlistPath,
        currentReleasePath: paths.currentReleasePath,
        initialRelease,
        workerStarted: options.startWorker
      },
      null,
      2
    )
  );
}

await main();
