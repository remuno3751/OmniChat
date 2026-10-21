import React, { useEffect, useState } from 'react';
import { BACK_PRIORITY } from '../../backHandler';
import { useBack } from '../../ui/useBack';
import { View } from 'react-native';
import { api } from '../../api';
import GlobalDefaults from '../../components/GlobalDefaults';
import { P3Entries, P3SubScreen } from '../../components/ToolsSettings';
import type { P3Sub } from '../../components/ToolsSettings';
import { useT } from '../../i18n';
import { useDeviceSetting } from '../../deviceSettings';
import type { RememberedPolicy } from '../../modelLoad';
import { applyUpsert, useStore } from '../../store';
import { Btn, Field, Hint, Label, useV3 } from '../../ui/kit';
import { toast } from '../../ui/toast';
import TemplatesManager from '../../components/TemplatesManager';
import { PageFrame, Section } from './common';
import { MyAttachmentsSection } from './AttachmentAdminCard';

const IDLE_DEFAULT = 30;
const IDLE_MIN = 1;
const IDLE_MAX = 1440;
const clampIdle = (n: number) => Math.min(IDLE_MAX, Math.max(IDLE_MIN, Math.round(n)));

/** Server setting: minutes an ephemeral chat may stay idle before it is erased (clamped to 1..1440). */
function EphemeralIdleSetting() {
  const tr = useT();
  const supported = useStore((s) => s.ephemeralSupported);
  const saved = useStore((s) => s.settings?.ephemeralIdleMinutes ?? IDLE_DEFAULT);
  const [draft, setDraft] = useState(String(saved));
  useEffect(() => setDraft(String(saved)), [saved]);
  if (!supported) return null;
  const dirty = draft.trim() !== String(saved);
  const step = (d: number) => {
    const n = Number(draft.trim());
    setDraft(String(clampIdle((Number.isFinite(n) && draft.trim() !== '' ? n : saved) + d)));
  };
  const save = async () => {
    const parsed = Number(draft.trim());
    const n = clampIdle(Number.isFinite(parsed) && draft.trim() !== '' ? parsed : saved);
    setDraft(String(n));
    if (n === saved) return;
    try {
      applyUpsert({ settings: await api.putSettings({ ephemeralIdleMinutes: n }) });
    } catch (e: any) {
      setDraft(String(saved));
      toast(e.message || tr('set.saveFailed'), 'error');
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Section title={tr('attach.settings.title')} />
      <MyAttachmentsSection />
      <Section title={tr('eph.settings.title')} />
      <Label>{tr('eph.settings.idle')}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Btn small label="-" onPress={() => step(-5)} />
        <View style={{ width: 90 }}>
          <Field value={draft} onChangeText={setDraft} keyboardType="numeric" onSubmit={save} />
        </View>
        <Btn small label="+" onPress={() => step(5)} />
        <Btn small primary label={tr('common.save')} disabled={!dirty} onPress={save} />
      </View>
      <Hint>{tr('eph.settings.idleHint')}</Hint>
    </View>
  );
}

const MODEL_LOAD_OPTIONS: RememberedPolicy[] = ['ask', 'unload_then_load', 'use_loaded', 'load_both'];

/** Device setting modelLoadPolicy: what to do when another chat model is already loaded (the Code tab is not affected). */
function ModelLoadSetting() {
  const tr = useT();
  const [policy, setPolicy] = useDeviceSetting('modelLoadPolicy');
  return (
    <View style={{ gap: 6 }}>
      <Section title={tr('modelload.settings.title')} />
      <Hint>{tr('modelload.settings.hint')}</Hint>
      <Label>{tr('modelload.settings.label')}</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {MODEL_LOAD_OPTIONS.map((o) => (
          <Btn key={o} small primary={policy === o} label={tr(`modelload.policy.${o}`)} onPress={() => setPolicy(o)} />
        ))}
      </View>
      {policy !== 'ask' && <Btn small label={tr('modelload.settings.reset')} onPress={() => setPolicy('ask')} />}
    </View>
  );
}

/** Settings > Chat: global defaults (system prompt, effort, context), auto title, per-model parameters and ephemeral chats. */
export default function ChatPage({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const v3 = useV3();
  const [p3, setP3] = useState<P3Sub | null>(null);
  useBack(!!p3, BACK_PRIORITY.SUBPAGE + 1, () => { setP3(null); });

  if (p3) return <P3SubScreen sub={p3} onBack={() => setP3(null)} />;

  return (
    <PageFrame title={tr('settings.page.chat')} onBack={onBack}>
      {v3 && <GlobalDefaults />}
      {v3 && <P3Entries onOpen={setP3} />}
      <EphemeralIdleSetting />
      <ModelLoadSetting />
      <Section title={tr('chat.templates')} />
      <TemplatesManager />
    </PageFrame>
  );
}
