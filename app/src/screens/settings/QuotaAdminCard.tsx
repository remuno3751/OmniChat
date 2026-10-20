// Settings > Server > Usage limits (PROTOCOL-v7-quotas): the defaults for every ordinary user, and per-user overrides.
// Uses GET/PUT /admin/quotas and GET /admin/quotas/users (admin only). Keys and URLs are never involved.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { adminApi } from '../../apiAdmin';
import { useT } from '../../i18n';
import {
  formatTokens, overrideChanged, parseLimitInput, type AdminQuotaUser, type QuotaSettings, type UserQuota,
} from '../../quota';
import { useTheme } from '../../theme';
import { Btn, Check, Field, Hint, Label } from '../../ui/kit';
import { toast } from '../../ui/toast';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Limit as shown in a list: 0 is unlimited. */
const limitText = (n: number | null | undefined, tr: (k: string) => string) => (n === null || n === undefined ? '' : n > 0 ? formatTokens(n) : tr('quota.admin.unlimited'));

interface Drafts { daily: string; monthly: string }

export default function QuotaAdminCard() {
  const t = useTheme();
  const tr = useT();
  const [defaults, setDefaults] = useState<QuotaSettings | null>(null);
  const [users, setUsers] = useState<AdminQuotaUser[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<Drafts>({ daily: '', monthly: '' });
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState<Drafts>({ daily: '', monthly: '' });
  const [userErr, setUserErr] = useState<string | null>(null);

  const load = () => adminApi.quotaUsers()
    .then((r) => {
      setDefaults(r.quotas);
      setEnabled(r.quotas.enabled);
      setForm({ daily: String(r.quotas.dailyTokens), monthly: String(r.quotas.monthlyTokens) });
      setUsers(r.users);
      setLoadErr(null);
    })
    .catch((e) => setLoadErr(msgOf(e)));
  useEffect(() => { void load(); }, []);

  if (loadErr) return <Hint danger>{tr('quota.admin.loadFailed')}</Hint>;
  if (!defaults || !users) return <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />;

  const parsedDefaults = (): QuotaSettings | 'invalid' => {
    const d = parseLimitInput(form.daily, false);
    const m = parseLimitInput(form.monthly, false);
    if (d === 'invalid' || d === null || m === 'invalid' || m === null) return 'invalid';
    return { enabled, dailyTokens: d, monthlyTokens: m };
  };
  const dirty = (() => {
    const p = parsedDefaults();
    return p === 'invalid' || p.enabled !== defaults.enabled || p.dailyTokens !== defaults.dailyTokens || p.monthlyTokens !== defaults.monthlyTokens;
  })();

  const saveDefaults = async () => {
    const p = parsedDefaults();
    if (p === 'invalid') { setFormErr(tr('quota.admin.invalid')); return; }
    setSaving(true);
    setFormErr(null);
    try {
      await adminApi.putQuotas(p);
      toast(tr('quota.admin.saved'), 'ok');
      await load();
    } catch (e) {
      setFormErr(tr('quota.admin.failed', { error: msgOf(e) }));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (u: AdminQuotaUser) => {
    setEditing(u.userId);
    setUserErr(null);
    setUserDraft({
      daily: u.override?.dailyTokens === null || u.override === null ? '' : String(u.override.dailyTokens),
      monthly: u.override?.monthlyTokens === null || u.override === null ? '' : String(u.override.monthlyTokens),
    });
  };

  const saveUser = async (u: AdminQuotaUser) => {
    const d = parseLimitInput(userDraft.daily, true);
    const m = parseLimitInput(userDraft.monthly, true);
    if (d === 'invalid' || m === 'invalid') { setUserErr(tr('quota.admin.invalid')); return; }
    const next: UserQuota = { dailyTokens: d, monthlyTokens: m };
    if (!overrideChanged(u.override, next)) { setEditing(null); return; }
    try {
      await adminApi.putUserQuota(u.userId, next);
      setEditing(null);
      toast(tr('quota.admin.userSaved', { name: u.username }), 'ok');
      await load();
    } catch (e) {
      setUserErr(tr('quota.admin.failed', { error: msgOf(e) }));
    }
  };

  const resetToDefault = async (u: AdminQuotaUser) => {
    try {
      await adminApi.deleteUserQuota(u.userId);
      setEditing(null);
      toast(tr('quota.admin.userSaved', { name: u.username }), 'ok');
      await load();
    } catch (e) {
      setUserErr(tr('quota.admin.failed', { error: msgOf(e) }));
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Hint>{tr('quota.admin.hint')}</Hint>
      <Check label={tr('quota.admin.enabled')} value={enabled} onChange={setEnabled} hint={tr('quota.admin.enabledHint')} />
      <Field label={tr('quota.admin.daily')} value={form.daily} onChangeText={(v) => setForm((f) => ({ ...f, daily: v }))} keyboardType="numeric" />
      <Field label={tr('quota.admin.monthly')} value={form.monthly} onChangeText={(v) => setForm((f) => ({ ...f, monthly: v }))} keyboardType="numeric" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Btn primary disabled={!dirty || saving} onPress={saveDefaults} label={tr('quota.admin.save')} />
        {formErr ? <Text style={{ color: t.danger, fontSize: 13, flexShrink: 1 }}>{formErr}</Text> : null}
      </View>

      <Label>{tr('quota.admin.usersTitle')}</Label>
      <Hint>{tr('quota.admin.usersHint')}</Hint>
      {users.length === 0 ? <Hint>{tr('quota.admin.none')}</Hint> : null}
      {users.map((u) => {
        const o = u.override;
        const isEditing = editing === u.userId;
        return (
          <View key={u.userId} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderColor: t.input }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{u.username}</Text>
              {u.isAdmin ? <Text style={{ color: t.sub, fontSize: 11 }}>{tr('quota.admin.admin')}</Text> : null}
            </View>
            <Text style={{ color: t.sub, fontSize: 12 }}>
              {tr('quota.admin.today', { used: formatTokens(u.usedToday) })} · {tr('quota.admin.month', { used: formatTokens(u.usedThisMonth) })}
            </Text>
            <Text style={{ color: t.sub, fontSize: 12 }}>
              {o ? tr('quota.admin.override') : tr('quota.admin.default')}
              {' · '}{tr('quota.admin.dayField')}: {limitText(u.limits.daily ?? 0, tr)}
              {' · '}{tr('quota.admin.monthField')}: {limitText(u.limits.monthly ?? 0, tr)}
            </Text>
            {isEditing ? (
              <View style={{ gap: 8 }}>
                <Field label={tr('quota.admin.dayField')} value={userDraft.daily} onChangeText={(v) => setUserDraft((d) => ({ ...d, daily: v }))} keyboardType="numeric" placeholder={tr('quota.admin.default')} />
                <Field label={tr('quota.admin.monthField')} value={userDraft.monthly} onChangeText={(v) => setUserDraft((d) => ({ ...d, monthly: v }))} keyboardType="numeric" placeholder={tr('quota.admin.default')} />
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Btn small primary label={tr('quota.admin.saveUser')} onPress={() => saveUser(u)} />
                  <Btn small label={tr('quota.admin.cancel')} onPress={() => setEditing(null)} />
                  {o ? <Btn small label={tr('quota.admin.useDefault')} onPress={() => resetToDefault(u)} /> : null}
                </View>
                {userErr ? <Text style={{ color: t.danger, fontSize: 12 }}>{userErr}</Text> : null}
              </View>
            ) : (
              <View style={{ flexDirection: 'row' }}>
                <Btn small label={tr('quota.admin.edit')} onPress={() => startEdit(u)} />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
