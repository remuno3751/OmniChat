import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { useTheme, useThemeDef, type ThemeRuntime } from '../theme';
import { FourStar, starPath } from './decor';

/**
 * Theme "skin" parts used by the screens: labels, badges, headings, ornaments and one-shot motion.
 * Every part either renders the Simple look unchanged or nothing at all in the Simple theme.
 * Ornaments are original geometry; nothing here loops.
 */

const native = Platform.OS !== 'web';

/** Text styles of the theme's type roles (heading / caps label / numbers). Empty objects in Simple. */
export function useFaces(): { heading: TextStyle; headingBold: TextStyle; label: TextStyle; labelBold: TextStyle; num: TextStyle } {
  const { def } = useThemeDef();
  return useMemo(() => {
    const f = def.fonts;
    if (!f.pack) return { heading: {}, headingBold: {}, label: {}, labelBold: {}, num: {} };
    const caps: TextStyle = f.labelCaps ? { textTransform: 'uppercase', letterSpacing: f.labelTracking } : { letterSpacing: f.labelTracking };
    // web: fall back to the body face for glyphs the display face lacks (Japanese)
    const stack = (face: string, bodyFace?: string) => (Platform.OS === 'web' && bodyFace ? `${face}, ${bodyFace}` : face);
    return {
      heading: f.heading ? { fontFamily: stack(f.heading.regular, f.body?.regular), fontWeight: 'normal' } : {},
      headingBold: f.heading ? { fontFamily: stack(f.heading.bold, f.body?.bold), fontWeight: 'normal' } : {},
      label: { ...(f.label ? { fontFamily: f.label.regular, fontWeight: 'normal' } : {}), ...caps },
      labelBold: { ...(f.label ? { fontFamily: f.label.bold, fontWeight: 'normal' } : {}), ...caps },
      num: f.label ? { fontFamily: f.label.regular, fontWeight: 'normal', fontVariant: ['tabular-nums'] } : {},
    };
  }, [def]);
}

/** Pressed-state transform of buttons (a slight press-in; none in Simple / reduced motion). */
export function pressStyle(th: ThemeRuntime, pressed: boolean): ViewStyle | null {
  // themes press in a bit; Simple gets a light 0.98. Amount scales the depth, Off / reduced motion disables it.
  const base = th.def.motion.pressScale === 1 ? 0.98 : th.def.motion.pressScale;
  return pressed && !th.reduceMotion ? { transform: [{ scale: 1 - (1 - base) * th.mo.distK }] } : null;
}

/**
 * Web-only CSS transition for state changes (hover, selected tab / segment, toggle, press). Spread into a style;
 * empty on native, with Animation amount Off or under prefers-reduced-motion. Cheap: the browser interpolates, no JS per frame.
 */
export function tx(th: ThemeRuntime, props: string[] = ['background-color', 'border-color', 'opacity', 'transform', 'color']): ViewStyle {
  if (native || !th.dur.fast) return {};
  const [a, b, c, d] = th.ease;
  return { transitionProperty: props.join(','), transitionDuration: `${th.dur.fast}ms`, transitionTimingFunction: `cubic-bezier(${a},${b},${c},${d})` } as any;
}

/**
 * One-shot entry motion on mount. 'wipe' (Frontier): fade + short straight slide from the left.
 * 'rise' (Astral, and Simple): fade + soft rise. Scaled by Settings > Appearance > Animation amount;
 * static when that is Off / under reduced motion, or with `skip` (e.g. rows that were already on screen).
 * `dist` is the travel in px before the amount factor (default 8); the scale dip is fixed. Opacity and transform run on the native driver.
 */
