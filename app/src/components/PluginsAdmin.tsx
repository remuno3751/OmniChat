// Settings > Server > Plugins (admin only): list, enable/disable, check updates, remove, and the GitHub install
// with a security review step (docs/PROTOCOL-v7-plugins.md). The review is a hint; the admin types the plugin id to confirm.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Switch, Text, View } from 'react-native';
import { ApiError, getIsAdmin } from '../api';
import { pluginsApi, type CheckUpdateResult, type InspectResult, type PluginDiff, type PluginFinding, type PluginRow } from '../apiPlugins';
import { useT, type Vars } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Field, Hint } from '../ui/kit';
import { confirmDialog } from '../ui/confirm';
import { toast } from '../ui/toast';
import {
  KNOWN_PERMISSIONS, confirmMatches, countFindings, diffIsEmpty, formatBytes, groupFindings, normalizeRepo,
  normalizeSubdir, optionalText, shortSha, SEVERITY_ORDER,
} from '../pluginsAdminLogic';

type Tr = (key: string, vars?: Vars) => string;

/** A checked plugin waiting for the admin's confirmation. `insp` is the inspection (install) or the update check. */
interface Review {
  mode: 'install' | 'update';
  inspectionId: string;
  insp: Omit<InspectResult, 'inspectionId'>;
  diff?: PluginDiff;
}

/** Shows a known server error code in the admin's language, otherwise the server's own message. */
function errText(e: unknown, tr: Tr): string {
  if (e instanceof ApiError && e.code) {
    const k = `plugins.err.${e.code}`;
    const s = tr(k);
    if (s !== k) return s;
  }
  return e instanceof Error ? e.message : String(e);
}

const permLabel = (p: string, tr: Tr) => {
  if ((KNOWN_PERMISSIONS as readonly string[]).includes(p)) return tr(`plugins.perm.${p}`);
  return p;
};

const ruleLabel = (rule: string, tr: Tr) => {
  const k = `plugins.rule.${rule}`;
  const s = tr(k);
  return s === k ? rule : s;
};

const severityLabel = (s: string, tr: Tr) => {
  const k = `plugins.review.severity.${s}`;
  const v = tr(k);
  return v === k ? s : v;
};

const listText = (items: string[]) => items.join(', ');

/** Small bordered label (source badge, permission chip). */
function Chip({ label, danger, warn }: { label: string; danger?: boolean; warn?: boolean }) {
  const t = useTheme();
  const color = danger ? t.danger : warn ? t.warn : t.sub;
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, marginRight: 6, marginTop: 4 }}>
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function Mono({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text
      selectable
      style={{
        color: t.text, fontSize: 12, lineHeight: 17, marginTop: 4, padding: 8, borderRadius: 6,
        backgroundColor: t.input, borderWidth: 1, borderColor: t.border,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
      }}
    >
      {children}
    </Text>
  );
}

function FindingRow({ f, tr }: { f: PluginFinding; tr: Tr }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{`${ruleLabel(f.rule, tr)} (${f.rule})`}</Text>
      <Text style={{ color: t.sub, fontSize: 12 }}>{`${f.file}:${f.line}`}</Text>
      {!!f.snippet && <Mono>{f.snippet}</Mono>}
    </View>
  );
}

