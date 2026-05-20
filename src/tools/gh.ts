#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { withoutGlobalGitHubTokenEnv } from "../utils/github-env.js";

export interface GhWrapperOptions {
  readonly brokerApiBase: string;
  readonly realGhPath: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface GhWrapperResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGhWrapper(options: GhWrapperOptions): Promise<GhWrapperResult> {
  const resolution = await resolveGitHubToken(options);
  if (!resolution.ok) {
    return {
      status: 1,
      stdout: "",
      stderr: `${resolution.message ?? "GitHub identity resolution blocked."}\n`
    };
  }

  return await runRealGh({
    ...options,
    token: resolution.token
  });
}

async function resolveGitHubToken(options: GhWrapperOptions): Promise<
  | {
      readonly ok: true;
      readonly token: string;
    }
  | {
      readonly ok: false;
      readonly message?: string | undefined;
    }
> {
  const response = await fetch(new URL("/slack/github-token/resolve", normalizeBaseUrl(options.brokerApiBase)), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      cwd: options.cwd,
      command: options.argv
    })
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || body.ok !== true) {
    return {
      ok: false,
      message: typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `GitHub identity resolution failed (${response.status}).`
    };
  }

  if (typeof body.token !== "string" || !body.token.trim()) {
    return {
      ok: false,
      message: "GitHub identity resolution did not return a token."
    };
  }

  return {
    ok: true,
    token: body.token
  };
}

function runRealGh(options: GhWrapperOptions & {
  readonly token: string;
}): Promise<GhWrapperResult> {
  return new Promise<GhWrapperResult>((resolve) => {
    const child = spawn(options.realGhPath, [...options.argv], {
      cwd: options.cwd,
      env: {
        ...withoutGlobalGitHubTokenEnv(options.env),
        GH_TOKEN: options.token
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        status: 1,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}\n`
      });
    });
    child.on("close", (code) => {
      resolve({
        status: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const brokerApiBase = process.env.BROKER_API_BASE?.trim();
  const realGhPath = process.env.BROKER_REAL_GH_PATH?.trim();
  if (!brokerApiBase || !realGhPath) {
    process.stderr.write("BROKER_API_BASE and BROKER_REAL_GH_PATH are required for broker gh wrapper.\n");
    process.exitCode = 1;
  } else {
    const result = await runGhWrapper({
      brokerApiBase,
      realGhPath,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      env: process.env
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  }
}
