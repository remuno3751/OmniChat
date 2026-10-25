/**
 * Host side of the slash commands the composer sends: `clear` starts a new conversation, `context` refreshes the
 * usage meter and toasts the usage, `usage` toasts the token breakdown, `compact` asks the server to summarise the
 * open conversation, `retry` sends the last reply's prompt again, `pin` toggles the pin of the open conversation
 * and `export` opens its transcript as Markdown (`/export json` as JSON). `effort` and `rename` change the open
 * conversation (v0.5.6-d). `/model` and `/help` never reach the host. No `vscode` import.
 */
import { regenerateItem } from "./actions";
import type { ChatController } from "./controller";
import type { CompactOutcome } from "./controllerTypes";
import { conversationJson } from "./exportJson";
import { conversationMarkdown } from "./exportConv";
import type { MementoLike } from "./favorites";
import { togglePin } from "./pins";
import type { ContextUsage } from "./state";
import { formatTokens } from "./viewModel";
import type { ContextBreakdownFields } from "../protocol/chat-frames";
import type { InputStrings } from "../ui/stringsInput";
import type { V056dStrings } from "../ui/stringsV056d";
import { EFFORT_LEVELS, type EffortLevel } from "../protocol/chat-frames";

export type SlashCommand = "clear" | "context" | "compact" | "usage" | "retry" | "pin" | "export" | "effort" | "rename";
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  "clear",
  "context",
  "compact",
  "usage",
  "retry",
  "pin",
  "export",
  "effort",
  "rename",
];
/** Longest argument the webview may send with a slash command. */
export const MAX_SLASH_ARG = 2000;

/** The command a webview `slash` message names, or null when it is not a host command. */
export function parseSlash(raw: unknown): SlashCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as { type?: unknown; name?: unknown };
  return m.type === "slash" && SLASH_COMMANDS.includes(m.name as SlashCommand) ? (m.name as SlashCommand) : null;
}

export interface SlashDeps {
  strings: InputStrings & V056dStrings;
  controller: Pick<
    ChatController,
    "newConversation" | "refreshContext" | "compact" | "snapshot" | "sendPrompt" | "cancelQueued" | "saveSettings"
  >;
  /** Shows a short localised line above the composer. */
  toast: (text: string) => void;
  /** The extension's global state, which keeps the pinned conversations. */
  globalState: MementoLike;
  /** Called after a pin changed, so the history list redraws. */
  onPinsChanged: () => void;
  /** Opens text in a new untitled editor, as Markdown (the default) or JSON. */
  openDocument: (text: string, language?: "markdown" | "json") => void;
}

/** The usage line for the context toast, e.g. "Context: 12.3k / 128k (10%)". */
export function contextToast(usage: ContextUsage, s: InputStrings): string {
  if (!(usage.limit > 0)) return s.slashContextUnknown;
  const pct = Math.round((usage.total / usage.limit) * 100);
  return s.slashContextResult
    .replace("{used}", formatTokens(usage.total))
    .replace("{limit}", formatTokens(usage.limit))
    .replace("{pct}", String(pct));
}

/** The usage toast: the context line, then the breakdown when the server sent it. */
export function usageToast(usage: ContextUsage & ContextBreakdownFields, s: InputStrings): string {
  const head = contextToast(usage, s);
  const u = usage.used;
  if (!u) return head;
  const parts: Array<[string, number]> = [
    [s.tokSystem, u.system],
    [s.tokHistory, u.history],
    [s.tokAttach, u.attachments],
    [s.tokTools, u.tools],
    [s.tokInput, u.input],
  ];
  if (usage.reasoning !== undefined) parts.push([s.tokReasoning, usage.reasoning]);
  return `${head} · ${parts.map(([label, n]) => `${label} ${formatTokens(n)}`).join(", ")}`;
}

