/**
 * Builds `ChatViewState.extras`: the slash command list, the attachment limits, the device list and
 * the pinned favourites, all localised. Pure, no `vscode` import.
 */
import type { DeviceItem } from "../protocol/chat-frames";
import type { InputStrings } from "../ui/stringsInput";
import type { V056dStrings } from "../ui/stringsV056d";
import { ATTACH_LIMITS, type VisionOk } from "./attach";
import type { ChatError, ChatSnapshot, ListState } from "./controllerTypes";
import type { Strings } from "../ui/strings";
import type { Favorites } from "./favorites";

/** Every entry of the composer's slash menu. `model` and `help` are answered inside the webview. */
export type SlashMenuName =
  | "clear"
  | "context"
  | "model"
  | "help"
  | "compact"
  | "usage"
  | "retry"
  | "pin"
  | "export"
  | "effort"
  | "rename";

export interface ExtrasView {
  /** `arg` is set for an entry that takes a fixed argument, e.g. `export json`. */
  slash: Array<{ name: SlashMenuName; desc: string; arg?: string }>;
  attach: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    imageMimes: string[];
    /** Vision of the effective model; null when unknown (the server decides then). */
    visionOk: boolean | null;
  };
  devices: { state: ListState; items: DeviceItem[] };
  favorites: { devices: string[]; folders: string[] };
}

/** Vision of the model a prompt is sent with: true, false, or null when unknown. */
export function visionOf(snap: ChatSnapshot): VisionOk {
  const model = snap.models.find((m) => m.ref === snap.effectiveModel);
  if (model?.vision === "yes") return true;
  if (model?.vision === "no") return false;
  return null;
}

export function buildExtras(input: {
  strings: InputStrings & V056dStrings;
  snapshot: ChatSnapshot;
  favorites: Favorites;
}): ExtrasView {
  const s = input.strings;
  return {
    slash: [
      { name: "clear", desc: s.slashClear },
      { name: "context", desc: s.slashContext },
      { name: "model", desc: s.slashModel },
      { name: "help", desc: s.slashHelp },
      { name: "compact", desc: s.slashCompact },
      { name: "usage", desc: s.slashUsage },
      { name: "retry", desc: s.slashRetry },
      { name: "pin", desc: s.slashPin },
      { name: "export", desc: s.slashExport },
      { name: "effort", desc: s.slashEffort },
      { name: "rename", desc: s.slashRename },
      { name: "export", arg: "json", desc: s.slashExportJson },
    ],
    attach: {
      maxFiles: ATTACH_LIMITS.maxFiles,
      maxFileBytes: ATTACH_LIMITS.maxFileBytes,
      maxTotalBytes: ATTACH_LIMITS.maxTotalBytes,
      imageMimes: [...ATTACH_LIMITS.imageMimes],
      visionOk: visionOf(input.snapshot),
    },
    devices: { state: input.snapshot.devices.state, items: input.snapshot.devices.items },
    favorites: { devices: [...input.favorites.devices], folders: [...input.favorites.folders] },
  };
}

/** The text of a controller error. Attachment codes use their own wording. */
export function errorTextOf(err: ChatError, strings: Strings): string {
  switch (err.code) {
    case "generic":
      return err.message ?? strings.errors.generic;
    case "attachment_invalid":
      return strings.errAttachInvalid;
    case "attachment_too_large":
      return strings.errAttachTooLarge;
    case "attachment_not_supported":
      return strings.errAttachNotSupported;
    default:
      return strings.errors[err.code];
  }
}
