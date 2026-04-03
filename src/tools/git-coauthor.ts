#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

interface ParsedArgs {
  readonly action: "commit-msg";
  readonly commitMessagePath: string;
}

export async function runCommitMsgHook(options: {
  readonly brokerApiBase: string;
  readonly cwd: string;
  readonly commitMessagePath: string;
}): Promise<void> {
  const commitMessage = await fs.readFile(options.commitMessagePath, "utf8");
  const primaryAuthorEmail =
    normalizeOptionalString(process.env.GIT_AUTHOR_EMAIL) ??
    readGitConfig(options.cwd, "user.email") ??
    undefined;

  const response = await fetch(`${options.brokerApiBase}/slack/git-coauthors/resolve-commit-message`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      cwd: options.cwd,
      commit_message: commitMessage,
      primary_author_email: primaryAuthorEmail
    })
  });
  const payload = await response.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    message?: string;
    status?: string;
    commitMessage?: string;
    commit_message?: string;
  };

  if (!response.ok) {
    throw new Error(payload.message || payload.error || `co-author helper failed (${response.status})`);
  }

  const nextCommitMessage = normalizeOptionalString(payload.commitMessage) ?? normalizeOptionalString(payload.commit_message);
  if (!nextCommitMessage || nextCommitMessage === commitMessage) {
    return;
  }

  await fs.writeFile(options.commitMessagePath, `${nextCommitMessage.replace(/\s+$/u, "")}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const brokerApiBase = normalizeOptionalString(process.env.BROKER_API_BASE);
  if (!brokerApiBase) {
    return;
  }

  if (parsed.action === "commit-msg") {
    await runCommitMsgHook({
      brokerApiBase,
      cwd: process.cwd(),
      commitMessagePath: path.resolve(parsed.commitMessagePath)
    });
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const action = argv[0];
  const commitMessagePath = argv[1];
  if (action !== "commit-msg" || !commitMessagePath) {
    throw new Error("usage: git-coauthor commit-msg <commit-message-path>");
  }

  return {
    action,
    commitMessagePath
  };
}

function readGitConfig(cwd: string, key: string): string | null {
  const result = spawnSync("git", ["config", "--get", key], {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }

  return normalizeOptionalString(result.stdout) ?? null;
}

function normalizeOptionalString(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
