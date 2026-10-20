// Pure slash-command logic (no React): the command table, composer-text parsing, argument parsers and model matching.

export type SlashCommandName = 'compact' | 'context' | 'usage' | 'clear' | 'help' | 'rename' | 'model' | 'effort' | 'export' | 'pin' | 'unpin' | 'retry';

export interface SlashCommandDef {
  name: SlashCommandName;
  /** i18n key of the menu description, always 'slash.cmd.<name>' */
  descKey: string;
  /** Shown after the name in the menu and inserted with a trailing space. Absent = the command takes no argument. */
  argHint?: string;
  /** Not offered in the Code tab */
  codeHidden: boolean;
  /** Not offered in ephemeral chats */
  ephemeralHidden: boolean;
  /** Needs an existing server conversation */
  needsConv: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'compact', descKey: 'slash.cmd.compact', argHint: '[focus]', codeHidden: true, ephemeralHidden: false, needsConv: true },
  { name: 'context', descKey: 'slash.cmd.context', codeHidden: true, ephemeralHidden: false, needsConv: true },
  { name: 'usage', descKey: 'slash.cmd.usage', argHint: '[today|week|month|all]', codeHidden: false, ephemeralHidden: true, needsConv: false },
  { name: 'clear', descKey: 'slash.cmd.clear', codeHidden: false, ephemeralHidden: false, needsConv: false },
  { name: 'help', descKey: 'slash.cmd.help', codeHidden: false, ephemeralHidden: false, needsConv: false },
  { name: 'rename', descKey: 'slash.cmd.rename', argHint: '<title>', codeHidden: false, ephemeralHidden: true, needsConv: true },
  { name: 'model', descKey: 'slash.cmd.model', argHint: '[model]', codeHidden: false, ephemeralHidden: false, needsConv: false },
  { name: 'effort', descKey: 'slash.cmd.effort', argHint: '<off|low|medium|high|max|default>', codeHidden: true, ephemeralHidden: false, needsConv: false },
  { name: 'export', descKey: 'slash.cmd.export', argHint: '[md|json]', codeHidden: false, ephemeralHidden: true, needsConv: true },
  { name: 'pin', descKey: 'slash.cmd.pin', codeHidden: false, ephemeralHidden: true, needsConv: true },
  { name: 'unpin', descKey: 'slash.cmd.unpin', codeHidden: false, ephemeralHidden: true, needsConv: true },
  { name: 'retry', descKey: 'slash.cmd.retry', codeHidden: false, ephemeralHidden: false, needsConv: true },
];

export interface ParsedSlash { name: SlashCommandName; arg: string }

const COMMAND_LINE = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/;
const TYPED_PREFIX = /^\s*\/\S+\s/;

function findDef(name: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((d) => d.name === name);
}

/**
 * Parses raw composer text as a slash command. Leading whitespace is ignored, the name is case-insensitive, and the
 * argument is the trimmed rest (may be multi-line; '' when absent). Returns null for anything that is not one of
 * SLASH_COMMANDS, e.g. '/new', '/usr/bin', '/ compact', '/compactfoo'. Extra text after a no-argument command is kept.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const m = COMMAND_LINE.exec(text.replace(/^\s+/, ''));
  if (!m) return null;
  const name = m[1].toLowerCase();
  const def = findDef(name);
  if (!def) return null;
  return { name: def.name, arg: (m[2] ?? '').trim() };
}

/** True when the text is a parsed command AND whitespace follows the command name (the user moved on to arguments). */
export function isTypedCommand(text: string): boolean {
  return parseSlashCommand(text) !== null && TYPED_PREFIX.test(text);
}

/** Usage line for a command, e.g. '/rename <title>' or '/pin'. */
export function commandUsage(name: SlashCommandName | string): string {
  const def = findDef(name);
  return def && def.argHint ? `/${def.name} ${def.argHint}` : `/${name}`;
}

export type CommandAvailability = 'ok' | 'code' | 'ephemeral';