/** The toast for a finished compaction, or for a failed one. */
export function compactToast(r: CompactOutcome, s: InputStrings): string {
  return r.ok
    ? s.slashCompactDone.replace("{before}", formatTokens(r.before)).replace("{after}", formatTokens(r.after))
    : s.slashCompactFail;
}

/** The text after the command name (`/export json` gives "json"), or undefined. Over 2000 characters is dropped. */
export function slashArg(raw: unknown): string | undefined {
  const arg = typeof raw === "object" && raw !== null ? (raw as { arg?: unknown }).arg : undefined;
  return typeof arg === "string" && arg.length <= MAX_SLASH_ARG ? arg : undefined;
}

/** `low`, `medium`, `high`, `max`, or `default` (null: the model default). Anything else is not an effort. */
export function parseEffortArg(arg: string | undefined): { ok: true; effort: EffortLevel | null } | { ok: false } {
  const v = (arg ?? "").trim().toLowerCase();
  if (v === "default") return { ok: true, effort: null };
  return EFFORT_LEVELS.includes(v as EffortLevel) ? { ok: true, effort: v as EffortLevel } : { ok: false };
}

/** The localised name of an effort level, `null` being the model default. */
export function effortLabel(effort: EffortLevel | null, s: V056dStrings): string {
  if (effort === null) return s.csEffortDefault;
  if (effort === "off") return s.csEffortOff;
  return effort === "low" ? s.csEffortLow : effort === "medium" ? s.csEffortMedium : effort === "high" ? s.csEffortHigh : s.csEffortMax;
}

/** Runs one slash command. Toasts are shown through `deps.toast`. `arg` is the text after the name. */
export function runSlash(name: SlashCommand, deps: SlashDeps, arg?: string): void {
  const { controller: c, strings: s } = deps;
  if (name === "clear") {
    c.newConversation();
    return;
  }
  const snap = c.snapshot();
  if (snap.conversationId === null) {
    deps.toast(s.slashNeedConversation);
    return;
  }
  if (name === "effort") {
    const parsed = parseEffortArg(arg);
    if (!parsed.ok) return deps.toast(s.effortBad);
    c.saveSettings({ effort: parsed.effort }, (ok) =>
      deps.toast(ok ? s.effortSet.replace("{level}", effortLabel(parsed.effort, s)) : s.csFailed),
    );
    return;
  }
  if (name === "rename") {
    const title = (arg ?? "").trim();
    if (title === "") return deps.toast(s.renameNeedTitle);
    c.saveSettings({ title }, (ok) => deps.toast(ok ? s.renameDone : s.csFailed));
    return;
  }
  if (name === "context") {
    c.refreshContext((usage) => deps.toast(contextToast(usage, s)));
    return;
  }
  if (name === "usage") {
    deps.toast(snap.context ? usageToast(snap.context, s) : s.slashContextUnknown);
    return;
  }
  if (name === "retry") {
    const last = [...snap.items].reverse().find((it) => it.kind === "assistant");
    const r = last?.kind === "assistant" ? regenerateItem(c, last.id) : "missing";
    if (r === "busy" || r === "refused") deps.toast(s.slashRetryNotNow);
    else if (r === "missing") deps.toast(s.slashNeedConversation);
    return;
  }
  if (name === "pin") {
    const id = snap.conversationId;
    void togglePin(deps.globalState, id).then((list) => {
      deps.toast(list.includes(id) ? s.slashPinned : s.slashUnpinned);
      deps.onPinsChanged();
    });
    return;
  }
  if (name === "export") {
    const title = snap.conversations.find((x) => x.id === snap.conversationId)?.title ?? "";
    if (arg?.trim().toLowerCase() === "json") {
      deps.openDocument(conversationJson(title, snap.conversationId, snap.items, Date.now()), "json");
    } else {
      deps.openDocument(conversationMarkdown(title, snap.items));
    }
    return;
  }
  deps.toast(s.slashCompactStart);
  c.compact((r) => deps.toast(compactToast(r, s)));
}
