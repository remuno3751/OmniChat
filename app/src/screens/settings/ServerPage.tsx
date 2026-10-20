import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { adminApi, type AdminAuditEntry, type AdminGeneral, type AdminNetwork, type AdminOverview } from '../../apiAdmin';
import { validateServerDescription, validateServerName } from '../../adminValidate';
import { useT } from '../../i18n';
import { useTheme, useThemeDef } from '../../theme';
import { Btn, Check, Field, Hint } from '../../ui/kit';
import { toast } from '../../ui/toast';
import SearchIntegration from '../../components/SearchIntegration';
import UpdatesSection from '../../components/UpdatesSection';
import PluginsAdmin from '../../components/PluginsAdmin';
import ServerUsers from './ServerUsers';
import ServerMaintenance from './ServerMaintenance';
import MaintenanceModeCard from './MaintenanceModeCard';
import SharedProvidersCard from './SharedProvidersCard';
import AttachmentAdminCard from './AttachmentAdminCard';
import QuotaAdminCard from './QuotaAdminCard';
import { PageFrame, Section } from './common';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface LoadState<T> {
  data: T | null;
  err: string | null;
  loading: boolean;
  retry: () => void;
  setData: (d: T) => void;
}

/** Loads with `fn`. Reloads when `deps` change; keeps the previous data while reloading. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => { if (alive) { setData(d); setErr(null); setLoading(false); } },
      (e) => { if (alive) { setErr(msgOf(e)); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [tick, ...deps]);
  const retry = useCallback(() => setTick((x) => x + 1), []);
  return { data, err, loading, retry, setData };
}

function Card({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const th = useThemeDef();
  return <View style={[styles.card, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(12), borderWidth: th.bw }]}>{children}</View>;
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.danger, fontSize: 14, fontWeight: '600' }}>{tr('admin.server.loadFailed')}</Text>
      <Hint danger>{message}</Hint>
      <View style={{ alignSelf: 'flex-start' }}><Btn small label={tr('admin.server.retry')} onPress={onRetry} /></View>
    </View>
  );
}

/** Shows loading / error states until the data exists. A failed reload keeps the data and adds a retry row. */
function Loadable<T>({ load, children }: { load: LoadState<T>; children: (d: T) => React.ReactNode }) {
  const t = useTheme();
  const tr = useT();
  if (load.data === null) {
    if (load.err) return <ErrorRow message={load.err} onRetry={load.retry} />;
    return <Text style={{ color: t.sub, fontSize: 14 }}>{tr('admin.server.loading')}</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      {load.err ? <ErrorRow message={load.err} onRetry={load.retry} /> : null}
      {children(load.data)}
    </View>
  );
}

function uptimeText(sec: number, tr: (k: string, v?: Record<string, number>) => string): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return tr('admin.server.uptime.dh', { d, h });
  if (h > 0) return tr('admin.server.uptime.hm', { h, m });
  return tr('admin.server.uptime.m', { m });
}

function OverviewStrip({ ov }: { ov: AdminOverview }) {
  const t = useTheme();
  const tr = useT();
  const stats: [string, string][] = [
    [tr('admin.server.name'), ov.server.name || '-'],
    [tr('admin.server.version'), ov.server.version],
    [tr('admin.server.uptime'), uptimeText(ov.server.uptimeSec, tr)],
    [tr('admin.server.usersStat'), tr('admin.server.usersCount', { total: ov.users.total, admins: ov.users.admins })],
    [tr('admin.server.installType'), ov.server.installType],
    [tr('admin.server.supervised'), ov.server.supervised ? tr('admin.server.yes') : tr('admin.server.no')],
  ];
  return (
    <Card>
      <View style={styles.statRow}>
        {stats.map(([label, value]) => (
          <View key={label} style={styles.stat}>
            <Text style={{ color: t.sub, fontSize: 12 }}>{label}</Text>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{value}</Text>
          </View>
        ))}
      </View>
      {ov.restartPending ? <Text style={{ color: t.warn, fontSize: 13 }}>{tr('admin.server.restartPending')}</Text> : null}
    </Card>
  );
}

