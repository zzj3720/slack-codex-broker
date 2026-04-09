import { describe, expect, it } from "vitest";

import { isRecoverableCodexConnectionError } from "../src/services/codex/codex-broker.js";

describe("codex broker", () => {
  it("treats EPIPE websocket writes as recoverable connection failures", () => {
    expect(isRecoverableCodexConnectionError(new Error("write EPIPE"))).toBe(true);
  });
});
