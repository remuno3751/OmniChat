import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, api, getIsAdmin } from '../api';
import { Chip, PermChips } from '../components/ToolCards';
import SearchSettingsSection from '../components/SearchSettingsSection';
import { hostOf, openUrl } from '../components/Sources';
import type { SearchResult } from '../protocol';
import { useT } from '../i18n';
import { applyUpsert, patchSettingsLocal, useStore } from '../store';
import { SEARCH_HELP, SEARCH_LABEL, resetToolCaches, useSearchStatus, useTools } from '../toolState';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, ScreenHeader, fmtAgo } from '../ui/kit';
import { toast } from '../ui/toast';
import type { SearchMode } from '../protocol';
import { Segmented } from '../ui/kit';

/** Settings > Tools: available tools, global enable switches, grants, plugin reload, search backend. */
export default function ToolsScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const admin = getIsAdmin() !== false;
  const settings = useStore((s) => s.settings);
  const tools = useTools();
  const search = useSearchStatus();
  const enabled = settings?.tools ?? [];
  const [grants, setGrants] = useState<{ tool: string; grantedAt: number }[] | null | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const [q, setQ] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [testErr, setTestErr] = useState('');

  const loadGrants = useCallback(async () => {
    try { setGrants((await api.toolGrants()).grants || []); } catch (e: any) { setGrants(e instanceof ApiError && e.status === 404 ? null : []); }
  }, []);
  useEffect(() => { loadGrants(); }, [loadGrants]);
  useEffect(() => { search.refresh(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setGlobalTools = async (next: string[]) => {
    const old = settings?.tools ?? null;
    patchSettingsLocal({ tools: next });
    try { applyUpsert({ settings: await api.putSettings({ tools: next }) }); } catch (e: any) {
      patchSettingsLocal({ tools: old });
      toast(e.message || tr('code.saveFailed'), 'error');
    }
  };
  const toggle = (name: string, on: boolean) => setGlobalTools(on ? Array.from(new Set([...enabled, name])) : enabled.filter((x) => x !== name));

  const setGlobalSearch = async (m: SearchMode) => {
    const old = settings?.searchMode;
    patchSettingsLocal({ searchMode: m });
    try { applyUpsert({ settings: await api.putSettings({ searchMode: m }) }); } catch (e: any) {
      patchSettingsLocal({ searchMode: old });
      toast(e.message || tr('code.saveFailed'), 'error');
    }
  };

  const reload = async () => {
    setReloading(true);
    try { await api.reloadTools(); resetToolCaches(); tools.refresh(); search.refresh(); toast(tr('tools.reloaded'), 'ok'); }
    catch (e: any) { toast(e.status === 403 ? tr('tools.reloadAdminOnly') : e.message || tr('tools.reloadFailed'), 'error'); }
    finally { setReloading(false); }
  };
  const revoke = async (tool: string) => {
    if (!(await confirmDialog(tr('tools.revokeTitle'), tr('tools.revokeMsg', { tool }), tr('tools.revoke')))) return;
    try { await api.revokeToolGrant(tool); setGrants((g) => (g || []).filter((x) => x.tool !== tool)); } catch (e: any) { toast(e.message || tr('tools.revokeFailed'), 'error'); }
  };
  const test = async () => {
    if (!q.trim()) return;
    setTesting(true); setTestErr(''); setResults(null);
    try {
      const r = await api.searchTest(q.trim());
      if (r?.error) setTestErr(r.error);
      setResults(r?.results || []);
    } catch (e: any) { setTestErr(e.status === 403 ? tr('tools.testAdminOnly') : e.message || tr('tools.testFailed')); }
    finally { setTesting(false); }
  };

  const list = tools.value;
  const sec = (s: string) => <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', marginTop: 22 }}>{s}</Text>;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScreenHeader title={tr('tools.title')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.notice, { borderRadius: th.r(12) }, { borderColor: t.warn, backgroundColor: t.panel }]}>
          <Text style={{ color: t.warn, fontWeight: '700', fontSize: 13 }}>{tr('tools.noticeTitle')}</Text>
          <Text style={{ color: t.text, fontSize: 13, lineHeight: 19, marginTop: 3 }}>
            {tr('tools.noticeBody')}
          </Text>
        </View>

        {sec(tr('tools.available'))}
        {tools.value === undefined && <ActivityIndicator color={t.accentInk} style={{ alignSelf: 'flex-start', marginTop: 8 }} />}
        {list === null && <Hint>{tools.error ? tr('tools.loadFailed', { error: tools.error }) : tr('tools.unsupported')}</Hint>}
        {list && list.length === 0 && <Hint>{tr('tools.none')}</Hint>}
        {list && list.length > 0 && <Hint>{tr('tools.switchHint')}</Hint>}
        {list?.map((tl) => {
          const on = enabled.includes(tl.name);
          const blocked = !tl.available && !on;
          return (
            <View key={tl.name} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: tl.error || !tl.available ? t.danger : t.border, backgroundColor: t.panel }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text style={{ color: t.text, fontWeight: '700', fontSize: 14 }}>{tl.name}</Text>
                  <Chip small label={tl.source === 'plugin' ? (tl.pluginId ? tr('tools.srcPluginId', { id: tl.pluginId }) : tr('tools.srcPlugin')) : tr('tools.srcBuiltin')} color={t.sub} />
                  {!tl.available && <Chip small label={tr('tools.unavailable')} color={t.danger} />}
                  {tl.available && tl.needsApproval === false && <Chip small label={tr('tools.noApproval')} color={t.good} />}
                </View>
                <Text style={{ color: t.sub, fontSize: 12, marginTop: 3, lineHeight: 17 }}>{tl.description}</Text>
                <View style={{ marginTop: 5 }}><PermChips perms={tl.permissions} small /></View>
                {!!tl.error && <Text style={{ color: t.danger, fontSize: 12, marginTop: 4 }}>{tl.error}</Text>}
              </View>
              <Pressable
                disabled={blocked}
                onPress={() => toggle(tl.name, !on)}
                accessibilityRole="switch"
                accessibilityLabel={tr('tools.enableA11y', { name: tl.name })}
                accessibilityState={{ checked: on, disabled: blocked }}
                style={[styles.sw, { backgroundColor: on ? t.accent : t.border, opacity: blocked ? 0.4 : 1 }]}
              >
                <View style={[styles.knob, { alignSelf: on ? 'flex-end' : 'flex-start' }]} />
              </Pressable>
            </View>
          );
        })}
        {list && admin && <View style={{ marginTop: 8 }}><Btn label={reloading ? tr('tools.reloading') : tr('tools.reload')} disabled={reloading} onPress={reload} /></View>}
        {list && admin && <Hint>{tr('tools.reloadHint')}</Hint>}

        {grants !== null && (
          <>
            {sec(tr('tools.grantsTitle'))}
            {grants === undefined && <ActivityIndicator color={t.accentInk} style={{ alignSelf: 'flex-start', marginTop: 8 }} />}
            {grants && grants.length === 0 && <Hint>{tr('tools.grantsEmpty')}</Hint>}
            {grants?.map((g) => (
              <View key={g.tool} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel, alignItems: 'center' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{g.tool}</Text>
                  <Text style={{ color: t.sub, fontSize: 12 }}>{tr('tools.granted', { ago: fmtAgo(g.grantedAt) })}</Text>
                </View>
                <Btn small danger label={tr('tools.revoke')} onPress={() => revoke(g.tool)} />
              </View>
            ))}
          </>
        )}

        {search.value !== null && search.value !== undefined && (
          <>
            {sec(tr('tools.webSearch'))}
            <View style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel, flexDirection: 'column', alignItems: 'stretch' }]}>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip label={search.value.configured ? tr('tools.configured') : tr('tools.notConfigured')} color={search.value.configured ? t.good : t.warn} />
                {search.value.configured && <Chip label={search.value.reachable === false ? tr('tools.unreachable') : search.value.reachable ? tr('tools.reachable') : tr('tools.statusUnknown')} color={search.value.reachable === false ? t.danger : search.value.reachable ? t.good : t.sub} />}
                {!!search.value.backend && <Text style={{ color: t.text, fontSize: 13 }}>{search.value.backend}</Text>}
                {!!search.value.host && <Text style={{ color: t.sub, fontSize: 13 }}>{search.value.host}</Text>}
              </View>
              {!search.value.configured && <Hint>{admin ? tr('tools.setSearchAdmin') : tr('tools.setSearchUser')}</Hint>}
              {!!search.value.error && <Hint danger>{search.value.error}</Hint>}
              {search.value.configured && (
                <>
                  <Text style={{ color: t.sub, fontSize: 12, marginTop: 10, marginBottom: 4 }}>{tr('tools.searchDefault')}</Text>
                  <Segmented<SearchMode> options={(['off', 'smart', 'always'] as SearchMode[]).map((m) => ({ value: m, label: SEARCH_LABEL[m] }))} value={settings?.searchMode || 'smart'} onChange={setGlobalSearch} />
                  <Hint>{SEARCH_HELP[settings?.searchMode || 'smart']}</Hint>
                </>
              )}
              {search.value.configured && admin && (
                <View style={{ marginTop: 10 }}>
                  <Field label={tr('tools.testLabel')} value={q} onChangeText={setQ} placeholder={tr('tools.testPlaceholder')} onSubmit={test} />
                  <View style={{ marginTop: 8 }}><Btn small primary label={testing ? tr('tools.searching') : tr('tools.testBtn')} disabled={testing || !q.trim()} onPress={test} /></View>
                  {!!testErr && <Hint danger>{testErr}</Hint>}
                  {results && results.length === 0 && !testErr && <Hint>{tr('tools.noResults')}</Hint>}
                  {results?.map((r, i) => (
                    <Pressable key={i} onPress={() => openUrl(r.url)} style={{ paddingVertical: 5 }} accessibilityRole="link">
                      <Text style={{ color: t.text, fontSize: 13 }}><Text style={{ color: t.accentInk, fontWeight: '700' }}>[{i + 1}] </Text>{r.title}</Text>
                      <Text numberOfLines={1} style={{ color: t.sub, fontSize: 11 }}>{hostOf(r.url)}</Text>
                      {!!r.snippet && <Text numberOfLines={2} style={{ color: t.sub, fontSize: 12 }}>{r.snippet}</Text>}
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={{ marginTop: 8 }}><Btn small label={tr('tools.refreshStatus')} onPress={() => search.refresh()} /></View>
            </View>
            <SearchSettingsSection />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 8, width: '100%', maxWidth: 720, alignSelf: 'center', paddingBottom: 40 },
  notice: { borderWidth: 1, padding: 12 },
  card: { flexDirection: 'row', gap: 10, borderWidth: 1, padding: 12 },
  sw: { width: 42, height: 24, borderRadius: 12, padding: 2, justifyContent: 'center' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
});
