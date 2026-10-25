/**
 * History search: the field above the history drawer list. A non-empty query is sent to the host after a 250 ms pause
 * and the hits replace the recent list; an empty box shows the list again. Snippets keep the host's match markers
 * (\u0001 ... \u0002) and are drawn as <mark> elements, never as HTML.
 */
import type { SearchHit } from "../../protocol/chat-frames-v056d";
import { el } from "./dom";
import { searchOf, sendExtra, type ChatViewState, type Send } from "./types";

const DEBOUNCE_MS = 250;
const MAX_QUERY_CHARS = 200;
const MATCH_START = "\u0001";
const MATCH_END = "\u0002";

export interface SnippetPart {
  text: string;
  match: boolean;
}

/** Splits a snippet at the host's match markers: "a \u0001b\u0002 c" -> [a , (b, match), c]. Unclosed matches run to the end. */
export function splitSnippet(snippet: string): SnippetPart[] {
  const out: SnippetPart[] = [];
  let match = false;
  let buf = "";
  for (const ch of snippet) {
    if (ch !== MATCH_START && ch !== MATCH_END) {
      buf += ch;
      continue;
    }
    if (buf !== "") out.push({ text: buf, match });
    buf = "";
    match = ch === MATCH_START;
  }
  if (buf !== "") out.push({ text: buf, match });
  return out;
}

/** The query as sent: trimmed and at most 200 characters. Empty means "no search". */
export function cleanQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_CHARS);
}

export interface HistorySearchOptions {
  /** A hit was clicked: the caller closes the drawer. */
  onOpenHit(): void;
  /** The box changed (typing): the caller re-applies the last state so the recent list shows or hides. */
  onChange(): void;
}

export interface HistorySearch {
  input: HTMLInputElement;
  note: HTMLParagraphElement;
  list: HTMLUListElement;
  /** Shows the state's answer for the box. Returns true while a query is in the box (the caller then hides the recents). */
  update(state: ChatViewState): boolean;
  /** Empties the box and drops a pending search (the drawer closed). */
  clear(): void;
}

function snippetNode(text: string): HTMLElement {
  const span = el("span", "ch-hit__snippet");
  for (const part of splitSnippet(text)) {
    if (part.match) span.appendChild(el("mark", "", part.text));
    else span.appendChild(document.createTextNode(part.text));
  }
  return span;
}

function hitRow(hit: SearchHit, S: ChatViewState["strings"], send: Send, onOpenHit: () => void): HTMLLIElement {
  const row = el("li", "ch-hit");
  const btn = el("button", "ch-hit__btn");
  btn.type = "button";
  const top = el("div", "ch-hit__top");
  const title = el("span", "ch-hit__title", hit.title.trim() === "" ? S.untitled : hit.title);
  title.title = hit.title;
  const tag = el("span", "ch-hit__tag", hit.messageId !== undefined ? S.searchMessageHit : S.searchTitleHit);
  top.append(title, tag);
  btn.appendChild(top);
  if (hit.snippet !== "") btn.appendChild(snippetNode(hit.snippet));
  btn.addEventListener("click", () => {
    const messageId = hit.messageId !== undefined ? { messageId: hit.messageId } : {};
    sendExtra(send, { type: "openHit", conversationId: hit.conversationId, ...messageId });
    onOpenHit();
  });
  row.appendChild(btn);
  return row;
}

export function createHistorySearch(send: Send, opts: HistorySearchOptions): HistorySearch {
  const input = el("input", "ch-history__search");
  input.type = "search";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  const note = el("p", "ch-history__note");
  const list = el("ul", "ch-history__list");
  list.hidden = true;
  note.hidden = true;

  let timer: number | null = null;
  // The hits last drawn, so the rows (and the focused one) are only rebuilt when something changed.
  let signature = "";

  function cancel(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  input.addEventListener("input", () => {
    cancel();
    const query = cleanQuery(input.value);
    opts.onChange();
    if (query === "") return;
    timer = window.setTimeout(() => {
      timer = null;
      sendExtra(send, { type: "searchHistory", query });
    }, DEBOUNCE_MS);
  });

  function renderHits(state: ChatViewState, hits: SearchHit[], query: string): void {
    const sig = `${state.lang}\u0000${query}\u0000${JSON.stringify(hits)}`;
    if (sig === signature) return;
    signature = sig;
    list.replaceChildren(...hits.map((h) => hitRow(h, state.strings, send, opts.onOpenHit)));
  }

  function update(state: ChatViewState): boolean {
    const S = state.strings;
    input.placeholder = S.searchPlaceholder;
    input.setAttribute("aria-label", S.searchPlaceholder);
    const query = cleanQuery(input.value);
    if (query === "") {
      note.hidden = true;
      list.hidden = true;
      signature = "";
      list.replaceChildren();
      return false;
    }
    const view = searchOf(state);
    const answered = view.query === query;
    note.hidden = false;
    list.hidden = true;
    if (answered && view.state === "error") {
      note.textContent = S.searchFailed;
    } else if (!answered || view.state !== "ready") {
      note.textContent = S.searchSearching;
    } else if (view.hits.length === 0) {
      note.textContent = S.searchNone;
    } else {
      note.hidden = true;
      list.hidden = false;
      renderHits(state, view.hits, query);
    }
    return true;
  }

  function clear(): void {
    cancel();
    input.value = "";
  }

  return { input, note, list, update, clear };
}
