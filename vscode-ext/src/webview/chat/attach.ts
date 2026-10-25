/**
 * Attachments of the composer: the paperclip button and hidden file input, drag and drop onto the composer, paste of
 * files, and the chips row (name, size, thumbnail for images, remove). Files are read to base64 with FileReader.
 * Pre-checks follow the host's limits (state.extras.attach); the server still decides.
 */
import { el, svg } from "./dom";
import { checkAttachment, fillTemplate, formatSize, isImageMime, limitMb, type AttachProblem } from "./attachLogic";
import { DEFAULT_ATTACH, extrasOf, type AttachLimitsView, type ChatViewState, type OutAttachment } from "./types";
import { setTip } from "./tip";

type Strings = ChatViewState["strings"];

interface Item {
  el: HTMLElement;
  name: string;
  size: number;
  mime: string;
  /** Base64 of the file, null while it is being read. */
  data: string | null;
  remove: HTMLButtonElement;
}

export interface AttachOptions {
  /** The composer textarea (paste target). */
  input: HTMLTextAreaElement;
  /** The composer box (drop target). */
  zone: HTMLElement;
  /** Shows a toast above the composer. */
  toast(text: string): void;
  /** Called when the chips change (so the send button can refresh). */
  onChange(): void;
}

export interface Attach {
  /** The paperclip button. */
  button: HTMLButtonElement;
  /** The hidden multi-file input the button opens. */
  fileInput: HTMLInputElement;
  /** The chips row (hidden while empty). */
  chips: HTMLElement;
  /** The overlay shown while a file is dragged over the composer. */
  overlay: HTMLElement;
  update(state: ChatViewState): void;
  /** The files ready to send (base64 read done). */
  takeAttachments(): OutAttachment[];
  /** True while a file is still being read. */
  busy(): boolean;
  /** Removes every chip (after the host took the prompt). */
  clear(): void;
}

const ICON_CLIP: Array<[string, Record<string, string>]> = [
  [
    "path",
    {
      d: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
  ],
];

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function createAttach(opts: AttachOptions): Attach {
  const button = el("button", "cm-attach");
  button.type = "button";
  button.appendChild(svg("0 0 24 24", "cm-attach__icon", ICON_CLIP));
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const chips = el("div", "cm-attachments");
  chips.setAttribute("role", "list");
  chips.hidden = true;
  const overlay = el("div", "cm-drop");
  overlay.setAttribute("aria-hidden", "true");

  let items: Item[] = [];
  let strings: Strings | null = null;
  let limits: AttachLimitsView = DEFAULT_ATTACH;

  function totals(): { count: number; totalBytes: number } {
    return { count: items.length, totalBytes: items.reduce((n, i) => n + i.size, 0) };
  }

  function problemText(problem: AttachProblem, name: string): string {
    const S = strings;
    if (!S) return "";
    switch (problem) {
      case "badType":
        return fillTemplate(S.attachBadType, { name });
      case "tooBig":
        return fillTemplate(S.attachTooBig, { name, mb: limitMb(limits.maxFileBytes) });
      case "totalBig":
        return fillTemplate(S.attachTotalBig, { mb: limitMb(limits.maxTotalBytes) });
      case "tooMany":
        return fillTemplate(S.attachTooMany, { n: limits.maxFiles });
      case "noVision":
        return S.attachNoVision;
    }
  }

  function removeItem(item: Item): void {
    items = items.filter((i) => i !== item);
    item.el.remove();
    chips.hidden = items.length === 0;
    opts.onChange();
  }

  function makeChip(file: File): Item {
    const item: Item = { el: el("span", "cm-attach__chip"), name: file.name, size: file.size, mime: file.type || "application/octet-stream", data: null, remove: el("button", "cm-attach__x", "×") };
    item.el.setAttribute("role", "listitem");
    item.remove.type = "button";
    item.remove.addEventListener("click", () => removeItem(item));
    if (isImageMime(item.mime)) {
      const thumb = el("img", "cm-attach__thumb");
      thumb.alt = "";
      item.el.appendChild(thumb);
    } else {
      item.el.appendChild(svg("0 0 24 24", "cm-attach__icon", ICON_CLIP));
    }
    item.el.append(el("span", "cm-attach__name", file.name), el("span", "cm-attach__size", formatSize(file.size)), item.remove);
    return item;
  }

  function readFile(file: File, item: Item): void {
    const reader = new FileReader();
    const fail = () => {
      if (strings) opts.toast(strings.errAttachInvalid);
      removeItem(item);
    };
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) return fail();
      item.data = url.slice(comma + 1);
      // The data URL doubles as the thumbnail (img-src allows data: only, not blob:).
      const thumb = item.el.querySelector<HTMLImageElement>("img.cm-attach__thumb");
      if (thumb) thumb.src = url;
      opts.onChange();
    };
    reader.onerror = fail;
    reader.readAsDataURL(file);
  }

  function addFiles(files: File[]): void {
    let warned = false;
    for (const file of files) {
      const problem = checkAttachment({ name: file.name, mime: file.type, size: file.size }, totals(), limits);
      if (problem) {
        // Show the first problem of the batch only; the toast is short-lived.
        if (!warned) opts.toast(problemText(problem, file.name));
        warned = true;
        continue;
      }
      const item = makeChip(file);
      items.push(item);
      chips.appendChild(item.el);
      chips.hidden = false;
      readFile(file, item);
    }
    if (files.length > 0) opts.onChange();
  }

  button.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const picked = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    addFiles(picked);
  });

  opts.input.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  });

  const zone = opts.zone;
  zone.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    zone.classList.add("cm-composer--drop");
  });
  zone.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove("cm-composer--drop");
  });
  zone.addEventListener("drop", (e) => {
    zone.classList.remove("cm-composer--drop");
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  });

  return {
    button,
    fileInput,
    chips,
    overlay,
    update(state: ChatViewState) {
      const S = state.strings;
      strings = S;
      limits = extrasOf(state).attach;
      // Like the textarea: usable offline (the files wait with the draft); only an unsupported server locks it.
      button.disabled = state.snapshot.chatSupport === "unsupported";
      setTip(button, S.attachBtn);
      overlay.textContent = S.attachDrop;
      for (const item of items) setTip(item.remove, S.attachRemove);
    },
    takeAttachments(): OutAttachment[] {
      return items.flatMap((i) => (i.data === null ? [] : [{ name: i.name, mime: i.mime, data: i.data }]));
    },
    busy(): boolean {
      return items.some((i) => i.data === null);
    },
    clear() {
      for (const item of items) item.el.remove();
      items = [];
      chips.hidden = true;
    },
  };
}
