/**
 * Handles the S -> E `rewind` frame (docs/design/VSCODE-BRIDGE.md §2.3, §2.4). Replies with
 * `rewound`. Refused during a run, outside the workspace roots, or with dirty open editors.
 */
import type { OpenDocument } from "../host/types";
import type { Frame, RewindFrame, RewoundFrame } from "../protocol/frames";
import type { RunGit } from "../git/checkpoint";
import { within } from "./runs";

export interface RewindDeps {
  send(frame: Frame): boolean;
  /** The run in progress (including closing), or null. Rewind is refused while one exists. */
  activeRunId(): string | null;
  roots(): readonly string[];
  openDocuments(): ReadonlyMap<string, OpenDocument>;
  git: RunGit;
}

export function createRewindHandler(deps: RewindDeps): (frame: RewindFrame) => Promise<void> {
  const reply = (requestId: string, ok: boolean, error?: string): void => {
    const frame: RewoundFrame = error === undefined ? { type: "rewound", requestId, ok } : { type: "rewound", requestId, ok, error };
    deps.send(frame);
  };

  return async (f) => {
    if (deps.activeRunId() !== null) return reply(f.requestId, false, "busy");
    if (!deps.roots().some((r) => within(f.cwd, r))) return reply(f.requestId, false, "cwd not allowed");
    const res = await deps.git.rewind(f.cwd, f.ref, { removeNew: f.removeNew, openDocuments: deps.openDocuments() });
    reply(f.requestId, res.ok, res.error);
  };
}
