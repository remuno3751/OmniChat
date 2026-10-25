import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message } from '../protocol';
import { Theme, useTheme, useThemeDef } from '../theme';
import { DottedInner, FourStar } from '../ui/decor';
import { CornerTicks, Enter } from '../ui/skin';
import { isFreshMessage } from '../ui/msgFresh';
import { copyText } from '../ui/clipboard';
import { Btn, Field, MenuSheet, useDevMode } from '../ui/kit';
import type { MenuEntry } from '../ui/kit';
import { toast } from '../ui/toast';
import MetricsLine from './MetricsLine';
import GuardBlockedNotice from './GuardBlockedNotice';
import { SourceSheet, SourcesList, useCitationSheet } from './Sources';
import Markdown from './Markdown';
import { useStreamText } from '../ui/streamText';
import ToolCards from './ToolCards';
import { CodeRunPanels } from './CodeRunPanels';
import type { SearchSource } from '../protocol';
import ThinkingBlock from './ThinkingBlock';
import PhaseLine from './PhaseLine';
import JsonBadge from './JsonBadge';
import TokenViewer from './TokenViewer';
import Icon from './Icon';
import AttachmentList from './AttachmentView';
import type { IconName } from './Icon';
import type { DebugTab } from './DebugSheet';
import { prettyJson } from '../devState';
import { useT } from '../i18n';
import { waitStage } from '../waitState';

export function MessageContent({ text, t, sources, onCite, streaming }: { text: string; t: Theme; sources?: SearchSource[] | null; onCite?: (s: SearchSource) => void; streaming?: boolean }) {
  const shown = useStreamText(text, !!streaming);
  return <Markdown text={shown} t={t} sources={sources} onCite={onCite} streaming={streaming} />;
}

interface Props {
  m: Message;
  /** position among siblings (1-based) and total; total <= 1 hides the navigator */
  sibIndex: number;
  sibTotal: number;
  onSwitch: (delta: -1 | 1) => void;
  /** false for linear (dsh-bridge) or old-server conversations */
  canBranch: boolean;
  /** a reply is streaming: actions that start a new generation are disabled */
  busy: boolean;
  onRegenerate: () => void;
  onEditResend: (text: string) => void;
  onDebug: (tab: DebugTab) => void;
  /** arrived after this chat was opened and newer than what was shown at open (ChatScreen's fresh tracker) */
  late?: boolean;
}

/** Status next to the spinner while a reply has no content or reasoning yet: elapsed seconds by stage. Ticks only while mounted. */
function WaitStatus({ since, hasToolActivity }: { since: number; hasToolActivity: boolean }) {
  const t = useTheme();
  const tr = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const { key, s } = waitStage(now - since, hasToolActivity);
  return <Text style={{ color: t.sub, fontSize: 12, flexShrink: 1 }}>{tr(key, { s })}</Text>;
}

