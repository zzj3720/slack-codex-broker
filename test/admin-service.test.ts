import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AdminService } from "../src/services/admin-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("AdminService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
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
          activeProfile: "primary",
          activeAuthPath: path.join(config.codexHome, "auth.json"),
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
        activeProfile: "primary",
        profiles: []
      }
    });
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
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
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
    await writerSessions.ensureSession("C123", "111.222");
    await writerSessions.setActiveTurnId("C123", "111.222", "turn-1");
    await writerSessions.upsertInboundMessage({
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

    status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        sessionCount: 1,
        activeCount: 1,
        openInboundCount: 1,
        openHumanInboundCount: 1,
        openSystemInboundCount: 0
      }
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
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
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
