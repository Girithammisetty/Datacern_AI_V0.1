import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/** The hub stream is a boundary (EventSource) — doubled here; the assertion
 * target is the REAL request body posted to /api/copilot/message. */
const streamCloses: ReturnType<typeof vi.fn>[] = [];
/** Captured `onEvent` callbacks, so a test can push a hub event through the
 * real handler chain exactly as realtime-hub would. */
const streamHandlers: ((topic: string, data: any) => void)[] = [];
vi.mock("@/lib/realtime/connection", () => ({
  openHubStream: vi.fn((opts: any) => {
    const close = vi.fn();
    streamCloses.push(close);
    if (opts?.handlers?.onEvent) streamHandlers.push(opts.handlers.onEvent);
    return { close };
  }),
}));

import { useCopilotThread } from "./useCopilotThread";

const fetchCalls: { url: string; body: any }[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  streamCloses.length = 0;
  streamHandlers.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url, body });
      return new Response(
        JSON.stringify({ threadId: "th-1", runId: "run-1", sessionId: `sess-${body.agentKey ?? "default"}`, topics: ["agent_run:run-1"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
});

describe("useCopilotThread agentKey routing (Tier 2b)", () => {
  it("posts the module specialist agentKey and replays the returned sessionId", async () => {
    const { result } = renderHook(() => useCopilotThread("wr:t:workspace:ws", "model-training"));

    await act(async () => {
      await result.current.send("train a severity model");
    });
    expect(fetchCalls[0].url).toBe("/api/copilot/message");
    expect(fetchCalls[0].body.agentKey).toBe("model-training");
    expect(fetchCalls[0].body.sessionId).toBeNull(); // first turn: no session yet
    expect(fetchCalls[0].body.contextUrn).toBe("wr:t:workspace:ws");

    await act(async () => {
      await result.current.send("use the claims dataset");
    });
    // Thread continuity: the agent-runtime session from turn 1 rides on turn 2.
    expect(fetchCalls[1].body.agentKey).toBe("model-training");
    expect(fetchCalls[1].body.sessionId).toBe("sess-model-training");
  });

  it("sends agentKey null (default agent) when no specialist applies", async () => {
    const { result } = renderHook(() => useCopilotThread("wr:t:workspace:ws"));
    await act(async () => {
      await result.current.send("hello");
    });
    expect(fetchCalls[0].body.agentKey).toBeNull();
  });

  it("surfaces a proposal_created hub event as a Review-proposal action", async () => {
    // agent-runtime publishes {type:"proposal_created", proposal_id, tool_id}
    // when a governed write lands as a pending proposal. That payload matches
    // none of the token/citation/done branches, so before this fix it was
    // silently dropped and the user never got a link to the approval.
    const { result } = renderHook(() => useCopilotThread("wr:t:case:case/c-1"));
    await act(async () => {
      await result.current.send("triage this dispute");
    });

    act(() => {
      streamHandlers[0]("agent_run:run-1", {
        type: "proposal_created",
        proposal_id: "prop-42",
        tool_id: "case.apply_disposition",
      });
    });

    const assistant = result.current.messages.find((m) => m.role === "assistant")!;
    expect(assistant.actions).toHaveLength(1);
    expect(assistant.actions![0].proposalId).toBe("prop-42");
    expect(assistant.actions![0].label).toBe("Review proposal");
  });

  it("still accepts a camelCase action-shaped payload", async () => {
    const { result } = renderHook(() => useCopilotThread("wr:t:workspace:ws"));
    await act(async () => {
      await result.current.send("design a dashboard");
    });
    act(() => {
      streamHandlers[0]("agent_run:run-1", {
        type: "action",
        proposalId: "prop-7",
        label: "Approve dashboard",
      });
    });
    const assistant = result.current.messages.find((m) => m.role === "assistant")!;
    expect(assistant.actions![0].proposalId).toBe("prop-7");
    expect(assistant.actions![0].label).toBe("Approve dashboard");
  });

  it("closes the live SSE stream on unmount (no leak)", async () => {
    const { result, unmount } = renderHook(() => useCopilotThread("wr:t:workspace:ws"));
    await act(async () => {
      await result.current.send("stream something");
    });
    // A hub stream is open and not yet closed while the thread is mounted.
    expect(streamCloses).toHaveLength(1);
    expect(streamCloses[0]).not.toHaveBeenCalled();
    // Unmounting (drawer close via navigation) must tear the stream down.
    unmount();
    expect(streamCloses[0]).toHaveBeenCalled();
  });
});

/** The route hint rides along with every turn.
 *
 * The drawer now talks to the meta-router instead of binding its agent to the
 * pathname, so the SCREEN has to travel as data — otherwise "run it again" on
 * the scoring page is indistinguishable from the same words anywhere else. It
 * must be sent per turn, not just on the first, because the router re-decides
 * on each one. */
describe("useCopilotThread route hint", () => {
  it("posts the hint on every turn, alongside the router agentKey", async () => {
    const { result } = renderHook(() =>
      useCopilotThread("wr:t:dataset:dataset/d-1", "meta-router", "inference"));

    await act(async () => {
      await result.current.send("run it again");
    });
    await act(async () => {
      await result.current.send("and once more");
    });

    expect(fetchCalls[0].body.agentKey).toBe("meta-router");
    expect(fetchCalls[0].body.routeHint).toBe("inference");
    // Re-routing is per-turn: the second turn must carry the hint too.
    expect(fetchCalls[1].body.routeHint).toBe("inference");
  });

  it("sends routeHint null where the route carries no prior", async () => {
    const { result } = renderHook(() =>
      useCopilotThread("wr:t:case:case/c-1", "meta-router", null));

    await act(async () => {
      await result.current.send("why did approvals spike?");
    });
    expect(fetchCalls[0].body.routeHint).toBeNull();
  });
});
