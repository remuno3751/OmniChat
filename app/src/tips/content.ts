// Assembles the Tips sheet content: static entries, merged strings, and runtime slash-command entries.
import type { Template } from '../protocol';
import { buildSlashEntries } from '../templates';
import type { SlashEntry } from '../templates';
import { SLASH_COMMANDS, commandUsage } from '../slashCommands';
import { TIP_SECTION_ORDER } from './types';
import type { ResolvedTip, TipEntry, TipSectionId } from './types';
import { SECTIONS_1 } from './sections1';
import { SECTIONS_2 } from './sections2';
import { en as en1, ja as ja1 } from './strings1';
import { en as en2, ja as ja2 } from './strings2';
import { en as enChrome, ja as jaChrome } from './stringsChrome';

export const TIPS_EN: Record<string, string> = { ...en1, ...en2, ...enChrome };
export const TIPS_JA: Record<string, string> = { ...ja1, ...ja2, ...jaChrome };

export const STATIC_TIPS: TipEntry[] = [...SECTIONS_1, ...SECTIONS_2];

/** Static entries translated with `tr`. Keywords are comma-separated in the strings and become space-separated. */
export function resolveStaticTips(tr: (key: string) => string): ResolvedTip[] {
  return STATIC_TIPS.map((e) => ({
    id: e.id,
    section: e.section,
    title: tr(e.titleKey),
    body: tr(e.bodyKey),
    ...(e.exampleKey ? { example: tr(e.exampleKey) } : {}),
    keywords: e.keywordsKey ? tr(e.keywordsKey).split(',').map((k) => k.trim()).filter(Boolean).join(' ') : '',
    ...(e.action
      ? { action: { action: e.action.action, label: tr(e.action.labelKey ?? 'tips.open') } }
      : {}),
  }));
}

export interface ResolveSlashArgs {
  templates: Template[];
  projectId: string | null;
  tr: (key: string, vars?: any) => string;
  mode?: 'chat' | 'code';
  ephemeral?: boolean;
}

/**
 * Slash-menu entries as tips, built from the real registry. All commands are listed regardless of tab; a note is
 * appended to commands that the Code tab or ephemeral chats hide. Actions, built-in prompts and user templates
 * come from buildSlashEntries.
 */
export function resolveSlashTips(args: ResolveSlashArgs): ResolvedTip[] {
  const { templates, projectId, tr } = args;
  const mode = args.mode ?? 'chat';
  const ephemeral = args.ephemeral ?? false;
  const out: ResolvedTip[] = [];

  for (const def of SLASH_COMMANDS) {
    const notes = [
      def.codeHidden ? tr('tips.slash.notInCode') : '',
      def.ephemeralHidden ? tr('tips.slash.notInEphemeral') : '',
    ].filter(Boolean);
    out.push({
      id: 'slash.cmd:' + def.name,
      section: 'slash',
      title: commandUsage(def.name),
      body: [tr(def.descKey), ...notes].join('\n'),
      keywords: `command ${def.name}`,
      insertText: `/${def.name} `,
    });
  }

  const entries: SlashEntry[] = buildSlashEntries(templates, projectId, tr, { mode, ephemeral });
  for (const e of entries) {
    if (e.kind === 'command') continue;
    const isUser = e.key.startsWith('tpl:');
    out.push({
      id: 'slash.' + e.key,
      section: 'slash',
      title: '/' + e.name,
      body: isUser ? (e.description || tr('tips.slash.userTemplate')) : e.description,
      keywords: `${e.kind} ${e.name}`,
      insertText: `/${e.name} `,
    });
  }
  return out;
}

/** Groups tips by section in TIP_SECTION_ORDER, omitting empty sections. */
export function groupBySection(tips: ResolvedTip[]): { section: TipSectionId; tips: ResolvedTip[] }[] {
  return TIP_SECTION_ORDER
    .map((section) => ({ section, tips: tips.filter((t) => t.section === section) }))
    .filter((g) => g.tips.length > 0);
}
