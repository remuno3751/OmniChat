import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, api } from '../api';
import { useT } from '../i18n';
import type { SearchBackendId, SearchConfig, SearchConfigPatch, SearchEngineState, SearchOption, SearchResult } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Check, Field, Hint } from '../ui/kit';
import Icon from './Icon';

/**
 * The three web search choices of Settings > Plugins > Web search (PROTOCOL-v6 1.1b):
 * SearXNG, built-in (keyless engines) and API services. Each has its own "use this" and "test" buttons.
 */

type Tr = ReturnType<typeof useT>;
type Tone = 'ok' | 'warn' | 'off';
interface Line { text: string; tone: Tone }

/** Engine ids as the server reports them. */
export const BUILTIN_ENGINES = ['bing-rss', 'wikipedia', 'duckduckgo'];
export const API_ENGINES = ['brave', 'tavily'];
const ENGINE_NAME: Record<string, string> = {
  'bing-rss': 'Bing (RSS)', wikipedia: 'Wikipedia', duckduckgo: 'DuckDuckGo', brave: 'Brave Search API', tavily: 'Tavily',
};

const SNIPPET_MAX = 160;
const clip = (s: string) => (s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s);

/** Shared wrapping for long URLs on web (no horizontal overflow at 375 px). */
export const wrapStyle: any = Platform.OS === 'web' ? { overflowWrap: 'anywhere', wordBreak: 'break-word' } : null;

export function optionName(tr: Tr, id?: string | null): string {
  if (id === 'searxng') return tr('integ.search.opt.searxng.name');
  if (id === 'builtin') return tr('integ.search.opt.builtin.name');
  if (id === 'api') return tr('integ.search.opt.api.name');
  return id || '—';
}

function optionLine(tr: Tr, id: SearchBackendId, opt?: SearchOption): Line {
  if (!opt || !opt.configured) return { text: tr('integ.search.opt.notConfigured'), tone: 'off' };
  if (opt.state === 'ok') return { text: tr('integ.search.opt.ok'), tone: 'ok' };
  if (opt.state === 'disabled') return { text: tr('integ.search.opt.disabled'), tone: 'off' };
  if (id === 'searxng' && !opt.reachable) return { text: tr('integ.search.status.unreachable'), tone: 'warn' };
  return { text: tr('integ.search.opt.error', { msg: opt.lastError || tr('integ.search.eng.errorPlain') }), tone: 'warn' };
}

function engineLine(tr: Tr, on: boolean, st?: SearchEngineState): Line {
  if (!on) return { text: tr('integ.search.eng.disabled'), tone: 'off' };
  if (!st) return { text: tr('integ.search.eng.unknown'), tone: 'off' };
  switch (st.state) {
    case 'ok': return { text: tr('integ.search.eng.ok'), tone: 'ok' };
    case 'cooldown': return { text: tr('integ.search.eng.cooldown'), tone: 'warn' };
    case 'error': return { text: tr('integ.search.eng.error', { msg: st.lastError || tr('integ.search.eng.errorPlain') }), tone: 'warn' };
    default: return { text: tr('integ.search.eng.disabled'), tone: 'off' };
  }
}

/** One test search at a time, for any option. Results are kept until the next test. */
export function useSearchTest() {
  const tr = useT();
  const [testFor, setTestFor] = useState<SearchBackendId | null>(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState('');

  const run = async (mode: SearchBackendId, query: string) => {
    setTestFor(mode);
    setTesting(true);
    setResults(null);
    setError('');
    try {
      const r = await api.searchTest(query.trim() || 'OmniChat', mode);
      if (r.error) setError(r.error);
      else setResults((r.results ?? []).slice(0, 3));
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 403 ? tr('integ.search.adminOnly') : e?.message || tr('integ.search.testFailed'));
    } finally {
      setTesting(false);
    }
  };
  return { testFor, testing, results, error, run };
}
export type SearchTest = ReturnType<typeof useSearchTest>;

