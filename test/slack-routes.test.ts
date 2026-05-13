import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { handleSlackRequest } from "../src/http/slack-routes.js";

function createJsonRequest(body: unknown) {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
  };
  request.headers = {
    "content-type": "application/json"
  };
  request.end(JSON.stringify(body));
  return request;
}

function createResponse() {
  const chunks: Buffer[] = [];

  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    }
  }) as Writable & {
    statusCode: number;
    writeHead: (code: number) => typeof response;
    end: (chunk?: string | Uint8Array) => typeof response;
    bodyText?: string;
  };

  response.statusCode = 200;
  response.writeHead = (code) => {
    response.statusCode = code;
    return response;
  };
  response.end = (chunk) => {
    if (chunk) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    response.bodyText = Buffer.concat(chunks).toString("utf8");
    return response;
  };

  return response;
}

describe("handleSlackRequest", () => {
  it("treats blank co-author arrays as omitted in configure-session", async () => {
    const configureSessionCoauthors = vi.fn(async () => ({
      sessionKey: "session-key",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace",
      selectionMode: "default_all_candidates",
      ignoreMissing: false,
      needsUserInput: false,
      canCommitDirectly: true,
      selectedUserIds: [],
      resolvedCoAuthors: [],
      missingSelectedUserIds: [],
      candidates: []
    }));

    const request = createJsonRequest({
      cwd: "/tmp/workspace",
      coauthors: ["   "],
      user_ids: [""]
    });
    const response = createResponse();

    const handled = await handleSlackRequest(
      "POST",
      new URL("http://localhost/slack/git-coauthors/configure-session"),
      request as never,
      response as never,
      {
        bridge: {
          configureSessionCoauthors
        } as never,
        config: {} as never
      }
    );

    expect(handled).toBe(true);
    expect(configureSessionCoauthors).toHaveBeenCalledWith({
      cwd: "/tmp/workspace",
      coauthors: undefined,
      userIds: undefined,
      ignoreMissing: undefined,
      mappings: undefined
    });
    expect(response.statusCode).toBe(200);
  });

  it("resolves GitHub PR tokens through the bridge", async () => {
    const resolveGitHubPrToken = vi.fn(async () => ({
      ok: true,
      mode: "initiator",
      slackUserId: "U_STARTER",
      githubLogin: "alice",
      token: "alice-token"
    }));
    const request = createJsonRequest({
      cwd: "/tmp/session/workspace",
      command: ["pr", "create", "--fill"]
    });
    const response = createResponse();

    const handled = await handleSlackRequest(
      "POST",
      new URL("http://localhost/slack/github-token/resolve"),
      request as never,
      response as never,
      {
        bridge: {
          resolveGitHubPrToken
        } as never,
        config: {} as never
      }
    );

    expect(handled).toBe(true);
    expect(resolveGitHubPrToken).toHaveBeenCalledWith({
      cwd: "/tmp/session/workspace",
      command: ["pr", "create", "--fill"]
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.bodyText || "{}")).toMatchObject({
      ok: true,
      githubLogin: "alice",
      token: "alice-token"
    });
  });

  it("returns a blocking status when GitHub PR token resolution is blocked", async () => {
    const resolveGitHubPrToken = vi.fn(async () => ({
      ok: false,
      mode: "blocked",
      reason: "initiator_token_invalid",
      message: "GitHub token for alice is invalid."
    }));
    const request = createJsonRequest({
      cwd: "/tmp/session/workspace",
      command: ["pr", "create"]
    });
    const response = createResponse();

    const handled = await handleSlackRequest(
      "POST",
      new URL("http://localhost/slack/github-token/resolve"),
      request as never,
      response as never,
      {
        bridge: {
          resolveGitHubPrToken
        } as never,
        config: {} as never
      }
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.bodyText || "{}")).toMatchObject({
      ok: false,
      reason: "initiator_token_invalid",
      message: "GitHub token for alice is invalid."
    });
  });
});
