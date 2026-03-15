#!/usr/bin/env node

type JobAction = "heartbeat" | "event" | "complete" | "fail" | "cancel";

interface ParsedArgs {
  readonly action: JobAction;
  readonly values: Map<string, string>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const body = buildBody(parsed);
  const url = buildUrl(parsed.action);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`job callback failed (${response.status}): ${text}`);
  }

  if (text.trim()) {
    process.stdout.write(text);
    if (!text.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const actionCandidate = argv[0];
  if (!actionCandidate) {
    throw new Error("missing job callback action");
  }

  const rest = argv.slice(1);
  if (!isJobAction(actionCandidate)) {
    throw new Error(`unsupported job callback action: ${actionCandidate}`);
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index]!;
    if (!entry.startsWith("--")) {
      throw new Error(`unexpected argument: ${entry}`);
    }

    const key = entry.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }

    values.set(key, next);
    index += 1;
  }

  return {
    action: actionCandidate,
    values
  };
}

function isJobAction(value: string): value is JobAction {
  return (
    value === "heartbeat" ||
    value === "event" ||
    value === "complete" ||
    value === "fail" ||
    value === "cancel"
  );
}

function buildUrl(action: JobAction): string {
  const base = readEnv("BROKER_API_BASE");
  const jobId = readEnv("BROKER_JOB_ID");
  return `${base}/jobs/${encodeURIComponent(jobId)}/${action}`;
}

function buildBody(parsed: ParsedArgs): Record<string, unknown> {
  const token = readEnv("BROKER_JOB_TOKEN");
  const detailsText = parsed.values.get("details-text");
  const detailsJson = parseOptionalJson(parsed.values.get("details-json"));
  const common = {
    token
  } as Record<string, unknown>;

  if (parsed.action === "heartbeat" || parsed.action === "cancel") {
    return common;
  }

  if (parsed.action === "event") {
    return {
      ...common,
      event_kind: readRequiredArg(parsed.values, "kind"),
      summary: readRequiredArg(parsed.values, "summary"),
      details_text: detailsText,
      details_json: detailsJson
    };
  }

  if (parsed.action === "complete") {
    return {
      ...common,
      summary: parsed.values.get("summary"),
      details_text: detailsText,
      details_json: detailsJson
    };
  }

  return {
    ...common,
    summary: parsed.values.get("summary"),
    error: parsed.values.get("error"),
    details_text: detailsText,
    details_json: detailsJson
  };
}

function readEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`missing environment variable ${key}`);
  }

  return value;
}

function readRequiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) {
    throw new Error(`missing required argument --${key}`);
  }

  return value;
}

function parseOptionalJson(value: string | undefined): unknown {
  if (!value?.trim()) {
    return undefined;
  }

  return JSON.parse(value);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
