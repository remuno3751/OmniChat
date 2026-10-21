/**
 * Pure view-model for the approval card (spec docs/design/VSCODE-BRIDGE.md §2.2, §2.4, §4, §5).
 * No `vscode` import. The panel host serialises the result and the webview renders it as text.
 */
import type { ApprovalFrame, ApprovalReplyFrame } from "../protocol/frames";

import { localizeReason } from "./reasonText";

export type Lang = "ja" | "en";
export type ApprovalDecision = ApprovalReplyFrame["decision"];

/** Commands longer than this (in code points) are cut for display (spec: first 800 chars + count). */
export const COMMAND_PREVIEW_CHARS = 800;

/**
 * Fields a richer escalation may carry beyond the wire `approval` frame (§2.2 has none of them).
 * Unknown fields are ignored, so frames without them still work.
 */
export interface ApprovalExtras {
  /** Shell command of a run_command escalation. */
  command?: string;
  /** Full file text before and after an edit. Both are needed for the "View diff" action. */
  before?: string;
  after?: string;
  /**
   * `false` only when the extension has checked the item and it is not protected. Absent means
   * protected: an approval frame is an escalation for a protected item (§2.4), so the safe default applies.
   */
  protected?: boolean;
  /** Protection reasons (§4.3 texts). When absent, the frame's `reason` is used. */
  protectedReasons?: string[];
}

export type ApprovalInput = ApprovalFrame & ApprovalExtras;

export interface ApprovalAction {
  id: "allowed-once" | "rejected" | "view-diff";
  label: string;
  /** Wire decision for the two reply actions. Absent for "view-diff". */
  decision?: ApprovalDecision;
  primary: boolean;
}

export interface DiffStat {
  additions: number;
  deletions: number;
}

export interface ApprovalView {
  approvalId: string;
  title: string;
  statusLabel: string;
  /** Protection badge text, or null for normal items. */
  badge: string | null;
  tool: string;
  path: string;
  reason: string;
  protected: boolean;
  protectedReasons: string[];
  /** Explains why "always allow" is missing; null for normal items. */
  protectedHint: string | null;
  /** Never true for protected items (§2.4, §4.2). */
  canAlwaysAllow: boolean;
  summaryKind: "command" | "diff-stat" | "path" | "none";
  summary: string;
  truncated: boolean;
  omittedChars: number;
  diffStat: DiffStat | null;
  actions: ApprovalAction[];
  /** Action id that receives keyboard focus when the card appears. */
  focusId: ApprovalAction["id"];
}

export interface ApprovalStrings {
  title: string;
  titleProtected: string;
  statusLabel: string;
  badge: string;
  allow: string;
  reject: string;
  viewDiff: string;
  protectedHint: string;
  empty: string;
  truncated: (omitted: number) => string;
  diffStat: (additions: number, deletions: number) => string;
}

const STRINGS: Record<Lang, ApprovalStrings> = {
  ja: {
    title: "承認が必要です",
    titleProtected: "保護された操作の承認",
    statusLabel: "承認待ち",
    badge: "保護",
    allow: "今回だけ許可",
    reject: "拒否",
    viewDiff: "差分を表示",
    protectedHint: "保護された操作のため「常に許可」は選べません。",
    empty: "承認待ちはありません",
    truncated: (omitted) => `…（残り ${omitted} 文字は省略）`,
    diffStat: (additions, deletions) => `+${additions} −${deletions} 行`,
  },
  en: {
    title: "Approval required",
    titleProtected: "Approval for a protected action",
    statusLabel: "Waiting",
    badge: "Protected",
    allow: "Allow once",
    reject: "Deny",
    viewDiff: "View diff",
    protectedHint: "Protected actions cannot be always-allowed.",
    empty: "No pending approvals",
    truncated: (omitted) => `… (${omitted} more characters omitted)`,
    diffStat: (additions, deletions) => `+${additions} -${deletions} lines`,
  },
};

/** Display texts for a language. Unknown values fall back to Japanese, the app's default. */
export function approvalStrings(lang: Lang): ApprovalStrings {
  return lang === "en" ? STRINGS.en : STRINGS.ja;
}

