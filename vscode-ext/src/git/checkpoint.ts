/**
 * Translates bridge/src/gitops.ts results into the wire frames `checkpoint`, `changes`
 * (docs/design/VSCODE-BRIDGE.md §2.2–2.4). gitops is Node-only and shared with the server
 * bridge; it is injected here so the mapping can be tested with a fake.
 *
 * Patches are passed through as gitops produced them (200 KB per file, 1 MB total). The
 * 20 KB limit in PROTOCOL-v4 applies to the server's sync of chat messages, not to this frame.
 */
import { isAbsolute, relative } from "node:path";
import type * as GitOps from "@gitops";
import type { ChangesFrame, CheckpointFrame, Frame } from "../protocol/frames";

export type GitOpsApi = Pick<typeof GitOps, "createCheckpoint" | "computeChanges" | "rewindTo" | "repoRoot">;

export interface BeginResult {
  /** A `checkpoint` frame: either the checkpoint or `unavailable` (a warning; the run continues). */
  checkpoint: CheckpointFrame;
  /** Set when a checkpoint was taken; pass it to `finish`. */
  checkpointId: string | null;
}

export interface RunGit {
  begin(cwd: string, runId: string): Promise<BeginResult>;
  /** The `changes` frame for the checkpoint's tree against the working tree now. */
  finish(cwd: string, checkpointId: string, runId: string): Promise<ChangesFrame>;
  /** Refuses with `dirty_editors` when an open buffer under the repo root is dirty. */
  rewind(cwd: string, ref: string, opts: RewindOptions): Promise<{ ok: boolean; error?: string }>;
}

export interface RewindOptions {
  removeNew: boolean;
  openDocuments: ReadonlyMap<string, { dirty: boolean }>;
}

export function createRunGit(deps: { gitops: GitOpsApi }): RunGit {
  const { gitops } = deps;
  /** Checkpoints taken and not yet finished, keyed by checkpointId (the tree is needed for `changes`). */
  const open = new Map<string, GitOps.Checkpoint>();

  return {
    async begin(cwd, runId) {
      const res = await gitops.createCheckpoint(cwd);
      if (!res.ok) {
        return { checkpoint: { type: "checkpoint", requestId: runId, unavailable: res.unavailable }, checkpointId: null };
      }
      const cp = res.checkpoint;
      open.set(cp.checkpointId, cp);
      return {
        checkpoint: {
          type: "checkpoint",
          requestId: runId,
          checkpointId: cp.checkpointId,
          ref: cp.ref,
          createdAt: cp.createdAt,
          dirty: cp.dirty,
        },
        checkpointId: cp.checkpointId,
      };
    },

    async finish(cwd, checkpointId, runId) {
      const cp = open.get(checkpointId);
      open.delete(checkpointId);
      if (!cp) return { type: "changes", requestId: runId, changes: [], truncated: false };
      const { changes, truncated } = await gitops.computeChanges(cwd, cp.tree);
      return {
        type: "changes",
        requestId: runId,
        changes: changes.map((c) => ({ ...c, patch: c.patch ?? "" })),
        truncated,
      };
    },

    async rewind(cwd, ref, opts) {
      const root = await gitops.repoRoot(cwd);
      if (!root) return { ok: false, error: "not a git repository" };
      for (const [abs, doc] of opts.openDocuments) {
        const rel = relative(root, abs);
        const inside = rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."));
        if (doc.dirty && inside) return { ok: false, error: "dirty_editors" };
      }
      const r = await gitops.rewindTo(cwd, ref, { removeNew: opts.removeNew });
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "rewind failed" };
    },
  };
}

export interface RunHooks {
  beforeRun(run: { runId: string; cwd: string }): Promise<Frame[]>;
  afterRun(info: { runId: string }): Promise<{ frames: Frame[]; warning?: string }>;
}

/**
 * Per-run wiring for createRunManager: `beforeRun` takes the checkpoint (frame before run_ack),
 * `afterRun` emits `changes` (frame before done). A non-git cwd yields `unavailable`, an empty
 * `changes`, and the warning on `done`.
 */
export function createRunHooks(git: RunGit): RunHooks {
  const runs = new Map<string, { cwd: string; checkpointId: string | null; unavailable?: string }>();
  return {
    async beforeRun(run) {
      const begun = await git.begin(run.cwd, run.runId);
      const unavailable = "unavailable" in begun.checkpoint ? begun.checkpoint.unavailable : undefined;
      runs.set(run.runId, { cwd: run.cwd, checkpointId: begun.checkpointId, unavailable });
      return [begun.checkpoint];
    },
    async afterRun(info) {
      const st = runs.get(info.runId);
      runs.delete(info.runId);
      if (!st || st.checkpointId === null) {
        const empty: ChangesFrame = { type: "changes", requestId: info.runId, changes: [], truncated: false };
        return { frames: [empty], warning: st?.unavailable };
      }
      return { frames: [await git.finish(st.cwd, st.checkpointId, info.runId)] };
    },
  };
}
