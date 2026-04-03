import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  GitHubAuthorMappingRecord,
  GitHubAuthorMappingSource,
  SlackUserIdentity
} from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { inferGitHubAuthorFromSlackIdentity } from "./git/github-author-utils.js";

export class GitHubAuthorMappingService {
  readonly #rootDir: string;
  readonly #mappingsDir: string;
  #mappings = new Map<string, GitHubAuthorMappingRecord>();

  constructor(options: {
    readonly stateDir: string;
  }) {
    this.#rootDir = path.join(options.stateDir, "github-author-mappings");
    this.#mappingsDir = this.#rootDir;
  }

  async load(): Promise<void> {
    await ensureDir(this.#mappingsDir);
    const entries = await fs.readdir(this.#mappingsDir, { withFileTypes: true });
    const next = new Map<string, GitHubAuthorMappingRecord>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.#mappingsDir, entry.name);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<GitHubAuthorMappingRecord>;
      const normalized = normalizeMapping(raw);
      if (!normalized) {
        continue;
      }

      next.set(normalized.slackUserId, normalized);
    }

    this.#mappings = next;
  }

  listMappings(): GitHubAuthorMappingRecord[] {
    return [...this.#mappings.values()].sort((left, right) => {
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
  }

  getMapping(slackUserId: string): GitHubAuthorMappingRecord | undefined {
    return this.#mappings.get(slackUserId);
  }

  async upsertManualMapping(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
    readonly slackIdentity?: SlackUserIdentity | undefined;
  }): Promise<GitHubAuthorMappingRecord> {
    const existing = await this.#readRecord(options.slackUserId) ?? this.#mappings.get(options.slackUserId);
    const slackIdentity = normalizeSlackIdentity(options.slackIdentity) ??
      existing?.slackIdentity ??
      {
        userId: options.slackUserId,
        mention: `<@${options.slackUserId}>`
      };

    const record = this.#buildRecord({
      slackUserId: options.slackUserId,
      githubAuthor: options.githubAuthor,
      source: "manual",
      slackIdentity
    });
    await this.#writeRecord(record);
    return record;
  }

  async deleteMapping(slackUserId: string): Promise<void> {
    this.#mappings.delete(slackUserId);
    await fs.rm(path.join(this.#mappingsDir, `${encodeKey(slackUserId)}.json`), {
      force: true
    });
  }

  async recordObservedIdentity(identity: SlackUserIdentity): Promise<GitHubAuthorMappingRecord | null> {
    const normalizedIdentity = normalizeSlackIdentity(identity);
    if (!normalizedIdentity) {
      return null;
    }

    const inferredAuthor = inferGitHubAuthorFromSlackIdentity(normalizedIdentity);
    const existing = await this.#readRecord(normalizedIdentity.userId) ?? this.#mappings.get(normalizedIdentity.userId);

    if (existing?.source === "manual") {
      if (!sameSlackIdentity(existing.slackIdentity, normalizedIdentity)) {
        const updated = this.#buildRecord({
          slackUserId: existing.slackUserId,
          githubAuthor: existing.githubAuthor,
          source: existing.source,
          slackIdentity: normalizedIdentity
        });
        await this.#writeRecord(updated);
        return updated;
      }

      return existing;
    }

    if (!inferredAuthor) {
      return existing ?? null;
    }

    if (
      existing &&
      existing.source === "slack_inferred" &&
      existing.githubAuthor === inferredAuthor &&
      sameSlackIdentity(existing.slackIdentity, normalizedIdentity)
    ) {
      return existing;
    }

    const record = this.#buildRecord({
      slackUserId: normalizedIdentity.userId,
      githubAuthor: inferredAuthor,
      source: "slack_inferred",
      slackIdentity: normalizedIdentity
    });
    await this.#writeRecord(record);
    return record;
  }

  #buildRecord(options: {
    readonly slackUserId: string;
    readonly githubAuthor: string;
    readonly source: GitHubAuthorMappingSource;
    readonly slackIdentity: SlackUserIdentity;
  }): GitHubAuthorMappingRecord {
    return {
      slackUserId: options.slackUserId,
      githubAuthor: options.githubAuthor.trim(),
      source: options.source,
      slackIdentity: options.slackIdentity,
      updatedAt: new Date().toISOString()
    };
  }

  async #writeRecord(record: GitHubAuthorMappingRecord): Promise<void> {
    this.#mappings.set(record.slackUserId, record);
    await ensureDir(this.#mappingsDir);
    const filePath = path.join(this.#mappingsDir, `${encodeKey(record.slackUserId)}.json`);
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2));
    await fs.rename(tempPath, filePath);
  }

  async #readRecord(slackUserId: string): Promise<GitHubAuthorMappingRecord | null> {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.#mappingsDir, `${encodeKey(slackUserId)}.json`), "utf8")
      ) as Partial<GitHubAuthorMappingRecord>;
      const normalized = normalizeMapping(raw);
      if (normalized) {
        this.#mappings.set(normalized.slackUserId, normalized);
      }
      return normalized;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

function normalizeMapping(raw: Partial<GitHubAuthorMappingRecord>): GitHubAuthorMappingRecord | null {
  const slackUserId = typeof raw.slackUserId === "string" ? raw.slackUserId.trim() : "";
  const githubAuthor = typeof raw.githubAuthor === "string" ? raw.githubAuthor.trim() : "";
  const source = raw.source === "manual" || raw.source === "slack_inferred" ? raw.source : undefined;
  const slackIdentity = normalizeSlackIdentity(raw.slackIdentity);

  if (!slackUserId || !githubAuthor || !source || !slackIdentity) {
    return null;
  }

  return {
    slackUserId,
    githubAuthor,
    source,
    slackIdentity,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  };
}

function normalizeSlackIdentity(identity: SlackUserIdentity | null | undefined): SlackUserIdentity | null {
  if (!identity?.userId?.trim()) {
    return null;
  }

  return {
    userId: identity.userId.trim(),
    mention: identity.mention?.trim() || `<@${identity.userId.trim()}>`,
    username: normalizeOptionalString(identity.username),
    displayName: normalizeOptionalString(identity.displayName),
    realName: normalizeOptionalString(identity.realName),
    email: normalizeOptionalString(identity.email)?.toLowerCase()
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function sameSlackIdentity(left: SlackUserIdentity, right: SlackUserIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