/** Security review panel: install preview or update diff, then the typed-id confirmation. */
function ReviewPanel({ review, busy, onInstall, onCancel, typed, setTyped, tr }: {
  review: Review; busy: boolean; onInstall: () => void; onCancel: () => void;
  typed: string; setTyped: (s: string) => void; tr: Tr;
}) {
  const t = useTheme();
  const m = review.insp.manifest;
  const src = review.insp.source;
  const grouped = groupFindings(review.insp.scan.findings);
  const counts = countFindings(review.insp.scan.findings);
  const mismatches = review.insp.scan.permissionMismatch;
  const d = review.diff;
  const canInstall = confirmMatches(m.id, typed) && !busy;
  const title = review.mode === 'update'
    ? tr('plugins.review.titleUpdate', { name: m.name, version: m.version })
    : tr('plugins.review.titleInstall', { name: m.name, version: m.version });

  return (
    <View style={{ marginTop: 12, gap: 10 }}>
      <View style={{ borderWidth: 2, borderColor: t.danger, borderRadius: 10, padding: 12, backgroundColor: t.danger + '1A' }}>
        <Text style={{ color: t.danger, fontSize: 14, fontWeight: '700' }}>{tr('plugins.review.warnTitle')}</Text>
        <Text style={{ color: t.text, fontSize: 14, lineHeight: 20, marginTop: 4 }}>{tr('plugins.review.warn')}</Text>
      </View>

      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
      {review.insp.alreadyInstalled ? <Hint>{tr('plugins.review.alreadyInstalled')}</Hint> : null}

      <View>
        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('plugins.review.source')}</Text>
        <Text selectable style={{ color: t.text, fontSize: 14 }}>{`${src.repo}${src.ref ? ` @ ${src.ref}` : ''}`}</Text>
        <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{tr('plugins.review.commit')}</Text>
        <Text selectable style={{ color: t.text, fontSize: 13, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }}>{src.commitSha}</Text>
        {!!src.subdir && <Hint>{tr('plugins.review.subdir', { subdir: src.subdir })}</Hint>}
        <Text style={{ color: t.text, fontSize: 13, marginTop: 4 }}>{`${m.description || ''}`.trim()}</Text>
      </View>

      {d ? (
        <View>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tr('plugins.review.diff')}</Text>
          {diffIsEmpty(d) ? <Hint>{tr('plugins.review.noChanges')}</Hint> : null}
          {!!d.added.length && <Text style={{ color: t.text, fontSize: 13 }}>{`${tr('plugins.review.added')}: ${listText(d.added)}`}</Text>}
          {!!d.removed.length && <Text style={{ color: t.text, fontSize: 13 }}>{`${tr('plugins.review.removed')}: ${listText(d.removed)}`}</Text>}
          {!!d.changed.length && <Text style={{ color: t.text, fontSize: 13 }}>{`${tr('plugins.review.changed')}: ${listText(d.changed)}`}</Text>}
          {!!d.toolsAdded.length && <Text style={{ color: t.text, fontSize: 13 }}>{tr('plugins.review.toolsAdded', { list: listText(d.toolsAdded) })}</Text>}
          {!!d.toolsRemoved.length && <Text style={{ color: t.text, fontSize: 13 }}>{tr('plugins.review.toolsRemoved', { list: listText(d.toolsRemoved) })}</Text>}
          {!!d.permissionsAdded.length && (
            <View style={{ marginTop: 4 }}>
              <Text style={{ color: t.danger, fontSize: 13, fontWeight: '700' }}>
                {tr('plugins.review.permissionsAdded', { list: d.permissionsAdded.map((p) => `${p.tool}: ${permLabel(p.permission, tr)}`).join(', ') })}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      <View>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tr('plugins.review.tools')}</Text>
        {m.tools.map((tool) => (
          <View key={tool.name} style={{ marginTop: 6 }}>
            <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{tool.name}</Text>
            {!!tool.description && <Text style={{ color: t.sub, fontSize: 12 }}>{tool.description}</Text>}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {tool.permissions.length
                ? tool.permissions.map((p) => <Chip key={p} label={permLabel(p, tr)} danger={!!d?.permissionsAdded.some((x) => x.tool === tool.name && x.permission === p)} />)
                : <Chip label={tr('plugins.review.noPerms')} />}
            </View>
          </View>
        ))}
      </View>

      {mismatches.length ? (
        <View style={{ borderWidth: 1, borderColor: t.warn, borderRadius: 8, padding: 10 }}>
          <Text style={{ color: t.warn, fontSize: 14, fontWeight: '700' }}>{tr('plugins.review.mismatchTitle')}</Text>
          {mismatches.map((mm, i) => (
            <Text key={`${mm.tool}-${i}`} style={{ color: t.text, fontSize: 13, marginTop: 4 }}>
              {tr('plugins.review.mismatch', {
                tool: mm.tool,
                used: listText(mm.used.map((p) => permLabel(p, tr))) || tr('plugins.review.none'),
                declared: listText(mm.declared.map((p) => permLabel(p, tr))) || tr('plugins.review.none'),
              })}
            </Text>
          ))}
        </View>
      ) : null}

      <View>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tr('plugins.review.findings')}</Text>
        {review.insp.scan.findings.length === 0 ? <Hint>{tr('plugins.review.noFindings')}</Hint> : null}
        {SEVERITY_ORDER.map((sev) => grouped[sev].length ? (
          <View key={sev} style={{ marginTop: 6 }}>
            <Text style={{ color: sev === 'high' ? t.danger : sev === 'medium' ? t.warn : t.sub, fontSize: 13, fontWeight: '700' }}>
              {`${severityLabel(sev, tr)} (${counts[sev]})`}
            </Text>
            {grouped[sev].map((f, i) => <FindingRow key={`${f.file}:${f.line}:${i}`} f={f} tr={tr} />)}
          </View>
        ) : null)}
        <Hint>{tr('plugins.review.scanNote')}</Hint>
      </View>

      <View>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tr('plugins.review.files', { n: review.insp.files.length, size: formatBytes(review.insp.totalBytes) })}</Text>
        {review.insp.files.map((f) => (
          <View key={f.path} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
            <Text selectable style={{ color: t.text, fontSize: 12, flexShrink: 1 }}>{f.path}</Text>
            <Text style={{ color: t.sub, fontSize: 12, marginLeft: 8 }}>{formatBytes(f.size)}</Text>
          </View>
        ))}
      </View>

      {review.insp.warnings.length ? (
        <View>
          <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{tr('plugins.review.notes')}</Text>
          {review.insp.warnings.map((w, i) => <Text key={i} style={{ color: t.warn, fontSize: 13, marginTop: 2 }}>{w}</Text>)}
        </View>
      ) : null}

      <Field
        label={tr('plugins.review.confirmLabel', { id: m.id })}
        value={typed}
        onChangeText={setTyped}
        placeholder={m.id}
        mono
      />
      <Hint>{tr('plugins.review.confirmHint')}</Hint>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        <Btn
          label={review.mode === 'update' ? tr('plugins.review.installUpdate') : tr('plugins.review.install')}
          primary
          disabled={!canInstall}
          onPress={onInstall}
        />
        <Btn label={tr('common.cancel')} onPress={onCancel} disabled={busy} />
      </View>
    </View>
  );
}

