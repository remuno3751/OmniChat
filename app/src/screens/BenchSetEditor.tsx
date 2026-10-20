import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiDev } from '../apiDev';
import { uuid } from '../api';
import type { BenchSet } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { useT } from '../i18n';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, ScreenHeader } from '../ui/kit';
import { toast } from '../ui/toast';

export const MAX_PROMPTS = 50;
export const MAX_PROMPT_CHARS = 8000;

/** Prompt-set editor: name, optional system prompt, 1-50 prompts (each up to 8000 characters). */
export default function BenchSetEditor({ initial, onBack, onSaved }: { initial: BenchSet | null; onBack: () => void; onSaved: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [id] = useState(() => initial?.id || uuid());
  const [name, setName] = useState(initial?.name || '');
  const [system, setSystem] = useState(initial?.systemPrompt || '');
  const [prompts, setPrompts] = useState<string[]>(initial?.prompts?.length ? initial.prompts : ['']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const cleaned = prompts.map((p) => p.trim()).filter((p) => p.length > 0);
  const tooLong = prompts.findIndex((p) => p.length > MAX_PROMPT_CHARS);

  const save = async () => {
    setErr('');
    if (!name.trim()) { setErr(tr('bench.errName')); return; }
    if (!cleaned.length) { setErr(tr('bench.errNoPrompt')); return; }
    if (cleaned.length > MAX_PROMPTS) { setErr(tr('bench.errTooMany', { max: MAX_PROMPTS })); return; }
    if (tooLong >= 0) { setErr(tr('bench.errTooLong', { n: tooLong + 1, max: MAX_PROMPT_CHARS })); return; }
    setBusy(true);
    try {
      await apiDev.putBenchSet(id, { name: name.trim(), prompts: cleaned, systemPrompt: system.trim() ? system : null });
      toast(tr('bench.saved'), 'ok');
      onSaved();
    } catch (e: any) { setErr(e?.message || tr('bench.saveFailed')); }
    setBusy(false);
  };

  const del = async () => {
    if (!initial) return;
    if (!(await confirmDialog(tr('bench.deleteSetTitle'), tr('bench.deleteSetBody'), tr('common.delete')))) return;
    try { await apiDev.deleteBenchSet(initial.id); onSaved(); } catch (e: any) { toast(e?.message || tr('bench.deleteFailed'), 'error'); }
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={initial ? tr('bench.editSet') : tr('bench.newSetTitle')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field label={tr('bench.name')} value={name} onChangeText={setName} placeholder={tr('bench.namePlaceholder')} />
        <Field label={tr('bench.systemOptional')} value={system} onChangeText={setSystem} multiline minHeight={50} placeholder={tr('bench.noneSystem')} />
        <Text style={[styles.h, { color: t.text }]}>{tr('bench.promptsHeading', { n: cleaned.length, max: MAX_PROMPTS })}</Text>
        {prompts.map((p, i) => (
          <View key={i} style={[styles.card, { borderRadius: th.r(10) }, { borderColor: t.border, backgroundColor: t.panel }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: t.sub, fontSize: 12, fontWeight: '700' }}>{tr('bench.promptN', { n: i + 1 })}</Text>
              <Text style={{ color: p.length > MAX_PROMPT_CHARS ? t.danger : t.sub, fontSize: 11 }}>{p.length}/{MAX_PROMPT_CHARS}</Text>
            </View>
            <Field value={p} onChangeText={(v) => setPrompts((ps) => ps.map((x, k) => (k === i ? v : x)))} multiline minHeight={56} placeholder={tr('bench.promptPlaceholder')} />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <Btn small label={tr('bench.remove')} danger disabled={prompts.length <= 1} onPress={() => setPrompts((ps) => ps.filter((_, k) => k !== i))} />
            </View>
          </View>
        ))}
        <Btn small label={tr('bench.addPrompt')} disabled={prompts.length >= MAX_PROMPTS} onPress={() => setPrompts((ps) => [...ps, ''])} />
        <Hint>{tr('bench.setHint')}</Hint>
        {!!err && <Text style={{ color: t.danger, marginTop: 10 }}>{err}</Text>}
        <View style={styles.actions}>
          <Btn primary label={busy ? tr('bench.saving') : tr('common.save')} disabled={busy} onPress={save} />
          <Btn label={tr('common.cancel')} onPress={onBack} />
          {!!initial && <Btn danger label={tr('bench.deleteSet')} onPress={del} />}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 760, alignSelf: 'center', paddingBottom: 40 },
  h: { fontSize: 15, fontWeight: '700', marginTop: 18, marginBottom: 4 },
  card: { borderWidth: 1, padding: 10, marginBottom: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
});
