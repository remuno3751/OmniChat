import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { APPROVAL_TIMEOUT_MS, PERM_LABEL, PERM_WARN, answerApproval, permDanger, removeApproval, useApprovals } from '../toolState';
import type { Approval } from '../toolState';
import { useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn, useWide } from '../ui/kit';
import { KeyboardAvoid, useInsets, useKeyboard } from '../ui/safe';
import { Chip } from './ToolCards';
import Icon from './Icon';

/**
 * Tool approval dialog: bottom sheet on phones, centred modal on desktop. Shows the oldest pending approval,
 * with a 120 s countdown. Disappears by itself when the server moves on (answered on another device,
 * generation stopped, timeout).
 */
export default function ApprovalHost() {
  const t = useTheme();
  const th = useThemeDef();
  const wide = useWide();
  const ins = useInsets();
  const kb = useKeyboard();
  const list = useApprovals();
  const messages = useStore((s) => s.messages);
  const [now, setNow] = useState(Date.now());

  // an approval whose assistant message is already settled (stopped/done/error) is obsolete
  const live = useMemo(() => list.filter((a) => {
    const st = messages[a.conversationId]?.[a.messageId]?.status;
    return !st || st === 'streaming';
  }), [list, messages]);

  useEffect(() => {
    if (!list.length) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [list.length]);

  useEffect(() => {
    // timed out (the server denies it on its side) or obsolete: remove
    for (const a of list) {
      if (now - a.receivedAt >= APPROVAL_TIMEOUT_MS + 500 || !live.includes(a)) removeApproval(a.approvalId);
    }
  }, [now, list, live]);

  const cur: Approval | undefined = live[0];
  return (
    <Modal visible={!!cur} transparent animationType={th.reduceMotion ? 'none' : wide ? 'fade' : 'slide'} onRequestClose={() => { /* must be answered explicitly */ }} statusBarTranslucent navigationBarTranslucent>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} />
      {!!cur && (
        <KeyboardAvoid
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, { justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center' }]}
        >
          <View style={[wide ? styles.dialog : styles.sheet, { backgroundColor: t.panel, borderColor: t.border, maxWidth: wide ? 520 : undefined }, wide && { borderRadius: th.r(16) }, !wide && { paddingBottom: 22 + (kb.visible ? 0 : ins.bottom) }]}>
            {!wide && <View style={[styles.grab, { backgroundColor: t.border }]} />}
            <Dialog a={cur} now={now} more={live.length - 1} />
          </View>
        </KeyboardAvoid>
      )}
    </Modal>
  );
}

function Dialog({ a, now, more }: { a: Approval; now: number; more: number }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const left = Math.max(0, Math.ceil((APPROVAL_TIMEOUT_MS - (now - a.receivedAt)) / 1000));
  const frac = Math.max(0, Math.min(1, (APPROVAL_TIMEOUT_MS - (now - a.receivedAt)) / APPROVAL_TIMEOUT_MS));
  let args = '';
  try { args = JSON.stringify(a.arguments ?? {}, null, 2); } catch { args = String(a.arguments); }
  const risky = a.permissions.some(permDanger);
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={risky ? 'warning' : 'tool'} size={24} color={risky ? t.warn : t.sub} />
        <Text style={{ flex: 1, color: t.text, fontSize: 17, fontWeight: '700' }} accessibilityRole="header">{tr('approval.title')}</Text>
        <Text style={{ color: left <= 15 ? t.danger : t.sub, fontSize: 13, fontWeight: '700' }} accessibilityLabel={tr('approval.secondsLeft', { n: left })}>{tr('approval.secs', { n: left })}</Text>
      </View>
      <View style={{ height: 3, borderRadius: th.r(2), backgroundColor: t.border, marginTop: 8, overflow: 'hidden' }}>
        <View style={{ height: 3, width: `${frac * 100}%`, backgroundColor: left <= 15 ? t.danger : t.accent }} />
      </View>
      <ScrollView style={{ flexShrink: 1, marginTop: 10 }} contentContainerStyle={{ paddingBottom: 4 }}>
        <Text style={{ color: t.sub, fontSize: 12 }}>{tr('approval.wantsUse')}</Text>
        <Text selectable style={{ color: t.text, fontSize: 16, fontWeight: '700', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }}>{a.tool}</Text>
        <Text style={[styles.cap, { color: t.sub }]}>{tr('tool.arguments')}</Text>
        <ScrollView nestedScrollEnabled style={[styles.pre, { backgroundColor: t.code, maxHeight: 150, borderRadius: th.r(6) }]}>
          <Text selectable style={{ color: t.codeText, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) }}>{args}</Text>
        </ScrollView>
        <Text style={[styles.cap, { color: t.sub }]}>{tr('approval.toolCan')}</Text>
        {a.permissions.length === 0 && <Text style={{ color: t.sub, fontSize: 13 }}>{tr('approval.noPerms')}</Text>}
        {a.permissions.map((p) => (
          <View key={p} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
            <Chip label={PERM_LABEL[p] || p} color={permDanger(p) ? t.danger : p === 'network' ? t.warn : t.sub} />
            <Text style={{ flex: 1, color: permDanger(p) ? t.danger : t.text, fontSize: 13, lineHeight: 18 }}>{PERM_WARN[p] || tr('approval.declaredPerm')}</Text>
          </View>
        ))}
        <Text style={{ color: t.sub, fontSize: 11, lineHeight: 16, marginTop: 4 }}>
          {tr('approval.sandboxNote')}
        </Text>
        {more > 0 && <Text style={{ color: t.warn, fontSize: 12, marginTop: 6 }}>{tr(more === 1 ? 'approval.moreOne' : 'approval.moreMany', { n: more })}</Text>}
      </ScrollView>
      <View style={styles.footer}>
        <Btn primary label={tr('approval.allowOnce')} onPress={() => answerApproval(a, 'once')} />
        <Btn label={tr('approval.alwaysAllow')} onPress={() => answerApproval(a, 'always')} />
        <Btn danger label={tr('code.action.deny')} onPress={() => answerApproval(a, 'deny')} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  dialog: { width: '100%', maxHeight: '86%', borderWidth: 1, padding: 16 },
  sheet: { width: '100%', maxHeight: '90%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, padding: 14, paddingBottom: 22 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
  cap: { fontSize: 11, fontWeight: '700', marginTop: 10, marginBottom: 4 },
  pre: { padding: 8 },
  footer: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
});