export function Enter({ children, style, delay = 0, from, skip, dist = 8 }: { children: React.ReactNode; style?: any; delay?: number; from?: 'left' | 'right'; skip?: boolean; dist?: number }) {
  const th = useThemeDef();
  const kind = th.def.motion.enter === 'none' ? 'rise' : th.def.motion.enter;
  const ms = skip ? 0 : th.dur.base;
  const v = useRef(new Animated.Value(!ms ? 1 : 0)).current;
  const [done, setDone] = useState(!ms); // afterwards the transform is dropped (no lingering containing block / blurry text)
  useEffect(() => {
    if (!ms) { v.setValue(1); return; }
    const [a, b, c, d] = th.ease;
    Animated.timing(v, { toValue: 1, duration: ms, delay: Math.min(delay, 240), easing: Easing.bezier(a, b, c, d), useNativeDriver: native }).start(() => setDone(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const k = th.mo.distK;
  const dx = (from === 'right' ? dist : -dist) * k;
  const transform = kind === 'wipe'
    ? [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) }]
    : [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [dist * k, 0] }) },{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1 - 0.015 * k, 1] }) }];
  if (!ms) return <View style={style}>{children}</View>;
  return <Animated.View style={done ? style : [style, { opacity: v, transform }]}>{children}</Animated.View>;
}

