import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SlackUserIdentity } from "../../types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(moduleDir, "prompts", "slack-thread-base-instructions.md");

let templateCache: Promise<string> | undefined;

export interface BuildSlackThreadBaseInstructionsOptions {
  readonly brokerHttpBaseUrl: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly workspacePath: string;
  readonly reposRoot: string;
  readonly codexGeneratedImagesRoot: string;
  readonly slackBotIdentity: SlackUserIdentity | null;
  readonly personalMemory?: string | undefined;
}

export async function buildSlackThreadBaseInstructions(
  options: BuildSlackThreadBaseInstructionsOptions
): Promise<string> {
  const template = await loadTemplate();
  const linearToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=linear`;
  const notionToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=notion`;
  const messagePayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    text: "replace with your Slack update",
    kind: "progress"
  });
  const waitStatePayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    kind: "wait",
    reason: "replace with what you are waiting for"
  });
  const finalStatePayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    kind: "final"
  });
  const blockStatePayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    kind: "block",
    reason: "replace with the blocker"
  });
  const filePayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    file_path: "/absolute/path/to/file.png",
    initial_comment: "replace with your Slack file caption"
  });
  const coauthorConfigurePayload = JSON.stringify({
    cwd: options.workspacePath,
    coauthors: ["Alice Example"],
    ignore_missing: true,
    mappings: [
      {
        slack_user: "Alice Example",
        github_author: "Alice Example <alice@example.com>"
      }
    ]
  });
  const linearCallPayload = JSON.stringify({
    server: "linear",
    name: "replace_with_linear_tool_name",
    arguments: {
      replace: "with tool arguments"
    }
  });
  const notionCallPayload = JSON.stringify({
    server: "notion",
    name: "replace_with_notion_tool_name",
    arguments: {
      replace: "with tool arguments"
    }
  });
  const jobPayload = JSON.stringify({
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    kind: "watch_ci",
    cwd: ".",
    script: "#!/usr/bin/env bash\nset -euo pipefail\nnode \"$BROKER_JOB_HELPER\" event --kind \"state_changed\" --summary \"replace with your update\"\nnode \"$BROKER_JOB_HELPER\" complete --summary \"replace with your completion update\""
  });

  return renderTemplate(template, {
    execution_environment_section: await buildExecutionEnvironmentSection(),
    session_workspace: options.workspacePath,
    shared_repos_root: options.reposRoot,
    codex_generated_images_root: options.codexGeneratedImagesRoot,
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    post_message_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/post-message -H 'content-type: application/json' -d '${messagePayload}'`,
    post_state_final_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/post-state -H 'content-type: application/json' -d '${finalStatePayload}'`,
    post_state_wait_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/post-state -H 'content-type: application/json' -d '${waitStatePayload}'`,
    post_state_block_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/post-state -H 'content-type: application/json' -d '${blockStatePayload}'`,
    post_file_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/post-file -H 'content-type: application/json' -d '${filePayload}'`,
    coauthor_status_command:
      `curl -sS '${options.brokerHttpBaseUrl}/slack/git-coauthors/session-status?cwd=${encodeURIComponent(options.workspacePath)}'`,
    coauthor_configure_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/git-coauthors/configure-session -H 'content-type: application/json' -d '${coauthorConfigurePayload}'`,
    thread_history_command:
      `curl -sS '${options.brokerHttpBaseUrl}/slack/thread-history?channel_id=${encodeURIComponent(options.channelId)}&thread_ts=${encodeURIComponent(options.rootThreadTs)}&before_ts=older-message-ts&limit=20&format=text'`,
    register_job_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/jobs/register -H 'content-type: application/json' -d '${jobPayload}'`,
    linear_tools_command: `curl -sS '${linearToolsUrl}'`,
    notion_tools_command: `curl -sS '${notionToolsUrl}'`,
    linear_call_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${linearCallPayload}'`,
    notion_call_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${notionCallPayload}'`,
    slack_bot_identity_section: formatSlackBotIdentitySection(options.slackBotIdentity),
    personal_memory_section: formatPersonalMemorySection(options.personalMemory)
  });
}

async function loadTemplate(): Promise<string> {
  if (!templateCache) {
    templateCache = fs.readFile(templatePath, "utf8");
  }

  return await templateCache;
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  const rendered = template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Missing prompt template variable: ${key}`);
    }

    return value;
  });

  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

async function buildExecutionEnvironmentSection(): Promise<string> {
  const runtimePlatform = process.platform;
  const runtimeHostname = os.hostname();
  const runtimeContainerized = await isContainerizedRuntime();

  return [
    "Current execution environment:",
    `- runtime_platform: ${runtimePlatform}`,
    `- runtime_hostname: ${runtimeHostname}`,
    `- runtime_containerized: ${runtimeContainerized}`,
    "- Shell commands, file edits, git, gh, clone, and worktree operations happen in this runtime.",
    "- Verify platform-specific app/runtime behavior from the runtime you can actually observe. Do not assume a different host environment unless the user explicitly gives you one."
  ].join("\n");
}

function formatSlackBotIdentitySection(identity: SlackUserIdentity | null): string {
  if (!identity) {
    return "Slack bot identity: when a Slack message mentions the bot user for this broker, that mention refers to you.";
  }

  const lines = [
    "Slack bot identity in this workspace:",
    `- bot_user_id: ${identity.userId}`,
    `- bot_mention: ${identity.mention}`
  ];

  if (identity.displayName) {
    lines.push(`- bot_display_name: ${identity.displayName}`);
  }

  if (identity.realName && identity.realName !== identity.displayName) {
    lines.push(`- bot_real_name: ${identity.realName}`);
  }

  if (identity.username && identity.username !== identity.displayName) {
    lines.push(`- bot_username: ${identity.username}`);
  }

  lines.push("- If a Slack message mentions this bot identity, that mention refers to you.");
  return lines.join("\n");
}

function formatPersonalMemorySection(personalMemory?: string): string {
  const normalized = personalMemory?.trim();
  if (!normalized) {
    return "";
  }

  return `Personal long-lived memory from ~/.codex/AGENT.md:\n${normalized}`;
}

async function isContainerizedRuntime(): Promise<boolean> {
  if (process.env.CONTAINER?.trim() || process.env.KUBERNETES_SERVICE_HOST?.trim()) {
    return true;
  }

  if (await pathExists("/.dockerenv")) {
    return true;
  }

  if (await pathExists("/run/.containerenv")) {
    return true;
  }

  if (process.platform === "linux") {
    const cgroupText = await fs.readFile("/proc/1/cgroup", "utf8").catch(() => "");
    if (/(docker|containerd|kubepods|podman|lxc)/i.test(cgroupText)) {
      return true;
    }
  }

  return false;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
