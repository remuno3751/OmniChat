/**
 * Slash-command popup above the composer. It opens while the draft is "/" followed by letters (no space or line
 * break) and lists the matching commands from state.extras.slash. Up/Down move, Tab completes the name, Enter runs
 * the highlighted command, Escape closes it until the draft changes. While the popup is open it takes those keys
 * (the composer checks IME composition before it asks).
 */
import { el } from "./dom";
import { ARG_COMMANDS, filterSlash, helpText, slashAction, slashQuery } from "./slashLogic";
import { sendExtra, type Send, type SlashEntry } from "./types";

export interface SlashOptions {
  input: HTMLTextAreaElement;
  send: Send;
  /** Shows a toast above the composer (the /help list). */
  toast(text: string): void;
  /** The /model command: the lead wires the model picker here. */
  onOpenModel?(): void;
  /** Called after a command ran and the draft was cleared. */
  onDone(): void;
}

export interface Slash {
  el: HTMLElement;
  /** New command list from the host (no-op when unchanged). */
  setEntries(entries: SlashEntry[]): void;
  /** Re-reads the draft and opens, moves or closes the popup. */
  refresh(): void;
  /** Handles a key while the popup is open. Returns true when the key was used (the caller stops there). */
  onKeydown(e: KeyboardEvent): boolean;
}

export function createSlash(opts: SlashOptions): Slash {
  const input = opts.input;
  const root = el("div", "cm-slash");
  root.id = "cm-slash";
  root.setAttribute("role", "listbox");
  root.hidden = true;
  const list = el("div", "cm-slash__list");
  list.setAttribute("role", "presentation");
  root.appendChild(list);

  let entries: SlashEntry[] = [];
  let entriesSig = "";
  let matches: SlashEntry[] = [];
  let active = 0;
  /** The draft text the user closed the popup on with Escape; it stays closed until the draft changes. */
  let dismissed: string | null = null;

  function close(): void {
    root.hidden = true;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }

  function setActive(index: number): void {
    active = index;
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) {
      const selected = i === active;
      rows[i].setAttribute("aria-selected", String(selected));
      if (selected) input.setAttribute("aria-activedescendant", rows[i].id);
    }
  }

  function render(): void {
    list.replaceChildren(
      ...matches.map((entry, i) => {
        const row = el("div", "cm-slash__item");
        row.id = `cm-slash-opt-${i}`;
        row.setAttribute("role", "option");
        row.append(el("span", "cm-slash__name", `/${entry.name}`), el("span", "cm-slash__desc", entry.desc));
        // Keep the focus in the textarea while the mouse picks a row.
        row.addEventListener("mousedown", (e) => e.preventDefault());
        row.addEventListener("mouseenter", () => setActive(i));
        row.addEventListener("click", () => execute(entry));
        return row;
      }),
    );
    setActive(Math.min(active, matches.length - 1));
  }

  function refresh(): void {
    const value = input.value;
    if (dismissed !== null && value !== dismissed) dismissed = null;
    const query = slashQuery(value);
    if (query === null || dismissed !== null) return close();
    const found = filterSlash(entries, query);
    if (found.length === 0) return close();
    const changed = found.length !== matches.length || found.some((e, i) => e.name !== matches[i]?.name);
    matches = found;
    if (changed) {
      active = 0;
      render();
    }
    root.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", root.id);
  }

  function execute(entry: SlashEntry): void {
    // A command that takes a word is completed with a space so the argument can be typed; Enter then sends it.
    if (ARG_COMMANDS.includes(entry.name)) return complete(entry, " ");
    close();
    dismissed = null;
    input.value = "";
    const action = slashAction(entry.name);
    if (action.kind === "host") sendExtra(opts.send, { type: "slash", name: action.name });
    else if (action.kind === "model") opts.onOpenModel?.();
    else opts.toast(helpText(entries));
    opts.onDone();
  }

  function complete(entry: SlashEntry, suffix = ""): void {
    input.value = `/${entry.name}${suffix}`;
    refresh();
    opts.onDone();
  }

  return {
    el: root,
    setEntries(next: SlashEntry[]) {
      const sig = JSON.stringify(next);
      if (sig === entriesSig) return;
      entriesSig = sig;
      entries = next;
      refresh();
    },
    refresh,
    onKeydown(e: KeyboardEvent): boolean {
      if (root.hidden || matches.length === 0) return false;
      const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActive((active + 1) % matches.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActive((active - 1 + matches.length) % matches.length);
          return true;
        case "Escape":
          e.preventDefault();
          dismissed = input.value;
          close();
          return true;
        case "Tab":
          if (!plain) return false;
          e.preventDefault();
          complete(matches[active]);
          return true;
        case "Enter":
          if (!plain) return false;
          e.preventDefault();
          execute(matches[active]);
          return true;
        default:
          return false;
      }
    },
  };
}
