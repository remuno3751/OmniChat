import React, { useEffect, useState } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { Effort } from '../protocol';
import { useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { Brackets, DottedInner, FourStar, shadowStyle } from './decor';
import { Barcode, pressStyle, Rule, tx, useFaces, useOnce } from './skin';
import { KeyboardAvoid, useInsets, useKeyboard } from './safe';
import Icon from '../components/Icon';
import { t, useT } from '../i18n';

export const webNoOutline: any = Platform.OS === 'web' ? { outlineStyle: 'none' } : null;

export const EFFORTS: Effort[] = ['off', 'low', 'medium', 'high', 'max'];
export const effortLabel = (e: Effort | null | undefined) => t(e ? `effort.${e}` : 'effort.default');

export const useDevMode = () => useStore((s) => !!s.settings?.devMode);
export const useV3 = () => useStore((s) => s.v3);
export const useWide = (min = 700) => useWindowDimensions().width >= min;

export function Btn({ label, onPress, primary, danger, disabled, small, style }: {
  label: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; small?: boolean; style?: any;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const bs = th.def.variants.button;
  // Astral: the main action is a white pill (dark brown on light), the others a brown pill with a thin gold edge
  const pill = bs === 'pill';
  const fill = pill && primary ? (th.dark ? '#ffffff' : '#564e45') : pill && !danger && th.dark ? '#534645' : null;
  const ink = pill && primary ? (th.dark ? '#2a2827' : '#ffffff') : primary ? t.accentText : danger ? t.danger : t.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed, hovered }: any) => [
        styles.btn,
        tx(th),
        hovered && !disabled && { opacity: 0.88 },
        { borderColor: danger ? t.danger : t.border, opacity: disabled ? 0.5 : 1, borderRadius: bs === 'pill' ? 999 : th.r(8), borderWidth: th.bw },
        small && { paddingVertical: 5, paddingHorizontal: 9 },
        primary && { backgroundColor: t.accent, borderColor: t.accent },
        pill && { paddingHorizontal: small ? 12 : 16 },
        fill && { backgroundColor: fill, borderColor: primary ? fill : t.borderStrong + '99' },
        pressStyle(th, pressed),
        style,
      ]}
    >
      <Text style={{ color: ink, fontWeight: '600', fontSize: small ? 13 : 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const { def } = useThemeDef();
  const f = def.fonts;
  return (
    <Text
      style={[
        styles.label,
        { color: t.sub },
        f.labelCaps && { textTransform: 'uppercase', letterSpacing: f.labelTracking, fontSize: 11 },
        f.label && f.pack && { fontFamily: f.label.regular },
      ]}
    >{children}</Text>
  );
}
export function Hint({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  const t = useTheme();
  return <Text style={{ color: danger ? t.danger : t.sub, fontSize: 12, lineHeight: 17, marginTop: 4 }}>{children}</Text>;
}

export function Field({ label, value, onChangeText, placeholder, multiline, secure, minHeight, mono, keyboardType, autoFocus, onSubmit }: {
  label?: string; value: string; onChangeText: (v: string) => void; placeholder?: string; multiline?: boolean; secure?: boolean;
  minHeight?: number; mono?: boolean; keyboardType?: any; autoFocus?: boolean; onSubmit?: () => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  return (
    <View>
      {!!label && <Label>{label}</Label>}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.sub}
        multiline={multiline}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmit}
        accessibilityLabel={label || placeholder}
        style={[
          styles.input,
          { color: t.text, borderColor: t.border, backgroundColor: t.input, borderRadius: th.r(8), borderWidth: th.bw },
          // TextInput is not covered by the Text font patch (ui/textPatch.ts): apply the theme body face here.
          !mono && th.def.fonts.pack && th.def.fonts.body && { fontFamily: th.def.fonts.body.regular },
          multiline && { minHeight: minHeight ?? 90, textAlignVertical: 'top', maxHeight: 260 },
          mono && { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13 },
          webNoOutline,
        ]}
      />
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const radius = th.def.variants.button === 'pill' ? 999 : th.r(8);
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            disabled={o.disabled}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled: !!o.disabled }}
            style={({ hovered, pressed }: any) => [styles.segItem, tx(th), pressStyle(th, pressed), { borderRadius: radius, borderWidth: th.bw, borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : hovered ? t.panel2 : 'transparent', opacity: o.disabled ? 0.4 : 1 }]}
          >
            <Text style={{ color: on ? t.accentText : t.text, fontSize: 13, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Bottom sheet on phones, centred dialog on desktop. */
export function Sheet({ visible, onClose, title, children, footer, header, width = 560 }: {
  visible: boolean; onClose: () => void; title?: string; children: React.ReactNode; footer?: React.ReactNode; header?: React.ReactNode; width?: number;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const wide = useWide();
  const tr = useT();
  const hf = th.def.fonts;
  const sv = th.def.variants.sheet;
  const faces = useFaces();
  const ins = useInsets();
  const kb = useKeyboard();
  /** phone card: the bottom inset clears the nav bar, but not while the keyboard covers it */
  const sheetInset = !wide && !kb.visible ? ins.bottom : 0;
  // web: Esc closes the popup
  useEffect(() => {
    if (!visible || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, onClose]);
  // phone: platform slide; desktop: platform fade (also on close) + SheetIn scale/drop on open. None when animation is Off.
  const anim = th.reduceMotion ? 'none' : !wide ? 'slide' : 'fade';
  const closeBtn = (color: string) => (
    <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tr('common.close')} {...({ title: tr('common.close') } as any)}><Icon name="close" size={20} color={color} /></Pressable>
  );
  const titleText = (color: string, extra?: any) => (
    <Text style={[{ flex: 1, color, fontSize: 17, fontWeight: '700' }, hf.heading && hf.pack && faces.headingBold, hf.heading && hf.pack && { fontSize: hf.labelCaps ? 14 : 17 }, hf.labelCaps && { textTransform: 'uppercase', letterSpacing: hf.labelTracking }, extra]} numberOfLines={1}>{title || ''}</Text>
  );
  const body = (
    <>
      {!!header && <View style={{ marginBottom: 8 }}>{header}</View>}
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 6 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {!!footer && <View style={styles.footer}>{footer}</View>}
    </>
  );
  let card: React.ReactNode;
  if (sv === 'notebook') {
    // Astral: dark frame, a tab with the title joined to the paper body (cream in light, warm dark in dark), thin close cross on the frame.
    // The body keeps the current mode's palette because callers pass children already coloured for it.
    const frame = th.dark ? '#1c1b22' : '#564e45';
    const paper = t.panel;
    card = (
      <View style={[wide ? styles.dialog : styles.sheet, wide && { maxHeight: '100%', flexShrink: 1 }, { backgroundColor: frame, borderColor: th.dark ? t.borderStrong + '66' : frame, padding: 6, paddingTop: 0, maxWidth: wide ? width : undefined }, wide ? { borderRadius: th.r(24) } : { borderTopLeftRadius: th.r(24), borderTopRightRadius: th.r(24), paddingBottom: 6 + sheetInset }, shadowStyle(th.def, th.fx)]}>
        {!wide && <View style={[styles.grab, { backgroundColor: 'rgba(255,255,255,0.35)', marginTop: 8, marginBottom: 0 }]} />}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 14, paddingRight: 10, paddingTop: wide ? 8 : 4, gap: 8 }}>
          <View style={{ maxWidth: '78%', backgroundColor: paper, borderTopLeftRadius: th.r(12), borderTopRightRadius: th.r(12), paddingHorizontal: 16, paddingTop: 9, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {th.fx && <FourStar size={10} color="#e0a92a" />}
            <Text numberOfLines={1} style={[{ color: t.text, fontSize: 16, fontWeight: '700', flexShrink: 1 }, faces.headingBold, { fontSize: 16 }]}>{title || ''}</Text>
          </View>
          <View style={{ flex: 1 }} />
          <View style={{ paddingBottom: 8 }}>{closeBtn('#f1ebdd')}</View>
        </View>
        <View style={{ backgroundColor: paper, borderRadius: th.r(18), borderTopLeftRadius: th.r(4), padding: 16, flexShrink: 1 }}>
          <DottedInner inset={5} radius={Math.max(0, th.r(18) - 5)} />
          {body}
        </View>
      </View>
    );
  } else {
    const plate = sv === 'plate';
    card = (
      <View
        style={[
          wide ? styles.dialog : styles.sheet,
          wide && plate && { maxHeight: '100%', flexShrink: 1 },
          { backgroundColor: t.panel, borderColor: th.def.shape.bracket ? t.borderStrong : t.border, maxWidth: wide ? width : undefined },
          wide ? { borderRadius: th.r(16) } : { borderTopLeftRadius: th.r(18), borderTopRightRadius: th.r(18) },
          shadowStyle(th.def, th.fx),
          !wide && { paddingBottom: 22 + sheetInset },
        ]}
      >
        <Brackets inset={-1} />
        <DottedInner inset={5} radius={Math.max(0, th.r(16) - 5)} />
        {plate && <SheetTopLine />}
        {!wide && <View style={[styles.grab, { backgroundColor: t.border }, plate && { width: 28, height: 3, borderRadius: 0, backgroundColor: t.borderStrong }]} />}
        <View style={[styles.sheetTop, plate && { marginBottom: 10 }]}>
          {plate && <Text style={[{ color: th.dark ? t.accentInk : t.sub, fontSize: 13, fontWeight: '700' }, faces.labelBold]}>//</Text>}
          {titleText(t.text)}
          {plate && th.fx && wide && <Barcode width={44} height={10} color={t.borderStrong} />}
          {closeBtn(t.sub)}
        </View>
        {plate && <Rule style={{ marginTop: -4, marginBottom: 8 }} />}
        {body}
      </View>
    );
  }
  return (
    <Modal visible={visible} transparent animationType={anim} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityLabel={tr('common.close')} />
      <KeyboardAvoid
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, { justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center' }]}
      >
        {wide ? <SheetIn width={width}>{card}</SheetIn> : card}
      </KeyboardAvoid>
    </Modal>
  );
}

/** One-shot entrance of a desktop dialog: Frontier fades in and drops 6px straight; Astral / Simple scale up softly (scaled by Animation amount). */
function SheetIn({ children, width }: { children: React.ReactNode; width: number }) {
  const th = useThemeDef();
  const v = useOnce('slow');
  const wipe = th.def.motion.enter === 'wipe';
  const k = th.mo.distK;
  const transform = !wipe
    ? [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1 - 0.06 * k, 1] }) }]
    : [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-6 * k, 0] }) }];
  return <Animated.View style={{ width: '100%', maxWidth: width, maxHeight: '80%', alignItems: 'center', opacity: v, transform }}>{children}</Animated.View>;
}