function PluginCard({ p, busy, onToggle, onCheck, onRemove, tr }: {
  p: PluginRow; busy: string | null; onToggle: (p: PluginRow, v: boolean) => void;
  onCheck: (p: PluginRow) => void; onRemove: (p: PluginRow) => void; tr: Tr;
}) {
  const t = useTheme();
  const local = p.source !== 'github';
  const anyBusy = busy !== null;
  return (
    <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, marginTop: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{p.name || p.id}</Text>
        <Text style={{ color: t.sub, fontSize: 13 }}>{p.version ? `v${p.version}` : ''}</Text>
        <Chip label={tr(`plugins.source.${local ? 'local' : 'github'}`)} />
      </View>
      {!local && (
        <Text selectable style={{ color: t.sub, fontSize: 12 }}>
          {`${p.repo || ''}${p.commitSha ? `@${shortSha(p.commitSha)}` : ''}`}
        </Text>
      )}
      {local ? <Hint>{tr('plugins.source.localNote')}</Hint> : null}
      {!!p.description && <Text style={{ color: t.text, fontSize: 13 }}>{p.description}</Text>}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={{ color: t.text, fontSize: 14 }}>{tr('plugins.enabled')}</Text>
        <Switch
          value={p.enabled}
          disabled={local || anyBusy}
          onValueChange={(v) => onToggle(p, v)}
          accessibilityLabel={tr('plugins.enabled')}
        />
      </View>

      {p.modified ? <Text style={{ color: t.danger, fontSize: 13, fontWeight: '600' }}>{tr('plugins.modified')}</Text> : null}

      <Text style={{ color: t.text, fontSize: 13, marginTop: 4 }}>{tr('plugins.tools')}</Text>
      {p.tools.map((tool) => (
        <View key={tool.name} style={{ marginTop: 2 }}>
          <Text style={{ color: tool.available ? t.text : t.sub, fontSize: 13 }}>{tool.name}</Text>
          {!tool.available && !!tool.error ? <Text style={{ color: t.sub, fontSize: 12 }}>{tool.error}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {tool.permissions.map((perm) => <Chip key={perm} label={permLabel(perm, tr)} warn={(KNOWN_PERMISSIONS as readonly string[]).includes(perm)} />)}
          </View>
        </View>
      ))}

      {p.scan ? <Hint>{tr('plugins.scan', { high: p.scan.high, medium: p.scan.medium, info: p.scan.info })}</Hint> : null}

      {!local && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <Btn
            small
            label={busy === `check:${p.id}` ? tr('plugins.working') : tr('plugins.checkUpdate')}
            disabled={anyBusy}
            onPress={() => onCheck(p)}
          />
          <Btn small danger label={tr('plugins.remove')} disabled={anyBusy} onPress={() => onRemove(p)} />
        </View>
      )}
    </View>
  );
}

