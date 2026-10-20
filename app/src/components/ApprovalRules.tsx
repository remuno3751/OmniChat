import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { uuid } from '../api';
import { apiV4 } from '../apiV4';
import type { ApprovalRule } from '../protocol';
import { useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Label, Segmented } from '../ui/kit';
import { toast } from '../ui/toast';
import Icon from './Icon';

type Kind = ApprovalRule['kind'];
type Action = ApprovalRule['action'];
const KINDS: Kind[] = ['tool', 'command', 'path'];
const ACTIONS: Action[] = ['allow', 'deny', 'ask'];
const PATTERN_MAX = 300;
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Settings > Code > Rules: list, edit, delete and add approval rules (global and per project). */
export default function ApprovalRules() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const projects = useStore((s) => s.projects);
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>('tool');
  const [action, setAction] = useState<Action>('ask');
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await apiV4.approvalRules());
    } catch (e: any) {
      toast(e?.message || tr('code.loadFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  const changeAction = async (r: ApprovalRule, next: Action) => {
    if (next === r.action) return;
    const prev = rules;
    setRules((list) => (list || []).map((x) => (x.id === r.id ? { ...x, action: next } : x)));
    try {
      await apiV4.putApprovalRule(r.id, { projectId: r.projectId, kind: r.kind, pattern: r.pattern, action: next, note: r.note });
    } catch (e: any) {
      setRules(prev);
      toast(e?.message || tr('code.saveFailed'), 'error');
    }
  };

  const remove = async (r: ApprovalRule) => {
    const ok = await confirmDialog(tr('code.ruleDelete'), tr('code.ruleDeleteMsg', { pattern: r.pattern }), tr('common.delete'));
    if (!ok) return;
    try {
      await apiV4.deleteApprovalRule(r.id);
      setRules((list) => (list || []).filter((x) => x.id !== r.id));
      toast(tr('code.ruleDeleted'), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('code.saveFailed'), 'error');
    }
  };

  const add = async () => {
    const p = pattern.trim();
    if (!p) { setFormErr(tr('code.rulePatternRequired')); return; }
    if (p.length > PATTERN_MAX) { setFormErr(tr('code.rulePatternTooLong')); return; }
    setFormErr('');
    setBusy(true);
    try {
      await apiV4.putApprovalRule(uuid(), { projectId: null, kind, pattern: p, action, note: note.trim() || null });
      setPattern('');
      setNote('');
      toast(tr('code.ruleAdded'), 'ok');
      await load();
    } catch (e: any) {
      toast(e?.message || tr('code.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = (r: ApprovalRule) =>
    r.projectId ? tr('code.rulesProject', { name: projects[r.projectId]?.name ?? r.projectId }) : tr('code.rulesGlobal');

  const list = rules || [];

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Hint>{tr('code.rulesHint')}</Hint>
        <View style={{ flex: 1 }} />
        <Btn small label={tr('common.refresh')} onPress={() => { void load(); }} disabled={loading} />
      </View>

      {rules !== null && list.length === 0 && <Hint>{tr('code.rulesEmpty')}</Hint>}
      {rules === null && loading && <Hint>{tr('code.loading')}</Hint>}

      {list.map((r) => (
        <View key={r.id} style={[styles.row, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(10) }]}>
          <View style={styles.rowTop}>
            <View style={[styles.badge, { borderColor: t.accent, borderRadius: th.r(4) }]}>
              <Text style={{ color: t.accentInk, fontSize: 11, fontWeight: '700' }}>{tr(`code.kind.${r.kind}`)}</Text>
            </View>
            <Text style={{ flex: 1, color: t.sub, fontSize: 12 }} numberOfLines={1}>{scopeLabel(r)}</Text>
            <Pressable onPress={() => { void remove(r); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.delete')}>
              <Icon name="close" size={18} color={t.danger} />
            </Pressable>
          </View>
          <Text selectable style={{ color: t.text, fontFamily: mono, fontSize: 13 }}>{r.pattern}</Text>
          <Segmented
            options={ACTIONS.map((a) => ({ value: a, label: tr(`code.action.${a}`) }))}
            value={r.action}
            onChange={(v) => { void changeAction(r, v); }}
          />
          {!!r.note && <Hint>{r.note}</Hint>}
        </View>
      ))}

      <View style={[styles.form, { borderColor: t.border, borderRadius: th.r(10) }]}>
        <Text style={{ color: t.text, fontSize: 14, fontWeight: '700' }}>{tr('code.addRule')}</Text>
        <Label>{tr('code.ruleKind')}</Label>
        <Segmented options={KINDS.map((k) => ({ value: k, label: tr(`code.kind.${k}`) }))} value={kind} onChange={setKind} />
        <Field
          label={tr('code.rulePattern')}
          value={pattern}
          onChangeText={(v) => { setPattern(v); if (formErr) setFormErr(''); }}
          placeholder={kind === 'tool' ? 'bash' : 'git push*'}
          mono
          onSubmit={() => { void add(); }}
        />
        <Hint danger={!!formErr}>{formErr || tr('code.rulePatternHint')}</Hint>
        <Label>{tr('code.ruleAction')}</Label>
        <Segmented options={ACTIONS.map((a) => ({ value: a, label: tr(`code.action.${a}`) }))} value={action} onChange={setAction} />
        <Field label={tr('code.ruleNote')} value={note} onChangeText={setNote} />
        <View style={{ marginTop: 10 }}>
          <Btn label={tr('code.addRule')} primary onPress={() => { void add(); }} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, padding: 10, gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  form: { borderWidth: 1, padding: 12, marginTop: 6 },
});
