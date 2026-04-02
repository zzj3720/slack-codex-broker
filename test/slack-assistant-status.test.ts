import { afterEach, describe, expect, it, vi } from "vitest";

import { SlackAssistantStatusController } from "../src/services/slack/slack-assistant-status.js";

describe("SlackAssistantStatusController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps assistant execution state into a Slack status label", async () => {
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const controller = new SlackAssistantStatusController({
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      channelId: "C123",
      threadTs: "111.222"
    });

    controller.handleAssistantState({
      phase: "execution",
      tools: [{ tool_name: "read" }]
    });

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledWith({
        channelId: "C123",
        threadTs: "111.222",
        status: "Reading files..."
      });
    });
  });

  it("normalizes underscored tool names before looking up status labels", async () => {
    const setAssistantThreadStatus = vi.fn(async () => undefined);

    const controller = new SlackAssistantStatusController({
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      channelId: "C123",
      threadTs: "111.222"
    });

    controller.handleToolStart({
      id: "call-1",
      name: "apply_patch"
    });

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledWith({
        channelId: "C123",
        threadTs: "111.222",
        status: "Updating files..."
      });
    });
  });

  it("retries the same status after a transient Slack API failure", async () => {
    vi.useFakeTimers();
    const setAssistantThreadStatus = vi.fn()
      .mockRejectedValueOnce(new Error("Slack API request failed (500 Internal Server Error) for assistant.threads.setStatus"))
      .mockResolvedValueOnce(undefined);

    const controller = new SlackAssistantStatusController({
      slackApi: {
        setAssistantThreadStatus,
        addReaction: vi.fn(),
        removeReaction: vi.fn()
      } as never,
      channelId: "C123",
      threadTs: "111.222"
    });

    controller.setThinking();
    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledTimes(1);
    });

    controller.setThinking();
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => {
      expect(setAssistantThreadStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("falls back to an eyes reaction when assistant thread status is unavailable", async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);

    const controller = new SlackAssistantStatusController({
      slackApi: {
        setAssistantThreadStatus: vi.fn(async () => {
          throw new Error("Slack API error for assistant.threads.setStatus: unknown_method");
        }),
        addReaction,
        removeReaction
      } as never,
      channelId: "C123",
      threadTs: "111.222"
    });

    controller.setThinking();

    await vi.waitFor(() => {
      expect(addReaction).toHaveBeenCalledWith({
        channelId: "C123",
        timestamp: "111.222",
        name: "eyes"
      });
    });

    controller.clear();

    await vi.waitFor(() => {
      expect(removeReaction).toHaveBeenCalledWith({
        channelId: "C123",
        timestamp: "111.222",
        name: "eyes"
      });
    });
  });
});
