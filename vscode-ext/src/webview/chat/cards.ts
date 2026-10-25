/** Chat cards: tool calls, the reasoning block and approval cards. Mirrors the OmniChat app look (ToolCards, ThinkingBlock). */
import { formatDuration } from "../../chat/format";
import type { Strings } from "../../ui/strings";
import type { ToolKey } from "../../ui/stringsChat";
import { detectPath } from "../render/paths";
import { createThinkingModel } from "../render/thinking";
import type { ApprovalView } from "../../ui/approvalModel";
import { button, el } from "./dom";
import type { Part, Send, ChatViewState } from "./types";

import { foldRuns, type ToolItem } from "../render/timeline";

let seq = 0;

function toolText(tool: string, status: ToolItem["status"], S: Strings): string {
  const known = (Object.prototype.hasOwnProperty.call(S.toolDone, tool) ? tool : null) as ToolKey | null;
  if (status === "pending" || status === "denied") return tool;
  if (status === "running") return known ? S.toolRunning[known] : S.toolRunningOther.replace("{tool}", tool);
  return known ? S.toolDone[known] : S.toolDoneOther.replace("{tool}", tool);
}

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

/** The summary as text, with a clickable path when it looks like one (first word for the file tools). */
function fillSummary(node: HTMLElement, tool: string, summary: string, title: string): void {
  node.replaceChildren();
  let linkText = summary;
  let ref = detectPath(summary);
  if (!ref && FILE_TOOLS.has(tool)) {
    linkText = summary.trimStart().split(/\s+/, 1)[0];
    ref = detectPath(linkText);
  }
  if (!ref) {
    node.textContent = summary;
    return;
  }
  const at = summary.indexOf(linkText);
  if (at > 0) node.appendChild(document.createTextNode(summary.slice(0, at)));
  const link = el("span", "cc-tl__path", linkText);
  link.dataset.ocPath = ref.path;
  if (ref.line !== undefined) link.dataset.ocLine = String(ref.line);
  link.setAttribute("role", "link");
  link.tabIndex = 0;
  link.title = title;
  node.appendChild(link);
  const rest = summary.slice(at + linkText.length);
  if (rest !== "") node.appendChild(document.createTextNode(rest));
}

interface DiffData { path: string; added: number; removed: number; truncated?: boolean; lines: string[] }

const diffSig = (item: ToolItem): string => {
  const d = diffOf(item);
  return d ? `${d.added}/${d.removed}/${d.lines.length}/${d.truncated ? 1 : 0}` : "";
};

const diffOf = (item: ToolItem): DiffData | undefined => (item as { diff?: DiffData }).diff;

/** Changed-lines block of an edit: `+` green, `-` red, context plain. Built with textContent only. */
function fillDiff(box: HTMLElement, d: DiffData | undefined, truncatedText: string): void {
  box.replaceChildren();
  box.hidden = !d || d.lines.length === 0;
  if (!d) return;
  for (const line of d.lines) {
    const c = line.charAt(0);
    const row = el("div", c === "+" ? "cc-diff__l cc-diff__l--add" : c === "-" ? "cc-diff__l cc-diff__l--del" : "cc-diff__l");
    row.textContent = line.slice(1) || " ";
    row.dataset.sign = c === "+" || c === "-" ? c : " ";
    box.appendChild(row);
  }
  if (d.truncated) box.appendChild(el("div", "cc-diff__more", truncatedText));
}

/**
 * The tool-run timeline of one turn: a thin vertical line with a square marker per call. Each call is a closed
 * <details> (summary, duration, decision inside). Entries are updated in place and only when their data changed.
 */