export default function PluginsAdmin({ onChanged }: { onChanged?: () => void }) {
  const t = useTheme();
  const tr = useT();
  const [plugins, setPlugins] = useState<PluginRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [subdir, setSubdir] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    pluginsApi.list().then(
      (r) => { if (alive) { setPlugins(r); setLoadErr(null); } },
      (e) => { if (alive) setLoadErr(errText(e, tr)); },
    );
    return () => { alive = false; };
  }, [tick, tr]);

  const reload = useCallback(() => setTick((x) => x + 1), []);

  const onInspect = async () => {
    setFormErr(null); setNotice(null); setActionErr(null);
    const r = normalizeRepo(repo);
    if (!r.ok) { setFormErr(tr(r.reason === 'empty' ? 'plugins.form.repoEmpty' : 'plugins.form.repoBad')); return; }
    const sd = normalizeSubdir(subdir);
    if (sd === null) { setFormErr(tr('plugins.form.subdirBad')); return; }
    const body = {
      source: 'github' as const,
      repo: r.repo,
      ...(optionalText(ref) ? { ref: optionalText(ref) } : {}),
      ...(sd ? { subdir: sd } : {}),
    };
    setBusy('inspect');
    try {
      const insp = await pluginsApi.inspect(body);
      setTyped('');
      setReview({ mode: 'install', inspectionId: insp.inspectionId, insp });
    } catch (e) {
      setFormErr(errText(e, tr));
    } finally {
      setBusy(null);
    }
  };

  const onCheck = async (p: PluginRow) => {
    setNotice(null); setActionErr(null); setBusy(`check:${p.id}`);
    try {
      const r: CheckUpdateResult = await pluginsApi.checkUpdate(p.id);
      if (r.updateAvailable && r.inspectionId && r.manifest && r.source && r.scan && r.files) {
        setTyped('');
        setReview({
          mode: 'update',
          inspectionId: r.inspectionId,
          insp: r as Omit<InspectResult, 'inspectionId'>,
          diff: r.diff,
        });
      } else {
        setNotice(tr('plugins.upToDate', { name: p.name || p.id }));
      }
    } catch (e) {
      setActionErr(errText(e, tr));
    } finally {
      setBusy(null);
    }
  };

  const onInstall = async () => {
    if (!review || !confirmMatches(review.insp.manifest.id, typed)) return;
    setActionErr(null); setBusy('install');
    try {
      const { plugin } = await pluginsApi.install(review.inspectionId, review.insp.manifest.id);
      setReview(null); setTyped('');
      const name = plugin?.name || review.insp.manifest.name;
      setNotice(tr(plugin?.enabled ? 'plugins.updatedNotice' : 'plugins.installedNotice', { name }));
      reload();
      onChanged?.();
    } catch (e) {
      // an expired or used inspection cannot be retried: close the review so the admin inspects again
      if (e instanceof ApiError && (e.code === 'inspection_expired')) setReview(null);
      setActionErr(errText(e, tr));
    } finally {
      setBusy(null);
    }
  };

  const onToggle = async (p: PluginRow, enabled: boolean) => {
    setActionErr(null); setNotice(null); setBusy(`toggle:${p.id}`);
    try {
      await pluginsApi.setEnabled(p.id, enabled);
      reload();
      onChanged?.();
    } catch (e) {
      setActionErr(errText(e, tr));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async (p: PluginRow) => {
    const ok = await confirmDialog(
      tr('plugins.removeTitle'),
      tr('plugins.removeBody', { name: p.name || p.id }),
      tr('plugins.remove'),
      true,
    );
    if (!ok) return;
    setActionErr(null); setNotice(null); setBusy(`remove:${p.id}`);
    try {
      await pluginsApi.remove(p.id);
      toast(tr('plugins.removed'), 'ok');
      reload();
      onChanged?.();
    } catch (e) {
      setActionErr(errText(e, tr));
    } finally {
      setBusy(null);
    }
  };

  // admin-only (the Server page is admin-only too); checked after the hooks
  if (!getIsAdmin()) return null;

  const anyBusy = busy !== null;
  return (
    <View>
      <Hint>{tr('plugins.admin.intro')}</Hint>
      {notice ? <Text style={{ color: t.text, fontSize: 13, marginTop: 8, fontWeight: '600' }}>{notice}</Text> : null}
      {actionErr ? <Hint danger>{actionErr}</Hint> : null}

      {loadErr ? <Hint danger>{loadErr}</Hint>
        : plugins === null ? <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />
        : plugins.length === 0 ? <Hint>{tr('plugins.admin.empty')}</Hint>
        : plugins.map((p) => (
          <PluginCard
            key={p.id}
            p={p}
            busy={busy}
            onToggle={onToggle}
            onCheck={onCheck}
            onRemove={onRemove}
            tr={tr}
          />
        ))}

      <View style={{ borderTopWidth: 1, borderColor: t.border, marginTop: 16, paddingTop: 12 }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{tr('plugins.form.title')}</Text>
        {review ? (
          <ReviewPanel
            review={review}
            busy={anyBusy}
            onInstall={onInstall}
            onCancel={() => { setReview(null); setTyped(''); }}
            typed={typed}
            setTyped={setTyped}
            tr={tr}
          />
        ) : (
          <View style={{ gap: 10, marginTop: 8 }}>
            <Field label={tr('plugins.form.repo')} value={repo} onChangeText={setRepo} placeholder="owner/name" mono />
            <Field label={tr('plugins.form.ref')} value={ref} onChangeText={setRef} mono />
            <Field label={tr('plugins.form.subdir')} value={subdir} onChangeText={setSubdir} mono />
            {formErr ? <Hint danger>{formErr}</Hint> : null}
            <View style={{ flexDirection: 'row' }}>
              <Btn
                label={busy === 'inspect' ? tr('plugins.form.inspecting') : tr('plugins.form.inspect')}
                primary
                disabled={anyBusy}
                onPress={onInspect}
              />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}
