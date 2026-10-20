// Contract for the in-app Tips / Help sheet. Pure types, no React.
import type { SettingsPageId } from '../settingsMeta';

export type ConnSubId = 'stats' | 'devices' | 'apikeys' | 'usage';

/** Deep link an entry can carry. Handled by App.tsx (closes the sheet first). */
export type TipAction =
  | { kind: 'settings'; page: SettingsPageId; sub?: ConnSubId }
  | { kind: 'search' }       // history search screen (Ctrl/Cmd+K)
  | { kind: 'ephemeral' };   // start a new ephemeral chat

/** Static sections. 'slash' is generated at runtime from the command registry, so it has no static entries. */
export type TipSectionId =
  | 'slash' | 'keys' | 'search' | 'ephemeral' | 'artifacts' | 'code' | 'modelload' | 'context' | 'themes' | 'privacy';

export const TIP_SECTION_ORDER: TipSectionId[] =
  ['slash', 'keys', 'search', 'ephemeral', 'artifacts', 'code', 'modelload', 'context', 'themes', 'privacy'];

/** All text is an i18n key (both en.ts and ja.ts). Section title key: `tips.section.<id>`. */
export interface TipEntry {
  /** unique, e.g. 'keys.enter' */
  id: string;
  section: TipSectionId;
  titleKey: string;
  bodyKey: string;
  /** optional example (shown in monospace) */
  exampleKey?: string;
  /** optional: ONE i18n key whose value is a comma-separated keyword list (extra search terms, may mix ja/en) */
  keywordsKey?: string;
  /** optional deep link + button label key (default label key 'tips.open') */
  action?: { action: TipAction; labelKey?: string };
}

/** Entry after translation (what searchTips works on). `slashName` set for generated slash entries. */
export interface ResolvedTip {
  id: string;
  section: TipSectionId;
  title: string;
  body: string;
  example?: string;
  keywords: string;
  action?: { action: TipAction; label: string };
  /** slash entries only: the text to insert into the composer, e.g. '/compact ' */
  insertText?: string;
}

export interface WhatsNewItem {
  /** ISO date 'YYYY-MM-DD' */
  date: string;
  /** i18n keys */
  titleKey: string;
  bodyKey: string;
}
