const GLOBAL_GITHUB_TOKEN_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "BROKER_DEFAULT_GITHUB_TOKEN"
] as const;

export function withoutGlobalGitHubTokenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of GLOBAL_GITHUB_TOKEN_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}
