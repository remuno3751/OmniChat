/**
 * The checkpoint calls of the chat controller (v0.5.6-E): the list request, the restore request and the
 * local status line. Each request is tracked by requestId, so a silent server times out. Split from
 * controller.ts to keep it small. No `vscode` import.
 */
import type { CheckpointApi } from "./controllerTypes";
import type { PendingKind } from "./pending";
import type { RequestDeps } from "./requests";
import type { ChatState, CheckpointsState } from "./state";

/** A restore runs git and writes files, so it gets more time than the list requests. */
export const RESTORE_TIMEOUT_MS = 60_000;

const EMPTY = (conversationId: string | null, state: CheckpointsState["state"]): CheckpointsState => ({
  conversationId,
  state,
  items: [],
  restoring: null,
  error: state === "error",
});

export function createCheckpointRequests(d: RequestDeps): CheckpointApi {
  const { st } = d;
  /** Shows the state of the list and keeps a restore in progress for the same conversation. */
  const setList = (conversationId: string | null, state: CheckpointsState["state"]): void => {
    const restoring = st.checkpoints.conversationId === conversationId ? st.checkpoints.restoring : null;
    st.checkpoints = { ...EMPTY(conversationId, state), restoring };
    d.emit();
  };

  return {
    request() {
      const conversationId = st.conversationId;
      d.pending.drop((r) => r.kind === "checkpoints");
      if (conversationId === null) return setList(null, "ready"); // a new chat has no checkpoints yet
      if (!st.online || d.support() === "unsupported") return setList(conversationId, "error");
      const requestId = d.nextId("h");
      if (!d.send({ type: "checkpoints_request", requestId, conversationId })) return setList(conversationId, "error");
      d.pending.track(requestId, { kind: "checkpoints", conversationId }, d.timeoutMs);
      setList(conversationId, "loading");
    },
    restore(checkpointId, removeNew, onResult) {
      const conversationId = st.conversationId;
      if (!st.online || conversationId === null || st.checkpoints.restoring !== null) return false;
      const requestId = d.nextId("r");
      const sent = d.send({
        type: "checkpoint_restore",
        requestId,
        conversationId,
        checkpointId,
        ...(removeNew ? { removeNew: true } : {}),
      });
      if (!sent) return false;
      d.pending.track(requestId, { kind: "checkpoint_restore", conversationId, onRestore: onResult }, RESTORE_TIMEOUT_MS);
      st.checkpoints = { ...st.checkpoints, restoring: checkpointId };
      d.emit();
      return true;
    },
    appendStatus(text) {
      const id = st.conversationId;
      if (id === null) return;
      st.transcripts.set(id, [...(st.transcripts.get(id) ?? []), { kind: "status", text }]);
      d.emit();
    },
  };
}

/** A checkpoint request failed (error frame, timeout): the list shows the error, a restore just stops. */
export function settleCheckpoints(st: ChatState, kind: PendingKind, conversation: string | undefined): void {
  if (st.checkpoints.conversationId !== (conversation ?? null)) return; // the conversation was left meanwhile
  if (kind === "checkpoints") st.checkpoints = EMPTY(conversation ?? null, "error");
  else if (kind === "checkpoint_restore") st.checkpoints = { ...st.checkpoints, restoring: null };
}
