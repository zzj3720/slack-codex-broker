import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";

describe("GitHubAuthorMappingService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true
    })));
  });

  it("infers mappings from Slack profile email and preserves manual overrides", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-author-mappings-"));
    tempDirs.push(stateDir);

    const service = new GitHubAuthorMappingService({
      stateDir
    });
    await service.load();

    const inferred = await service.recordObservedIdentity({
      userId: "U123",
      mention: "<@U123>",
      username: "alice",
      displayName: "Alice Slack",
      realName: "Alice Example",
      email: "alice@example.com"
    });
    expect(inferred).toMatchObject({
      slackUserId: "U123",
      githubAuthor: "Alice Example <alice@example.com>",
      source: "slack_inferred"
    });

    const manual = await service.upsertManualMapping({
      slackUserId: "U123",
      githubAuthor: "Alice Manual <manual@example.com>"
    });
    expect(manual).toMatchObject({
      slackUserId: "U123",
      githubAuthor: "Alice Manual <manual@example.com>",
      source: "manual"
    });

    const afterManual = await service.recordObservedIdentity({
      userId: "U123",
      mention: "<@U123>",
      username: "alice-updated",
      displayName: "Alice Updated",
      realName: "Alice Updated",
      email: "alice-updated@example.com"
    });
    expect(afterManual).toMatchObject({
      githubAuthor: "Alice Manual <manual@example.com>",
      source: "manual",
      slackIdentity: {
        userId: "U123",
        email: "alice-updated@example.com"
      }
    });
  });
});
