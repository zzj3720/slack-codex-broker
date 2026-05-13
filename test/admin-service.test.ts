import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { AdminService } from "../src/services/admin-service.js";
import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";
import { GitHubPrIdentityService } from "../src/services/github-pr-identity-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("AdminService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("bounds slow runtime status probes so overview can still answer", async () => {
    vi.useFakeTimers();
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-runtime-timeout-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const never = new Promise<never>(() => {});

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => never
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        readAccountSummary: async () => never,
        readAccountRateLimits: async () => never
      } as never,
      deployment: {
        getStatus: async () => never
      } as never
    });

    const overviewPromise = service.getOverview();
    await vi.advanceTimersByTimeAsync(4_100);
    const overview = await overviewPromise;
    expect(overview).toMatchObject({
      ok: true,
      account: {
        ok: false,
        error: expect.stringContaining("account summary timed out")
      },
      rateLimits: {
        ok: false,
        error: expect.stringContaining("account rate limits timed out")
      },
      deployment: {
        ok: false,
        error: expect.stringContaining("deployment status timed out")
      },
      authProfiles: {
        ok: false,
        error: expect.stringContaining("auth profiles timed out"),
        profiles: []
      }
    });
  });

  it("keeps overview off the unbounded inbound-message history", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-overview-inbound-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const inboundCalls: Array<unknown> = [];

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/tmp/session",
            initiatorUserId: "U0BOB",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          }
        ],
        listInboundMessages: (options?: unknown) => {
          inboundCalls.push(options);
          return [];
        },
        listBackgroundJobs: () => [],
        listAgentTurnUsage: () => {
          throw new Error("overview must not aggregate usage");
        }
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const overview = await service.getOverview();
    expect(overview).not.toHaveProperty("usage");
    expect(overview).toMatchObject({
      state: {
        sessionCount: 1,
        openInboundCount: 0
      },
      githubAccounts: {
        accounts: [
          {
            slackUserId: "U0BOB"
          }
        ]
      }
    });
    expect(inboundCalls).toEqual([]);
  });

  it("resolves session Slack thread links through Slack permalinks", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-thread-link-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");

    const permalinkCalls: Array<Record<string, string>> = [];
    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never,
      slackConversations: {
        getConversationInfo: async () => null,
        getPermalink: async (options) => {
          permalinkCalls.push(options);
          return "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123";
        }
      }
    });

    await expect(service.getSessionSlackThreadUrl("C123:111.222")).resolves.toEqual({
      ok: true,
      sessionKey: "C123:111.222",
      url: "https://workspace.slack.com/archives/C123/p111222?thread_ts=111.222&cid=C123"
    });
    expect(permalinkCalls).toEqual([{ channelId: "C123", messageTs: "111.222" }]);
  });

  it("exposes GitHub author mappings and OAuth bindings as unified GitHub accounts", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-github-accounts-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      BROKER_DEFAULT_GITHUB_LOGIN: "legacy-bot",
      BROKER_DEFAULT_GITHUB_TOKEN: "legacy-token"
    } as NodeJS.ProcessEnv);

    const githubAuthorMappings = new GitHubAuthorMappingService({ stateDir: config.stateDir });
    await githubAuthorMappings.load();
    await githubAuthorMappings.upsertManualMapping({
      slackUserId: "U_ALICE",
      githubAuthor: "Alice Example <alice@example.com>",
      slackIdentity: {
        userId: "U_ALICE",
        mention: "<@U_ALICE>",
        displayName: "Alice",
        email: "alice@example.com"
      }
    });

    const githubPrIdentity = new GitHubPrIdentityService({
      stateDir: config.stateDir,
      defaultGitHubLogin: config.defaultGitHubLogin,
      defaultGitHubToken: config.defaultGitHubToken
    });
    await githubPrIdentity.load();
    await githubPrIdentity.upsertBinding({
      slackUserId: "U_ALICE",
      githubLogin: "alice-gh",
      githubUserId: 101,
      token: "alice-token",
      scopes: ["repo", "read:user", "user:email"],
      githubEmail: "alice@github.example",
      githubName: "Alice GitHub"
    });
    await githubPrIdentity.setDefaultBinding("U_ALICE");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/tmp/session",
            initiatorUserId: "U0BOB",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          }
        ],
        listInboundMessages: () => [
          {
            key: "m1",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.222",
            source: "app_mention",
            userId: "U0BOB",
            text: "@bot hi",
            senderKind: "user",
            senderUsername: "bob",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          },
          {
            key: "m2",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.333",
            source: "thread_reply",
            userId: "U_CAROL",
            text: "please review this too",
            senderKind: "user",
            senderUsername: "carol",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          },
          {
            key: "m3",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.444",
            source: "thread_reply",
            userId: "U_BOT",
            text: "bot message",
            senderKind: "bot",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          },
          {
            key: "m4",
            sessionKey: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            messageTs: "111.555",
            source: "thread_reply",
            userId: "username:legacy-bot",
            text: "legacy sender",
            senderKind: "user",
            mentionedUsers: [],
            status: "done",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z"
          }
        ],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings,
      githubPrIdentity,
      slackConversations: {
        getUserIdentity: async (userId: string) => {
          if (userId !== "U0BOB") return null;
          return {
            userId,
            mention: `<@${userId}>`,
            username: "bob",
            displayName: "Bob Slack",
            realName: "Bob Example",
            email: "bob@example.com"
          };
        }
      } as never,
      runtime: {
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const overview = await service.getOverview();
    expect(overview.githubAccounts).toMatchObject({
      count: 2,
      defaultPrAccount: {
        available: true,
        source: "bound",
        slackUserId: "U_ALICE",
        githubLogin: "alice-gh"
      },
      accounts: [
        {
          slackUserId: "U_ALICE",
          isDefaultPrAccount: true,
          slackIdentity: {
            userId: "U_ALICE",
            mention: "<@U_ALICE>"
          },
          prBinding: {
            state: "bound",
            githubLogin: "alice-gh",
            githubUserId: 101,
            githubEmail: "alice@github.example",
            githubName: "Alice GitHub",
            scopes: ["repo", "read:user", "user:email"]
          }
        },
        {
          slackUserId: "U0BOB",
          slackIdentity: {
            userId: "U0BOB",
            mention: "<@U0BOB>",
            username: "bob",
            displayName: "Bob Slack",
            realName: "Bob Example",
            email: "bob@example.com"
          },
          prBinding: {
            state: "unbound"
          }
        }
      ]
    });
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("U_CAROL");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("U_BOT");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("username:legacy-bot");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("githubAuthor");
    expect(JSON.stringify(overview.githubAccounts)).not.toContain("Alice Example <alice@example.com>");
  });

  it("includes account rate limits in status output", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.mkdir(path.join(config.logDir, "broker"), { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker", "2026-03-19-00.jsonl"), "{\"message\":\"older\"}\n", "utf8");
    await fs.writeFile(path.join(config.logDir, "broker", "2026-03-19-01.jsonl"), "{\"message\":\"newer\"}\n", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10_080,
              resetsAt: 1_735_999_999
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "18.75"
            },
            planType: "team"
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_735_692_000
              },
              secondary: {
                usedPercent: 7,
                windowDurationMins: 10_080,
                resetsAt: 1_735_999_999
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "18.75"
              },
              planType: "team"
            }
          }
        })
      } as never
    });

    const status = await service.getStatus();
    expect((status.state as { recentBrokerLogs: unknown[] }).recentBrokerLogs).toEqual([
      { message: "older" },
      { message: "newer" }
    ]);
    expect(status).toMatchObject({
      account: {
        ok: true,
        account: {
          email: "quota@example.com",
          type: "chatgpt",
          planType: "team"
        }
      },
      rateLimits: {
        ok: true,
        rateLimits: {
          limitId: "codex",
          planType: "team",
          credits: {
            balance: "18.75",
            hasCredits: true,
            unlimited: false
          }
        },
        rateLimitsByLimitId: {
          codex: {
            limitName: "Codex"
          }
        }
      },
      authProfiles: {
        profiles: []
      }
    });
  });

  it("reads recent broker logs from a bounded tail instead of decoding whole files", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-large-log-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(path.join(config.logDir, "broker"), { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker", "2026-03-19-00.jsonl"),
      `${"x".repeat(1024 * 1024)}\n{"message":"tail-1"}\n{"message":"tail-2"}\n`,
      "utf8"
    );

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus();
    expect((status.state as { recentBrokerLogs: unknown[] }).recentBrokerLogs).toEqual([
      { message: "tail-1" },
      { message: "tail-2" }
    ]);
  });

  it("reloads persisted session state before reporting status", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-state-refresh-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: null,
            credits: null,
            planType: "team"
          },
          rateLimitsByLimitId: {}
        })
      } as never
    });

    let status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        sessionCount: 0,
        activeCount: 0
      }
    });

    const writerStore = new StateStore(config.stateDir, config.sessionsRoot);
    const writerSessions = new SessionManager({
      stateStore: writerStore,
      sessionsRoot: config.sessionsRoot
    });
    await writerSessions.load();
    await writerSessions.ensureSession("C123", "111.222", {
      channelName: "deep-review",
      channelType: "channel"
    });
    await writerSessions.setActiveTurnId("C123", "111.222", "turn-1");
    await writerSessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "<@U234> follow up",
      senderUsername: "starter",
      mentionedUserIds: ["U234"],
      mentionedUsers: [
        {
          userId: "U234",
          mention: "<@U234>",
          username: "mock-user-234",
          displayName: "Mock Display 234",
          realName: "Mock User 234"
        }
      ],
      status: "pending",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z"
    });

    status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        sessionCount: 1,
        activeCount: 1,
        openInboundCount: 1,
        openHumanInboundCount: 1,
        openSystemInboundCount: 0,
        sessions: [
          {
            channelId: "C123",
            channelName: "deep-review",
            channelType: "channel",
            channelLabel: "#deep-review",
            firstUserMessage: {
              userId: "U123",
              senderUsername: "starter",
              slackIdentity: {
                userId: "U123",
                username: "starter"
              },
              textPreview: "@Mock Display 234 follow up"
            },
            lastUserMessage: {
              userId: "U123",
              senderUsername: "starter",
              slackIdentity: {
                userId: "U123",
                username: "starter"
              },
              textPreview: "@Mock Display 234 follow up"
            }
          }
        ]
      }
    });

    await writerSessions.ensureSession("C123", "222.333");

    status = await service.getStatus();
    const legacySession = ((status as Record<string, any>).state.sessions as Record<string, any>[])
      .find((session) => session.key === "C123:222.333");
    expect(legacySession).toMatchObject({
      channelId: "C123",
      channelName: null,
      channelLabel: "#deep-review"
    });
  });

  it("resolves legacy channel labels from Slack when persisted metadata is missing", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-channel-lookup-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");
    await sessions.ensureSession("C123", "222.333");

    const lookupCalls: string[] = [];
    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never,
      slackConversations: {
        getConversationInfo: async (channelId) => {
          lookupCalls.push(channelId);
          return {
            channelId,
            name: "ops",
            channelType: "channel"
          };
        }
      }
    });

    const timeline = await service.getSessionTimeline("C123:111.222");
    expect((timeline as Record<string, any>).session).toMatchObject({
      key: "C123:111.222",
      channelName: null,
      channelLabel: "#ops"
    });

    const status = await service.getStatus();
    expect((status as Record<string, any>).state.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "C123:111.222",
          channelName: null,
          channelLabel: "#ops"
        }),
        expect.objectContaining({
          key: "C123:222.333",
          channelName: null,
          channelLabel: "#ops"
        })
      ])
    );

    const summaries = await service.listSessionSummaries();
    expect((summaries as Record<string, any>).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "C123:111.222",
          channelLabel: "#ops"
        })
      ])
    );
    expect(lookupCalls).toEqual(["C123"]);
  });

  it("reports session activity time from real activity instead of metadata updates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-activity-time-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");
    await sessions.ensureSession("C123", "222.333");
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "old activity",
      status: "done",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z"
    });
    await sessions.upsertInboundMessage({
      key: "C123:222.333:222.334",
      sessionKey: "C123:222.333",
      channelId: "C123",
      rootThreadTs: "222.333",
      messageTs: "222.334",
      source: "thread_reply",
      userId: "U123",
      text: "new activity",
      status: "done",
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z"
    });

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus();
    const summaries = (status as Record<string, any>).state.sessions as Record<string, any>[];
    expect(summaries.map((session) => session.key).slice(0, 2)).toEqual([
      "C123:222.333",
      "C123:111.222"
    ]);
    expect(summaries.find((session) => session.key === "C123:111.222")).toMatchObject({
      updatedAt: expect.any(String),
      lastActivityAt: "2026-03-19T00:00:00.000Z"
    });
  });

  it("splits open inbound counts into human and system messages", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-open-inbound-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z"
    });
    await sessions.upsertInboundMessage({
      key: "C123:111.222:111.224",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.224",
      source: "background_job_event",
      userId: "U0ALY77RMJL",
      text: "job update",
      status: "pending",
      createdAt: "2026-03-19T00:00:01.000Z",
      updatedAt: "2026-03-19T00:00:01.000Z"
    });

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: null,
            credits: null,
            planType: "team"
          },
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        openInboundCount: 2,
        openHumanInboundCount: 1,
        openSystemInboundCount: 1,
        sessions: [
          {
            openInboundCount: 2,
            openHumanInboundCount: 1,
            openSystemInboundCount: 1
          }
        ]
      }
    });
  });
});
