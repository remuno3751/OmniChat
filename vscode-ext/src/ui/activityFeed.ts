/**
 * Turns protocol frames into activity reducer events (docs/design/VSCODE-BRIDGE.md §2.2–2.3).
 * Inbound and outbound frames both go through `handle`; their types never overlap. `run` is held
 * until `run_ack` is accepted, so a rejected (busy) run does not replace the run on screen.
 * No `vscode` import.
 */
import { reduce, type ActivityEvent, type ActivityState } from "./activityModel";
import type { Frame, RunFrame } from "../protocol/frames";

/** Maps one frame to reducer events. `run` and `run_ack` are handled by the feed (they need state). */
export function eventsForFrame(frame: Frame): ActivityEvent[] {
  switch (frame.type) {
    case "tool_call":
      return [{ type: "toolCall", callId: frame.callId, tool: frame.tool, args: frame.args }];
    case "tool_result":
      return [
        {
          type: "toolResult",
          callId: frame.callId,
          ok: frame.ok,
          summary: frame.ok ? "" : `${frame.error.code}: ${frame.error.message}`,
          durationMs: frame.ok ? frame.durationMs : 0,
        },
      ];
    case "done":
      return [{ type: "runDone", ok: frame.ok, error: frame.error }];
    case "approval":
      return [{ type: "approvalPending", approvalId: frame.approvalId }];
    default:
      return [];
  }
}

export interface ActivityFeed {
  /** Feeds one frame, inbound or outbound. Frames that do not map are ignored. */
  handle(frame: Frame): void;
  /** Ends a running run as interrupted, e.g. when the connection drops. No-op otherwise. */
  interrupt(reason: string): void;
  state(): ActivityState | null;
}

function runStart(run: RunFrame): ActivityEvent {
  return { type: "runStart", runId: run.runId, cwd: run.cwd, mode: run.approvalMode };
}

/** `onChange` runs only when the state object changes. */
export function createActivityFeed(onChange: (state: ActivityState | null) => void): ActivityFeed {
  let state: ActivityState | null = null;
  let pendingRun: RunFrame | null = null;

  const apply = (events: readonly ActivityEvent[]): void => {
    let next = state;
    for (const event of events) next = reduce(next, event);
    if (next !== state) {
      state = next;
      onChange(state);
    }
  };

  return {
    handle(frame) {
      if (frame.type === "run") {
        pendingRun = frame;
        return;
      }
      if (frame.type === "run_ack") {
        const run = pendingRun;
        pendingRun = null;
        if (run && frame.ok && run.runId === frame.runId) apply([runStart(run)]);
        return;
      }
      apply(eventsForFrame(frame));
    },
    interrupt(reason) {
      pendingRun = null;
      if (state?.status === "running") apply([{ type: "runDone", ok: false, error: reason }]);
    },
    state() {
      return state;
    },
  };
}
