import type { SlackUserIdentity } from "../../types.js";

export interface ParsedGitHubAuthor {
  readonly name: string;
  readonly email: string;
}

export function inferGitHubAuthorFromSlackIdentity(identity: SlackUserIdentity): string | undefined {
  const name = identity.realName?.trim() || identity.displayName?.trim() || identity.username?.trim();
  const email = normalizeEmail(identity.email);

  if (!name || !email) {
    return undefined;
  }

  return `${name} <${email}>`;
}

export function parseGitHubAuthor(value: string): ParsedGitHubAuthor | null {
  const match = value.match(/^\s*(.+?)\s*<([^<>@\s]+@[^<>@\s]+)>\s*$/u);
  if (!match) {
    return null;
  }

  const name = match[1]?.trim();
  const email = normalizeEmail(match[2]);
  if (!name || !email) {
    return null;
  }

  return {
    name,
    email
  };
}

export function isValidGitHubAuthor(value: string): boolean {
  return parseGitHubAuthor(value) !== null;
}

export function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function appendCoAuthorTrailers(
  commitMessage: string,
  options: {
    readonly coAuthors: readonly string[];
    readonly primaryAuthorEmail?: string | undefined;
  }
): string {
  const newline = commitMessage.includes("\r\n") ? "\r\n" : "\n";
  const existingLines = commitMessage.split(/\r?\n/u);
  const existingEmails = new Set(
    existingLines
      .map((line) => line.match(/^Co-authored-by:\s*(.+)$/iu)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => parseGitHubAuthor(value))
      .filter((value): value is ParsedGitHubAuthor => value !== null)
      .map((value) => value.email)
  );
  const primaryAuthorEmail = normalizeEmail(options.primaryAuthorEmail);
  const additions: string[] = [];

  for (const candidate of options.coAuthors) {
    const parsed = parseGitHubAuthor(candidate);
    if (!parsed) {
      continue;
    }

    if (parsed.email === primaryAuthorEmail || existingEmails.has(parsed.email)) {
      continue;
    }

    existingEmails.add(parsed.email);
    additions.push(`Co-authored-by: ${parsed.name} <${parsed.email}>`);
  }

  if (additions.length === 0) {
    return commitMessage;
  }

  const trimmed = commitMessage.replace(/\s+$/u, "");
  const hasExistingTrailers = /^(?:[A-Za-z-]+):\s.+$/mu.test(trimmed.split(/\r?\n/u).at(-1) ?? "");
  const separator = trimmed.length === 0 ? "" : hasExistingTrailers ? newline : `${newline}${newline}`;
  return `${trimmed}${separator}${additions.join(newline)}${newline}`;
}
