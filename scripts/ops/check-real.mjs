#!/usr/bin/env node

import { checkContainer } from "./lib.mjs";

function parseArgs(argv) {
  let containerName = "slack-codex-broker-real";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--container") {
      containerName = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/ops/check-real.mjs [--container <name>]");
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    containerName
  };
}

const options = parseArgs(process.argv.slice(2));
const summary = await checkContainer(options.containerName);
console.log(JSON.stringify(summary, null, 2));

