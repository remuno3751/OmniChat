/**
 * The scrolling transcript. Rows are keyed by item id and updated in place, so a streaming reply does not
 * rebuild the list. Markdown is only re-rendered when its text (or streaming flag) changes.
 * The tool calls of a turn are gathered into one timeline row placed between the user row and the answer.
 */
import { renderMarkdown } from "../render/markdown";
import { plainToHtml } from "../render/chat-text";
import { groupTimeline } from "../render/timeline";
import type { DisplayEntry } from "../render/timeline";
import type { Strings } from "../../ui/strings";
import { el, logoMark, svg } from "./dom";
import { createThinking, createTimeline } from "./cards";
import type { ChatMessage, Part, Send, ChatViewState } from "./types";
import { canRegenerate, sendAction } from "./messageActions";
import { setTip } from "./tip";
import { canEditItem } from "./editLast";
import { createSources, sourcesOf } from "./sources";
import { stringsOf } from "./v056eTypes";

/** How close to the bottom (px) the list must be for new content to pull it down. */
const NEAR_BOTTOM_PX = 60;
const COPY_FEEDBACK_MS = 1500;
/** How long the message a history hit opened stays highlighted (the CSS animation is 2 s too). */
const FLASH_MS = 2000;

/** Material "content-copy" and "check" glyphs, the family the OmniChat app uses. */
const COPY_D = "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z";
const CHECK_D = "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";
/** Material "refresh" glyph (regenerate). */
const REGENERATE_D = "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
/** Material "edit" glyph (edit the last prompt). */
const EDIT_D = "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";

/** Icon-only copy button: the copy glyph swaps to a check (class is-copied) after a successful copy. */
function copyIconButton(cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.append(
    svg("0 0 24 24", "oc-ico oc-ico--copy", [["path", { fill: "currentColor", d: COPY_D }]]),
    svg("0 0 24 24", "oc-ico oc-ico--check", [["path", { fill: "currentColor", d: CHECK_D }]]),
  );
  b.addEventListener("click", onClick);
  return b;
}

/** Icon-only button with one glyph; the label and tooltip are set by the caller. */
function glyphButton(cls: string, d: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.appendChild(svg("0 0 24 24", "oc-ico", [["path", { fill: "currentColor", d }]]));
  b.addEventListener("click", onClick);
  return b;
}

