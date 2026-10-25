/**
 * Sources card under an assistant answer (v0.5.6-E §3 出典カード): a collapsed <details> that lists the web sources
 * of the turn. Each row is a button (no <a href>) that asks the host to open the link. Hidden while streaming.
 */
import { button, el } from "./dom";
import { setTip } from "./tip";
import type { ChatViewState, Send } from "./types";
import { sendV056e, stringsOf, type Source, type V056eStrings } from "./v056eTypes";

/** The host keeps at most this many sources per answer. */
export const SOURCES_MAX = 8;

/** True for an absolute http or https URL (the only kinds the card opens). */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The valid sources of an assistant item. An invalid entry is dropped alone (the rest of the list stays);
 * a missing title falls back to the URL.
 */
export function sourcesOf(item: unknown): Source[] {
  const raw = (item as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(raw)) return [];
  const out: Source[] = [];
  for (const s of raw as unknown[]) {
    if (out.length >= SOURCES_MAX) break;
    if (typeof s !== "object" || s === null) continue;
    const { title, url, host } = s as Record<string, unknown>;
    if (typeof url !== "string" || !isHttpUrl(url) || typeof host !== "string") continue;
    const name = typeof title === "string" && title.trim() !== "" ? title : url;
    out.push({ title: name, url, host });
  }
  return out;
}

export interface SourcesCard {
  el: HTMLDetailsElement;
  update(sources: readonly Source[], streaming: boolean, state: ChatViewState): void;
}

function sourceRow(source: Source, S: V056eStrings, send: Send): HTMLLIElement {
  const li = el("li", "cm-sources__row");
  const link = button("", "cm-sources__item", () => {
    const url = link.dataset.url ?? "";
    if (isHttpUrl(url)) sendV056e(send, { type: "openExternal", url });
  });
  link.dataset.url = source.url;
  link.append(el("span", "cm-sources__title", source.title), el("span", "cm-sources__host", source.host));
  setTip(link, source.url);
  link.setAttribute("aria-label", `${S.srcOpen}: ${source.title}`);
  li.appendChild(link);
  return li;
}

export function createSources(send: Send): SourcesCard {
  const root = el("details", "cm-sources");
  root.hidden = true;
  const summary = el("summary", "cm-sources__summary");
  const list = el("ol", "cm-sources__list");
  root.append(summary, list);

  // Rebuilt only when the sources or the language change, so the open state of the card survives updates.
  let signature = "";

  return {
    el: root,
    update(sources, streaming, state) {
      root.hidden = streaming || sources.length === 0;
      if (root.hidden) return;
      const S = stringsOf(state);
      summary.textContent = S.srcTitle(sources.length);
      const sig = `${state.lang}\u0000${JSON.stringify(sources)}`;
      if (sig === signature) return;
      signature = sig;
      list.replaceChildren(...sources.map((s) => sourceRow(s, S, send)));
    },
  };
}