/** Editable General form. Mounted only after the settings load, so its drafts start from the server values. */
function GeneralForm({ initial, onSaved }: { initial: AdminGeneral; onSaved: (g: AdminGeneral) => void }) {
  const t = useTheme();
  const tr = useT();
  const [name, setName] = useState(initial.serverName);
  const [desc, setDesc] = useState(initial.serverDescription);
  const [allowReg, setAllowReg] = useState(initial.allowRegistration);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const id = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(id);
  }, [justSaved]);

  const nameErr = validateServerName(name);
  const descErr = validateServerDescription(desc);
  const dirty = name.trim() !== initial.serverName || desc.trim() !== initial.serverDescription || allowReg !== initial.allowRegistration;
  const canSave = dirty && !nameErr && !descErr && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await adminApi.putSettings({ serverName: name.trim(), serverDescription: desc.trim(), allowRegistration: allowReg });
      onSaved(r.general);
      setJustSaved(true);
      toast(tr('admin.server.saved'), 'ok');
    } catch (e) {
      setSaveErr(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  const regHint = initial.allowRegistrationSource === 'env' ? tr('admin.server.allowRegEnv') : tr('admin.server.allowRegDb');
  const btnLabel = saving ? tr('admin.server.saving') : justSaved && !dirty ? tr('admin.server.saved') : tr('admin.server.save');

  return (
    <View style={{ gap: 10 }}>
      <Field label={tr('admin.server.serverName')} value={name} onChangeText={setName} />
      {nameErr ? <Hint danger>{tr(nameErr)}</Hint> : null}
      <Field label={tr('admin.server.serverDesc')} value={desc} onChangeText={setDesc} multiline minHeight={80} />
      {descErr ? <Hint danger>{tr(descErr)}</Hint> : null}
      <Check label={tr('admin.server.allowReg')} value={allowReg} onChange={setAllowReg} hint={regHint} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Btn primary disabled={!canSave} onPress={save} label={btnLabel} />
        {saveErr ? <Text style={{ color: t.danger, fontSize: 13, flexShrink: 1 }}>{`${tr('admin.server.saveFailed')} ${saveErr}`}</Text> : null}
      </View>
    </View>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.kv}>
      <Text style={{ color: t.sub, fontSize: 13 }}>{label}</Text>
      <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{children}</View>
    </View>
  );
}

