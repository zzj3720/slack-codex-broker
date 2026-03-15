import { afterEach, describe, expect, it, vi } from "vitest";

import { SlackSocketModeClient } from "../src/services/slack/socket-mode-client.js";

describe("SlackSocketModeClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries after a failed socket-open request without crashing start()", async () => {
    vi.useFakeTimers();
    const api = {
      openSocketConnection: vi.fn().mockRejectedValue(new Error("fetch failed"))
    };
    const client = new SlackSocketModeClient({
      api: api as never,
      socketOpenPath: "apps.connections.open"
    });

    await expect(client.start()).resolves.toBeUndefined();
    expect(api.openSocketConnection).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.openSocketConnection).toHaveBeenCalledTimes(2);

    await client.stop();
  });
});
