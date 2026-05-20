import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("macOS bootstrap", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("writes admin, worker, and cloudflared LaunchDaemons that do not depend on a GUI launchd domain", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-bootstrap-"));
    tempDirs.push(tempRoot);

    const home = path.join(tempRoot, "home");
    const fakeBin = path.join(tempRoot, "bin");
    const serviceRoot = path.join(tempRoot, "service");
    const daemonDir = path.join(tempRoot, "LaunchDaemons");
    const commandLog = path.join(tempRoot, "commands.log");
    const packageVersion = "0.2.0";

    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(path.join(serviceRoot, "config"), { recursive: true });
    await fs.writeFile(
      path.join(serviceRoot, "config", "broker.env"),
      [
        "SLACK_APP_TOKEN=\"xapp-from-broker-env\"",
        "SLACK_BOT_TOKEN=\"xoxb-from-broker-env\"",
        "DISK_CLEANUP_MIN_FREE_BYTES=\"21474836480\"",
        "DISK_CLEANUP_TARGET_FREE_BYTES=\"32212254720\"",
        "LOG_RAW_MAX_BYTES=\"65536\"",
        "ADMIN_BASE_URL=\"https://admin.example.test\"",
        "BROKER_DEFAULT_GITHUB_LOGIN=\"default-pr-account\"",
        "BROKER_DEFAULT_GITHUB_TOKEN=\"default-pr-token\"",
        "GH_TOKEN=\"legacy-gh-token\"",
        "GITHUB_TOKEN=\"legacy-github-token\"",
        "CLOUDFLARED_TUNNEL_TOKEN=\"cloudflared-test-token\"",
        "CURRENT_RELEASE_PATH=\"stale-single-release-path\""
      ].join("\n") + "\n",
      "utf8"
    );
    await writeExecutable(path.join(fakeBin, "npm"), fakeNpmScript());
    await writeExecutable(path.join(fakeBin, "launchctl"), fakeCommandScript("launchctl"));
    await writeExecutable(path.join(fakeBin, "node"), fakeCommandScript("node"));
    await writeExecutable(path.join(fakeBin, "cloudflared"), fakeCommandScript("cloudflared"));

    const childEnv = { ...process.env };
    for (const key of [
      "ADMIN_BASE_URL",
      "BROKER_DEFAULT_GITHUB_LOGIN",
      "BROKER_DEFAULT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CLOUDFLARED_TUNNEL_TOKEN",
      "CURRENT_RELEASE_PATH"
    ]) {
      delete childEnv[key];
    }

    const result = await runNodeScript(
      [
        "scripts/ops/macos-bootstrap.mjs",
        "--service-root",
        serviceRoot,
        "--label",
        "test.admin",
        "--worker-label",
        "test.worker",
        "--node-path",
        path.join(fakeBin, "node"),
        "--npm-path",
        path.join(fakeBin, "npm"),
        "--launchd-daemon-dir",
        daemonDir,
        "--run-user",
        "test-admin",
        "--cloudflared-label",
        "test.cloudflared",
        "--cloudflared-path",
        path.join(fakeBin, "cloudflared"),
        "--package-version",
        packageVersion,
        "--start-worker"
      ],
      {
        ...childEnv,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        FAKE_COMMAND_LOG: commandLog
      }
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      serviceRoot,
      currentAdminReleasePath: path.join(serviceRoot, "current-admin"),
      currentWorkerReleasePath: path.join(serviceRoot, "current-worker"),
      workerStarted: true,
      cloudflaredStarted: true
    });

    const currentAdminReleasePath = path.join(serviceRoot, "current-admin");
    const currentWorkerReleasePath = path.join(serviceRoot, "current-worker");
    const adminReleaseRoot = path.join(serviceRoot, "releases", "admin", `npm-${packageVersion}`, "node_modules", "@agent-session-broker", "admin");
    const workerReleaseRoot = path.join(serviceRoot, "releases", "worker", `npm-${packageVersion}`, "node_modules", "@agent-session-broker", "worker");
    await expect(fs.readlink(currentAdminReleasePath)).resolves.toBe(path.relative(serviceRoot, adminReleaseRoot));
    await expect(fs.readlink(currentWorkerReleasePath)).resolves.toBe(path.relative(serviceRoot, workerReleaseRoot));

    const adminPlist = await fs.readFile(path.join(daemonDir, "test.admin.plist"), "utf8");
    const workerPlist = await fs.readFile(path.join(daemonDir, "test.worker.plist"), "utf8");
    const cloudflaredPlist = await fs.readFile(path.join(daemonDir, "test.cloudflared.plist"), "utf8");
    const adminEnv = await fs.readFile(path.join(serviceRoot, "config", "admin.env"), "utf8");
    const workerEnv = await fs.readFile(path.join(serviceRoot, "config", "worker.env"), "utf8");
    const adminLauncherPath = path.join(currentAdminReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
    const workerLauncherPath = path.join(currentWorkerReleasePath, "scripts", "ops", "macos-launchd-launcher.mjs");
    const adminPlistPath = path.join(daemonDir, "test.admin.plist");
    const workerPlistPath = path.join(daemonDir, "test.worker.plist");

    expectLaunchdRuntime(adminPlist, {
      launcherPath: adminLauncherPath,
      repoRootPath: currentAdminReleasePath,
      entryPoint: "dist/src/admin-index.js",
      runUser: "test-admin",
      home
    });
    expectLaunchdRuntime(workerPlist, {
      launcherPath: workerLauncherPath,
      repoRootPath: currentWorkerReleasePath,
      entryPoint: "dist/src/worker-index.js",
      runUser: "test-admin",
      home
    });
    expect(cloudflaredPlist).toContain("<key>UserName</key>");
    expect(cloudflaredPlist).toContain("<string>test-admin</string>");
    expect(cloudflaredPlist).toContain(`<string>${path.join(fakeBin, "cloudflared")}</string>`);
    expect(cloudflaredPlist).toContain("<string>--url</string>");
    expect(cloudflaredPlist).toContain("<string>http://127.0.0.1:3000</string>");
    expect(cloudflaredPlist).toContain("<string>--token</string>");
    expect(cloudflaredPlist).toContain("<string>cloudflared-test-token</string>");
    expect(adminEnv).toContain(`ADMIN_PLIST_PATH="${adminPlistPath}"`);
    expect(adminEnv).toContain(`WORKER_PLIST_PATH="${workerPlistPath}"`);
    for (const envText of [adminEnv, workerEnv]) {
      expect(envText).toContain('DISK_CLEANUP_MIN_FREE_BYTES="21474836480"');
      expect(envText).toContain('DISK_CLEANUP_TARGET_FREE_BYTES="32212254720"');
      expect(envText).toContain('LOG_RAW_MAX_BYTES="65536"');
      expect(envText).toContain('ADMIN_BASE_URL="https://admin.example.test"');
      expect(envText).not.toContain('ADMIN_BASE_URL="http://127.0.0.1:3000"');
      expect(envText).toContain('BROKER_DEFAULT_GITHUB_LOGIN="default-pr-account"');
      expect(envText).toContain('BROKER_DEFAULT_GITHUB_TOKEN="default-pr-token"');
      expect(envText).toContain(`CODEX_TEAM_HOME="${path.join(serviceRoot, ".data", "team-codex-home")}"`);
      expect(envText).toContain('GH_TOKEN="legacy-gh-token"');
      expect(envText).toContain('GITHUB_TOKEN="legacy-github-token"');
      expect(envText).not.toContain("CURRENT_RELEASE_PATH");
    }

    const commands = await fs.readFile(commandLog, "utf8");
    expect(commands).toContain(`launchctl bootstrap system ${adminPlistPath}`);
    expect(commands).toContain(`launchctl kickstart -k system/test.admin`);
    expect(commands).toContain(`launchctl bootstrap system ${workerPlistPath}`);
    expect(commands).toContain(`launchctl kickstart -k system/test.worker`);
    expect(commands).toContain(`launchctl bootstrap system ${path.join(daemonDir, "test.cloudflared.plist")}`);
    expect(commands).not.toContain("gui/");
    await expect(fs.stat(path.join(home, "Library", "LaunchAgents", "test.admin.plist"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, `${content}\n`, "utf8");
  await fs.chmod(filePath, 0o755);
}

function fakeCommandScript(command: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `echo "${command} $*" >> "$FAKE_COMMAND_LOG"`
  ].join("\n");
}

function fakeNpmScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "echo \"npm $*\" >> \"$FAKE_COMMAND_LOG\"",
    "if [ \"${1:-}\" = \"install\" ] && [ \"${2:-}\" = \"--prefix\" ]; then",
    "  prefix=\"$3\"",
    "  last=\"\"",
    "  for arg in \"$@\"; do last=\"$arg\"; done",
    "  version=\"${last##*@}\"",
    "  package_name=\"${last%@*}\"",
    "  package_path=\"$(printf '%s' \"$package_name\" | sed 's#/# #g')\"",
    "  set -- $package_path",
    "  package_root=\"$prefix/node_modules/$1/$2\"",
    "  mkdir -p \"$package_root/dist/src\" \"$package_root/scripts/ops\"",
    "  if [ \"$package_name\" = \"@agent-session-broker/admin\" ]; then",
    "    mkdir -p \"$package_root/dist/admin-ui\"",
    "    : > \"$package_root/dist/src/admin-index.js\"",
    "    : > \"$package_root/dist/admin-ui/index.html\"",
    "    : > \"$package_root/scripts/ops/macos-bootstrap.mjs\"",
    "  fi",
    "  if [ \"$package_name\" = \"@agent-session-broker/worker\" ]; then",
    "    : > \"$package_root/dist/src/worker-index.js\"",
    "  fi",
    "  : > \"$package_root/scripts/ops/macos-launchd-launcher.mjs\"",
    "  : > \"$package_root/scripts/ops/macos-launchd-restart.mjs\"",
    "  printf '{\"name\":\"%s\",\"version\":\"%s\"}\\n' \"$package_name\" \"$version\" > \"$package_root/package.json\"",
    "fi"
  ].join("\n");
}

function runNodeScript(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({
        status,
        stdout,
        stderr
      });
    });
  });
}

function expectLaunchdRuntime(
  plist: string,
  expected: {
    readonly launcherPath: string;
    readonly repoRootPath: string;
    readonly entryPoint: string;
    readonly runUser: string;
    readonly home: string;
  }
): void {
  expect(plist).toContain("<key>UserName</key>");
  expect(plist).toContain(`<string>${expected.runUser}</string>`);
  expect(plist).toContain("<key>EnvironmentVariables</key>");
  expect(plist).toContain("<key>HOME</key>");
  expect(plist).toContain(`<string>${expected.home}</string>`);
  expect(plist).toContain(`<string>${expected.launcherPath}</string>`);
  expect(plist).toContain([
    "    <string>--repo-root</string>",
    `    <string>${expected.repoRootPath}</string>`
  ].join("\n"));
  expect(plist).toContain([
    "    <string>--entry-point</string>",
    `    <string>${expected.entryPoint}</string>`
  ].join("\n"));
  expect(plist).toContain([
    "  <key>WorkingDirectory</key>",
    `  <string>${expected.repoRootPath}</string>`
  ].join("\n"));
}
