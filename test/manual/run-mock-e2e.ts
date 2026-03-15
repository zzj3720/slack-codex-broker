import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { MockSlackServer } from "./mock-slack-server.js";

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-broker-e2e-"));
  const stateDir = path.join(tempRoot, "state");
  const sessionsRoot = path.join(tempRoot, "sessions");
  const reposRoot = path.join(tempRoot, "repos");
  const codexHome = path.join(tempRoot, "codex-home");
  const mockSlack = new MockSlackServer("UBOT");

  const slackPort = await mockSlack.start();
  await fs.mkdir(reposRoot, { recursive: true });

  const child = spawn(
    "pnpm",
    ["exec", "tsx", "src/index.ts"],
    {
      cwd: path.resolve(""),
      env: {
        ...process.env,
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}/api`,
        SLACK_SOCKET_OPEN_URL: "apps.connections.open",
        SLACK_INITIAL_THREAD_HISTORY_COUNT: "1",
        SLACK_HISTORY_API_MAX_LIMIT: "20",
        STATE_DIR: stateDir,
        SESSIONS_ROOT: sessionsRoot,
        REPOS_ROOT: reposRoot,
        CODEX_HOME: codexHome,
        CODEX_AUTH_JSON_PATH: path.join(os.homedir(), ".codex", "auth.json"),
        PORT: "3300",
        DEBUG: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await mockSlack.waitForSocket();
    await waitForHttpReady("http://127.0.0.1:3300");

    await mockSlack.sendEvent("evt-pre-1", {
      type: "message",
      user: "U123",
      channel: "C123",
      ts: "111.220",
      text: "ROOT_CONTEXT_ABC"
    });
    await mockSlack.sendEvent("evt-pre-2", {
      type: "message",
      user: "U234",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.221",
      text: "RECENT_CONTEXT_DEF"
    });
    console.log("Sent pre-thread history");

    const historyResponse = await fetch(
      "http://127.0.0.1:3300/slack/thread-history?channel_id=C123&thread_ts=111.220&before_ts=111.221&limit=1&format=text"
    );
    const historyText = await historyResponse.text();
    if (!historyText.includes("ROOT_CONTEXT_ABC")) {
      throw new Error(`Expected history API to include ROOT_CONTEXT_ABC, got: ${historyText}`);
    }

    await mockSlack.sendEvent("evt-1", {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.222",
      text: "<@UBOT> Reply with exactly ROOT_CONTEXT_ABC. If it is not already in the visible backfilled Slack history, use curl against the local broker API to fetch older thread history first."
    });
    console.log("Sent evt-1");

    await mockSlack.waitForPostedMessage((message) => message.text.includes("Session ready."));
    const firstReply = await mockSlack.waitForPostedMessage((message) => message.text.includes("ROOT_CONTEXT_ABC"));
    console.log("First reply:", firstReply.text);

    await mockSlack.sendEvent("evt-2", {
      type: "message",
      user: "U123",
      channel: "C123",
      thread_ts: "111.220",
      ts: "111.223",
      text: "Reply with exactly the sender display name from the Slack metadata header."
    });
    console.log("Sent evt-2");

    const secondReply = await mockSlack.waitForPostedMessage((message) => message.text.includes("Mock Display 123"));
    console.log("Second reply:", secondReply.text);

    await mockSlack.sendEvent("evt-3", {
      type: "message",
      user: "U123",
      channel: "C123",
      thread_ts: "111.220",
      text: "Run the shell command `sleep 20` before replying."
    });
    console.log("Sent evt-3");

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await mockSlack.sendEvent("evt-4", {
      type: "message",
      user: "U123",
      channel: "C123",
      thread_ts: "111.220",
      text: "-stop"
    });
    console.log("Sent evt-4");

    const stopReply = await mockSlack.waitForPostedMessage((message) => message.text.includes("Stopped the current run."));
    console.log("Stop reply:", stopReply.text);

    await mockSlack.sendEvent("evt-5", {
      type: "message",
      user: "U234",
      channel: "D123",
      channel_type: "im",
      ts: "222.333",
      text: "Reply with exactly the sender user id from the Slack metadata header."
    });
    console.log("Sent evt-5");

    await mockSlack.waitForPostedMessage((message) => message.channel === "D123" && message.text.includes("Session ready."));
    const dmReply = await mockSlack.waitForPostedMessage((message) => message.channel === "D123" && message.text.includes("U234"));
    console.log("DM reply:", dmReply.text);
    console.log("Mock end-to-end flow passed.");
  } finally {
    child.kill("SIGTERM");
    await mockSlack.stop();
  }
}

async function waitForHttpReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for HTTP readiness: ${url}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
