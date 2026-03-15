#!/usr/bin/env node

import {
  dockerExecNode,
  getDataRootSource,
  getPublishedPort,
  inspectContainer,
  readDetailedStateFromHost
} from "./lib.mjs";

function parseArgs(argv) {
  const options = {
    containerName: "slack-codex-broker-real",
    openInboundLimit: 20,
    logLineLimit: 40
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }

    switch (argument) {
      case "--container":
        options.containerName = argv[index + 1];
        index += 1;
        break;
      case "--open-inbound-limit":
        options.openInboundLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--log-lines":
        options.logLineLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/ops/status-real.mjs [--container <name>] [--open-inbound-limit <n>] [--log-lines <n>]"
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.openInboundLimit) || options.openInboundLimit < 1) {
    throw new Error("--open-inbound-limit must be a positive number");
  }

  if (!Number.isFinite(options.logLineLimit) || options.logLineLimit < 1) {
    throw new Error("--log-lines must be a positive number");
  }

  return options;
}

async function readHealthSummary(hostPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/`);
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: safeParseJson(body)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readReadySummary(containerName) {
  try {
    return JSON.parse(
      dockerExecNode(
        containerName,
        [
          'fetch("http://127.0.0.1:4590/readyz")',
          "  .then(async (response) => {",
          "    const text = await response.text();",
          "    console.log(JSON.stringify({ ok: response.ok, status: response.status, body: text }));",
          "    if (!response.ok) process.exit(0);",
          "  })",
          "  .catch((error) => {",
          "    console.log(JSON.stringify({ ok: false, error: error.stack || String(error) }));",
          "  });"
        ].join("\n")
      )
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const options = parseArgs(process.argv.slice(2));
const inspect = inspectContainer(options.containerName);
const hostPort = getPublishedPort(inspect);
const dataRootSource = getDataRootSource(inspect);
const detailedState = await readDetailedStateFromHost(dataRootSource, {
  openInboundLimit: options.openInboundLimit,
  logLineLimit: options.logLineLimit
});
const health = await readHealthSummary(hostPort);
const ready = readReadySummary(options.containerName);

console.log(
  JSON.stringify(
    {
      container: {
        name: options.containerName,
        status: inspect.State?.Status ?? null,
        running: inspect.State?.Running ?? null,
        startedAt: inspect.State?.StartedAt ?? null,
        restartCount: inspect.RestartCount ?? 0,
        hostPort,
        dataRootSource
      },
      health,
      ready,
      state: detailedState
    },
    null,
    2
  )
);