export function createTimeline(): { el: HTMLElement; update(tools: readonly ToolItem[], state: ChatViewState): void } {
  const root = el("div", "cc-tl");
  root.setAttribute("role", "list");
  interface Entry {
    el: HTMLDetailsElement;
    sig: string;
    sigLang: string;
    refresh(item: ToolItem, S: Strings): void;
  }
  const entries = new Map<string, Entry>();

  const build = (): Entry => {
    const d = el("details", "cc-tl__item");
    d.setAttribute("role", "listitem");
    const sum = el("summary", "cc-tl__sum");
    const mark = el("span", "cc-tl__mark");
    mark.setAttribute("aria-hidden", "true");
    const label = el("span", "cc-tl__label");
    const chip = el("span", "cc-chip cc-tl__chip");
    const stat = el("span", "cc-tl__stat");
    const statAdd = el("span", "cc-tl__stat-add");
    const statDel = el("span", "cc-tl__stat-del");
    stat.append(statAdd, statDel);
    const dur = el("span", "cc-tl__dur");
    sum.append(mark, label, stat, chip, dur);
    const body = el("div", "cc-tl__body");
    const code = el("div", "cc-tl__code");
    const name = el("span", "cc-tl__tool");
    const text = el("span", "cc-tl__summary");
    code.append(name, text);
    const meta = el("div", "cc-tl__meta");
    const diffBox = el("div", "cc-diff");
    body.append(code, diffBox, meta);
    d.append(sum, body);
    const entry: Entry = {
      el: d,
      sig: "",
      sigLang: "",
      refresh(item, S) {
        d.className = `cc-tl__item cc-tl__item--${item.status}`;
        label.textContent = toolText(item.tool, item.status, S);
        const showChip = item.status !== "done" && item.status !== "running";
        chip.textContent = showChip ? S.tool[item.status] : "";
        chip.hidden = !showChip;
        dur.textContent = item.durationMs === undefined ? "" : formatDuration(item.durationMs);
        dur.hidden = item.durationMs === undefined;
        name.textContent = item.tool;
        fillSummary(text, item.tool, item.summary, S.openFile);
        const diff = diffOf(item);
        stat.hidden = !diff;
        statAdd.textContent = diff ? `+${diff.added}` : "";
        statDel.textContent = diff ? `\u2212${diff.removed}` : "";
        fillDiff(diffBox, diff, S.diffTruncated);
        text.hidden = item.summary === "";
        const parts: string[] = [S.tool[item.status]];
        if (item.durationMs !== undefined) parts.push(`${S.toolDuration} ${formatDuration(item.durationMs)}`);
        if (item.decidedBy) parts.push(item.decidedBy);
        meta.textContent = parts.join("  ·  ");
      },
    };
    return entry;
  };

  interface Group {
    el: HTMLDetailsElement;
    label: HTMLElement;
    body: HTMLElement;
  }
  const groups = new Map<string, Group>();

  const buildGroup = (): Group => {
    const d = el("details", "cc-tl__group");
    d.setAttribute("role", "listitem");
    const sum = el("summary", "cc-tl__sum cc-tl__gsum");
    const mark = el("span", "cc-tl__mark");
    mark.setAttribute("aria-hidden", "true");
    const label = el("span", "cc-tl__label");
    sum.append(mark, label);
    const body = el("div", "cc-tl__gbody");
    d.append(sum, body);
    return { el: d, label, body };
  };

  /** Puts `nodes` into `parent` in this order, moving or removing only what differs. */
  const place = (parent: HTMLElement, nodes: Element[]): void => {
    nodes.forEach((n, i) => {
      if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null);
    });
    while (parent.children.length > nodes.length) parent.lastElementChild?.remove();
  };

  const update = (tools: readonly ToolItem[], state: ChatViewState): void => {
    const S = state.strings;
    const live = new Set(tools.map((t) => t.id));
    for (const id of [...entries.keys()]) if (!live.has(id)) entries.delete(id);

    const entryOf = (item: ToolItem): Entry => {
      let entry = entries.get(item.id);
      if (!entry) {
        entry = build();
        entries.set(item.id, entry);
      }
      const sig = `${item.tool}|${item.summary}|${item.status}|${item.durationMs ?? ""}|${item.decidedBy ?? ""}|${diffSig(item)}`;
      if (sig !== entry.sig || S.copy !== entry.sigLang) {
        entry.sig = sig;
        entry.sigLang = S.copy;
        entry.refresh(item, S);
      }
      return entry;
    };

    const top: Element[] = [];
    const seen = new Set<string>();
    for (const slot of foldRuns(tools)) {
      if (!slot.group) {
        top.push(entryOf(slot.tool).el);
        continue;
      }
      seen.add(slot.key);
      let g = groups.get(slot.key);
      if (!g) {
        g = buildGroup();
        groups.set(slot.key, g);
      }
      const first = slot.tools[0];
      g.label.textContent = S.toolGroup.replace("{label}", toolText(first.tool, "done", S)).replace("{n}", String(slot.tools.length));
      const open = slot.tools.some((t) => t.status === "running" || t.status === "pending");
      const failed = slot.tools.some((t) => t.status === "error" || t.status === "denied");
      g.el.className = `cc-tl__group${open ? " cc-tl__group--active" : ""}${failed ? " cc-tl__group--failed" : ""}`;
      place(g.body, slot.tools.map((t) => entryOf(t).el));
      top.push(g.el);
    }
    for (const key of [...groups.keys()]) if (!seen.has(key)) groups.delete(key);
    place(root, top);
  };
  return { el: root, update };
}

/**
 * Reasoning block, closed by default. While the model is thinking and has not started the answer, the summary shows
 * "Thinking..." with the typing dots (class toggle; the dots fold away by CSS transition once the answer starts).
 * The user's open/closed choice wins from the first click on.
 */