/** A value that runs 0 → 1 once on mount with the theme's timing, scaled by Animation amount (1 at once when Off / reduced motion). */
export function useOnce(duration: 'fast' | 'base' | 'slow' = 'base', delay = 0): Animated.Value {
  const th = useThemeDef();
  const ms = th.dur[duration];
  const v = useRef(new Animated.Value(ms ? 0 : 1)).current;
  useEffect(() => {
    if (!ms) { v.setValue(1); return; }
    const [a, b, c, d] = th.ease;
    Animated.timing(v, { toValue: 1, duration: ms, delay, easing: Easing.bezier(a, b, c, d), useNativeDriver: false }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

/**
 * Presence with an exit: `mounted` stays true for the exit duration after `visible` goes false; `v` runs 0 ↔ 1
 * (native driver). Use for drawers, popups and banners that should animate out instead of vanishing.
 */
export function usePresence(visible: boolean, duration: 'fast' | 'base' | 'slow' = 'base'): { mounted: boolean; v: Animated.Value } {
  const th = useThemeDef();
  const ms = th.dur[duration];
  const [mounted, setMounted] = useState(visible);
  const v = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    const [a, b, c, d] = th.ease;
    const easing = Easing.bezier(a, b, c, d);
    if (visible) {
      setMounted(true);
      if (!ms) { v.setValue(1); return; }
      Animated.timing(v, { toValue: 1, duration: ms, easing, useNativeDriver: native }).start();
    } else {
      if (!ms) { v.setValue(0); setMounted(false); return; }
      Animated.timing(v, { toValue: 0, duration: Math.round(ms * 0.8), easing, useNativeDriver: native }).start(({ finished }) => { if (finished) setMounted(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  return { mounted: mounted || visible, v };
}

/**
 * Unread / attention badge, absolutely placed at the parent's top-right corner.
 * Frontier: small orange dot. Astral: red disc with a white "!". Simple: nothing.
 */
export function NotifyBadge({ top = -3, right = -3, label }: { top?: number; right?: number; label?: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const v = th.def.variants.badge;
  const pop = useOnce('fast');
  if (v === 'none') return null;
  const scale = pop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1.2, 1] });
  const bang = v === 'bang';
  const size = bang ? 15 : 8;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLabel={label}
      style={{ position: 'absolute', top, right, width: size, height: size, borderRadius: size / 2, backgroundColor: t.notify, alignItems: 'center', justifyContent: 'center', transform: [{ scale }], borderWidth: bang ? 1.5 : 0, borderColor: '#ffffff' }}
    >
      {bang && <Text style={{ color: '#ffffff', fontSize: 10, lineHeight: 12, fontWeight: '800', fontFamily: Platform.select({ web: 'system-ui', default: undefined }) }}>!</Text>}
    </Animated.View>
  );
}

/** "NEW" tag. Frontier: yellow plate with black caps. Astral: amber tag with a small sparkle. Simple: accent outline. */
export function NewTag({ text }: { text: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const id = th.def.id;
  if (id === 'simple') {
    return <Text style={{ color: t.accentInk, fontSize: 10, fontWeight: '700', borderWidth: 1, borderColor: t.accent, borderRadius: 4, paddingHorizontal: 4 }}>{text}</Text>;
  }
  const astralLook = th.def.variants.badge === 'bang';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ backgroundColor: astralLook ? '#e6a14c' : t.accent2, paddingHorizontal: 6, paddingVertical: 1, borderRadius: astralLook ? 3 : 0 }}>
        <Text style={[{ color: '#1a1714', fontSize: 10, fontWeight: '700' }, faces.labelBold, { letterSpacing: 1 }]}>{text}</Text>
      </View>
      {astralLook && <View style={{ marginLeft: -4, marginTop: -12 }}><FourStar size={10} color="#fbe9b6" /></View>}
    </View>
  );
}

/**
 * Small label tag. Frontier: inverted plate (text colour fill, background-coloured caps).
 * Astral: pale-gold ticket chip. Simple: plain small grey text.
 */
export function Tag({ children, style }: { children: React.ReactNode; style?: any }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  if (th.def.id === 'simple') return <Text style={[{ color: t.sub, fontSize: 11, fontWeight: '600' }, style]}>{children}</Text>;
  if (th.def.variants.tabs === 'tag') {
    return (
      <View style={[{ alignSelf: 'flex-start', backgroundColor: t.text, paddingHorizontal: 6, paddingVertical: 1 }, style]}>
        <Text style={[{ color: t.bg, fontSize: 10, fontWeight: '700' }, faces.labelBold, { letterSpacing: 1.4 }]}>{children}</Text>
      </View>
    );
  }
  return (
    <View style={[{ alignSelf: 'flex-start', backgroundColor: th.dark ? 'rgba(215,196,147,0.18)' : '#e6d4b7', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 }, style]}>
      <Text style={[{ color: th.dark ? '#fbe9b6' : '#4a3f33', fontSize: 11 }, faces.labelBold]}>{children}</Text>
    </View>
  );
}

/** Thin gold rule with a centred four-point star (Astral); a hatched strip with a slash mark (Frontier). */
export function Rule({ style }: { style?: any }) {
  const t = useTheme();
  const th = useThemeDef();
  if (th.def.id === 'simple' || !th.fx) return null;
  if (th.def.variants.tabs === 'tag') {
    return (
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 6 }, style]} pointerEvents="none">
        <View style={{ width: 18, height: 3, backgroundColor: th.dark ? t.accent : t.accent2 }} />
        <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
      </View>
    );
  }
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6 }, style]} pointerEvents="none">
      <View style={{ flex: 1, height: 1, backgroundColor: t.borderStrong, opacity: 0.5 }} />
      <FourStar size={9} color={t.borderStrong} />
      <View style={{ flex: 1, height: 1, backgroundColor: t.borderStrong, opacity: 0.5 }} />
    </View>
  );
}

/** Section heading. Frontier: "//" + caps + hairline. Astral: star + text + gold line. Simple: the old bold text. */
export function SectionTitle({ title, first, simpleStyle }: { title: string; first?: boolean; simpleStyle: any }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  if (th.def.id === 'simple') return <Text style={[simpleStyle, { color: t.text, marginTop: first ? 0 : 18 }]}>{title}</Text>;
  const ef = th.def.variants.tabs === 'tag';
  return (
    <View accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: first ? 2 : 22, marginBottom: 2 }}>
      {ef
        ? <Text style={[{ color: th.dark ? t.accentInk : t.sub, fontSize: 12, fontWeight: '700' }, faces.labelBold]}>//</Text>
        : th.fx ? <FourStar size={11} color={t.accent} /> : null}
      <Text style={[{ color: t.text, fontSize: 15, fontWeight: '700' }, ef && faces.labelBold, ef && { fontSize: 13 }]}>{title}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: ef ? t.border : t.borderStrong, opacity: ef ? 1 : 0.45 }} />
    </View>
  );
}