function setCopyLabel(btn: HTMLElement, label: string): void {
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

/** The two frame-scheduling calls the coalescer needs; injectable so the scheduling is testable without a browser. */
export interface FrameApi {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

const windowFrames: FrameApi = {
  request: (cb) => window.requestAnimationFrame(() => cb()),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export interface FrameCoalescer {
  /** Schedules `paint` for the next frame. Calls made before that frame fold into the one paint. */
  request(): void;
  /** Cancels a pending frame and paints now (synchronously). */
  flush(): void;
}

/** At most one `paint` per frame; `flush` is the immediate path for the final update. */
export function createFrameCoalescer(paint: () => void, frames: FrameApi = windowFrames): FrameCoalescer {
  let handle: number | null = null;
  return {
    request() {
      if (handle !== null) return;
      handle = frames.request(() => {
        handle = null;
        paint();
      });
    },
    flush() {
      if (handle !== null) {
        frames.cancel(handle);
        handle = null;
      }
      paint();
    },
  };
}

/** One transcript row. `update` is called with every state; it must be cheap when nothing changed. */
interface Row {
  el: HTMLElement;
  update(entry: DisplayEntry, state: ChatViewState): void;
}

type Thinking = ReturnType<typeof createThinking>;

function createUserRow(send: Send, onCopied: (btn: HTMLElement) => void, onEdit: (text: string) => void): Row {
  const row = el("div", "cm-row cm-row--user");
  const bubble = el("div", "cm-msg cm-msg--user");
  const actions = el("div", "cm-actions");
  let text: string | null = null;
  let itemId = "";
  const copyBtn = copyIconButton("cm-action cm-action--icon", () => {
    if (text === null || text === "") return;
    send({ type: "copy", text });
    onCopied(copyBtn);
  });
  // Edit shows only on the last user prompt, and only while no run is going (see editLast.ts).
  const editBtn = glyphButton("cm-action cm-action--icon", EDIT_D, () => {
    if (text) onEdit(text);
  });
  editBtn.hidden = true;
  actions.append(editBtn, copyBtn);
  row.append(bubble, actions);
  return {
    el: row,
    update(entry, state) {
      const item = entry.type === "item" ? entry.item : null;
      if (!item || item.kind !== "user") return;
      if (item.text !== text) {
        text = item.text;
        bubble.innerHTML = plainToHtml(item.text);
      }
      itemId = item.id;
      copyBtn.hidden = item.text === "";
      if (copyBtn.dataset.flash !== "1") setCopyLabel(copyBtn, state.strings.copyMessage);
      const busy = state.snapshot.running || state.snapshot.sending;
      editBtn.hidden = item.text === "" || !canEditItem(state.snapshot.items, itemId, busy);
      const label = stringsOf(state).editLabel;
      setTip(editBtn, label);
    },
  };
}

function createAssistantRow(send: Send, onCopied: (btn: HTMLElement) => void): Row {
  const row = el("div", "cm-row cm-row--assistant");
  const bubble = el("div", "cm-msg cm-msg--assistant");
  const md = el("div", "cm-md");
  const status = el("div", "cm-status");
  bubble.append(md, status);
  const actions = el("div", "cm-actions");
  const copyBtn = copyIconButton("cm-action cm-action--icon", () => {
    if (copyText === "") return;
    send({ type: "copy", text: copyText });
    onCopied(copyBtn);
  });
  // Regenerate re-sends the prompt before this answer; the host refuses it while a run is active.
  const regenBtn = glyphButton("cm-action cm-action--icon", REGENERATE_D, () => {
    if (itemId !== "") sendAction(send, { type: "regenerate", id: itemId });
  });
  regenBtn.hidden = true;
  actions.append(copyBtn, regenBtn);
  // The web sources sit under the answer text, above the footer buttons (hidden while streaming).
  const sources = createSources(send);
  row.append(bubble, sources.el, actions);

  let thinking: Thinking | null = null;
  let copyText = "";
  let itemId = "";
  let statusKey: string | null = null;

  // Markdown is painted at most once per frame while streaming, always with the latest text.
  let mdText = "";
  let mdStreaming = false;
  let mdLabel = "";
  let renderedKey: string | null = null;
  const paintMarkdown = (): void => {
    const key = `${mdStreaming ? "1" : "0"}${mdText}`;
    if (key === renderedKey) return;
    md.innerHTML = renderMarkdown(mdText, { streaming: mdStreaming, copyLabel: mdLabel });
    renderedKey = key;
  };
  const mdFrame = createFrameCoalescer(paintMarkdown);

  return {
    el: row,
    update(entry, state) {
      const item = entry.type === "item" ? entry.item : null;
      if (!item || item.kind !== "assistant") return;
      const S = state.strings;
      const streaming = item.status === "streaming";
      itemId = item.id;

      if (item.reasoning) {
        if (!thinking) {
          // The reasoning is its own row above the answer bubble, never inside it.
          thinking = createThinking();
          row.insertBefore(thinking.el, bubble);
        }
        thinking.el.hidden = false;
        thinking.update(item.reasoning, streaming, item.text !== "", state);
      } else if (thinking) {
        thinking.el.hidden = true;
      }
      // Reasoning with no answer text yet (or a finished run that ended empty) shows only the reasoning row.
      bubble.hidden = !!item.reasoning && item.text === "" && (streaming || item.status === "done");

      mdText = item.text;
      mdStreaming = streaming;
      mdLabel = S.copy;
      if (streaming) {
        if (`1${item.text}` !== renderedKey) mdFrame.request();
      } else {
        mdFrame.flush();
      }

      // The reasoning block shows its own "Thinking..." dots while it is live, so the status line steps aside.
      const thinkingLive = streaming && !!item.reasoning && item.text === "";
      const nextStatusKey = `${item.status}${thinkingLive ? "~" : ""}`;
      if (nextStatusKey !== statusKey) {
        statusKey = nextStatusKey;
        status.className = `cm-status cm-status--${item.status}`;
        status.hidden = item.status === "done" || thinkingLive;
        if (item.status === "streaming") {
          const dots = el("span", "cm-typing");
          dots.setAttribute("role", "img");
          dots.setAttribute("aria-label", S.assistantStatus.streaming);
          for (let i = 0; i < 3; i++) dots.appendChild(el("span"));
          status.replaceChildren(dots);
        } else {
          status.textContent = S.assistantStatus[item.status];
        }
      }

      copyText = item.text;
      copyBtn.hidden = streaming || item.text === "";
      if (copyBtn.dataset.flash !== "1") setCopyLabel(copyBtn, S.copy);
      sources.update(sourcesOf(item), streaming, state);

      const busy = state.snapshot.running || state.snapshot.sending;
      regenBtn.hidden = !canRegenerate(state.snapshot.items, item.id, busy);
      setTip(regenBtn, S.regenerateTip);
      regenBtn.setAttribute("aria-label", S.regenerate);
    },
  };
}

function createTimelineRow(): Row {
  const row = el("div", "cm-row cm-row--timeline");
  const timeline = createTimeline();
  row.appendChild(timeline.el);
  return {
    el: row,
    update(entry, state) {
      if (entry.type === "timeline") timeline.update(entry.tools, state);
    },
  };
}

function createStatusRow(): Row {
  const row = el("div", "cm-row cm-row--status");
  const line = el("div", "cm-status-line");
  row.appendChild(line);
  let text: string | null = null;
  return {
    el: row,
    update(entry) {
      const item = entry.type === "item" ? entry.item : null;
      if (!item || item.kind !== "status" || item.text === text) return;
      text = item.text;
      line.textContent = item.text;
    },
  };
}

function createRow(entry: DisplayEntry, send: Send, onCopied: (btn: HTMLElement) => void, onEdit: (text: string) => void): Row {
  if (entry.type === "timeline") return createTimelineRow();
  switch (entry.item.kind) {
    case "user":
      return createUserRow(send, onCopied, onEdit);
    case "assistant":
      return createAssistantRow(send, onCopied);
    default:
      return createStatusRow();
  }
}

export interface MessageListOptions {
  /** The Edit button of the last prompt: the composer takes the prompt text. */
  onEdit?(text: string): void;
}

export function createMessageList(send: Send, opts: MessageListOptions = {}): Part & { scrollTo(id: string): void } {
  const onEdit = (text: string): void => opts.onEdit?.(text);
  const list = el("div", "cm-list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");

  const rows = new Map<string, Row>();
  const emptyEl = el("div", "cm-empty");
  const emptyLogo = logoMark("oc-logo cm-empty__logo");
  const emptyText = el("p", "cm-empty__text");
  emptyEl.append(emptyLogo, emptyText);

  let strings: Strings | null = null;
  let lastConversationId: string | null | undefined = undefined;
  const copyTimers = new WeakMap<HTMLElement, number>();

  function flash(btn: HTMLElement): void {
    if (!strings) return;
    const label = strings.copied;
    btn.dataset.flash = "1";
    btn.classList.add("is-copied");
    setCopyLabel(btn, label);
    const prev = copyTimers.get(btn);
    if (prev !== undefined) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      delete btn.dataset.flash;
      btn.classList.remove("is-copied");
      setCopyLabel(btn, strings ? strings.copy : label);
      copyTimers.delete(btn);
    }, COPY_FEEDBACK_MS);
    copyTimers.set(btn, timer);
  }

  function openPath(node: HTMLElement | null): void {
    if (!node || !list.contains(node)) return;
    const path = node.dataset.ocPath;
    if (!path) return;
    const line = Number(node.dataset.ocLine);
    // The "openFile" message (docs/design/V055-CONTRACT.md) is declared with the host code.
    const msg: Record<string, unknown> = { type: "openFile", path };
    if (Number.isInteger(line) && line > 0) msg.line = line;
    send(msg as unknown as ChatMessage);
  }

  // Delegated clicks: copy buttons inside rendered code blocks (data-oc-copy) and file paths (data-oc-path).
  list.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const btn = target.closest("[data-oc-copy]") as HTMLElement | null;
    if (btn && list.contains(btn)) {
      const code = btn.closest(".oc-code")?.querySelector("code")?.textContent ?? "";
      if (code === "") return;
      send({ type: "copy", text: code });
      flash(btn);
      return;
    }
    openPath(target.closest("[data-oc-path]") as HTMLElement | null);
  });
  // Paths are links by role, so Enter / Space open them as well.
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const node = target.closest("[data-oc-path]") as HTMLElement | null;
    if (!node) return;
    e.preventDefault();
    openPath(node);
  });

  // The message a history hit opened: its bubble flashes for 2 s (one at a time).
  let flashed: HTMLElement | null = null;
  let flashTimer: number | null = null;
  function clearFlash(): void {
    if (flashTimer !== null) window.clearTimeout(flashTimer);
    flashTimer = null;
    flashed?.classList.remove("ch-msg--flash");
    flashed = null;
  }

  /** Scrolls the message with this item id into view and flashes it. Unknown ids (not loaded yet) are ignored. */
  function scrollTo(id: string): void {
    const row = rows.get(`user:${id}`) ?? rows.get(`assistant:${id}`);
    if (!row) return;
    clearFlash();
    const target = row.el.querySelector<HTMLElement>(".cm-msg") ?? row.el;
    target.scrollIntoView({ block: "center" });
    void target.offsetWidth; // restart the animation when the same message is opened twice
    target.classList.add("ch-msg--flash");
    flashed = target;
    flashTimer = window.setTimeout(clearFlash, FLASH_MS);
    target.addEventListener("animationend", () => {
      if (flashed === target) clearFlash();
    }, { once: true });
  }

  function renderEmpty(state: ChatViewState): void {
    const S = state.strings;
    emptyText.textContent = state.snapshot.loadingConversation ? S.loadingConversation : S.noMessages;
    emptyText.className = state.snapshot.loadingConversation ? "cm-empty__text cm-muted" : "cm-empty__text";
    if (!emptyEl.isConnected) list.appendChild(emptyEl);
  }

  return {
    el: list,
    scrollTo,
    update(state: ChatViewState) {
      strings = state.strings;
      const items = state.snapshot.items;
      const conversationId = state.snapshot.conversationId;
      const switched = conversationId !== lastConversationId;
      lastConversationId = conversationId;

      if (items.length === 0) {
        for (const row of rows.values()) row.el.remove();
        rows.clear();
        renderEmpty(state);
        list.scrollTop = 0;
        return;
      }
      emptyEl.remove();

      const near = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
      const hadRows = rows.size > 0;
      const entries = groupTimeline(items);
      const keys = entries.map((e) => e.key);
      const live = new Set(keys);
      for (const [key, row] of rows) {
        if (!live.has(key)) {
          row.el.remove();
          rows.delete(key);
        }
      }

      let appendedUser = false;
      for (const entry of entries) {
        let row = rows.get(entry.key);
        if (!row) {
          row = createRow(entry, send, flash, onEdit);
          rows.set(entry.key, row);
          if (entry.type === "item" && entry.item.kind === "user") appendedUser = true;
        }
        try {
          row.update(entry, state);
        } catch (err) {
          console.error("[omnichat] transcript row failed", err);
        }
      }

      // Keep DOM order equal to display order; moves only the rows that are out of place.
      let cursor: Element | null = list.firstElementChild;
      for (const key of keys) {
        const row = rows.get(key);
        if (!row) continue;
        if (row.el === cursor) cursor = cursor.nextElementSibling;
        else list.insertBefore(row.el, cursor);
      }

      if (switched || !hadRows || near || appendedUser) list.scrollTop = list.scrollHeight;
    },
  };
}