function NetworkCard({ n }: { n: AdminNetwork }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const exposureLabel = n.exposure === 'all' ? tr('admin.server.exp.all') : n.exposure === 'lan' ? tr('admin.server.exp.lan') : tr('admin.server.exp.loopback');
  const badge = n.exposure === 'all' ? t.warn : t.good;
  const origins = n.corsOrigins.length ? n.corsOrigins.join(', ') : tr('admin.server.corsAny');
  return (
    <Card>
      <KV label={tr('admin.server.address')}><Text style={{ color: t.text, fontSize: 14 }}>{`${n.host}:${n.port}`}</Text></KV>
      <KV label={tr('admin.server.exposure')}>
        <View style={{ borderWidth: th.bw, borderColor: badge, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text style={{ color: badge, fontSize: 13, fontWeight: '600' }}>{exposureLabel}</Text>
        </View>
      </KV>
      <KV label={tr('admin.server.trustProxy')}><Text style={{ color: t.text, fontSize: 14 }}>{n.trustProxy ? tr('admin.server.yes') : tr('admin.server.no')}</Text></KV>
      <KV label={tr('admin.server.cors')}><Text style={{ color: t.text, fontSize: 14, textAlign: 'right' }}>{origins}</Text></KV>
      {n.tlsHint ? <Hint>{n.tlsHint}</Hint> : null}
      <Hint>{tr('admin.server.networkHint')}</Hint>
    </Card>
  );
}

/** Turns a dotted action such as "settings.serverName" into readable text. */
function humanAction(a: string): string {
  const s = a
    .split('.')
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase())
    .join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function AuditList({ entries, none }: { entries: AdminAuditEntry[]; none: string }) {
  const t = useTheme();
  const tr = useT();
  if (entries.length === 0) return <Text style={{ color: t.sub, fontSize: 14 }}>{tr('admin.server.auditEmpty')}</Text>;
  const v = (s: string | null) => (s === null ? none : s);
  return (
    <View>
      {entries.map((e, i) => (
        <View key={e.id} style={[styles.auditRow, i > 0 && { borderTopWidth: 1, borderTopColor: t.border }]}>
          <Text style={{ color: t.sub, fontSize: 12 }}>{`${new Date(e.at).toLocaleString()} · ${e.actor}`}</Text>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{humanAction(e.action)}</Text>
          <Text style={{ color: t.sub, fontSize: 12 }}>{e.key}</Text>
          <Text style={{ color: t.text, fontSize: 13 }}>{`${v(e.oldValue)} → ${v(e.newValue)}`}</Text>
        </View>
      ))}
    </View>
  );
}

/** Settings > Server: overview, general settings, web search, updates, users, network, maintenance and recent changes. */
export default function ServerPage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const [bump, setBump] = useState(0);
  const onChanged = useCallback(() => setBump((b) => b + 1), []);

  const overview = useLoad(() => adminApi.overview(), [bump]);
  const gen = useLoad(() => adminApi.settings().then((r) => r.general), []);
  const net = useLoad(() => adminApi.network(), []);
  const audit = useLoad(() => adminApi.audit(30).then((r) => r.entries), [bump]);
  const { setData: setGen } = gen;

  const onGeneralSaved = useCallback((g: AdminGeneral) => {
    setGen(g);
    setBump((b) => b + 1);
  }, [setGen]);

  return (
    <PageFrame title={tr('settings.page.server')} onBack={onBack}>
      <Section title={tr('admin.server.overview')} first />
      <Loadable load={overview}>{(ov) => <OverviewStrip ov={ov} />}</Loadable>

      <Section title={tr('admin.server.general')} />
      <Card>
        <Loadable load={gen}>{(g) => <GeneralForm initial={g} onSaved={onGeneralSaved} />}</Loadable>
      </Card>
      <Hint>{tr('admin.server.perUserHint')}</Hint>

      <Section title={tr('maint.title')} />
      <Card>
        <MaintenanceModeCard />
      </Card>

      <Section title={tr('shared.card.title')} />
      <Card>
        <SharedProvidersCard />
      </Card>
      <Section title={tr('quota.admin.title')} />
      <Card>
        <QuotaAdminCard />
      </Card>
      <Section title={tr('attach.admin.title')} />
      <Card>
        <AttachmentAdminCard />
      </Card>

      <Section title={tr('admin.server.search')} />
      <SearchIntegration />

      <Section title={tr('admin.server.updates')} />
      <UpdatesSection />

      <Section title={tr('admin.server.usersTitle')} />
      <ServerUsers onChanged={onChanged} />

      <Section title={tr('admin.server.network')} />
      <Loadable load={net}>{(n) => <NetworkCard n={n} />}</Loadable>

      <Section title={tr('admin.server.maintenance')} />
      <ServerMaintenance onChanged={onChanged} />

      <Section title={tr('plugins.admin.title')} />
      <PluginsAdmin onChanged={onChanged} />

      <Section title={tr('admin.server.audit')} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn small label={tr('admin.server.refresh')} onPress={audit.retry} />
        </View>
        <Loadable load={audit}>{(entries) => <AuditList entries={entries} none={tr('admin.server.none')} />}</Loadable>
      </Card>
    </PageFrame>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 10 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: { flexBasis: 140, flexGrow: 1, gap: 2 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 },
  auditRow: { paddingVertical: 8, gap: 2 },
});
