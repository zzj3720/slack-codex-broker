import { describe, expect, it } from "vitest";

import { parseSlackEvent } from "../src/services/slack/slack-event-parser.js";

describe("slack event parser", () => {
  it("classifies bot messages with user and bot ids as bot-authored", () => {
    const parsed = parseSlackEvent({
      type: "message",
      channel: "C123",
      thread_ts: "111.111",
      ts: "111.222",
      user: "U_BOTUSER",
      bot_id: "B123",
      app_id: "A123",
      username: "Bridge",
      text: "Let me check that now."
    }, "UBOT");

    expect(parsed?.input).toEqual(expect.objectContaining({
      userId: "bot:B123",
      senderKind: "bot",
      botId: "B123",
      appId: "A123",
      senderUsername: "Bridge"
    }));
  });
});