export interface OptionProps {
  config: SearchConfig;
  option?: SearchOption;
  selected: boolean;
  readOnly: boolean;
  busy: boolean;
  query: string;
  test: SearchTest;
  /** Saves a PUT /search/config body. Resolves true on success. */
  onSave: (body: SearchConfigPatch) => Promise<boolean>;
}

function Radio({ on }: { on: boolean }) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      style={[styles.radio, { borderColor: on ? t.accent : t.border }]}
    >
      {on && <View style={[styles.radioDot, { backgroundColor: t.accent }]} />}
    </View>
  );
}

function StatusLine({ line }: { line: Line }) {
  const t = useTheme();
  const color = line.tone === 'ok' ? t.good : line.tone === 'warn' ? t.warn : t.sub;
  return (
    <View style={styles.statusLine}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[{ flex: 1, minWidth: 0, color, fontSize: 13, fontWeight: '600' }, wrapStyle]}>{line.text}</Text>
    </View>
  );
}

/** Card frame with radio, name, optional badge and a one-line description. */
function OptionFrame({ name, badge, selected, desc, children }: {
  name: string; badge?: string; selected: boolean; desc: string; children?: React.ReactNode;
}) {
  const t = useTheme();
  const th = useThemeDef();
  return (
    <View style={[styles.frame, { borderColor: selected ? t.accent : t.border, backgroundColor: t.bg, borderRadius: th.r(10) }]}>
      <View style={styles.frameHead}>
        <Radio on={selected} />
        <Text style={{ flex: 1, minWidth: 0, color: t.text, fontSize: 14, fontWeight: '600' }}>{name}</Text>
        {!!badge && (
          <Text style={{ color: t.accentText, backgroundColor: t.accent, fontSize: 11, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, borderRadius: th.r(6), overflow: 'hidden' }}>
            {badge}
          </Text>
        )}
      </View>
      <Hint>{desc}</Hint>
      {children}
    </View>
  );
}

function TestResult({ test }: { test: SearchTest }) {
  const tr = useT();
  const t = useTheme();
  if (test.error) return <Hint danger>{test.error}</Hint>;
  if (test.results === null) return null;
  if (test.results.length === 0) return <Hint>{tr('integ.search.noResults')}</Hint>;
  return (
    <View style={{ gap: 8, marginTop: 8, minWidth: 0 }}>
      <Text style={{ color: t.sub, fontSize: 12 }}>{tr('integ.search.results', { n: test.results.length })}</Text>
      {test.results.map((r, i) => (
        <View key={`${r.url}-${i}`} style={{ minWidth: 0 }}>
          <Text style={[{ color: t.text, fontSize: 14, fontWeight: '600' }, wrapStyle]}>{r.title || r.url}</Text>
          <Text selectable style={[{ color: t.accentInk, fontSize: 12, marginTop: 1 }, wrapStyle]}>{r.url}</Text>
          {!!r.snippet && <Text style={[{ color: t.sub, fontSize: 12, marginTop: 2 }, wrapStyle]}>{clip(r.snippet)}</Text>}
        </View>
      ))}
    </View>
  );
}

/** "Use this" (primary unless this option is already the choice), optional extra button, and "Test". */
function OptionActions({ mode, selected, disabled, busy, test, query, onUse, extra }: {
  mode: SearchBackendId; selected: boolean; disabled?: boolean; busy: boolean; test: SearchTest; query: string;
  onUse: () => void; extra?: React.ReactNode;
}) {
  const tr = useT();
  const mine = test.testFor === mode;
  return (
    <View style={{ marginTop: 10, gap: 8, minWidth: 0 }}>
      <View style={styles.actionRow}>
        <Btn small primary={!selected} label={tr('integ.search.useThis')} onPress={onUse} disabled={busy || !!disabled} />
        {extra}
        <Btn
          small
          label={test.testing && mine ? tr('integ.search.testing') : tr('integ.search.test')}
          onPress={() => test.run(mode, query)}
          disabled={test.testing || busy}
        />
      </View>
      {mine && <TestResult test={test} />}
    </View>
  );
}

