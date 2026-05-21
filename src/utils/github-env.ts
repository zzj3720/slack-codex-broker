const GLOBAL_GITHUB_TOKEN_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "BROKER_DEFAULT_GITHUB_TOKEN"
] as const;

const BROKER_GITHUB_GIT_CONFIG_ENTRIES = [
  {
    key: "credential.https://github.com.helper",
    value: ""
  },
  {
    key: "credential.https://github.com.helper",
    value: "!gh auth git-credential"
  }
] as const;

export function withoutGlobalGitHubTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of GLOBAL_GITHUB_TOKEN_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function withBrokerGitHubEnv(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly ghConfigDir: string;
  readonly includeGitCredentialHelper?: boolean | undefined;
}): NodeJS.ProcessEnv {
  const sanitized = withoutGlobalGitHubTokenEnv(options.env);
  sanitized.GH_CONFIG_DIR = options.ghConfigDir;

  if (options.includeGitCredentialHelper === false) {
    return sanitized;
  }

  return withGitConfigEntries(sanitized, BROKER_GITHUB_GIT_CONFIG_ENTRIES);
}

function withGitConfigEntries(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
  }>
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const existingCount = Number.parseInt(next.GIT_CONFIG_COUNT ?? "0", 10);
  const startIndex = Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;

  entries.forEach((entry, offset) => {
    const index = startIndex + offset;
    next[`GIT_CONFIG_KEY_${index}`] = entry.key;
    next[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  });
  next.GIT_CONFIG_COUNT = String(startIndex + entries.length);
  return next;
}