/** Whether a command is offered in the given context. 'code' = hidden in the Code tab, 'ephemeral' = hidden in ephemeral chats. */
export function commandAvailable(
  def: SlashCommandDef | SlashCommandName,
  ctx: { mode: 'chat' | 'code'; ephemeral: boolean },
): CommandAvailability {
  const d = typeof def === 'string' ? findDef(def) : def;
  if (!d) return 'ok';
  if (ctx.mode === 'code' && d.codeHidden) return 'code';
  if (ctx.ephemeral && d.ephemeralHidden) return 'ephemeral';
  return 'ok';
}

export type EffortArg = 'off' | 'low' | 'medium' | 'high' | 'max' | 'default';
const EFFORT_ARGS: readonly EffortArg[] = ['off', 'low', 'medium', 'high', 'max', 'default'];

/** `/effort` argument; case-insensitive. Only the six levels are accepted. */
export function parseEffortArg(arg: string): EffortArg | null {
  const a = arg.trim().toLowerCase();
  return (EFFORT_ARGS as readonly string[]).includes(a) ? (a as EffortArg) : null;
}

/** `/export` argument: '' -> md; 'md' or 'markdown' -> md; 'json' -> json; anything else -> null. */
export function parseExportArg(arg: string): 'md' | 'json' | null {
  const a = arg.trim().toLowerCase();
  if (a === '' || a === 'md' || a === 'markdown') return 'md';
  if (a === 'json') return 'json';
  return null;
}

export type UsagePeriod = 'today' | 'week' | 'month' | 'all';

/** `/usage` argument: '' -> today; accepts today/day, week/7d, month/30d, all; anything else -> null. */
export function parseUsageArg(arg: string): UsagePeriod | null {
  const a = arg.trim().toLowerCase();
  switch (a) {
    case '': case 'today': case 'day': return 'today';
    case 'week': case '7d': return 'week';
    case 'month': case '30d': return 'month';
    case 'all': return 'all';
    default: return null;
  }
}

export interface ModelCandidate { providerId: string; model: string; label: string }

/** Lowercases and strips spaces and the separators - _ . : / so 'gpt 4o', 'gpt-4o' and 'GPT4O' compare equal. */
function normalizeModelText(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.:/]/g, '');
}

const MAX_AMBIGUOUS = 6;

/**
 * Finds the model a `/model <query>` argument names. Ranks exact (model or label) over prefix over substring
 * (every whitespace-separated query token is contained in the model or label). A single top candidate is `best`;
 * several at the top rank give `best: null` and `ambiguous` (at most 6). Duplicate providerId+model pairs collapse.
 */
export function matchModel(query: string, cands: ModelCandidate[]): { best: ModelCandidate | null; ambiguous: ModelCandidate[] } {
  const none = { best: null, ambiguous: [] as ModelCandidate[] };
  const q = normalizeModelText(query);
  if (!q) return none;
  const tokens = query.toLowerCase().split(/\s+/).map(normalizeModelText).filter((t) => t.length > 0);

  const seen = new Set<string>();
  const ranked: { cand: ModelCandidate; rank: number }[] = [];
  for (const c of cands) {
    const key = c.providerId + '\u0000' + c.model;
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = [normalizeModelText(c.model), normalizeModelText(c.label)];
    let rank = 0;
    if (fields.some((f) => f === q)) rank = 3;
    else if (fields.some((f) => f.startsWith(q))) rank = 2;
    else if (tokens.every((t) => fields.some((f) => f.includes(t)))) rank = 1;
    if (rank > 0) ranked.push({ cand: c, rank });
  }
  if (ranked.length === 0) return none;

  const top = Math.max(...ranked.map((r) => r.rank));
  const matches = ranked.filter((r) => r.rank === top).map((r) => r.cand);
  if (matches.length === 1) return { best: matches[0], ambiguous: [] };
  return { best: null, ambiguous: matches.slice(0, MAX_AMBIGUOUS) };
}
