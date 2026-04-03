import os from "node:os";
import path from "node:path";

import { AppServerProcess } from "../../src/services/codex/app-server-process.js";
import { AppServerClient } from "../../src/services/codex/app-server-client.js";

async function main(): Promise<void> {
  const codexHome = path.join(os.tmpdir(), `codex-smoke-${Date.now()}`);
  const processManager = new AppServerProcess({
    brokerHttpBaseUrl: "http://127.0.0.1:3300",
    codexHome,
    port: 4599,
    authJsonPath: path.join(os.homedir(), ".codex", "auth.json")
  });
  const client = new AppServerClient({
    url: processManager.url,
    serviceName: "codex-smoke",
    brokerHttpBaseUrl: "http://127.0.0.1:3300",
    reposRoot: path.join(codexHome, "repos")
  });

  await processManager.start();

  try {
    await client.connect();
    await client.ensureAuthenticated();

    const threadId = await client.ensureThread({
      channelId: "C-SMOKE",
      rootThreadTs: "thread-smoke",
      workspacePath: process.cwd()
    });

    const started = await client.startTurn(threadId, process.cwd(), [
      {
        type: "text",
        text: "Reply with REAL_SMOKE_OK only.",
        text_elements: []
      }
    ]);
    const result = await started.completion;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
    await processManager.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
