import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, ApiError, getIsAdmin } from '../api';
import type { SettingsPageId } from '../settingsMeta';
import { useT } from '../i18n';
import type { SearchBackendId, SearchConfig, SearchConfigPatch, SearchStatus } from '../protocol';
import { useTheme } from '../theme';
import { Btn, Check, Field, Hint } from '../ui/kit';
import { CopyBlock, IntegrationCard, Step } from './IntegrationParts';
import { ApiOption, BuiltinOption, optionName, SearxngOption, useSearchTest, wrapStyle } from './SearchOptions';

const POLL_MS = 10000;

const SETTINGS_YML = [
  'use_default_settings: true',
  '',
  'server:',
  '  secret_key: "change-me"',
  '  limiter: false',
  '',
  'search:',
  '  formats: [html, json]',
].join('\n');

const COMPOSE_YML = [
  'services:',
  '  searxng:',
  '    image: searxng/searxng',
  '    ports:',
  '      - "8080:8080"',
  '    volumes:',
  '      - ./searxng:/etc/searxng',
].join('\n');

type Tone = 'ok' | 'warn' | 'unknown';

/**
 * Settings > Plugins: web search card (PROTOCOL-v6 1.1b).
 * Shows the active method, three choices (SearXNG, built-in, API services) and the fallback switch.
 * Polls GET /search/status and GET /search/config every 10 s. Every change is a PUT that applies at once.
 * Non-admins see the same card read-only. `onGoto` opens another settings page (used for Settings > Chat).
 */