/** SearXNG: URL field (shows the current host), recommended badge, setup guide as children. */
export function SearxngOption(props: OptionProps & { guide: React.ReactNode }) {
  const { config, option, selected, readOnly, busy, query, test, onSave, guide } = props;
  const t = useTheme();
  const tr = useT();
  const host = config.searxngHost ?? '';
  const [url, setUrl] = useState(host);
  const [guideOpen, setGuideOpen] = useState(false);
  useEffect(() => { setUrl(host); }, [host]);

  const save = () => onSave({ mode: 'searxng', ...(url.trim() ? { searxngUrl: url.trim() } : {}) });

  return (
    <OptionFrame
      name={optionName(tr, 'searxng')}
      badge={tr('integ.search.badge.recommended')}
      selected={selected}
      desc={tr('integ.search.searxng.desc')}
    >
      <StatusLine line={optionLine(tr, 'searxng', option)} />
      {readOnly ? (
        <Hint>{`${tr('integ.search.host')}: ${host || '—'}`}</Hint>
      ) : (
        <View style={{ marginTop: 8, minWidth: 0 }}>
          <Field label={tr('integ.search.searxng.url')} value={url} onChangeText={setUrl} placeholder="http://localhost:8080" mono />
          <Hint>{tr('integ.search.searxng.urlHint')}</Hint>
        </View>
      )}
      {!readOnly && <OptionActions mode="searxng" selected={selected} busy={busy} test={test} query={query} onUse={save} />}

      <Pressable
        onPress={() => setGuideOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: guideOpen }}
        style={styles.toggle}
      >
        <Text style={{ flex: 1, minWidth: 0, color: t.text, fontSize: 13, fontWeight: '600' }}>{tr('integ.search.guide.toggle')}</Text>
        <Icon name={guideOpen ? 'collapse' : 'expand'} size={18} color={t.sub} />
      </Pressable>
      {guideOpen && guide}
    </OptionFrame>
  );
}

/** Built-in: keyless engines with a checkbox and live state each. Engine checkboxes save at once. */
export function BuiltinOption(props: OptionProps) {
  const { config, option, selected, readOnly, busy, query, test, onSave } = props;
  const tr = useT();
  const on = config.engines.builtin;

  const setEngines = (next: string[]) => { if (!busy) void onSave({ engines: { builtin: next } }); };
  const toggle = (id: string, v: boolean) => setEngines(v ? [...on.filter((x) => x !== id), id] : on.filter((x) => x !== id));

  return (
    <OptionFrame name={optionName(tr, 'builtin')} selected={selected} desc={tr('integ.search.builtin.desc')}>
      <StatusLine line={optionLine(tr, 'builtin', option)} />
      <View style={{ marginTop: 4, minWidth: 0 }}>
        {BUILTIN_ENGINES.map((id) => {
          const checked = on.includes(id);
          const name = ENGINE_NAME[id] ?? id;
          const line = engineLine(tr, checked, option?.engines?.find((e) => e.id === id));
          if (readOnly) return <Hint key={id}>{`${name}: ${line.text}`}</Hint>;
          return <Check key={id} label={name} value={checked} onChange={(v) => toggle(id, v)} hint={line.text} />;
        })}
      </View>
      <Hint danger>{tr('integ.search.builtin.warn')}</Hint>
      {!readOnly && (
        <OptionActions
          mode="builtin" selected={selected} busy={busy} test={test} query={query}
          disabled={on.length === 0}
          onUse={() => onSave({ mode: 'builtin', engines: { builtin: on } })}
        />
      )}
    </OptionFrame>
  );
}

