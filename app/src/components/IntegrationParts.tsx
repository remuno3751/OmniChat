import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { copyText } from '../ui/clipboard';
import Icon from './Icon';
import { CornerTicks, useFaces } from '../ui/skin';
import { DottedInner } from '../ui/decor';

export type IntegrationStatus = 'ok' | 'warn' | 'off' | 'unknown';

/** Long unbroken strings (tokens, URLs) must wrap on web instead of overflowing 375 px screens. */
const wrapStyle: any = Platform.OS === 'web' ? { overflowWrap: 'anywhere', wordBreak: 'break-word' } : null;

/**
 * Collapsible card for one integration (Settings > Plugins).
 * Closed it is one compact row: name, status, chevron. Tapping the row opens the description and details.
 * Starts closed unless `defaultOpen`; the status never opens or closes it by itself.
 */
export function IntegrationCard({ title, subtitle, status, statusText, defaultOpen, children, headerRight }: {
  title: string;
  subtitle?: string;
  status: IntegrationStatus;
  statusText: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const ef = th.def.variants.tabs === 'tag';
  const astralLook = th.def.variants.tabs === 'folder';
  const [open, setOpen] = useState<boolean>(() => !!defaultOpen);

  const color = status === 'ok' ? t.good : status === 'warn' ? t.warn : t.sub;

  return (
    <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(12) }, ef && { borderLeftWidth: 3, borderLeftColor: th.dark ? t.accent : t.text }, astralLook && { borderLeftWidth: 6, borderLeftColor: t.accent2, paddingLeft: 14 }]}>
      {ef && <CornerTicks color={t.borderStrong} />}
      {astralLook && !th.dark && <DottedInner inset={4} radius={Math.max(0, th.r(12) - 4)} />}
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          {...({ 'aria-expanded': open } as any)}
          style={styles.header}
        >
          <View style={styles.headerText}>
            <Text numberOfLines={open ? undefined : 1} style={[styles.title, { color: t.text }, faces.headingBold, ef && { fontSize: 14, letterSpacing: 0.5 }]}>{title}</Text>
            {open && !!subtitle && <Text style={[styles.subtitle, { color: t.sub }, wrapStyle]}>{subtitle}</Text>}
          </View>
          <View style={[styles.statusRow, { marginTop: 0, flexShrink: 1, maxWidth: '55%' }]}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text numberOfLines={1} style={[styles.statusText, { color, flexShrink: 1 }]}>{statusText}</Text>
          </View>
          <Icon name={open ? 'expand' : 'chevronRight'} size={20} color={t.sub} />
        </Pressable>
        {headerRight}
      </View>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

/** Monospace, selectable text with a Copy button (shows 'Copied' for 1.5 s). */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<any>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'fail');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  return (
    <View style={styles.copyWrap}>
      <View style={styles.copyTop}>
        {!!label && <Text style={[styles.copyLabel, { color: t.sub }]}>{label}</Text>}
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel={tr('common.copy')}
          style={[styles.copyBtn, { borderColor: t.border, borderRadius: th.r(6) }]}
        >
          <Text style={{ color: t.text, fontSize: 12, fontWeight: '600' }}>
            {state === 'ok' ? tr('integ.copied') : state === 'fail' ? tr('msg.copyFailed') : tr('common.copy')}
          </Text>
        </Pressable>
      </View>
      <View style={[styles.codeBox, { backgroundColor: t.input, borderColor: t.border, borderRadius: th.r(8) }]}>
        <Text
          selectable
          style={[styles.code, { color: t.text }, wrapStyle]}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

/** Numbered step. `done` true = green check; otherwise a neutral number (undefined = no tick known). */
export function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: React.ReactNode }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const tr = useT();
  // Frontier: square step plates; Astral: gold nodes (as in the staged progress)
  const shape = th.def.variants.tabs === 'tag' ? { borderRadius: 0 } : th.def.variants.tabs === 'folder' ? { borderColor: t.borderStrong } : null;
  const doneFill = th.def.variants.tabs === 'folder' ? t.accent : t.good;
  return (
    <View style={styles.step}>
      {done === true ? (
        <View style={[styles.circle, { backgroundColor: doneFill, borderColor: doneFill }, shape, th.def.variants.tabs === 'folder' && { borderColor: doneFill }]} accessibilityLabel={tr('status.done')}>
          <Icon name="check" size={15} color={th.def.variants.tabs === 'folder' ? t.accentText : '#ffffff'} />
        </View>
      ) : (
        <View style={[styles.circle, { borderColor: t.border, backgroundColor: t.bg }, shape]}>
          <Text style={[{ color: t.sub, fontSize: 13, fontWeight: '700' }, faces.num]}>{th.def.variants.tabs === 'tag' ? String(n).padStart(2, '0') : n}</Text>
        </View>
      )}
      <View style={styles.stepBody}>
        <Text style={[styles.stepTitle, { color: t.text }]}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 12, marginTop: 10, minWidth: 0, maxWidth: '100%' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  header: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  body: { marginTop: 4, minWidth: 0 },
  copyWrap: { marginTop: 8, minWidth: 0, maxWidth: '100%' },
  copyTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  copyLabel: { fontSize: 12, flexShrink: 1, minWidth: 0 },
  copyBtn: { borderWidth: 1, paddingHorizontal: 9, paddingVertical: 4, marginLeft: 'auto' },
  codeBox: { borderWidth: 1, padding: 10, marginTop: 6, minWidth: 0, maxWidth: '100%' },
  code: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13, lineHeight: 18 },
  step: { flexDirection: 'row', gap: 10, marginTop: 14, minWidth: 0, maxWidth: '100%' },
  circle: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stepBody: { flex: 1, minWidth: 0 },
  stepTitle: { fontSize: 14, fontWeight: '600', marginTop: 3 },
});
