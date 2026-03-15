#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  checkContainer,
  createTempEnvFile,
  getRunArgumentsFromInspect,
  inspectContainer,
  readSessionStatsFromHost,
  repoRoot,
  runCommand,
  writeRolloutMetadata,
  getDataRootSource
} from "./lib.mjs";

function parseArgs(argv) {
  const options = {
    containerName: "slack-codex-broker-real",
    imageName: "slack-codex-broker:latest",
    skipBuild: false,
    skipTests: false,
    skipChecks: false,
    allowActive: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--container":
        options.containerName = argv[index + 1];
        index += 1;
        break;
      case "--image":
        options.imageName = argv[index + 1];
        index += 1;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--skip-tests":
        options.skipTests = true;
        break;
      case "--skip-checks":
        options.skipChecks = true;
        break;
      case "--allow-active":
        options.allowActive = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/ops/rollout-real.mjs [--container <name>] [--image <name>] [--skip-build] [--skip-tests] [--skip-checks] [--allow-active]"
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function assertNoActiveSessions(containerName, allowActive) {
  const inspect = inspectContainer(containerName);
  const sessionStats = await readSessionStatsFromHost(getDataRootSource(inspect));
  if (!allowActive && sessionStats.activeCount > 0) {
    throw new Error(
      `Refusing rollout while active sessions exist (activeCount=${sessionStats.activeCount}). Re-run with --allow-active if you really want to interrupt them.`
    );
  }

  return sessionStats;
}

const options = parseArgs(process.argv.slice(2));
const beforeStats = await assertNoActiveSessions(options.containerName, options.allowActive);

if (!options.skipBuild) {
  runCommand("pnpm", ["build"]);
}

if (!options.skipTests) {
  runCommand("pnpm", ["test"]);
}

runCommand("docker", ["build", "-t", options.imageName, "."]);

const inspect = inspectContainer(options.containerName);
const { envFile, cleanup } = await createTempEnvFile(inspect);
const { mountArgs, portArgs, restartPolicy } = getRunArgumentsFromInspect(inspect);

const rolloutStamp = new Date().toISOString().replace(/[:.]/g, "-");
const rolloutDir = path.join(repoRoot, ".backups", "rollouts", rolloutStamp);
await writeRolloutMetadata(rolloutDir, {
  containerName: options.containerName,
  imageName: options.imageName,
  beforeStats,
  restartPolicy,
  startedAt: new Date().toISOString()
});
await fs.writeFile(
  path.join(rolloutDir, "logs-before.txt"),
  `${runCommand("docker", ["logs", "--tail", "200", options.containerName], { capture: true })}\n`
);

try {
  const latestStats = await assertNoActiveSessions(options.containerName, options.allowActive);
  await writeRolloutMetadata(rolloutDir, {
    containerName: options.containerName,
    imageName: options.imageName,
    beforeStats: latestStats,
    restartPolicy,
    startedAt: new Date().toISOString()
  });

  runCommand("docker", ["rm", "-f", options.containerName]);

  const dockerArgs = [
    "run",
    "-d",
    "--name",
    options.containerName,
    "--restart",
    restartPolicy,
    "--env-file",
    envFile,
    ...portArgs,
    ...mountArgs,
    options.imageName
  ];
  const containerId = runCommand("docker", dockerArgs, { capture: true });

  let summary = undefined;
  if (!options.skipChecks) {
    summary = await checkContainer(options.containerName);
    await writeRolloutMetadata(rolloutDir, {
      containerName: options.containerName,
      imageName: options.imageName,
      beforeStats: latestStats,
      restartPolicy,
      startedAt: new Date().toISOString(),
      containerId,
      checkSummary: summary
    });
  }

  console.log(
    JSON.stringify(
      {
        containerId,
        rolloutDir,
        checkSummary: summary
      },
      null,
      2
    )
  );
} finally {
  await cleanup();
}