/** Thin bar-code like strip (Frontier nameplates). Purely decorative. */
export function Barcode({ width = 64, height = 10, color }: { width?: number; height?: number; color: string }) {
  const bars = useMemo(() => {
    const out: { x: number; w: number }[] = [];
    let x = 0, s = 11;
    while (x < width) { s = (s * 48271) % 2147483647; const w = 1 + (s % 3); out.push({ x, w }); x += w + 1 + ((s >> 3) % 3); }
    return out;
  }, [width]);
  return (
    <Svg width={width} height={height}>
      {bars.map((b, i) => <Path key={i} d={`M${b.x} 0h${b.w}v${height}h${-b.w}z`} fill={color} />)}
    </Svg>
  );
}

/** Faint contour (topographic) lines filling the parent box: Frontier panels. */
export function Contour({ color, opacity = 0.12 }: { color: string; opacity?: number }) {
  const th = useThemeDef();
  if (!th.fx) return null;
  const rings = [1, 2, 3, 4, 5, 6];
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      <Svg width="100%" height="100%" viewBox="0 0 400 140" preserveAspectRatio="xMaxYMid slice">
        <G opacity={opacity} fill="none" stroke={color} strokeWidth="1">
          {rings.map((k) => (
            <Path key={k} d={`M${330 - k * 26} 70 C ${330 - k * 26} ${40 - k * 12}, ${360 + k * 8} ${22 - k * 10}, ${392 + k * 10} ${44 - k * 6} S ${420 + k * 14} ${110 + k * 10}, ${370} ${104 + k * 12} S ${330 - k * 26} ${100 + k * 4}, ${330 - k * 26} 70Z`} />
          ))}
        </G>
      </Svg>
    </View>
  );
}

/** Small filled squares at the four corners (Frontier title marks). */
export function CornerTicks({ color, size = 3, inset = -1 }: { color: string; size?: number; inset?: number }) {
  const th = useThemeDef();
  if (!th.fx || !th.def.shape.bracket) return null;
  const b = { position: 'absolute' as const, width: size, height: size, backgroundColor: color };
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[b, { top: inset, left: inset }]} />
      <View style={[b, { top: inset, right: inset }]} />
      <View style={[b, { bottom: inset, left: inset }]} />
      <View style={[b, { bottom: inset, right: inset }]} />
    </View>
  );
}

export interface Step { key: string; label: string; state: 'done' | 'current' | 'todo' }

/**
 * Astral-style staged progress: round nodes joined by a line; finished nodes are gold with a check,
 * the current one is a gold ring (its line grows in once), the rest are grey.
 */
export function NodeTrack({ steps }: { steps: Step[] }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const grow = useOnce('slow');
  const grey = th.dark ? 'rgba(255,255,255,0.28)' : 'rgba(42,40,39,0.25)';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && (
            <View style={{ width: 26, height: 2, marginTop: 7, backgroundColor: grey }}>
              {s.state !== 'todo' && (
                <Animated.View style={{ height: 2, backgroundColor: t.accent, width: s.state === 'current' ? grow.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '100%' }} />
              )}
            </View>
          )}
          <View style={{ alignItems: 'center', maxWidth: 84 }}>
            <View style={[nodeStyles.node, s.state === 'done' && { backgroundColor: t.accent, borderColor: t.accent }, s.state === 'current' && { borderColor: t.accent, backgroundColor: th.dark ? 'rgba(249,200,55,0.18)' : '#fff6d6' }, s.state === 'todo' && { borderColor: grey }]}>
              {s.state === 'done' && <Svg width={9} height={9} viewBox="0 0 10 10"><Path d="M1.5 5.2 4 7.6 8.6 2.4" stroke={t.accentText} strokeWidth={1.8} fill="none" /></Svg>}
              {s.state === 'current' && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent }} />}
            </View>
            <Text numberOfLines={1} style={[{ color: s.state === 'todo' ? t.sub : t.text, fontSize: 11, marginTop: 3, opacity: s.state === 'todo' ? 0.8 : 1 }, faces.label]}>{s.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}
