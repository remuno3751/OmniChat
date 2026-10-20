// Server settings card: attachments (PROTOCOL-v7). Admin only. Also the user's own attachment list.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { api, getAdminAttachments, listAttachments, deleteAttachment, putAdminAttachments, type AttachmentMeta, type AttachmentSettings } from '../../api';
import { formatBytes } from '../../attachments';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { Btn, Field, Hint, Label } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../ui/confirm';

const msgOf = (e: any) => (e?.message ? String(e.message) : String(e));

export default function AttachmentAdminCard() {
  const t = useTheme();
  const tr = useT();
  const [cur, setCur] = useState<AttachmentSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Record<keyof AttachmentSettings, string>>({
    maxFileMB: '', quotaMB: '', retentionDays: '', maxPerMessage: '', extractMaxChars: '', transcribeModel: '',
  });
  const [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    getAdminAttachments()
      .then((s) => {
        setCur(s);
        setForm({
          maxFileMB: String(s.maxFileMB), quotaMB: String(s.quotaMB), retentionDays: String(s.retentionDays),
          maxPerMessage: String(s.maxPerMessage), extractMaxChars: String(s.extractMaxChars), transcribeModel: s.transcribeModel ?? '',
        });
      })
      .catch((e) => setErr(msgOf(e)));
    api.models()
      .then((r) => setModels(r.groups.flatMap((g) => g.models.map((m) => ({ value: `${g.providerId}::${m.id}`, label: `${g.providerName} / ${m.name || m.id}` })))))
      .catch(() => setModels([]));
  }, []);

  if (err) return <Hint danger>{tr('attach.admin.unsupported')}</Hint>;
  if (!cur) return <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />;

  const set = (k: keyof AttachmentSettings) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k: keyof AttachmentSettings) => Number(form[k]);
  const days = num('retentionDays');
  const patch = (): Partial<AttachmentSettings> => ({
    maxFileMB: num('maxFileMB'), quotaMB: num('quotaMB'), retentionDays: num('retentionDays'), maxPerMessage: num('maxPerMessage'),
    extractMaxChars: num('extractMaxChars'), transcribeModel: form.transcribeModel.trim() || null,
  });
  const dirty = JSON.stringify(patch()) !== JSON.stringify({
    maxFileMB: cur.maxFileMB, quotaMB: cur.quotaMB, retentionDays: cur.retentionDays, maxPerMessage: cur.maxPerMessage,
    extractMaxChars: cur.extractMaxChars, transcribeModel: cur.transcribeModel ?? null,
  });
  const valid = [num('maxFileMB'), num('quotaMB'), num('retentionDays'), num('maxPerMessage'), num('extractMaxChars')].every((n) => Number.isInteger(n) && n >= 0);

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await putAdminAttachments(patch());
      const next = (r?.attachments ?? r) as AttachmentSettings;
      setCur(next);
      toast(tr('attach.admin.saved'), 'ok');
    } catch (e) {
      setSaveErr(msgOf(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <Hint>{tr('attach.admin.hint')}</Hint>
      <Field label={tr('attach.admin.maxFileMB')} value={form.maxFileMB} onChangeText={set('maxFileMB')} keyboardType="numeric" />
      <Field label={tr('attach.admin.quotaMB')} value={form.quotaMB} onChangeText={set('quotaMB')} keyboardType="numeric" />
      <Field label={tr('attach.admin.retentionDays')} value={form.retentionDays} onChangeText={set('retentionDays')} keyboardType="numeric" />
      <Hint>{days > 0 ? tr('attach.admin.retentionWarn', { n: days }) : tr('attach.admin.retentionForever')}</Hint>
      <Field label={tr('attach.admin.maxPerMessage')} value={form.maxPerMessage} onChangeText={set('maxPerMessage')} keyboardType="numeric" />
      <Field label={tr('attach.admin.extractMaxChars')} value={form.extractMaxChars} onChangeText={set('extractMaxChars')} keyboardType="numeric" />
      <Label>{tr('attach.admin.transcribeModel')}</Label>
      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
        {[{ value: '', label: tr('attach.admin.transcribeNone') }, ...models].map((o) => {
          const on = (form.transcribeModel || '') === o.value;
          return (
            <Pressable key={o.value || 'none'} onPress={() => set('transcribeModel')(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }}
              style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: on ? t.input : 'transparent' }}>
              <Text style={{ color: t.text, fontSize: 13, fontWeight: on ? '700' : '400' }} numberOfLines={2}>{o.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Btn primary disabled={!dirty || !valid || saving} onPress={save} label={saving ? tr('admin.server.saving') : tr('attach.admin.save')} />
        {saveErr ? <Text style={{ color: t.danger, fontSize: 13, flexShrink: 1 }}>{`${tr('admin.server.saveFailed')} ${saveErr}`}</Text> : null}
      </View>
    </View>
  );
}

/** Every user: their own attachments, the space they use, and deleting one. */
export function MyAttachmentsSection() {
  const t = useTheme();
  const tr = useT();
  const [items, setItems] = useState<AttachmentMeta[] | null>(null);
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const [err, setErr] = useState(false);

  const load = () => {
    listAttachments()
      .then((r) => { setItems(r.attachments.filter((a) => a.status !== 'deleted')); setUsage(r.usage); })
      .catch(() => setErr(true));
  };
  useEffect(load, []);

  if (err) return <Hint>{tr('attach.unavailable')}</Hint>;
  if (!items || !usage) return <ActivityIndicator color={t.accentInk} style={{ margin: 12 }} />;

  const remove = async (a: AttachmentMeta) => {
    try { await deleteAttachment(a.id); load(); } catch (e: any) { toast(msgOf(e), 'error'); }
  };
  return (
    <View style={{ gap: 8 }}>
      <Hint>{tr('attach.settings.usage', { count: usage.count, size: formatBytes(usage.bytes) })}</Hint>
      {items.length === 0 ? <Hint>{tr('attach.settings.empty')}</Hint> : null}
      {items.map((a) => (
        <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: t.text, fontSize: 13 }} numberOfLines={1}>{a.name}</Text>
            <Text style={{ color: t.sub, fontSize: 11 }}>{formatBytes(a.size)}</Text>
          </View>
          <Btn small danger label={tr('attach.settings.delete')} onPress={async () => { if (await confirmDialog(tr('attach.settings.delete'), tr('attach.settings.confirmDelete'), tr('attach.settings.delete'))) void remove(a); }} />
        </View>
      ))}
    </View>
  );
}
