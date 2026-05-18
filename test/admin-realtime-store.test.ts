import { describe, expect, it } from "vitest";

import {
  applyAdminRealtimeEventToStatus,
  applyTimelineRealtimeEvent,
  mergeAdminStatusSnapshot,
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

  it("keeps session-derived counts while overview-only refresh data is loading", () => {
    const current = {
      realtime: { cursor: 4 },
      state: {
        sessions: [
          { key: "C1:1", runningBackgroundJobCount: 1 }
        ],
        sessionCount: 1,
        activeCount: 1,
        openInboundCount: 2,
        openHumanInboundCount: 1,
        openSystemInboundCount: 1,
        backgroundJobCount: 1,
        runningBackgroundJobCount: 1,
        failedBackgroundJobCount: 0
      }
    };

    const merged = mergeAdminStatusSnapshot(current, {
      ok: true,
      realtime: { cursor: 5 },
      deployment: { ok: true },
      state: {
        sessionCount: 1,
        activeCount: 0,
        openInboundCount: 0,
        openHumanInboundCount: 0,
        openSystemInboundCount: 0,
        backgroundJobCount: 0,
        runningBackgroundJobCount: 0,
        failedBackgroundJobCount: 0
      }
    }) as Record<string, any>;

    expect(merged.deployment).toEqual({ ok: true });
    expect(merged.realtime).toEqual({ cursor: 4 });
    expect(merged.state.sessions).toEqual(current.state.sessions);
    expect(merged.state).toMatchObject({
      activeCount: 1,
      openInboundCount: 2,
      runningBackgroundJobCount: 1
    });
  });

  it("lets a session snapshot overwrite preserved counts after a refresh completes", () => {
    const current = {
      state: {
        sessions: [
          { key: "C1:1", runningBackgroundJobCount: 1 }
        ],
        sessionCount: 1,
        activeCount: 1,
        runningBackgroundJobCount: 1
      }
    };

    const merged = mergeAdminStatusSnapshot(current, {
      state: {
        sessions: [],
        sessionCount: 0,
        activeCount: 0,
        runningBackgroundJobCount: 0
      }
    }) as Record<string, any>;

    expect(merged.state.sessions).toEqual([]);
    expect(merged.state).toMatchObject({
      sessionCount: 0,
      activeCount: 0,
      runningBackgroundJobCount: 0
    });
  });

  it("merges partial realtime session summaries over existing rows", () => {
    const updated = applyAdminRealtimeEventToStatus({
      realtime: { cursor: 1 },
      state: {
        sessions: [
          { key: "C1:1", runningBackgroundJobCount: 1, backgroundJobCount: 1 }
        ],
        runningBackgroundJobCount: 1,
        backgroundJobCount: 1
      }
    }, {
      sequence: 2,
      kind: "session.upsert",
      scope: "session",
      sessionKey: "C1:1",
      entityId: "C1:1",
      createdAt: "2026-05-09T00:00:02.000Z",
      payload: {},
      session: { key: "C1:1", updatedAt: "2026-05-09T00:00:02.000Z" }
    } satisfies AdminRealtimeEvent) as Record<string, any>;

    expect(updated.state.sessions[0]).toMatchObject({
      key: "C1:1",
      updatedAt: "2026-05-09T00:00:02.000Z",
      runningBackgroundJobCount: 1,
      backgroundJobCount: 1
    });
    expect(updated.state).toMatchObject({
      runningBackgroundJobCount: 1,
      backgroundJobCount: 1
    });
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

  it("replaces a running realtime tool call with its matching result", () => {
    const payload = {
      ok: true,
      trace: {
        source: "broker_db",
        eventCount: 1,
        categories: {
          agent_tool_call: 1
        }
      },
      events: [
        {
          id: "tool-call-1",
          type: "agent_tool_call",
          at: "2026-05-09T00:00:01.000Z",
          turnId: "turn-1",
          callId: "call-1",
          toolName: "exec_command"
        }
      ]
    };

    const updated = applyTimelineRealtimeEvent(payload, {
      sequence: 2,
      kind: "trace.append",
      scope: "session",
      sessionKey: "C1:1",
      entityId: "tool-result-1",
      createdAt: "2026-05-09T00:00:02.000Z",
      payload: {},
      timelineEvent: {
        id: "tool-result-1",
        type: "agent_tool_result",
        at: "2026-05-09T00:00:02.000Z",
        turnId: "turn-1",
        callId: "call-1",
        toolName: "exec_command"
      }
    } satisfies AdminRealtimeEvent);

    expect((updated as Record<string, any>).events).toEqual([
      expect.objectContaining({
        id: "tool-result-1",
        type: "agent_tool_result"
      })
    ]);
    expect((updated as Record<string, any>).trace).toMatchObject({
      eventCount: 1,
      categories: {
        agent_tool_result: 1
      }
    });
  });
});