export function createThinking(): {
  el: HTMLElement;
  update(reasoning: string, streaming: boolean, hasText: boolean, state: ChatViewState): void;
} {
  const details = el("details", "cc-think");
  const summary = el("summary", "cc-think__summary");
  const label = el("span", "cc-think__label");
  const dots = el("span", "cc-think__dots");
  const typing = el("span", "cm-typing");
  typing.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) typing.appendChild(el("span"));
  dots.appendChild(typing);
  summary.append(label, dots);
  const text = el("div", "cc-think__text");
  details.append(summary, text);
  const model = createThinkingModel();
  summary.addEventListener("click", () => model.userToggled());

  let lastReasoning: string | null = null;
  const update = (reasoning: string, streaming: boolean, hasText: boolean, state: ChatViewState): void => {
    const view = model.update({ streaming, hasText });
    details.classList.toggle("cc-think--live", view.live);
    label.textContent = view.live ? state.strings.thinking : state.strings.thought;
    if (reasoning !== lastReasoning) {
      lastReasoning = reasoning;
      text.textContent = reasoning;
    }
    if (view.forceOpen !== null && details.open !== view.forceOpen) details.open = view.forceOpen;
  };
  return { el: details, update };
}

/** Pending approvals: one card per approval, kept until the approval leaves the state. */
export function createApprovals(send: Send): Part {
  const section = el("section", "cc-approvals");
  section.setAttribute("aria-live", "polite");
  const title = el("h3", "cc-approvals__title");
  const list = el("div", "cc-approvals__list");
  section.append(title, list);
  const cards = new Map<string, HTMLElement>();
  section.hidden = true;

  const build = (view: ApprovalView): { el: HTMLElement; focus: HTMLButtonElement | null } => {
    seq += 1;
    const headingId = `cc-approval-title-${seq}`;
    const card = el("article", view.protected ? "cc-approval cc-approval--protected" : "cc-approval");
    card.setAttribute("role", "group");
    card.setAttribute("aria-labelledby", headingId);

    const bar = el("div", "cc-approval__bar");
    const heading = el("span", "cc-approval__heading", view.title);
    heading.id = headingId;
    bar.appendChild(heading);
    if (view.badge) bar.appendChild(el("span", "cc-badge", view.badge));
    card.appendChild(bar);

    const body = el("div", "cc-approval__body");
    const reasons = view.protected && view.protectedReasons.length > 0 ? view.protectedReasons : [view.reason];
    for (const r of reasons) if (r) body.appendChild(el("div", "cc-approval__reason", r));

    const meta = el("div", "cc-approval__meta");
    meta.append(el("span", "cc-chip", view.statusLabel), el("span", "cc-approval__tool", view.tool));
    body.appendChild(meta);
    if (view.path) body.appendChild(el("code", "cc-approval__path", view.path));
    if (view.summary) {
      const pre = el("pre", "cc-preview", view.summary);
      body.appendChild(pre);
      if (view.truncated) body.appendChild(el("div", "cc-preview__note", "…"));
    }
    if (view.diffStat) {
      const diff = el("div", "cc-diff");
      diff.append(
        el("span", "cc-diff__add", `+${view.diffStat.additions}`),
        el("span", "cc-diff__del", `-${view.diffStat.deletions}`),
      );
      body.appendChild(diff);
    }
    if (view.protectedHint) body.appendChild(el("div", "cc-approval__hint", view.protectedHint));

    const actions = el("div", "cc-actions");
    const decisionButtons: HTMLButtonElement[] = [];
    let focusBtn: HTMLButtonElement | null = null;
    const busy = (): boolean => card.getAttribute("aria-busy") === "true";
    const reply = (decision: "allowed-once" | "rejected"): void => {
      if (busy()) return;
      for (const b of decisionButtons) b.disabled = true;
      card.setAttribute("aria-busy", "true");
      send({ type: "approval_reply", approvalId: view.approvalId, decision });
    };
    for (const a of view.actions) {
      const cls = a.id === "view-diff" ? "cc-btn cc-btn--ghost" : `cc-btn${a.primary ? " cc-btn--primary" : ""}`;
      const b = button(a.label, cls, () => {
        if (a.id === "view-diff") {
          send({ type: "viewDiff", approvalId: view.approvalId });
          return;
        }
        if (a.decision === "allowed-once" || a.decision === "rejected") reply(a.decision);
      });
      if (a.id !== "view-diff") decisionButtons.push(b);
      if (a.id === view.focusId) focusBtn = b;
      actions.appendChild(b);
    }
    body.appendChild(actions);
    card.appendChild(body);
    // Escape denies: denial is the safe default for every card.
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") reply("rejected");
    });
    return { el: card, focus: focusBtn };
  };

  const update = (state: ChatViewState): void => {
    title.textContent = state.strings.pendingApprovals;
    const keep = new Set<string>();
    let firstNew: HTMLButtonElement | null = null;
    for (const view of state.approvals) {
      keep.add(view.approvalId);
      if (cards.has(view.approvalId)) continue;
      const built = build(view);
      cards.set(view.approvalId, built.el);
      list.appendChild(built.el);
      if (!firstNew && built.focus) firstNew = built.focus;
    }
    for (const [id, node] of cards) {
      if (!keep.has(id)) {
        node.remove();
        cards.delete(id);
      }
    }
    section.hidden = state.approvals.length === 0;
    // Focus the first new card's action, unless the user is already working inside the section.
    if (firstNew && !section.contains(document.activeElement)) firstNew.focus();
  };
  return { el: section, update };
}
