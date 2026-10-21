// Template helpers (PROTOCOL-v4.md section 8): {{variable}} extraction/filling and the slash-command list.
import type { SearchMode, Template } from './protocol';
import { SLASH_COMMANDS, commandAvailable } from './slashCommands';
import type { SlashCommandName } from './slashCommands';

const VAR_SOURCE = '\\{\\{\\s*([\\w.-]+)\\s*\\}\\}';

/** Unique `{{name}}` variable names in the order they first appear. */
export function extractVars(body: string): string[] {
  const re = new RegExp(VAR_SOURCE, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Replaces each `{{name}}` with values[name]; unknown names are left as they are. */
export function fillVars(body: string, values: Record<string, string>): string {
  return body.replace(new RegExp(VAR_SOURCE, 'g'), (whole: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}

export interface BuiltinAction { id: string; name: string; descKey: string }

/** Built-in slash actions. `id` is the action body the server accepts for kind 'action'. */
export const BUILTIN_ACTIONS: BuiltinAction[] = [
  { id: 'new_session', name: 'new', descKey: 'slash.desc.new_session' },
  { id: 'search:off', name: 'search off', descKey: 'slash.desc.search_off' },
  { id: 'search:smart', name: 'search smart', descKey: 'slash.desc.search_smart' },
  { id: 'search:always', name: 'search always', descKey: 'slash.desc.search_always' },
  { id: 'approval_mode:ask', name: 'approval ask', descKey: 'slash.desc.approval_ask' },
  { id: 'approval_mode:rules', name: 'approval rules', descKey: 'slash.desc.approval_rules' },
];

/**
 * Built-in email prompts (kind 'prompt', not editable). Each id has i18n keys tpl.builtin.<id>.name / .desc / .body;
 * the bodies use {{email}} (or {{text}} / {{dates}}) and ask for an `artifact type=email` answer.
 */
export const BUILTIN_PROMPTS: { id: string }[] = [
  { id: 'email.reply' },
  { id: 'email.polish' },
  { id: 'email.shorten' },
  { id: 'email.decline' },
  { id: 'email.schedule' },
];

const SEARCH_MODE_IDS: readonly SearchMode[] = ['off', 'smart', 'always'];

/** The SearchMode for a `search:<mode>` action id, or null. */
export function searchModeOf(actionId: string): SearchMode | null {
  if (!actionId.startsWith('search:')) return null;
  const m = actionId.slice('search:'.length) as SearchMode;
  return SEARCH_MODE_IDS.includes(m) ? m : null;
}

export interface SlashEntry {
  key: string;
  name: string;
  description: string;
  kind: 'prompt' | 'action' | 'command';
  /** prompt text, the action id, or the command name */
  body: string;
  /** kind 'command' only: the command this entry runs */
  command?: SlashCommandName;
  /** kind 'command' only: argument hint shown after the name; absent = no argument */
  argHint?: string;
}

/**
 * Entries for the slash menu: commands available in `opts` (default: chat tab, not ephemeral), then built-in actions,
 * built-in email prompts, and the user's templates. Project-scoped templates are included only when they belong to
 * `projectId`; global ones always. `tr` translates descKey values and the tpl.builtin.* keys.
 */
export function buildSlashEntries(
  templates: Template[],
  projectId: string | null,
  tr: (key: string) => string,
  opts?: { mode?: 'chat' | 'code'; ephemeral?: boolean },
): SlashEntry[] {
  const ctx = { mode: opts?.mode ?? 'chat', ephemeral: opts?.ephemeral ?? false };
  const commands: SlashEntry[] = SLASH_COMMANDS
    .filter((def) => commandAvailable(def, ctx) === 'ok')
    .map((def) => ({
      key: 'cmd:' + def.name,
      name: def.name,
      description: tr(def.descKey),
      kind: 'command',
      body: def.name,
      command: def.name,
      ...(def.argHint ? { argHint: def.argHint } : {}),
    }));
  const builtin: SlashEntry[] = BUILTIN_ACTIONS.map((a) => ({
    key: 'builtin:' + a.id, name: a.name, description: tr(a.descKey), kind: 'action', body: a.id,
  }));
  const prompts: SlashEntry[] = BUILTIN_PROMPTS.map((p) => ({
    key: 'builtin:' + p.id,
    name: tr(`tpl.builtin.${p.id}.name`),
    description: tr(`tpl.builtin.${p.id}.desc`),
    kind: 'prompt',
    body: tr(`tpl.builtin.${p.id}.body`),
  }));
  const user: SlashEntry[] = templates
    .filter((t) => !t.deleted && (t.projectId === null || t.projectId === projectId))
    .map((t) => ({ key: 'tpl:' + t.id, name: t.name, description: t.description || '', kind: t.kind, body: t.body }));
  return [...commands, ...builtin, ...prompts, ...user];
}

/**
 * Entries whose name or description contains the query (case-insensitive); an empty query keeps all. Command entries
 * match on the first word only, so '/compact focus on x' still lists /compact. Entries whose name starts with the
 * query come first; otherwise the order is kept.
 */
export function filterSlash(entries: SlashEntry[], query: string): SlashEntry[] {
  const full = query.trim().toLowerCase();
  if (!full) return entries;
  const first = full.split(/\s+/)[0];
  const keyOf = (e: SlashEntry) => (e.kind === 'command' ? first : full);
  const matched = entries.filter((e) => {
    const q = keyOf(e);
    return e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
  });
  const startsWith = (e: SlashEntry) => e.name.toLowerCase().startsWith(keyOf(e));
  return [...matched.filter(startsWith), ...matched.filter((e) => !startsWith(e))];
}
