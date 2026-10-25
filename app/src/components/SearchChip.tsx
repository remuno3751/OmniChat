import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Icon from './Icon';
import Tip from './Tip';
import type { SearchMode } from '../protocol';
import { getIsAdmin } from '../api';
import { useStore } from '../store';
import { resolveSearch, useSearchStatus } from '../toolState';
import { t as tt, useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Hint, Sheet } from '../ui/kit';
import { SearchModeSelect } from './ToolPickers';

type Tr = (key: string, vars?: Record<string, string | number>) => string;
/** Translated mode labels and help (the English constants live in toolState). */
const modeLabel = (tr: Tr, m: SearchMode): string => tr(`composer.search.${m}`);
const modeHelp = (tr: Tr, m: SearchMode): string => tr(m === 'smart' ? 'composer.search.helpSmart' : 'composer.search.helpAlways');

/**
 * Search mode chip next to the effort chip (Off / Auto / Always). `chat` is the chat-level value (null = inherit),
 * `project` the project's. Hidden when the server has no search endpoint; admins see a hint when no backend is configured.
 */
export default function SearchChip({ chat, project, onPin }: { chat: SearchMode | null; project: SearchMode | null | undefined; onPin: (m: SearchMode | null) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const status = useSearchStatus();
  const global = useStore((s) => s.settings?.searchMode);
  const [open, setOpen] = useState(false);
  const st = status.value;
  const tip = st?.configured
    ? tr('composer.search.tip', { smart: modeHelp(tr, 'smart'), always: modeHelp(tr, 'always') })
    : tr('composer.search.notConfigured');
  // web tooltip: RN-web drops the `title` prop, so set the DOM attribute on the element found by its label
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try { (globalThis as any).document?.querySelector(`[aria-label="${tt('composer.search.a11y')}"]`)?.setAttribute('title', tip); } catch {}
  }, [tip, st]);
  if (!st) return null;
  const admin = getIsAdmin() !== false;
  const r = resolveSearch(chat, project, global);
  if (!st.configured && !admin) return null;
  const on = st.configured && r.mode !== 'off';
  const fromLabel = (from: string) => tr(`composer.search.from.${from}`);
  const chipText = !st.configured
    ? tr('composer.search.notSetUp')
    : chat ? tr('composer.search.labelChat', { mode: modeLabel(tr, r.mode) })
    : r.from === 'project' || r.from === 'global' ? tr('composer.search.labelFrom', { mode: modeLabel(tr, r.mode), from: fromLabel(r.from) })
    : tr('composer.search.label', { mode: modeLabel(tr, r.mode) });
  return (
    <>
      <Tip label={tr('composer.search.a11y')}>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={tr('composer.search.a11y')}
          accessibilityHint={tip}
          style={[{ alignSelf: 'flex-start', borderWidth: 1, borderColor: on ? t.accent : t.border, paddingHorizontal: 10, paddingVertical: 4, opacity: st.configured ? 1 : 0.6 }, { borderRadius: th.r(14) }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="search" size={14} color={on ? t.accentInk : t.sub} />
            <Text style={{ color: on ? t.accentInk : t.sub, fontSize: 12, fontWeight: '600' }}>
              {chipText}
            </Text>
          </View>
        </Pressable>
      </Tip>
      <Sheet visible={open} onClose={() => setOpen(false)} title={tr('sheet.search.title')} width={440}>
        {!st.configured && <Hint danger>{tr('sheet.search.noBackend')}</Hint>}
        {st.configured && st.reachable === false && <Hint danger>{st.error ? tr('sheet.search.unreachable', { error: st.error }) : tr('sheet.search.unreachableNoErr')}</Hint>}
        <SearchModeSelect value={chat} onChange={(m) => { onPin(m); }} inheritFrom={tr('composer.search.inheritFrom')} label={tr('composer.search.forChat')} />
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: t.sub, fontSize: 12, lineHeight: 18 }}>
            {tr('sheet.search.summary', {
              chat: chat ? modeLabel(tr, chat) : tr('composer.search.inherit'),
              project: project ? modeLabel(tr, project) : tr('composer.search.inherit'),
              global: global ? modeLabel(tr, global) : tr('composer.search.offLower'),
            })}
          </Text>
          <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', marginTop: 2 }}>{tr('sheet.search.effective', { mode: modeLabel(tr, r.mode), from: fromLabel(r.from) })}</Text>
        </View>
        <Hint>{modeHelp(tr, 'smart')}</Hint>
        <Hint>{modeHelp(tr, 'always')}</Hint>
      </Sheet>
    </>
  );
}
