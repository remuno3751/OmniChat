/**
 * The scrolling transcript. Rows are keyed by item id and updated in place, so a streaming reply does not
 * rebuild the list. Markdown is only re-rendered when its text (or streaming flag) changes.
 */
import { renderMarkdown } from "../render/markdown";
import { plainToHtml } from "../render/chat-text";
import type { Strings } from "../../ui/strings";
import type { TranscriptItem } from "../../protocol/chat-frames";
import { button, el, logoMark } from "./dom";
import { createThinking, createToolCard } from "./cards";
import type { Part, Send, ChatViewState } from "./types";

/** How close to the bottom (px) the list must be for new content to pull it down. */
const NEAR_BOTTOM_PX = 60;
const COPY_FEEDBACK_MS = 1500;

/** One transcript row. `update` is called with every state; it must be cheap when nothing changed. */
interface Row {
  el: HTMLElement;
  update(item: TranscriptItem, state: ChatViewState): void;
}

type Thinking = ReturnType<typeof createThinking>;
type ToolCard = ReturnType<typeof createToolCard>;

function keyOf(item: TranscriptItem, index: number): string {
  return `${item.kind}:${item.id ?? `#${index}`}`;
}

function createUserRow(): Row {
  const row = el("div", "cm-row cm-row--user");
  const bubble = el("div", "cm-msg cm-msg--user");
  row.appendChild(bubble);
  let text: string | null = null;
  return {
    el: row,
    update(item) {
      if (item.kind !== "user" || item.text === text) return;
      text = item.text;
      bubble.innerHTML = plainToHtml(item.text);
    },
  };
}

function createAssistantRow(send: Send): Row {
  const row = el("div", "cm-row cm-row--assistant");
  const bubble = el("div", "cm-msg cm-msg--assistant");
  const md = el("div", "cm-md");
  const status = el("div", "cm-status");
  bubble.append(md, status);
  const actions = el("div", "cm-actions");
  const copyBtn = button("", "cm-action", () => {
    if (copyText !== "") send({ type: "copy", text: copyText });
  });
  actions.appendChild(copyBtn);
  row.append(bubble, actions);

  let thinking: Thinking | null = null;
  let copyText = "";
  let renderedKey: string | null = null;
  let statusKey: string | null = null;

  return {
    el: row,
    update(item, state) {
      if (item.kind !== "assistant") return;
      const S = state.strings;
      const streaming = item.status === "streaming";

      if (item.reasoning) {
        if (!thinking) {
          thinking = createThinking();
          bubble.insertBefore(thinking.el, md);
        }
        thinking.el.hidden = false;
        thinking.update(item.reasoning, streaming, state);
      } else if (thinking) {
        thinking.el.hidden = true;
      }

      const mdKey = `${streaming ? "1" : "0"}${item.text}`;
      if (mdKey !== renderedKey) {
        md.innerHTML = renderMarkdown(item.text, { streaming, copyLabel: S.copy });
        renderedKey = mdKey;
      }

      if (item.status !== statusKey) {
        statusKey = item.status;
        status.className = `cm-status cm-status--${item.status}`;
        status.hidden = item.status === "done";
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
      if (copyBtn.dataset.flash !== "1") copyBtn.textContent = S.copy;
    },
  };
}

function createToolRow(): Row {
  const row = el("div", "cm-row cm-row--tool");
  let card: ToolCard | null = null;
  return {
    el: row,
    update(item, state) {
      if (item.kind !== "tool") return;
      if (!card) {
        card = createToolCard(item, state);
        row.appendChild(card.el);
      }
      card.update(item, state);
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
    update(item) {
      if (item.kind !== "status" || item.text === text) return;
      text = item.text;
      line.textContent = item.text;
    },
  };
}

function createRow(item: TranscriptItem, send: Send): Row {
  switch (item.kind) {
    case "user":
      return createUserRow();
    case "assistant":
      return createAssistantRow(send);
    case "tool":
      return createToolRow();
    default:
      return createStatusRow();
  }
}

export function createMessageList(send: Send): Part {
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

  // Copy buttons inside rendered code blocks (delegated; the markdown HTML carries data-oc-copy).
  list.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    const btn = target && typeof target.closest === "function" ? (target.closest("[data-oc-copy]") as HTMLElement | null) : null;
    if (!btn || !list.contains(btn)) return;
    const code = btn.closest(".oc-code")?.querySelector("code")?.textContent ?? "";
    if (code === "") return;
    send({ type: "copy", text: code });
    flash(btn);
  });

  function flash(btn: HTMLElement): void {
    if (!strings) return;
    const label = strings.copied;
    btn.dataset.flash = "1";
    btn.textContent = label;
    const prev = copyTimers.get(btn);
    if (prev !== undefined) window.clearTimeout(prev);
    const timer = window.setTimeout(() => {
      delete btn.dataset.flash;
      btn.textContent = strings ? strings.copy : label;
      copyTimers.delete(btn);
    }, COPY_FEEDBACK_MS);
    copyTimers.set(btn, timer);
  }

  function renderEmpty(state: ChatViewState): void {
    const S = state.strings;
    emptyText.textContent = state.snapshot.loadingConversation ? S.loadingConversation : S.noMessages;
    emptyText.className = state.snapshot.loadingConversation ? "cm-empty__text cm-muted" : "cm-empty__text";
    if (!emptyEl.isConnected) list.appendChild(emptyEl);
  }

  return {
    el: list,
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
      const keys = items.map((item, i) => keyOf(item, i));
      const live = new Set(keys);
      for (const [key, row] of rows) {
        if (!live.has(key)) {
          row.el.remove();
          rows.delete(key);
        }
      }

      let appendedUser = false;
      items.forEach((item, i) => {
        const key = keys[i];
        let row = rows.get(key);
        if (!row) {
          row = createRow(item, send);
          rows.set(key, row);
          if (item.kind === "user") appendedUser = true;
        }
        try {
          row.update(item, state);
        } catch (err) {
          console.error("[omnichat] transcript row failed", err);
        }
      });

      // Keep DOM order equal to transcript order; moves only the rows that are out of place.
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
