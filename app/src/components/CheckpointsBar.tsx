import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { apiV4 } from '../apiV4';
import type { CodeCheckpoint } from '../protocol';
import { useT } from '../i18n';
import { fmtDate } from '../historyTypes';
import { useStore } from '../store';
import { useAppearance, useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Check } from '../ui/kit';
import { toast } from '../ui/toast';
import { onCheckpoint } from '../v4Events';
import Icon from './Icon';

/** Code conversations only: collapsible list of checkpoints with a Rewind action. Mount with key={convId}. */
export default function CheckpointsBar({ convId }: { convId: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const { messageWidth } = useAppearance();
  const codeStatus = useStore((s) => s.conversations[convId]?.codeStatus);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CodeCheckpoint[] | null>(null);
  const [removeNew, setRemoveNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await apiV4.checkpoints(convId));
    } catch {
      // keep the last known list
    }
  }, [convId]);

  // load on mount (for the count), on expand, and when the run state changes
  useEffect(() => { void load(); }, [load, codeStatus, open]);

  // a new or unavailable checkpoint for this conversation
  useEffect(() => onCheckpoint((f) => { if (f.conversationId === convId) void load(); }), [convId, load]);

  const rewind = async (c: CodeCheckpoint) => {
    const message = tr('code.rewindConfirm') + (removeNew ? ' ' + tr('code.removeNewWarn') : '');
    const ok = await confirmDialog(tr('code.rewind'), message, tr('code.rewind'));
    if (!ok) return;
    setBusyId(c.id);
    try {
      await apiV4.rewind(c.id, removeNew);
      toast(tr('code.rewound'), 'ok');
      void load();
    } catch (e: any) {
      toast(e?.message || tr('code.rewindFailed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const count = items?.length ?? 0;
  const running = codeStatus === 'running';

  return (
    <View style={[styles.wrap, { borderColor: t.border, backgroundColor: t.panel, maxWidth: messageWidth, borderRadius: th.r(10) }]}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.head}
      >
        <Text style={{ flex: 1, color: t.text, fontSize: 13, fontWeight: '600' }}>{tr('code.checkpointsCount', { n: count })}</Text>
        <Icon name={open ? 'collapse' : 'expand'} size={18} color={t.sub} />
      </Pressable>

      {open && (
        <View style={styles.body}>
          <Check label={tr('code.removeNew')} hint={tr('code.removeNewHint')} value={removeNew} onChange={setRemoveNew} />
          {items !== null && items.length === 0 && <Text style={{ color: t.sub, fontSize: 12 }}>{tr('code.checkpointsEmpty')}</Text>}
          {(items || []).map((c) => (
            <View key={c.id} style={[styles.row, { borderColor: t.border }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={{ color: t.text, fontSize: 13 }}>{fmtDate(c.createdAt)}</Text>
                  <Text style={{ color: t.sub, fontSize: 11 }}>{c.id.slice(0, 8)}</Text>
                  {c.dirty && (
                    <Text style={[styles.badge, { color: t.accentInk, borderColor: t.accent, borderRadius: th.r(4) }]}>{tr('code.dirty')}</Text>
                  )}
                </View>
                {!!c.unavailable && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name="warning" size={14} color={t.danger} />
                    <Text style={{ flex: 1, color: t.danger, fontSize: 12 }}>{tr('code.unavailable')}: {c.unavailable}</Text>
                  </View>
                )}
              </View>
              {!c.unavailable && (
                <Btn
                  small
                  label={tr('code.rewind')}
                  onPress={() => { void rewind(c); }}
                  disabled={running || busyId !== null}
                />
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', alignSelf: 'center', borderWidth: 1, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  body: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  badge: { fontSize: 11, borderWidth: 1, paddingHorizontal: 4 },
});