export default function MessageView({ m, sibIndex, sibTotal, onSwitch, canBranch, busy, onRegenerate, onEditResend, onDebug, late }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const bv = th.def.variants.bubble;
  const themed = th.def.id !== 'simple';
  const tr = useT();
  const dev = useDevMode();
  const [menu, setMenu] = useState(false);
  // action icons: always visible on touch; on web they show on hover or when a button has keyboard focus
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [tokens, setTokens] = useState(false);
  const cite = useCitationSheet();
  const user = m.role === 'user';
  const settled = m.status !== 'streaming';
  // structured output: a JSON answer (metrics.jsonValid set) is shown pretty-printed
  const pretty = !user && m.metrics?.jsonValid ? prettyJson(m.content) : null;

  const touch = Platform.OS !== 'web' || coarsePointer();
  const showActions = touch || hover || focus;
  const copy = async () => toast((await copyText(m.content)) ? tr('msg.copied') : tr('msg.copyFailed'), 'ok');
  // developer-only details stay in a small menu (the one-click actions replace the old overflow menu)
  const devItems: MenuEntry[] = [
    { label: tr('msg.menu.tokens'), hidden: !dev || !settled || !m.content, onPress: () => setTokens(true) },
    { label: tr('msg.menu.finalPrompt'), hidden: user || !dev || !settled, onPress: () => onDebug('final') },
    { label: tr('msg.menu.rawJson'), hidden: user || !dev || !settled, onPress: () => onDebug('raw') },
    { label: tr('msg.menu.speed'), hidden: user || !dev || !settled || !m.metrics, onPress: () => onDebug('metrics') },
  ];

  // the card fades/slides in once, in every theme
  // (only messages that just arrived animate; opening a long chat stays static). The wrapper is fixed per mount so nothing remounts.
  // Skew: m.createdAt is stamped by the SERVER, Date.now() is the PHONE clock, so a few seconds of drift made fresh messages
  // look old. `late` (ChatScreen's tracker: it arrived while the chat was open) is the reliable signal; the clock test is only the fallback.
  const fresh = useRef(isFreshMessage(m.createdAt, Date.now(), !!late)).current;
  const wrapped = themed || fresh;
  const wrapEnter = (node: React.ReactElement) => (wrapped ? <Enter skip={!fresh} dist={16} from={user ? 'right' : 'left'} style={{ maxWidth: '88%' }}>{node}</Enter> : node);

  if (editing !== null) {
    return (
      <View style={[styles.row, { justifyContent: 'flex-end' }]}>
        <View style={{ width: '88%' }}>
          <Field value={editing} onChangeText={setEditing} multiline minHeight={70} autoFocus />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
            <Btn small label={tr('common.cancel')} onPress={() => setEditing(null)} />
            <Btn small primary label={tr('common.send')} disabled={!editing.trim()} onPress={() => { const x = editing.trim(); setEditing(null); onEditResend(x); }} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      style={{ alignItems: user ? 'flex-end' : 'flex-start' }}
      {...(Platform.OS === 'web' ? ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any) : {})}
    >
      {wrapEnter(
      <Pressable
        style={[
          styles.bubble,
          wrapped && { maxWidth: '100%' },
          { backgroundColor: user ? t.userBubble : t.botBubble, borderRadius: th.r(14) },
          bv === 'bar' && { borderRadius: 0, borderWidth: th.bw, borderColor: t.border, borderLeftWidth: 3, borderLeftColor: user ? t.borderStrong : t.accentInk },
          bv === 'card' && { borderRadius: th.r(12), paddingHorizontal: 14, paddingVertical: 10 },
          bv === 'card' && user && { borderWidth: 1, borderColor: t.borderStrong },
          m.status === 'error' && { borderColor: t.danger, borderWidth: 1 },
        ]}
      >
        {bv === 'card' && !th.dark && <DottedInner inset={4} radius={Math.max(0, th.r(12) - 4)} />}
        {bv === 'bar' && !user && <CornerTicks color={t.borderStrong} />}
        {bv === 'card' && !user && th.fx && <View pointerEvents="none" style={styles.star}><FourStar size={12} color={t.accent} /></View>}
        {!user && <PhaseLine m={m} />}
        {!user && !!m.reasoning && <ThinkingBlock m={m} />}
        {!user && <ToolCards calls={m.toolCalls} />}
        {!user && (m.changes?.length || m.agents?.length) ? <CodeRunPanels m={m} /> : null}
        {pretty ? (
          <View style={[styles.code, { backgroundColor: t.code, borderRadius: th.r(8) }]}>
            <Text selectable style={[styles.codeText, { color: t.codeText }]}>{pretty}</Text>
          </View>
        ) : m.content ? <MessageContent text={m.content.replace(/^\s+/, '')} t={t} sources={user ? null : m.sources} onCite={cite.open} streaming={m.status === 'streaming'} /> : null}
        {m.attachments?.length ? <AttachmentList attachments={m.attachments} /> : null}
        {!user && <SourcesList sources={m.sources} highlight={cite.src?.index} />}
        {!user && <GuardBlockedNotice items={m.guardBlocked} />}
        {m.status === 'streaming' && (!!m.content || !m.reasoning) && (
          <View style={[styles.waitRow, { marginTop: m.content ? 6 : 0 }]}>
            <ActivityIndicator size="small" color={t.accentInk} />
            {!m.content && <WaitStatus since={m.createdAt} hasToolActivity={!!m.toolCalls?.length} />}
          </View>
        )}
        {m.status === 'stopped' && <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{tr('msg.statusStopped')}</Text>}
        {m.status === 'error' && <Text style={{ color: t.danger, fontSize: 12, marginTop: 4 }}>{tr('msg.statusError')}</Text>}
      </Pressable>)}
      {!user && settled && <MetricsLine metrics={m.metrics} onPress={dev ? () => onDebug('metrics') : undefined} />}
      {!user && settled && <JsonBadge metrics={m.metrics} />}
      <View style={[styles.actions, { opacity: showActions ? 1 : 0 }]}>
        {sibTotal > 1 && (
          <View style={styles.nav}>
            <Pressable onPress={() => onSwitch(-1)} disabled={sibIndex <= 1} hitSlop={8} accessibilityLabel={tr('msg.prevVersion')}>
              <Icon name="chevronLeft" size={18} color={sibIndex <= 1 ? t.border : t.sub} />
            </Pressable>
            <Text style={{ color: t.sub, fontSize: 12 }} accessibilityLabel={tr('msg.versionOf', { i: sibIndex, n: sibTotal })}>{sibIndex}/{sibTotal}</Text>
            <Pressable onPress={() => onSwitch(1)} disabled={sibIndex >= sibTotal} hitSlop={8} accessibilityLabel={tr('msg.nextVersion')}>
              <Icon name="chevronRight" size={18} color={sibIndex >= sibTotal ? t.border : t.sub} />
            </Pressable>
          </View>
        )}
        {!!m.content && <ActionBtn icon="copy" label={tr('common.copy')} onPress={copy} onFocusChange={setFocus} />}
        {!user && canBranch && !busy && settled && <ActionBtn icon="regenerate" label={tr('msg.regenerate')} onPress={onRegenerate} onFocusChange={setFocus} />}
        {user && canBranch && !busy && <ActionBtn icon="edit" label={tr('msg.editResend')} onPress={() => setEditing(m.content)} onFocusChange={setFocus} />}
        {dev && settled && (!!m.content || !!m.reasoning) && <ActionBtn icon="more" label={tr('msg.devDetails')} onPress={() => setMenu(true)} onFocusChange={setFocus} />}
      </View>
      <SourceSheet source={cite.src} onClose={cite.close} />
      <MenuSheet visible={menu} onClose={() => setMenu(false)} items={devItems} title={user ? tr('msg.yourMessage') : tr('msg.reply')} />
      <TokenViewer visible={tokens} text={m.content} onClose={() => setTokens(false)} />
    </View>
  );
}

/** Web on a touch device (no hover): the action icons stay visible. */
function coarsePointer(): boolean {
  try { return !!(globalThis as any).matchMedia?.('(hover: none)')?.matches; } catch { return false; }
}

/** One icon button under a message. Focusable; reports focus so the row stays visible for keyboard users. */
function ActionBtn({ icon, label, onPress, onFocusChange }: { icon: IconName; label: string; onPress: () => void; onFocusChange: (f: boolean) => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ hovered, focused }: any) => [styles.actBtn, (hovered || focused) && { backgroundColor: t.border }]}
    >
      <Icon name={icon} size={16} color={t.sub} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  waitRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6 },
  row: { flexDirection: 'row' },
  actBtn: { width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '88%', paddingHorizontal: 12, paddingVertical: 8 },
  star: { position: 'absolute', top: -6, left: -6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22, marginTop: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  msgText: { fontSize: 16, lineHeight: 23 },
  code: { padding: 10, marginVertical: 6 },
  codeText: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13 },
});