/** Frontier plate: a thin yellow line along the top edge that wipes across once when the popup opens. */
function SheetTopLine() {
  const t = useTheme();
  const th = useThemeDef();
  const v = useOnce('slow', 60);
  if (!th.fx) return null;
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', top: -1, left: 0, height: 2, backgroundColor: t.accent2, width: v.interpolate({ inputRange: [0, 1], outputRange: ['0%', '38%'] }) }} />
  );
}

export interface MenuEntry { label: string; onPress: () => void; danger?: boolean; hidden?: boolean }
export function MenuSheet({ visible, onClose, title, items }: { visible: boolean; onClose: () => void; title?: string; items: MenuEntry[] }) {
  const t = useTheme();
  const th = useThemeDef();
  const themed = th.def.id !== 'simple';
  const ef = th.def.variants.tabs === 'tag';
  return (
    <Sheet visible={visible} onClose={onClose} title={title} width={360}>
      {items.filter((i) => !i.hidden).map((i) => (
        <Pressable
          key={i.label}
          onPress={() => { onClose(); i.onPress(); }}
          accessibilityRole="button"
          style={({ hovered }: any) => [styles.menuItem, tx(th), themed && { borderRadius: th.r(8), flexDirection: 'row', alignItems: 'center', gap: 10 }, hovered && { backgroundColor: themed ? t.panel2 : t.border }]}
        >
          {themed && <View style={{ width: 5, height: 5, backgroundColor: i.danger ? t.danger : t.borderStrong, borderRadius: ef ? 0 : 1, transform: ef ? undefined : [{ rotate: '45deg' }] }} />}
          <Text style={{ color: i.danger ? t.danger : t.text, fontSize: 16 }}>{i.label}</Text>
        </Pressable>
      ))}
    </Sheet>
  );
}

