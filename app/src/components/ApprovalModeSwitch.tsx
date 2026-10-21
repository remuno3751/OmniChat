import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { applyUpsert } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, Check } from '../ui/kit';
import { toast } from '../ui/toast';
import type { Conversation } from '../protocol';
import {
  approvalModeActions, approvalModePatch, canConfirmFull, closedFullDialog, openFullDialog, toggleFullDialogCheck,
  type ApprovalMode, type FullDialogState,
} from '../approvalMode';
import Icon from './Icon';

/**
 * Code conversation approval mode: Manual / Auto / Full access. The shown value is always the server's
 * (conv.approvalMode). Full access goes through a warning dialog with a required checkbox and sends confirmFull:true.
 * `requestMode` is also what the slash actions use.
 */
export function useApprovalMode(conv: Conversation | undefined) {
  const tr = useT();
  const [dlg, setDlg] = useState<FullDialogState>(closedFullDialog);
  const [busy, setBusy] = useState(false);
  const convId = conv?.id;
  useEffect(() => { setDlg(closedFullDialog); }, [convId]);

  const apply = async (mode: ApprovalMode, confirmed: boolean) => {
    if (!convId) return;
    setBusy(true);
    try {
      applyUpsert({ conversations: [await api.putConversation(convId, approvalModePatch(mode, confirmed))] });
    } catch (e: any) {
      toast(e?.message || tr('approval.mode.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const requestMode = (mode: ApprovalMode) => {
    if (!conv) { toast(tr('approval.mode.noChat'), 'info'); return; }
    const act = approvalModeActions(conv.approvalMode).find((a) => a.mode === mode);
    if (!act || act.selected) return;
    if (act.needsConfirm) { setDlg(openFullDialog()); return; }
    void apply(mode, false);
  };

  return {
    busy,
    dialog: dlg,
    requestMode,
    toggleCheck: () => setDlg((s) => toggleFullDialogCheck(s)),
    cancel: () => setDlg(closedFullDialog),
    confirm: () => {
      if (!canConfirmFull(dlg)) return;
      setDlg(closedFullDialog);
      void apply('full', true);
    },
  };
}

export function ApprovalModeSwitch({ conv, busy, onSelect }: { conv: Conversation; busy: boolean; onSelect: (m: ApprovalMode) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const actions = approvalModeActions(conv.approvalMode);
  return (
    <View style={[styles.bar, { borderColor: t.border }]}>
      <Text style={{ color: t.sub, fontSize: 12 }}>{tr('approval.mode.label')}</Text>
      <View style={[styles.seg, { borderColor: t.border, borderRadius: th.r(8) }]} accessibilityRole="radiogroup">
        {actions.map((a) => {
          const full = a.mode === 'full';
          const col = a.selected ? (full ? t.danger : t.accentInk) : t.sub;
          return (
            <Pressable
              key={a.mode}
              disabled={busy}
              onPress={() => onSelect(a.mode)}
              accessibilityRole="radio"
              accessibilityState={{ selected: a.selected, disabled: busy }}
              accessibilityLabel={tr(`approval.mode.${a.mode}`)}
              style={[styles.opt, a.selected && { backgroundColor: t.border }]}
            >
              {full && <Icon name="warning" size={13} color={col} />}
              <Text style={{ color: col, fontSize: 12, fontWeight: a.selected ? '700' : '500' }}>{tr(`approval.mode.${a.mode}`)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function FullAccessDialog({ state, onToggle, onCancel, onConfirm }: { state: FullDialogState; onToggle: () => void; onCancel: () => void; onConfirm: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  return (
    <Modal visible={state.open} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 16 }]}>
        <View style={{ width: '100%', maxWidth: 480, backgroundColor: t.panel, borderColor: t.border, borderWidth: 1, borderRadius: th.r(16), padding: 16, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="warning" size={22} color={t.danger} />
            <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '700' }}>{tr('approval.full.title')}</Text>
          </View>
          <Text style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>{tr('approval.full.auto')}</Text>
          <Text style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>{tr('approval.full.protected')}</Text>
          <Text style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>{tr('approval.full.checkpoints')}</Text>
          <Check label={tr('approval.full.check')} value={state.checked} onChange={onToggle} />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn danger label={tr('approval.full.confirm')} onPress={onConfirm} disabled={!canConfirmFull(state)} />
            <Btn label={tr('common.cancel')} onPress={onCancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, flexWrap: 'wrap' },
  seg: { flexDirection: 'row', borderWidth: 1, overflow: 'hidden' },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5 },
});
