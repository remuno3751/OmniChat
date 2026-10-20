import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { apiHistory, deliverText } from '../apiHistory';
import { safeFilename } from '../historyTypes';
import type { ExportBranches, ExportFormat } from '../historyTypes';
import type { Conversation } from '../protocol';
import { t as tt, useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Check, Hint, Label, Segmented, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';

/** Per-conversation export dialog: format, branches (JSON), include thinking (Markdown). */
export default function ExportSheet({ conv, initialFormat, onClose }: { conv: Conversation | null; initialFormat: ExportFormat; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  const [format, setFormat] = useState<ExportFormat>(initialFormat);
  const [branches, setBranches] = useState<ExportBranches>('current');
  const [reasoning, setReasoning] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (conv) { setFormat(initialFormat); setBranches('current'); setReasoning(false); } }, [conv, initialFormat]);

  const go = async () => {
    if (!conv) return;
    setBusy(true);
    try {
      const text = await apiHistory.exportConversation(conv.id, format, format === 'json' ? branches : 'current', format === 'md' && reasoning);
      await deliverText(safeFilename(conv.title, format === 'md' ? 'md' : 'json'), text, format === 'md' ? 'text/markdown' : 'application/json');
      toast(tt('sheet.export.ready'), 'ok');
      onClose();
    } catch (e: any) { toast(e?.message || tt('sheet.export.failed'), 'error'); }
    setBusy(false);
  };

  return (
    <Sheet
      visible={!!conv}
      onClose={onClose}
      title={tr('sheet.export.title')}
      width={440}
      footer={<><Btn primary label={busy ? tr('sheet.export.busy') : tr('sheet.export.action')} disabled={busy} onPress={go} /><Btn label={tr('common.cancel')} onPress={onClose} /></>}
    >
      <Text numberOfLines={1} style={{ color: t.sub, fontSize: 13 }}>{conv?.title}</Text>
      <Label>{tr('sheet.export.format')}</Label>
      <Segmented<ExportFormat> value={format} onChange={setFormat} options={[{ value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }]} />
      {format === 'json' ? (
        <>
          <Label>{tr('sheet.export.branches')}</Label>
          <Segmented<ExportBranches> value={branches} onChange={setBranches} options={[{ value: 'current', label: tr('sheet.export.currentBranch') }, { value: 'all', label: tr('sheet.export.allBranches') }]} />
        </>
      ) : (
        <Check label={tr('sheet.export.thinking')} value={reasoning} onChange={setReasoning} hint={tr('sheet.export.thinkingHint')} />
      )}
      <Hint>{tr('sheet.export.hint')}</Hint>
    </Sheet>
  );
}
