#!/usr/bin/env node

import {
  getPublishedPort,
  inspectContainer
} from "./lib.mjs";

function parseArgs(argv) {
  const options = {
    containerName: "slack-codex-broker-real",
    channelId: undefined,
    threadTs: undefined,
    forceReset: true
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
      case "--channel-id":
        options.channelId = argv[index + 1];
        index += 1;
        break;
      case "--thread-ts":
        options.threadTs = argv[index + 1];
        index += 1;
        break;
      case "--no-force-reset":
        options.forceReset = false;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: node scripts/ops/resume-real.mjs --channel-id <id> --thread-ts <ts> [--container <name>] [--no-force-reset]"
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.channelId || !options.threadTs) {
    throw new Error("Missing required arguments: --channel-id and --thread-ts");
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const inspect = inspectContainer(options.containerName);
const hostPort = getPublishedPort(inspect);
const body = new URLSearchParams({
  channel_id: options.channelId,
  thread_ts: options.threadTs,
  force_reset: options.forceReset ? "true" : "false"
});

const response = await fetch(`http://127.0.0.1:${hostPort}/slack/resume-pending-session`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded"
  },
  body: body.toString()
});
const payload = await response.json();

if (!response.ok || !payload?.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
