/** Chat cards: tool calls, the reasoning block and approval cards. Mirrors the OmniChat app look (ToolCards, ThinkingBlock). */
import { formatDuration } from "../../chat/format";
import type { ApprovalView } from "../../ui/approvalModel";
import type { TranscriptItem } from "../../protocol/chat-frames";
import { button, el } from "./dom";
import type { Part, Send, ChatViewState } from "./types";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

let seq = 0;

/** One tool call row: status dot, bold tool name, monospace summary, duration and status chip. */
export function createToolCard(
  item: ToolItem,
  state: ChatViewState,
): { el: HTMLElement; update(item: ToolItem, state: ChatViewState): void } {
  const root = el("div", "cc-tool");
  const head = el("div", "cc-tool__head");
  const mark = el("span", "cc-tool__mark");
  mark.setAttribute("aria-hidden", "true");
  const text = el("div", "cc-tool__text");
  const name = el("span", "cc-tool__name");
  const summary = el("span", "cc-tool__summary");
  text.append(name, summary);
  const meta = el("div", "cc-tool__meta");
  const duration = el("span", "cc-tool__duration");
  const chip = el("span", "cc-chip");
  meta.append(duration, chip);
  head.append(mark, text, meta);
  const decided = el("div", "cc-tool__decided");
  root.append(head, decided);

  const update = (next: ToolItem, s: ChatViewState): void => {
    const label = s.toolLabels[next.id] ?? next.tool;
    root.className = `cc-tool cc-tool--${next.status}`;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", label);
    name.textContent = next.tool;
    summary.textContent = next.summary;
    summary.hidden = next.summary === "";
    duration.textContent = next.durationMs === undefined ? "" : formatDuration(next.durationMs);
    duration.hidden = next.durationMs === undefined;
    chip.textContent = s.strings.tool[next.status];
    decided.textContent = next.decidedBy ?? "";
    decided.hidden = !next.decidedBy;
  };
  update(item, state);
  return { el: root, update };
}

/** Collapsible reasoning block. The user's open/closed choice is kept across updates. */
export function createThinking(): { el: HTMLElement; update(reasoning: string, streaming: boolean, state: ChatViewState): void } {
  const details = el("details", "cc-think");
  const summary = el("summary", "cc-think__summary");
  const text = el("div", "cc-think__text");
  details.append(summary, text);
  let initialized = false;

  // The open state is only set on the first update; after that the browser keeps the user's choice.
  const update = (reasoning: string, streaming: boolean, state: ChatViewState): void => {
    summary.textContent = state.strings.reasoning;
    text.textContent = reasoning === "" && streaming ? state.strings.thinking : reasoning;
    details.hidden = reasoning === "" && !streaming;
    if (!initialized) {
      initialized = true;
      details.open = streaming;
    }
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
