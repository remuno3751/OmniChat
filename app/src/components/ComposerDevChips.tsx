import React, { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useDevAvail } from '../devState';
import type { ResponseFormat } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Sheet, useDevMode } from '../ui/kit';
import ResponseFormatEditor, { draftToRF, rfToDraft } from './ResponseFormatEditor';
import type { RFDraft } from './ResponseFormatEditor';
import TokenViewer from './TokenViewer';
import { toast } from '../ui/toast';

/** Developer-mode chips in the composer overflow row: one-shot response format for the next message, token viewer for the draft. */
export default function ComposerDevChips({ oneShot, onOneShot, draft, providerId, model }: {
  oneShot: ResponseFormat | null; onOneShot: (rf: ResponseFormat | null) => void; draft: string; providerId?: string | null; model?: string | null;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const dev = useDevMode();
  const ok = useDevAvail('any');
  const [edit, setEdit] = useState<RFDraft | null>(null);
  const [tokens, setTokens] = useState(false);
  if (!dev || !ok) return null;

  const label = !oneShot ? tr('composer.dev.jsonOff') : oneShot.type === 'json_object' ? tr('composer.dev.jsonObject') : tr('composer.dev.jsonSchema');
  const on = !!oneShot;
  const apply = () => {
    if (!edit) return;
    const r = draftToRF(edit);
    if (r.error) { toast(r.error, 'error'); return; }
    onOneShot(r.value);
    setEdit(null);
  };
  const chip = (txt: string, onPress: () => void, active: boolean, a11y: string) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={{ borderWidth: 1, borderColor: active ? t.accent : t.border, borderRadius: th.r(14), paddingHorizontal: 10, paddingVertical: 4, backgroundColor: active ? t.userBubble : 'transparent' }}
    >
      <Text style={{ color: active ? t.text : t.sub, fontSize: 12, fontWeight: '600' }}>{txt}</Text>
    </Pressable>
  );
  return (
    <>
      {chip(label, () => setEdit(rfToDraft(oneShot)), on, tr('composer.dev.rfA11y'))}
      {chip(tr('composer.dev.tokens'), () => (draft.trim() ? setTokens(true) : toast(tr('composer.dev.typeFirst'), 'info')), false, tr('composer.dev.tokensA11y'))}
      <Sheet
        visible={!!edit}
        onClose={() => setEdit(null)}
        title={tr('sheet.responseFormat')}
        footer={<><Btn primary label={tr('composer.dev.apply')} onPress={apply} /><Btn label={tr('common.cancel')} onPress={() => setEdit(null)} /></>}
      >
        {edit && <ResponseFormatEditor value={edit} onChange={setEdit} label={tr('composer.dev.nextOnly')} />}
      </Sheet>
      <TokenViewer visible={tokens} text={draft} providerId={providerId} model={model} onClose={() => setTokens(false)} />
    </>
  );
}
