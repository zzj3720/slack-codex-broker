import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import type { SessionManager } from "./session-manager.js";
import type { PersistedBackgroundJob, PersistedInboundMessage, SlackSessionRecord } from "../types.js";
import type { CodexBroker } from "./codex/codex-broker.js";

interface FileInfo {
  readonly exists: boolean;
  readonly path: string;
  readonly size?: number | undefined;
  readonly mtime?: string | undefined;
}

export class AdminService {
  readonly #dataRoot: string;
  readonly #backupsRoot: string;

  constructor(
    private readonly options: {
      readonly config: AppConfig;
      readonly sessions: SessionManager;
      readonly codex: CodexBroker;
      readonly startedAt: Date;
    }
  ) {
    this.#dataRoot = path.dirname(this.options.config.stateDir);
    this.#backupsRoot = path.join(this.#dataRoot, "admin-backups", "auth-switches");
  }

  getAdminUiBootstrap(): {
    readonly tokenConfigured: boolean;
    readonly serviceName: string;
  } {
    return {
      tokenConfigured: Boolean(this.options.config.brokerAdminToken),
      serviceName: this.options.config.serviceName
    };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const activeSessions = this.options.sessions
      .listSessions()
      .filter((session) => Boolean(session.activeTurnId))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const openInbound = this.options.sessions
      .listInboundMessages({
        status: ["pending", "inflight"]
      })
      .sort((left, right) => String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? "")));
    const backgroundJobs = this.options.sessions
      .listBackgroundJobs()
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const account = await this.#readAccountSummary();

    return {
      service: {
        name: this.options.config.serviceName,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: this.options.startedAt.toISOString(),
        port: this.options.config.port,
        brokerHttpBaseUrl: this.options.config.brokerHttpBaseUrl,
        sessionsRoot: this.options.config.sessionsRoot,
        reposRoot: this.options.config.reposRoot,
        codexHome: this.options.config.codexHome,
        adminTokenConfigured: Boolean(this.options.config.brokerAdminToken)
      },
      authFiles: {
        authJson: await this.#fileInfo(path.join(this.options.config.codexHome, "auth.json")),
        credentialsJson: await this.#fileInfo(path.join(this.options.config.codexHome, ".credentials.json")),
        configToml: await this.#fileInfo(path.join(this.options.config.codexHome, "config.toml"))
      },
      account,
      state: {
        sessionCount: this.options.sessions.listSessions().length,
        activeCount: activeSessions.length,
        activeSessions,
        openInboundCount: openInbound.length,
        openInbound: openInbound.slice(0, 25).map((message) => this.#summarizeInbound(message)),
        backgroundJobs: backgroundJobs.slice(0, 50).map((job) => this.#summarizeJob(job)),
        recentBrokerLogs: await this.#readRecentBrokerLogs(40)
      }
    };
  }

  async replaceAuthFiles(options: {
    readonly authJsonContent: string;
    readonly credentialsJsonContent?: string | undefined;
    readonly configTomlContent?: string | undefined;
    readonly allowActive: boolean;
  }): Promise<Record<string, unknown>> {
    const activeSessions = this.options.sessions.listSessions().filter((session) => Boolean(session.activeTurnId));
    if (!options.allowActive && activeSessions.length > 0) {
      throw new Error(
        `Refusing auth replacement while active sessions exist (activeCount=${activeSessions.length}). Retry with allow_active=true if you really want to interrupt them.`
      );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(this.#backupsRoot, stamp);
    const replacements = [
      {
        relativePath: "auth.json",
        content: options.authJsonContent
      },
      options.credentialsJsonContent != null
        ? {
            relativePath: ".credentials.json",
            content: options.credentialsJsonContent
          }
        : null,
      options.configTomlContent != null
        ? {
            relativePath: "config.toml",
            content: options.configTomlContent
          }
        : null
    ].filter((entry): entry is { relativePath: string; content: string } => entry != null);

    const backups = [];
    for (const replacement of replacements) {
      const targetPath = path.join(this.options.config.codexHome, replacement.relativePath);
      const backupPath = await this.#backupIfExists(targetPath, backupDir);
      backups.push({
        targetPath,
        backupPath
      });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, replacement.content, "utf8");
    }

    await this.options.codex.restartRuntime("admin auth replacement");
    const status = await this.getStatus();

    return {
      ok: true,
      backups,
      replaced: replacements.map((entry) => ({
        targetPath: path.join(this.options.config.codexHome, entry.relativePath)
      })),
      status
    };
  }

  async #readAccountSummary(): Promise<Record<string, unknown>> {
    try {
      const account = await this.options.codex.readAccountSummary(false);
      return {
        ok: true,
        account: account.account ?? null,
        quota: account.quota ?? account.usage ?? null,
        requiresOpenaiAuth: account.requiresOpenaiAuth ?? false,
        note:
          account.quota == null && account.usage == null
            ? "Codex app-server account/read did not expose quota or usage fields."
            : undefined
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #fileInfo(filePath: string): Promise<FileInfo> {
    try {
      const stat = await fs.stat(filePath);
      return {
        exists: true,
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {
          exists: false,
          path: filePath
        };
      }

      throw error;
    }
  }

  async #backupIfExists(targetPath: string, backupDir: string): Promise<string | null> {
    try {
      await fs.access(targetPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, path.basename(targetPath));
    await fs.copyFile(targetPath, backupPath);
    return backupPath;
  }

  async #readRecentBrokerLogs(limit: number): Promise<readonly unknown[]> {
    const filePath = path.join(this.options.config.logDir, "broker.jsonl");

    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  #summarizeInbound(message: PersistedInboundMessage): Record<string, unknown> {
    return {
      sessionKey: message.sessionKey,
      messageTs: message.messageTs,
      source: message.source,
      status: message.status,
      userId: message.userId,
      textPreview: message.text.slice(0, 160),
      updatedAt: message.updatedAt,
      batchId: message.batchId ?? null
    };
  }

  #summarizeJob(job: PersistedBackgroundJob): Record<string, unknown> {
    return {
      id: job.id,
      sessionKey: job.sessionKey,
      kind: job.kind,
      status: job.status,
      cwd: job.cwd,
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt ?? null,
      lastEventAt: job.lastEventAt ?? null,
      error: job.error ?? null
    };
  }
}
