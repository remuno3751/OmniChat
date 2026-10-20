import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { uuid } from '../api';
import { apiV4 } from '../apiV4';
import type { Template } from '../protocol';
import { activeProjects, activeTemplates, applyUpsert, useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { BUILTIN_ACTIONS } from '../templates';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Label, Segmented, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';

type Kind = Template['kind'];
const NAME_MAX = 60;
const BODY_MAX = 20000;
const GLOBAL = 'global';
const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface Form {
  id: string | null; // null = new template
  name: string;
  description: string;
  kind: Kind;
  body: string;
  scope: string; // GLOBAL or a project id
}

/** Settings > Chat > Templates: list, add, edit and delete prompt / action templates (global or per project). */
export default function TemplatesManager() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const templatesMap = useStore((s) => s.templates);
  const projectsMap = useStore((s) => s.projects);
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const list = activeTemplates(templatesMap);
  const projects = activeProjects(projectsMap);
  const scopeLabel = (tpl: Template) =>
    tpl.projectId ? projectsMap[tpl.projectId]?.name ?? tpl.projectId : tr('templates.scopeGlobal');

  const openNew = () => {
    setErr('');
    setForm({ id: null, name: '', description: '', kind: 'prompt', body: '', scope: GLOBAL });
  };

  const openEdit = (tpl: Template) => {
    setErr('');
    setForm({
      id: tpl.id, name: tpl.name, description: tpl.description || '', kind: tpl.kind, body: tpl.body,
      scope: tpl.projectId ?? GLOBAL,
    });
  };

  const changeKind = (kind: Kind) => {
    if (!form) return;
    // switching to action keeps a valid action id; switching back to prompt clears it
    const body = kind === 'action'
      ? (BUILTIN_ACTIONS.some((a) => a.id === form.body) ? form.body : BUILTIN_ACTIONS[0].id)
      : (BUILTIN_ACTIONS.some((a) => a.id === form.body) ? '' : form.body);
    setForm({ ...form, kind, body });
  };

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    const body = form.body;
    if (!name) { setErr(tr('templates.nameRequired')); return; }
    if (name.length > NAME_MAX) { setErr(tr('templates.nameTooLong')); return; }
    if (form.kind === 'prompt' && !body.trim()) { setErr(tr('templates.bodyRequired')); return; }
    if (body.length > BODY_MAX) { setErr(tr('templates.bodyTooLong')); return; }
    const projectId = form.scope === GLOBAL ? null : form.scope;
    // same rule as the server: names are unique per scope
    const clash = list.some((x) => x.id !== form.id && x.name === name && (x.projectId ?? null) === projectId);
    if (clash) { setErr(tr('templates.nameTaken')); return; }

    setErr('');
    setBusy(true);
    try {
      const saved = await apiV4.putTemplate(form.id ?? uuid(), {
        projectId, name, body, description: form.description.trim(), kind: form.kind,
      });
      applyUpsert({ templates: [saved] });
      setForm(null);
      toast(tr('templates.saved'), 'ok');
    } catch (e: any) {
      setErr(e?.message || tr('templates.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tpl: Template) => {
    const ok = await confirmDialog(tr('templates.deleteTitle'), tr('templates.deleteMsg', { name: tpl.name }), tr('common.delete'));
    if (!ok) return;
    try {
      await apiV4.deleteTemplate(tpl.id);
      applyUpsert({ templates: [{ ...tpl, deleted: true }] });
      toast(tr('templates.deleted'), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('templates.saveFailed'), 'error');
    }
  };

  const scopeOptions = [
    { value: GLOBAL, label: tr('templates.scopeGlobal') },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Hint>{tr('chat.slashHint')}</Hint>
          <Hint>{tr('templates.varsHint')}</Hint>
        </View>
        <Btn small label={tr('templates.add')} primary onPress={openNew} />
      </View>

      {list.length === 0 && <Hint>{tr('templates.none')}</Hint>}

      {list.map((tpl) => (
        <View key={tpl.id} style={[styles.row, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(10) }]}>
          <View style={styles.rowTop}>
            <View style={[styles.badge, { borderColor: t.accent, borderRadius: th.r(6) }]}>
              <Text style={{ color: t.accentInk, fontSize: 11, fontWeight: '700' }}>{tr(`templates.kind.${tpl.kind}`)}</Text>
            </View>
            <Text style={{ flex: 1, color: t.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>{`/${tpl.name}`}</Text>
            <Text style={{ color: t.sub, fontSize: 12 }} numberOfLines={1}>{scopeLabel(tpl)}</Text>
          </View>
          {!!tpl.description && <Text style={{ color: t.sub, fontSize: 13 }}>{tpl.description}</Text>}
          <Text style={{ color: t.text, fontFamily: mono, fontSize: 12 }} numberOfLines={2}>{tpl.body}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <Btn small label={tr('common.edit')} onPress={() => openEdit(tpl)} />
            <Btn small danger label={tr('common.delete')} onPress={() => { void remove(tpl); }} />
          </View>
        </View>
      ))}

      <Sheet
        visible={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? tr('templates.edit') : tr('templates.add')}
        width={560}
        footer={
          <>
            <Btn label={tr('common.save')} primary onPress={() => { void save(); }} disabled={busy} />
            <Btn label={tr('common.cancel')} onPress={() => setForm(null)} />
          </>
        }
      >
        {!!form && (
          <View style={{ gap: 2 }}>
            <Field label={tr('templates.name')} value={form.name} autoFocus={!form.id}
              onChangeText={(v) => { setForm({ ...form, name: v }); setErr(''); }} />
            <Field label={tr('templates.description')} value={form.description}
              onChangeText={(v) => setForm({ ...form, description: v })} />
            <Label>{tr('templates.kindLabel')}</Label>
            <Segmented
              options={[{ value: 'prompt' as Kind, label: tr('templates.kind.prompt') }, { value: 'action' as Kind, label: tr('templates.kind.action') }]}
              value={form.kind}
              onChange={changeKind}
            />
            {form.kind === 'action' ? (
              <>
                <Label>{tr('templates.actionBody')}</Label>
                <Segmented
                  options={BUILTIN_ACTIONS.map((a) => ({ value: a.id, label: a.id }))}
                  value={form.body}
                  onChange={(v) => setForm({ ...form, body: v })}
                />
              </>
            ) : (
              <Field label={tr('templates.body')} value={form.body} multiline minHeight={120} mono
                onChangeText={(v) => { setForm({ ...form, body: v }); setErr(''); }} />
            )}
            <Label>{tr('templates.scope')}</Label>
            <Segmented options={scopeOptions} value={form.scope} onChange={(v) => setForm({ ...form, scope: v })} />
            {!!err && <Hint danger>{err}</Hint>}
          </View>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, padding: 10, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
});