/** True when both sides of an edit are present, so the diff button can open the native diff. */
export function hasDiffContent(frame: ApprovalInput): boolean {
  return typeof frame.before === "string" && typeof frame.after === "string";
}

/**
 * Line-level add/delete counts as a multiset comparison (order is ignored). An approximation
 * for display, not a patch. Empty text has zero lines.
 */
export function lineStat(before: string, after: string): DiffStat {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const pool = new Map<string, number>();
  for (const line of beforeLines) pool.set(line, (pool.get(line) ?? 0) + 1);
  let matched = 0;
  for (const line of afterLines) {
    const left = pool.get(line) ?? 0;
    if (left > 0) {
      pool.set(line, left - 1);
      matched += 1;
    }
  }
  return { additions: afterLines.length - matched, deletions: beforeLines.length - matched };
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function cleanReasons(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/**
 * Builds the card for one `approval` frame. Protected items get no "always allow" action and
 * focus moves to Deny. Command text is cut to 800 code points with a count of what was omitted.
 */
export function buildApprovalView(frame: ApprovalInput, lang: Lang = "ja"): ApprovalView {
  const s = approvalStrings(lang);
  const isProtected = frame.protected !== false;
  const given = cleanReasons(frame.protectedReasons);
  const protectedReasons = (isProtected ? (given.length > 0 ? given : cleanReasons([frame.reason])) : []).map((r) =>
    localizeReason(r, lang),
  );
  const hasDiff = hasDiffContent(frame);

  let summaryKind: ApprovalView["summaryKind"] = "none";
  let summary = "";
  let truncated = false;
  let omittedChars = 0;
  let diffStat: DiffStat | null = null;

  if (typeof frame.command === "string" && frame.command !== "") {
    summaryKind = "command";
    const chars = Array.from(frame.command);
    if (chars.length > COMMAND_PREVIEW_CHARS) {
      truncated = true;
      omittedChars = chars.length - COMMAND_PREVIEW_CHARS;
      summary = `${chars.slice(0, COMMAND_PREVIEW_CHARS).join("")}\n${s.truncated(omittedChars)}`;
    } else {
      summary = frame.command;
    }
  } else if (hasDiff) {
    summaryKind = "diff-stat";
    diffStat = lineStat(frame.before as string, frame.after as string);
    summary = s.diffStat(diffStat.additions, diffStat.deletions);
  } else if (frame.path) {
    summaryKind = "path";
    summary = frame.path;
  }

  const actions: ApprovalAction[] = [];
  if (hasDiff) actions.push({ id: "view-diff", label: s.viewDiff, primary: false });
  actions.push({ id: "rejected", label: s.reject, decision: "rejected", primary: isProtected });
  actions.push({ id: "allowed-once", label: s.allow, decision: "allowed-once", primary: !isProtected });

  return {
    approvalId: frame.approvalId,
    title: isProtected ? s.titleProtected : s.title,
    statusLabel: s.statusLabel,
    badge: isProtected ? s.badge : null,
    tool: frame.tool,
    path: frame.path,
    reason: frame.reason.split("; ").map((r) => localizeReason(r, lang)).join("; "),
    protected: isProtected,
    protectedReasons,
    protectedHint: isProtected ? s.protectedHint : null,
    canAlwaysAllow: !isProtected,
    summaryKind,
    summary,
    truncated,
    omittedChars,
    diffStat,
    actions,
    focusId: isProtected ? "rejected" : "allowed-once",
  };
}

/** Messages the webview may post to the host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "approval_reply"; approvalId: string; decision: ApprovalDecision }
  | { type: "viewDiff"; approvalId: string };

/** Validates a message from the webview. Anything unexpected returns null. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type === "ready") return { type: "ready" };
  if (typeof msg.approvalId !== "string" || msg.approvalId === "") return null;
  if (msg.type === "viewDiff") return { type: "viewDiff", approvalId: msg.approvalId };
  if (msg.type === "approval_reply" && (msg.decision === "allowed-once" || msg.decision === "rejected")) {
    return { type: "approval_reply", approvalId: msg.approvalId, decision: msg.decision };
  }
  return null;
}
