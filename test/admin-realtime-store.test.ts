import { describe, expect, it } from "vitest";

import {
  applyAdminRealtimeEventToStatus,
  applyTimelineRealtimeEvent,
  type AdminRealtimeEvent
} from "../src/admin-ui/admin-status-store.js";

describe("admin realtime client store", () => {
  it("upserts session summaries without reordering existing rows", () => {
    const status = {
      state: {
        sessions: [
          { key: "C1:1", updatedAt: "2026-05-09T00:00:01.000Z", activeTurnId: "turn-old" },
          { key: "C2:2", updatedAt: "2026-05-09T00:00:02.000Z" }
        ]
      }
    };

    const updated = applyAdminRealtimeEventToStatus(status, {
      sequence: 1,
      kind: "session.upsert",
      scope: "session",
      sessionKey: "C2:2",
      entityId: "C2:2",
      createdAt: "2026-05-09T00:00:03.000Z",
      payload: {},
      session: { key: "C2:2", updatedAt: "2026-05-09T00:00:03.000Z", activeTurnId: "turn-new" }
    } satisfies AdminRealtimeEvent);

    expect((updated as Record<string, any>).state.sessions.map((session: Record<string, unknown>) => session.key)).toEqual(["C1:1", "C2:2"]);
    expect((updated as Record<string, any>).state.sessions[1]).toMatchObject({
      key: "C2:2",
      activeTurnId: "turn-new"
    });

    const appended = applyAdminRealtimeEventToStatus(updated, {
      sequence: 2,
      kind: "session.upsert",
      scope: "session",
      sessionKey: "C3:3",
      entityId: "C3:3",
      createdAt: "2026-05-09T00:00:04.000Z",
      payload: {},
      session: { key: "C3:3", updatedAt: "2026-05-09T00:00:04.000Z" }
    } satisfies AdminRealtimeEvent);

    expect((appended as Record<string, any>).state.sessions.map((session: Record<string, unknown>) => session.key)).toEqual(["C1:1", "C2:2", "C3:3"]);
  });

  it("appends realtime timeline events and updates trace counts", () => {
    const payload = {
      ok: true,
      trace: {
        source: "broker_db",
        eventCount: 1,
        categories: {
          agent_assistant_message: 1
        }
      },
      events: [
        { id: "message-1", type: "agent_assistant_message", at: "2026-05-09T00:00:01.000Z" }
      ]
    };

    const updated = applyTimelineRealtimeEvent(payload, {
      sequence: 2,
      kind: "trace.append",
      scope: "session",
      sessionKey: "C1:1",
      entityId: "trace-2",
      createdAt: "2026-05-09T00:00:02.000Z",
      payload: {},
      timelineEvent: {
        id: "tool-1",
        type: "agent_tool_call",
        at: "2026-05-09T00:00:02.000Z",
        toolName: "exec_command"
      },
      trace: {
        source: "broker_db",
        eventCount: 2,
        categories: {
          agent_assistant_message: 1,
          agent_tool_call: 1
        }
      }
    } satisfies AdminRealtimeEvent);

    expect((updated as Record<string, any>).events.map((event: Record<string, unknown>) => event.id)).toEqual([
      "message-1",
      "tool-1"
    ]);
    expect((updated as Record<string, any>).trace).toMatchObject({
      eventCount: 2,
      categories: {
        agent_tool_call: 1
      }
    });
  });
});
