import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/services/session-manager.js";
import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";
import { SlackCoauthorService } from "../src/services/slack/slack-coauthor-service.js";
import { StateStore } from "../src/store/state-store.js";

describe("SlackCoauthorService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true
    })));
  });

  it("prompts once per candidate revision when commit confirmation is still missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-sessions-"));
    tempDirs.push(stateDir, sessionsRoot);

    const sessions = new SessionManager({
      stateStore: new StateStore(stateDir, sessionsRoot),
      sessionsRoot
    });
    await sessions.load();
    const session = await sessions.ensureSession("C123", "111.222");

    const postEphemeral = vi.fn(async () => "111.333");
    const service = new SlackCoauthorService({
      sessions,
      mappings: new GitHubAuthorMappingService({ stateDir }),
      slackApi: {
        getUserIdentity: vi.fn(async () => ({
          userId: "U123",
          mention: "<@U123>",
          realName: "Alice Example",
          email: "alice@example.com"
        })),
        postEphemeral,
        openView: vi.fn()
      } as never
    });

    await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "111.223",
      userId: "U123",
      senderKind: "user",
      text: "please commit this"
    });

    const first = await service.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(test): demo"
    });
    expect(first).toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required"
    });
    expect(postEphemeral).toHaveBeenCalledTimes(1);

    const second = await service.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(test): demo"
    });
    expect(second).toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required"
    });
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("opens the Slack modal, stores manual mappings, and resolves commit trailers", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-coauthor-sessions-"));
    tempDirs.push(stateDir, sessionsRoot);

    const sessions = new SessionManager({
      stateStore: new StateStore(stateDir, sessionsRoot),
      sessionsRoot
    });
    await sessions.load();
    const session = await sessions.ensureSession("C555", "222.333");
    const mappings = new GitHubAuthorMappingService({ stateDir });
    await mappings.load();

    const identities = new Map([
      ["U1", {
        userId: "U1",
        mention: "<@U1>",
        realName: "Alice Example",
        email: "alice@example.com"
      }],
      ["U2", {
        userId: "U2",
        mention: "<@U2>",
        displayName: "Bob Example",
        email: "bob@example.com"
      }]
    ]);
    const openView = vi.fn(async () => {});
    const service = new SlackCoauthorService({
      sessions,
      mappings,
      slackApi: {
        getUserIdentity: vi.fn(async (userId: string) => identities.get(userId) ?? null),
        postEphemeral: vi.fn(async () => "111.444"),
        openView
      } as never
    });

    let latestSession = await service.noteIncomingSlackInput(session, {
      source: "thread_reply",
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      messageTs: "222.334",
      userId: "U1",
      senderKind: "user",
      text: "first request"
    });
    latestSession = await service.noteIncomingSlackInput(latestSession, {
      source: "thread_reply",
      channelId: latestSession.channelId,
      rootThreadTs: latestSession.rootThreadTs,
      messageTs: "222.335",
      userId: "U2",
      senderKind: "user",
      text: "second request"
    });

    await service.handleInteractivePayload({
      type: "block_actions",
      trigger_id: "trigger-1",
      actions: [
        {
          action_id: "coauthor_configure",
          value: JSON.stringify({
            session_key: latestSession.key,
            candidate_revision: latestSession.coAuthorCandidateRevision
          })
        }
      ]
    });

    expect(openView).toHaveBeenCalledTimes(1);
    const modalView = (openView.mock.calls[0] as unknown as [Record<string, unknown>])?.[0]?.view as Record<string, unknown>;
    expect(modalView).toMatchObject({
      callback_id: "coauthor_confirm"
    });
    expect((modalView.blocks as Array<Record<string, unknown>>).filter((block) => String(block.block_id || "").startsWith("author__"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          optional: true
        })
      ])
    );

    await service.handleInteractivePayload({
      type: "view_submission",
      user: { id: "U1" },
      view: {
        private_metadata: JSON.stringify({
          session_key: latestSession.key,
          candidate_revision: latestSession.coAuthorCandidateRevision
        }),
        state: {
          values: {
            contributors: {
              selected: {
                selected_options: [
                  { value: "U1" },
                  { value: "U2" }
                ]
              }
            },
            author__U1: {
              value: {
                value: "Alice Example <alice@example.com>"
              }
            },
            author__U2: {
              value: {
                value: "Bob Example <bob@example.com>"
              }
            }
          }
        }
      }
    });

    const resolved = await service.resolveCommitCoauthors({
      cwd: latestSession.workspacePath,
      commitMessage: "feat(slack): add coauthors",
      primaryAuthorEmail: "broker@example.com"
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.commitMessage).toContain("Co-authored-by: Alice Example <alice@example.com>");
    expect(resolved.commitMessage).toContain("Co-authored-by: Bob Example <bob@example.com>");
  });
});
