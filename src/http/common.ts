import http from "node:http";

import type { JsonLike } from "../types.js";

export async function readFormBody(request: http.IncomingMessage): Promise<Record<string, string>> {
  const body = await readBodyAsText(request);
  const rawContentType = request.headers["content-type"];
  const contentTypeHeader = Array.isArray(rawContentType) ? rawContentType[0] : (rawContentType ?? "");
  const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  if (!body.trim()) {
    return {};
  }

  if (contentType === "application/json") {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return normalizeRequestBody(parsed);
  }

  if (contentType === "application/x-www-form-urlencoded" || contentType === "") {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }

  throw new Error(`unsupported_content_type:${contentType}`);
}

export async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBodyAsText(request);

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return fallback;
}

export function parseJsonLike(value: unknown): JsonLike | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    return JSON.parse(trimmed) as JsonLike;
  }

  return value as JsonLike;
}

export function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBodyAsText(request: http.IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function normalizeRequestBody(input: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value == null) {
      continue;
    }

    normalized[key] = String(value);
  }

  return normalized;
}