const nodeStyles = StyleSheet.create({
  node: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});

/**
 * Frontier-style loading bar: "[" hatched track with a solid fill "]" + caps status + step counter.
 * The fill eases to the new value when the step changes (no looping).
 */
export function LoadBar({ value, label, counter }: { value: number; label: string; counter: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  const w = useRef(new Animated.Value(value)).current;
  useEffect(() => {
    const [a, b, c, d] = th.ease;
    Animated.timing(w, { toValue: value, duration: th.dur.slow, easing: Easing.bezier(a, b, c, d), useNativeDriver: false }).start();
  }, [value, th.dur.slow, th.ease, w]);
  const W = 120;
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={[{ color: t.sub, fontSize: 15 }, faces.num]}>[</Text>
        <View style={{ width: W, height: 6, justifyContent: 'center', overflow: 'hidden' }}>
          <View style={StyleSheet.absoluteFill}>
            <Svg width={W} height={6}>{Array.from({ length: Math.ceil(W / 5) }, (_, i) => <Line key={i} x1={i * 5} y1={6} x2={i * 5 + 6} y2={0} stroke={t.borderStrong} strokeWidth="1" />)}</Svg>
          </View>
          <Animated.View style={{ height: 4, backgroundColor: t.text, width: w.interpolate({ inputRange: [0, 1], outputRange: [0, W] }) }} />
        </View>
        <Text style={[{ color: t.sub, fontSize: 15 }, faces.num]}>]</Text>
        <Text style={[{ color: t.sub, fontSize: 11 }, faces.num]}>{counter}</Text>
      </View>
      <Text numberOfLines={1} style={[{ color: t.text, fontSize: 11 }, faces.labelBold]}>{label}</Text>
    </View>
  );
}

/** Speech bubble with a tail (Astral): white rounded card, dark text, tail at bottom-left or bottom-right. */
export function Speech({ children, tail = 'left', style }: { children: React.ReactNode; tail?: 'left' | 'right'; style?: any }) {
  const th = useThemeDef();
  const t = useTheme();
  const bubble = th.dark ? '#ffffff' : '#fffdf8';
  return (
    <View style={style}>
      <View style={[{ backgroundColor: bubble, borderRadius: th.r(16), borderWidth: 1, borderColor: th.dark ? '#ffffff' : t.borderStrong, paddingHorizontal: 14, paddingVertical: 10 }]}>{children}</View>
      <View style={[{ width: 12, height: 12, marginTop: -7, backgroundColor: bubble, transform: [{ rotate: '45deg' }], borderRightWidth: 1, borderBottomWidth: 1, borderColor: th.dark ? '#ffffff' : t.borderStrong }, tail === 'left' ? { marginLeft: 22 } : { alignSelf: 'flex-end', marginRight: 22 }]} />
    </View>
  );
}

/** Round emblem (Astral): ring + orbit + four-point star. An original mark, used as the speaker of hints. */
export function Emblem({ size = 34 }: { size?: number }) {
  const t = useTheme();
  const th = useThemeDef();
  const gold = th.dark ? '#d7c493' : '#8a7545';
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Circle cx="20" cy="20" r="18.5" fill={th.dark ? '#2e2c2e' : '#fffdf8'} stroke={gold} strokeWidth="1" />
      <Circle cx="20" cy="20" r="14" fill="none" stroke={gold} strokeWidth="0.6" strokeDasharray="1.5 2" />
      <Path d="M5 26 C 14 18, 26 14, 35 13" stroke={gold} strokeWidth="0.8" fill="none" />
      <Path d={starPath(20, 20, 8)} fill={t.accent} />
    </Svg>
  );
}
