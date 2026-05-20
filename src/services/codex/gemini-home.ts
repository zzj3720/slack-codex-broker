import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureDir, fileExists } from "../../utils/fs.js";

const mirroredGeminiFiles = [
  "settings.json",
  "oauth_creds.json",
  "google_accounts.json"
] as const;

async function resolveSourceGeminiHome(hostGeminiHomePath?: string): Promise<string | undefined> {
  const candidates = [
    hostGeminiHomePath,
    path.join(os.homedir(), ".gemini")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  return undefined;
}

export async function syncGeminiHome(options: {
  readonly runtimeHomePath: string;
  readonly hostGeminiHomePath?: string | undefined;
}): Promise<void> {
  const sourceHome = await resolveSourceGeminiHome(options.hostGeminiHomePath);
  if (!sourceHome) {
    return;
  }

  const targetHome = path.join(options.runtimeHomePath, ".gemini");
  await ensureDir(targetHome);

  for (const entry of mirroredGeminiFiles) {
    const sourcePath = path.join(sourceHome, entry);
    const targetPath = path.join(targetHome, entry);

    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      continue;
    }

    if (await fileExists(sourcePath)) {
      await fs.copyFile(sourcePath, targetPath);
      continue;
    }

    await fs.rm(targetPath, {
      force: true,
      recursive: true
    });
  }
}
