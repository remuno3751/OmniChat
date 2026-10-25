/** Pure slash-command rules for the composer (no DOM, unit tested). */
import type { SlashEntry, SlashName } from "./types";

/** The query of a command being typed ("/cl" -> "cl"), or null when the text is not a command in progress. */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const query = value.slice(1);
  return /\s/.test(query) ? null : query;
}

/** Entries whose name starts with the query (case-insensitive), in the host's order. */
export function filterSlash(entries: readonly SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase();
  return entries.filter((e) => e.name.startsWith(q));
}

/**
 * What executing a command does: the host commands (all but model and help) go to the host; model opens the model picker (the lead's
 * callback); help lists the commands in a toast.
 */
export type SlashAction = { kind: "host"; name: Exclude<SlashName, "model" | "help"> } | { kind: "model" } | { kind: "help" };

export function slashAction(name: SlashName): SlashAction {
  if (name === "model") return { kind: "model" };
  if (name === "help") return { kind: "help" };
  return { kind: "host", name };
}

/** Commands that take a word after the name; the popup completes them with a space instead of running them. */
export const ARG_COMMANDS: readonly SlashName[] = ["effort", "rename"];

/** Longest argument the host accepts (the frame's limit). */
export const MAX_SLASH_ARG = 2000;

/** A typed command with an argument: "/effort high", "/rename My title", "/export json". `arg` is "" when none was given. */
export interface ArgCommand {
  name: "effort" | "rename" | "export";
  arg: string;
}

const ARG_LINE = /^\/(effort|rename|export)(?:\s+([\s\S]*))?$/;

/**
 * The argument command a draft is, or null for any other text. "/export" takes only "json" (the JSON document); its
 * other forms stay ordinary text. "/effort" and "/rename" take whatever follows (the host checks it).
 */
export function argCommand(text: string): ArgCommand | null {
  const m = ARG_LINE.exec(text.trim());
  if (!m) return null;
  const name = m[1] as ArgCommand["name"];
  const arg = (m[2] ?? "").trim();
  if (name === "export") return arg.toLowerCase() === "json" ? { name, arg: "json" } : null;
  return { name, arg: arg.slice(0, MAX_SLASH_ARG) };
}

/** One line per command: "/clear - Start a new conversation". */
export function helpText(entries: readonly SlashEntry[]): string {
  return entries.map((e) => `/${e.name} - ${e.desc}`).join("\n");
}