/** API services: Brave and Tavily keys (secure, never shown back), which engines to use, optional key removal. */
export function ApiOption(props: OptionProps) {
  const { config, option, selected, readOnly, busy, query, test, onSave } = props;
  const tr = useT();
  const [draft, setDraft] = useState<Record<string, string>>({ brave: '', tavily: '' });
  const on = config.engines.api;
  const keySet = config.keySet as Record<string, boolean>;

  const typedPatch = (): SearchConfigPatch => {
    const k: SearchConfigPatch = {};
    if (draft.brave.trim()) k.braveApiKey = draft.brave.trim();
    if (draft.tavily.trim()) k.tavilyApiKey = draft.tavily.trim();
    return k;
  };
  const afterSave = (ok: boolean) => { if (ok) setDraft({ brave: '', tavily: '' }); };
  const saveKeys = async () => afterSave(await onSave(typedPatch()));
  const useThis = async () => afterSave(await onSave({ mode: 'api', engines: { api: on }, ...typedPatch() }));
  const removeKey = (id: string) => onSave(id === 'brave' ? { braveApiKey: null } : { tavilyApiKey: null });
  const hasAnyKey = keySet.brave || keySet.tavily || !!draft.brave.trim() || !!draft.tavily.trim();
  const typed = !!draft.brave.trim() || !!draft.tavily.trim();

  const toggle = (id: string, v: boolean) => { if (!busy) void onSave({ engines: { api: v ? [...on.filter((x) => x !== id), id] : on.filter((x) => x !== id) } }); };

  return (
    <OptionFrame name={optionName(tr, 'api')} selected={selected} desc={tr('integ.search.api.desc')}>
      <StatusLine line={optionLine(tr, 'api', option)} />
      {API_ENGINES.map((id) => {
        const name = ENGINE_NAME[id] ?? id;
        const isSet = !!keySet[id];
        const checked = on.includes(id);
        const line = !checked || isSet
          ? engineLine(tr, checked, option?.engines?.find((e) => e.id === id))
          : { text: tr('integ.search.noKey'), tone: 'warn' as Tone };
        return (
          <View key={id} style={{ marginTop: 8, minWidth: 0 }}>
            {readOnly ? (
              <Hint>{`${name}: ${isSet ? tr('integ.search.keySet') : tr('integ.search.noKey')}`}</Hint>
            ) : (
              <>
                <Field
                  label={`${name} ${tr('integ.search.keyLabel')}`}
                  value={draft[id]}
                  onChangeText={(v) => setDraft((d) => ({ ...d, [id]: v }))}
                  secure
                  placeholder={isSet ? tr('integ.search.keySet') : tr('integ.search.keyEmpty')}
                />
                <View style={styles.keyRow}>
                  <Hint>{tr('integ.search.keyHint')}</Hint>
                  {isSet && <Btn small danger label={tr('integ.search.removeKey')} onPress={() => removeKey(id)} disabled={busy} />}
                </View>
              </>
            )}
            {readOnly ? null : (
              <Check label={tr('integ.search.useEngine', { name })} value={checked} onChange={(v) => toggle(id, v)} hint={line.text} />
            )}
            {readOnly && <Hint>{line.text}</Hint>}
          </View>
        );
      })}
      <Hint>{tr('integ.search.api.getKey')}</Hint>
      {!readOnly && (
        <OptionActions
          mode="api" selected={selected} busy={busy} test={test} query={query}
          disabled={!hasAnyKey}
          onUse={useThis}
          extra={typed ? <Btn small label={tr('integ.search.saveKeys')} onPress={saveKeys} disabled={busy} /> : null}
        />
      )}
    </OptionFrame>
  );
}

const styles = StyleSheet.create({
  frame: { borderWidth: 1, borderRadius: 10, padding: 12, minWidth: 0, maxWidth: '100%' },
  frameHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  keyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingVertical: 4, minWidth: 0 },
});
