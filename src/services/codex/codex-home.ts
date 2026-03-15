import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureDir, fileExists } from "../../utils/fs.js";

export const PERSONAL_MEMORY_FILENAME = "AGENT.md";

const mirroredEntries = [
  PERSONAL_MEMORY_FILENAME,
  "AGENTS.md",
  "memory.md",
  "config.toml",
  "memories",
  "skills",
  "superpowers",
  "rules",
  "vendor_imports"
] as const;

const detachedMarkdownEntries = new Set<string>([PERSONAL_MEMORY_FILENAME, "AGENTS.md"]);
const linkedMarkdownEntries = new Set<string>(["memory.md"]);

function isDirectoryEntry(entry: string): boolean {
  return !entry.endsWith(".md") && !entry.endsWith(".toml");
}

async function resolveSourceCodexHome(
  codexHome: string,
  hostCodexHomePath?: string
): Promise<string | undefined> {
  const candidates = [
    hostCodexHomePath,
    path.join(os.homedir(), ".codex")
  ].filter((value): value is string => Boolean(value));

  const resolvedTarget = path.resolve(codexHome);

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    if (resolvedCandidate === resolvedTarget) {
      continue;
    }

    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  return undefined;
}

async function replaceWithCopy(targetPath: string, sourcePath: string, isDirectory: boolean): Promise<void> {
  await fs.rm(targetPath, {
    force: true,
    recursive: true
  });

  if (isDirectory) {
    await fs.cp(sourcePath, targetPath, {
      dereference: true,
      force: true,
      recursive: true
    });
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
}

async function replaceWithSymlink(targetPath: string, sourcePath: string): Promise<void> {
  await fs.rm(targetPath, {
    force: true,
    recursive: true
  });
  await fs.symlink(sourcePath, targetPath, "file");
}

async function ensureDetachedMarkdownFile(targetPath: string, sourcePath: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));

  const targetExists = await fileExists(targetPath);
  if (!targetExists) {
    if (await fileExists(sourcePath)) {
      await fs.copyFile(sourcePath, targetPath);
      return;
    }

    await fs.writeFile(targetPath, "");
    return;
  }

  const targetStat = await fs.lstat(targetPath);
  if (!targetStat.isSymbolicLink()) {
    return;
  }

  const currentContent = await fs.readFile(targetPath, "utf8").catch(() => "");
  await fs.rm(targetPath, {
    force: true,
    recursive: true
  });
  await fs.writeFile(targetPath, currentContent);
}

async function readTextIfExists(filePath: string): Promise<string> {
  if (!(await fileExists(filePath))) {
    return "";
  }

  return await fs.readFile(filePath, "utf8").catch(() => "");
}

function resolvePersonalMemoryPath(rootPath: string): string {
  return path.join(rootPath, PERSONAL_MEMORY_FILENAME);
}

async function migrateLegacyPersonalMemory(targetPath: string, legacyPath?: string): Promise<void> {
  if (!legacyPath || !(await fileExists(legacyPath))) {
    return;
  }

  const targetContent = await readTextIfExists(targetPath);
  if (targetContent.trim()) {
    return;
  }

  const legacyContent = await readTextIfExists(legacyPath);
  if (!legacyContent.trim()) {
    return;
  }

  await fs.writeFile(targetPath, legacyContent);
}

async function ensureRuntimePersonalMemoryAlias(options: {
  readonly codexHome: string;
  readonly runtimeHomePath?: string | undefined;
  readonly legacyPersonalMemoryPath?: string | undefined;
}): Promise<void> {
  if (!options.runtimeHomePath) {
    return;
  }

  const targetPath = getPersonalMemoryPath(options.codexHome);
  await migrateLegacyPersonalMemory(targetPath, options.legacyPersonalMemoryPath);

  const runtimeCodexHome = path.join(options.runtimeHomePath, ".codex");
  const runtimePath = resolvePersonalMemoryPath(runtimeCodexHome);
  await ensureDir(runtimeCodexHome);

  if (await fileExists(runtimePath)) {
    const targetContent = await readTextIfExists(targetPath);
    const runtimeContent = await readTextIfExists(runtimePath);
    if (!targetContent.trim() && runtimeContent.trim()) {
      await fs.writeFile(targetPath, runtimeContent);
    }

    const runtimeStat = await fs.lstat(runtimePath);
    if (runtimeStat.isSymbolicLink()) {
      const linkedPath = await fs.readlink(runtimePath);
      const resolvedLink = path.resolve(path.dirname(runtimePath), linkedPath);
      if (resolvedLink === path.resolve(targetPath)) {
        return;
      }
    }
  }

  await replaceWithSymlink(runtimePath, targetPath);
}

export function getPersonalMemoryPath(codexHome: string): string {
  return resolvePersonalMemoryPath(codexHome);
}

export async function readPersonalMemory(codexHome: string): Promise<string> {
  return await readTextIfExists(getPersonalMemoryPath(codexHome));
}

export async function syncUserCodexHome(options: {
  readonly codexHome: string;
  readonly hostCodexHomePath?: string | undefined;
  readonly runtimeHomePath?: string | undefined;
  readonly legacyPersonalMemoryPath?: string | undefined;
}): Promise<void> {
  await ensureDir(options.codexHome);

  const sourceHome = await resolveSourceCodexHome(options.codexHome, options.hostCodexHomePath);
  if (!sourceHome) {
    return;
  }

  for (const entry of mirroredEntries) {
    const sourcePath = path.join(sourceHome, entry);
    const targetPath = path.join(options.codexHome, entry);

    if (detachedMarkdownEntries.has(entry)) {
      await ensureDetachedMarkdownFile(targetPath, sourcePath);
      continue;
    }

    if (linkedMarkdownEntries.has(entry)) {
      await ensureDir(path.dirname(sourcePath));
      if (!(await fileExists(sourcePath))) {
        await fs.writeFile(sourcePath, "");
      }

      await ensureDir(path.dirname(targetPath));
      await replaceWithSymlink(targetPath, sourcePath);
      continue;
    }

    if (await fileExists(sourcePath)) {
      await ensureDir(path.dirname(targetPath));
      await replaceWithCopy(targetPath, sourcePath, isDirectoryEntry(entry));
      continue;
    }

    await fs.rm(targetPath, {
      force: true,
      recursive: true
    });
  }

  await ensureRuntimePersonalMemoryAlias({
    codexHome: options.codexHome,
    runtimeHomePath: options.runtimeHomePath,
    legacyPersonalMemoryPath: options.legacyPersonalMemoryPath
  });
}