/** Small controlled toggle row. */
export function Check({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const t = useTheme();
  const th = useThemeDef();
  return (
    <Pressable onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value }} style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={[styles.box, tx(th), { borderRadius: th.r(5), borderColor: value ? t.accent : t.border, backgroundColor: value ? t.accent : 'transparent' }]}>
          {value && <Icon name="check" size={14} color={t.accentText} />}
        </View>
        <Text style={{ color: t.text, flex: 1, fontSize: 14 }}>{label}</Text>
      </View>
      {!!hint && <Hint>{hint}</Hint>}
    </Pressable>
  );
}

export function useDraft<T>(initial: T, resetKey: unknown): [T, (v: T) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => { setV(initial); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  return [v, setV];
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t('time.justNow');
  if (s < 3600) return t('time.minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hourAgo', { n: Math.floor(s / 3600) });
  return t('time.dayAgo', { n: Math.floor(s / 86400) });
}

export function ScreenHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useTheme();
  const tr = useT();
  const th = useThemeDef();
  const faces = useFaces();
  const ef = th.def.variants.tabs === 'tag';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.border }}>
      <Pressable onPress={onBack} hitSlop={8} accessibilityLabel={tr('common.back')}><Icon name="back" size={22} color={t.text} /></Pressable>
      {ef && th.fx && <View style={{ width: 4, height: 18, backgroundColor: th.dark ? t.accent : t.accent2 }} />}
      <Text style={[{ flex: 1, color: t.text, fontSize: 18, fontWeight: '600' }, faces.headingBold, th.def.id !== 'simple' && { fontSize: 19 }]} numberOfLines={1}>{title}</Text>
      {th.def.variants.tabs === 'folder' && th.fx && <FourStar size={12} color={t.accent} />}
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center', alignSelf: 'flex-start' },
  label: { fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  seg: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  segItem: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 7 },
  dialog: { width: '100%', maxHeight: '80%', borderWidth: 1, borderRadius: 16, padding: 16 },
  sheet: { width: '100%', maxHeight: '90%', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, padding: 14, paddingBottom: 22 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 8 },
  sheetTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  footer: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  menuItem: { paddingVertical: 13, paddingHorizontal: 10, borderRadius: 8 },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