export function SearchIntegration({ onGoto }: { onGoto?: (page: SettingsPageId) => void }) {
  const t = useTheme();
  const tr = useT();

  const [info, setInfo] = useState<SearchStatus | null>(null);
  const [config, setConfig] = useState<SearchConfig | null>(null);
  const [err, setErr] = useState<'old' | 'failed' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [query, setQuery] = useState('OmniChat');
  const test = useSearchTest();
  // undefined = unknown (older session): the server decides, same as the other admin screens.
  const readOnly = getIsAdmin() === false;

  // A 404 on the status means the server predates /search/status: stop polling.
  useEffect(() => {
    let alive = true;
    let timer: any = null;
    const tick = async () => {
      try {
        const r = await api.searchStatus();
        if (!alive) return;
        setInfo(r);
        setErr(null);
      } catch (e: any) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) { setErr('old'); return; }
        setErr('failed');
      }
      try {
        const c = await api.searchConfig();
        if (alive) setConfig(c);
      } catch {}
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [refreshKey]);

  /** PUT /search/config, then take the new config and refresh the status at once. */
  const save = async (body: SearchConfigPatch): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setSaveErr('');
    try {
      const c = await api.putSearchConfig(body);
      setConfig(c);
      setRefreshKey((k) => k + 1);
      return true;
    } catch (e: any) {
      setSaveErr(e instanceof ApiError && e.status === 403 ? tr('integ.search.readOnly') : e?.message || tr('integ.search.saveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const activeId = (info?.active ?? info?.mode ?? null) as SearchBackendId | null;
  const activeOpt = info?.options?.find((o) => o.id === activeId);
  const activeOk = activeOpt ? activeOpt.state === 'ok' : !!(info?.configured && info?.reachable);

  let status: Tone = 'unknown';
  let statusText = tr('integ.status.loading');
  if (err === 'old') { status = 'warn'; statusText = tr('integ.search.status.old'); }
  else if (err === 'failed') { status = 'warn'; statusText = tr('integ.status.checkFailed'); }
  else if (info !== null) {
    if (activeId && activeOk) { status = 'ok'; statusText = tr('integ.search.status.using', { name: optionName(tr, activeId) }); }
    else if (activeId) { status = 'warn'; statusText = tr('integ.search.status.notReady', { name: optionName(tr, activeId) }); }
    else { status = 'warn'; statusText = tr('integ.search.status.none'); }
  }

  const ready = !!info?.configured && !!info?.reachable;
  const yesNo = (v: boolean) => (v ? tr('integ.search.yes') : tr('integ.search.no'));

  const Row = ({ label, value }: { label: string; value: string }) => (
    <View style={{ flexDirection: 'row', gap: 8, minWidth: 0 }}>
      <Text style={{ color: t.sub, fontSize: 13, flexShrink: 0, minWidth: 96 }}>{label}</Text>
      <Text style={[{ flex: 1, minWidth: 0, color: t.text, fontSize: 13 }, wrapStyle]}>{value}</Text>
    </View>
  );

  const optionProps = (id: SearchBackendId) => ({
    config: config as SearchConfig,
    option: info?.options?.find((o) => o.id === id),
    selected: config?.mode === id,
    readOnly,
    busy,
    query,
    test,
    onSave: save,
  });

  // Setup guide for SearXNG (steps 1-3). It sits under a toggle inside the SearXNG option.
  const guide = (
    <>
      <Step n={1} title={tr('integ.search.step1.title')} done={info ? ready : undefined}>
        <Hint>{tr('integ.search.step1.hint')}</Hint>
        <CopyBlock label="searxng/settings.yml" text={SETTINGS_YML} />
        <Hint>{tr('integ.search.step1.run')}</Hint>
        <CopyBlock label="docker" text="docker run -d --name searxng -p 8080:8080 -v ./searxng:/etc/searxng searxng/searxng" />
        <Hint>{tr('integ.search.step1.compose')}</Hint>
        <CopyBlock label="docker-compose.yml" text={COMPOSE_YML} />
        <Hint>{tr('integ.search.step1.check')}</Hint>
        <CopyBlock label="curl" text={'curl "http://localhost:8080/search?q=test&format=json"'} />
        <Hint>{tr('integ.search.step1.htmlHint')}</Hint>
      </Step>

      <Step n={2} title={tr('integ.search.step2.title')} done={info ? !!info.configured : undefined}>
        <Hint>{tr('integ.search.step2.hint')}</Hint>
        <CopyBlock text="SEARXNG_URL=http://localhost:8080" />
        <Hint>{tr('integ.search.step2.where')}</Hint>
        <View style={{ gap: 4, minWidth: 0 }}>
          {[
            tr('integ.search.step2.winService'),
            tr('integ.search.step2.linux'),
            tr('integ.search.step2.mac'),
            tr('integ.search.step2.docker'),
            tr('integ.search.step2.source'),
          ].map((line, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, minWidth: 0 }}>
              <Text style={{ color: t.sub, fontSize: 13 }}>•</Text>
              <Text style={[{ flex: 1, minWidth: 0, color: t.text, fontSize: 13, lineHeight: 18 }, wrapStyle]}>{line}</Text>
            </View>
          ))}
        </View>
        <Hint>{tr('integ.search.step2.localhost')}</Hint>
        <Hint>{tr('integ.search.step2.engines')}</Hint>
        <CopyBlock label={tr('integ.search.step2.enginesLabel')} text="SEARXNG_ENGINES=bing news,yandex" />
      </Step>

      <Step n={3} title={tr('integ.search.step3.title')} done={info ? !!info.reachable : undefined}>
        <Hint>{tr('integ.search.step3.hint')}</Hint>
        <CopyBlock label="Windows" text={'net stop OmniChat\nnet start OmniChat'} />
        <CopyBlock label="Linux" text="sudo systemctl restart omnichat" />
        <CopyBlock label="Docker" text="docker compose restart" />
      </Step>
    </>
  );

  return (
    <IntegrationCard title={tr('integ.search.title')} subtitle={tr('integ.search.subtitle')} status={status} statusText={statusText}>
      {err === 'old' && <Hint danger>{tr('integ.serverTooOld')}</Hint>}
      {readOnly && <Hint>{tr('integ.search.readOnly')}</Hint>}

      <View style={{ marginTop: 8, gap: 4, minWidth: 0 }}>
        <Row label={tr('integ.search.configured')} value={info ? yesNo(!!info.configured) : '—'} />
        <Row label={tr('integ.search.backend')} value={info?.backend || '—'} />
        <Row label={tr('integ.search.host')} value={info?.host || '—'} />
        <Row label={tr('integ.search.reachable')} value={info ? yesNo(!!info.reachable) : '—'} />
        <Row label={tr('integ.search.lastError')} value={info?.error || tr('integ.search.none')} />
      </View>
      <View style={{ alignSelf: 'flex-start', marginTop: 8 }}>
        <Btn small label={tr('common.refresh')} onPress={() => setRefreshKey((k) => k + 1)} />
      </View>

      {!readOnly && <Hint>{tr('integ.search.pick')}</Hint>}
      {!!saveErr && <Hint danger>{saveErr}</Hint>}

      {config ? (
        <View style={{ marginTop: 10, gap: 10, minWidth: 0 }}>
          <SearxngOption {...optionProps('searxng')} guide={guide} />
          <BuiltinOption {...optionProps('builtin')} />
          <ApiOption {...optionProps('api')} />

          {!readOnly && (
            <Field label={tr('integ.search.query')} value={query} onChangeText={setQuery} placeholder="OmniChat" />
          )}

          {readOnly ? (
            <Hint>{`${tr('integ.search.fallback')}: ${yesNo(!!config.fallback)}`}</Hint>
          ) : (
            <Check
              label={tr('integ.search.fallback')}
              value={!!config.fallback}
              onChange={(v) => { void save({ fallback: v }); }}
              hint={tr('integ.search.fallbackHint')}
            />
          )}

          <View style={{ gap: 4, minWidth: 0 }}>
            <Row label={tr('integ.search.currently')} value={optionName(tr, activeId)} />
            {!!info?.lastUsed && <Row label={tr('integ.search.lastAnswered')} value={optionName(tr, info.lastUsed.usedBackend)} />}
          </View>
        </View>
      ) : (
        err !== 'old' && <Hint>{tr('integ.status.loading')}</Hint>
      )}

      <Step n={4} title={tr('integ.search.step4.title')}>
        <Hint>{tr('integ.search.step4.hint')}</Hint>
        {!!onGoto && (
          <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
            <Btn small label={tr('integ.search.openChat')} onPress={() => onGoto('chat')} />
          </View>
        )}
      </Step>

      <Step n={5} title={tr('integ.search.step5.title')}>
        <Hint>{tr('integ.search.step5.hint')}</Hint>
      </Step>
    </IntegrationCard>
  );
}

export default SearchIntegration;
