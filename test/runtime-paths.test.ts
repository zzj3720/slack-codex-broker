import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimeToolPath } from "../src/utils/runtime-paths.js";

describe("resolveRuntimeToolPath", () => {
  it("resolves helper scripts from the current runtime instead of a container-only /app path", () => {
    expect(resolveRuntimeToolPath("gemini-ui.js")).toBe(
      path.resolve(process.cwd(), "src", "tools", "gemini-ui.js")
    );
    expect(resolveRuntimeToolPath("job-callback.js")).toBe(
      path.resolve(process.cwd(), "src", "tools", "job-callback.js")
    );
    expect(resolveRuntimeToolPath("git-coauthor.js")).toBe(
      path.resolve(process.cwd(), "src", "tools", "git-coauthor.js")
    );
  });
});
