import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { SearchMode } from '../protocol';
import { SEARCH_HELP, SEARCH_LABEL, useSearchStatus, useTools } from '../toolState';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { Hint, Label, Segmented } from '../ui/kit';
import { Chip, PermChips } from './ToolCards';
import Icon from './Icon';

/** Inherit / Off / Auto / Always. `inheritFrom` names the level that is inherited, e.g. "the project / global setting". */
export function SearchModeSelect({ value, onChange, inheritFrom, label }: {
  value: SearchMode | null; onChange: (v: SearchMode | null) => void; inheritFrom: string; label?: string;
}) {
  const tr = useT();
  const status = useSearchStatus();
  if (!status.value) return null; // old server or still loading
  const set = (v: 'inherit' | SearchMode) => onChange(v === 'inherit' ? null : v);
  return (
    <View>
      <Label>{label ?? tr('sheet.search.title')}</Label>
      <Segmented<'inherit' | SearchMode>
        options={[{ value: 'inherit', label: tr('tool.inherit') }, ...(['smart', 'off', 'auto', 'always'] as SearchMode[]).map((m) => ({ value: m, label: SEARCH_LABEL[m] }))]}
        value={value ?? 'inherit'}
        onChange={set}
      />
      <Hint>{value ? SEARCH_HELP[value] : tr('tool.inheritUses', { from: inheritFrom })}{status.value.configured ? '' : tr('tool.noSearchBackend')}</Hint>
    </View>
  );
}

type TMode = 'inherit' | 'none' | 'custom';
const modeOf = (v: string[] | null | undefined): TMode => (v == null ? 'inherit' : v.length ? 'custom' : 'none');

/** Inherit / None / Custom list of enabled tools. Hidden when the server has no tools endpoint. */
export function ToolsSelect({ value, onChange, inheritFrom, label }: {
  value: string[] | null; onChange: (v: string[] | null) => void; inheritFrom: string; label?: string;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const tools = useTools();
  const [mode, setMode] = useState<TMode>(modeOf(value));
  useEffect(() => {
    const m = modeOf(value);
    if (m !== mode && !(mode === 'custom' && value && value.length === 0)) setMode(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  if (!tools.value) return null;
  const pick = (m: TMode) => {
    setMode(m);
    onChange(m === 'inherit' ? null : m === 'none' ? [] : (value || []));
  };
  const cur = value || [];
  const toggle = (name: string) => onChange(cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]);
  return (
    <View>
      <Label>{label ?? tr('code.tools')}</Label>
      <Segmented<TMode> options={[{ value: 'inherit', label: tr('tool.inherit') }, { value: 'none', label: tr('common.none') }, { value: 'custom', label: tr('tool.custom') }]} value={mode} onChange={pick} />
      <Hint>
        {mode === 'inherit' ? tr('tool.inheritUses', { from: inheritFrom }) : mode === 'none' ? tr('tool.noneLevel') : tr('tool.customHint')}
        {' '}{tr('tool.consentNote')}
      </Hint>
      {mode === 'custom' && (
        <View style={{ marginTop: 6 }}>
          {tools.value.length === 0 && <Hint>{tr('tool.noTools')}</Hint>}
          {tools.value.map((tl) => {
            const on = cur.includes(tl.name);
            return (
              <Pressable
                key={tl.name}
                disabled={!tl.available && !on}
                onPress={() => toggle(tl.name)}
                accessibilityRole="switch"
                accessibilityState={{ checked: on, disabled: !tl.available && !on }}
                style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6, opacity: !tl.available && !on ? 0.5 : 1 }}
              >
                <View style={[{ width: 20, height: 20, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent', marginTop: 1 }, { borderRadius: th.r(5) }]}>
                  {on && <Icon name="check" size={14} color={t.accentText} />}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tl.name}</Text>
                    {!tl.available && <Chip small label={tr('tool.unavailable')} color={t.danger} />}
                    <PermChips perms={tl.permissions} small />
                  </View>
                  <Text numberOfLines={2} style={{ color: t.sub, fontSize: 12 }}>{tl.description}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** Tools + search mode block for the project / chat settings sheets (each part hides itself on an old server). */
export function ToolSearchFields({ tools, onTools, search, onSearch, inheritFrom }: {
  tools: string[] | null; onTools: (v: string[] | null) => void; search: SearchMode | null; onSearch: (v: SearchMode | null) => void; inheritFrom: string;
}) {
  return (
    <View>
      <SearchModeSelect value={search} onChange={onSearch} inheritFrom={inheritFrom} />
      <ToolsSelect value={tools} onChange={onTools} inheritFrom={inheritFrom} />
    </View>
  );
}
