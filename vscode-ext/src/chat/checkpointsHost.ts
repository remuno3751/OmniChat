/**
 * Host side of the checkpoints panel (v0.5.6-E, contract §2): answers `requestCheckpoints` and
 * `restoreCheckpoint` from the webview. A restore asks first in a modal dialog (`confirm`, injected so the
 * VS Code window is not needed in tests); a cancelled dialog sends nothing. The result is a toast, a local
 * status line in the transcript, and a fresh list on success. No `vscode` import.
 */
import type { ChatController, RestoreOutcome } from "./controllerTypes";
import type { CheckpointItem } from "../protocol/chat-frames";
import type { Strings } from "../ui/strings";
import { checkpointTimeLabel } from "./viewModelV056e";

export interface CheckpointsHostDeps {
  controller: ChatController;
  strings: Strings;
  now: () => number;
  /** Shows a modal warning with the buttons. Resolves with the chosen button's text, or undefined when cancelled. */
  confirm: (message: string, buttons: string[]) => Promise<string | undefined>;
  /** Shows a toast on the surface the request came from. */
  toast: (text: string) => void;
}

export interface CheckpointsHost {
  /** The webview asked for the list. */
  request(): void;
  /** The webview asked to restore a checkpoint. Unknown ids are ignored. */
  restore(checkpointId: string): void;
}

/** Fills `{name}` placeholders. A function replacer keeps `$` in the values as written. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? (values[key] ?? "") : whole));
}

/** The toast text of a failed restore. */
function failureText(s: Strings, r: RestoreOutcome): string {
  switch (r.error) {
    case "busy":
      return s.cpBusy;
    case "dirty_editors":
      return s.cpDirtyEditors;
    case "unavailable":
      return s.cpUnavailable;
    case "timeout":
      return fill(s.cpFailed, { msg: s.errors.timeout });
    default:
      return fill(s.cpFailed, { msg: r.message ?? r.error ?? s.errors.generic });
  }
}

export function createCheckpointsHost(d: CheckpointsHostDeps): CheckpointsHost {
  const s = d.strings;
  const timeOf = (item: CheckpointItem): string => checkpointTimeLabel(item.createdAt, d.now());

  const onResult = (item: CheckpointItem, r: RestoreOutcome): void => {
    if (!r.ok) {
      d.toast(failureText(s, r));
      return;
    }
    const text = fill(s.cpRestored, { time: timeOf(item) });
    d.controller.checkpoints.appendStatus(text);
    d.toast(text);
    d.controller.checkpoints.request();
  };

  return {
    request() {
      d.controller.checkpoints.request();
    },
    restore(checkpointId) {
      const snap = d.controller.snapshot();
      const item = snap.checkpoints.items.find((i) => i.id === checkpointId);
      if (item === undefined || snap.checkpoints.restoring !== null) return;
      if (snap.busy) return d.toast(s.cpBusy);
      if (!item.restorable) return d.toast(s.cpUnavailable);
      const message = fill(s.cpConfirm, { time: timeOf(item), prompt: item.prompt === "" ? "—" : item.prompt });
      void d.confirm(message, [s.cpConfirmRestore, s.cpConfirmRestoreRemove]).then((choice) => {
        if (choice === undefined) return; // cancelled: nothing is sent
        if (d.controller.snapshot().busy) return d.toast(s.cpBusy); // a run started while the dialog was open
        const removeNew = choice === s.cpConfirmRestoreRemove;
        const sent = d.controller.checkpoints.restore(checkpointId, removeNew, (r) => onResult(item, r));
        if (!sent) d.toast(fill(s.cpFailed, { msg: s.errors.not_ready }));
      });
    },
  };
}
