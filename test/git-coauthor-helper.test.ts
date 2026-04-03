import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendCoAuthorTrailers } from "../src/services/git/github-author-utils.js";
import { runCommitMsgHook } from "../src/tools/git-coauthor.js";

describe("git coauthor helper", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true
    })));
  });

  it("appends co-author trailers idempotently and skips the primary author email", () => {
    const message = appendCoAuthorTrailers("feat(test): demo\n", {
      primaryAuthorEmail: "alice@example.com",
      coAuthors: [
        "Alice Example <alice@example.com>",
        "Bob Example <bob@example.com>",
        "Bob Example <bob@example.com>"
      ]
    });

    expect(message).not.toContain("Alice Example <alice@example.com>");
    expect(message).toContain("Co-authored-by: Bob Example <bob@example.com>");
    expect(message.match(/Co-authored-by:/g)).toHaveLength(1);
  });

  it("rewrites the commit message file with the broker-resolved trailers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-coauthor-helper-"));
    tempDirs.push(tempDir);
    const messagePath = path.join(tempDir, "COMMIT_EDITMSG");
    await fs.writeFile(messagePath, "feat(test): demo\n");

    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(JSON.stringify({
        ok: true,
        status: "resolved",
        commitMessage: "feat(test): demo\n\nCo-authored-by: Bob Example <bob@example.com>\n"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }));

    await runCommitMsgHook({
      brokerApiBase: "http://127.0.0.1:3000",
      cwd: tempDir,
      commitMessagePath: messagePath
    });

    await expect(fs.readFile(messagePath, "utf8")).resolves.toContain(
      "Co-authored-by: Bob Example <bob@example.com>"
    );
  });
});
