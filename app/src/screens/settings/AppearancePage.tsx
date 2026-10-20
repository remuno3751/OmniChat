import React from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useDeviceSetting } from '../../deviceSettings';
import type { CodeScheme, MotionAmount, ParticleColorMode, StreamAnim, ThemeId, ThemeName } from '../../deviceSettings';
import { useColorScheme } from 'react-native';
import { THEMES, THEME_IDS } from '../../themes';
import { APP_ICONS, applyAppIcon } from '../../appIcon';
import { paletteFor, useTheme, useThemeDef } from '../../theme';
import { Btn } from '../../ui/kit';
import SliderField from '../../ui/SliderField';
import { PARTICLE_PRESETS, PARTICLE_SWATCHES, isHexColor } from '../../ui/particleFx';
import { TextInput } from 'react-native';
import Markdown from '../../components/Markdown';
import { useStreamText } from '../../ui/streamText';
import Svg, { Ellipse, Line, Path } from 'react-native-svg';
import Icon from '../../components/Icon';
import { starPath } from '../../ui/decor';
import { CornerTicks, LoadBar, NewTag, NodeTrack, NotifyBadge, Tag, type Step } from '../../ui/skin';
import PetsSettings from '../../components/PetsSettings';
import { useT } from '../../i18n';
import { Check, Hint, Label, Segmented } from '../../ui/kit';
import { PageFrame, Section } from './common';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Minus / plus stepper for a numeric setting. */
function Stepper({ value, min, max, step, format, onChange }: {
  value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const button = (label: string, delta: number) => {
    const next = clamp(value + delta, min, max);
    return (
      <Pressable
        onPress={() => onChange(next)}
        disabled={next === value}
        accessibilityRole="button"
        accessibilityLabel={label === '-' ? tr('set.decrease') : tr('set.increase')}
        style={[styles.stepBtn, { borderColor: t.border, opacity: next === value ? 0.4 : 1, borderRadius: th.r(8) }]}
      >
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '600' }}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.stepRow}>
      {button('-', -step)}
      <Text style={{ color: t.text, minWidth: 80, textAlign: 'center', fontSize: 15 }}>{format(value)}</Text>
      {button('+', step)}
    </View>
  );
}

/** One selectable theme card: a miniature of the theme's palette, shapes and ornaments in the current mode. */
function ThemeCard({ id, on, onPress }: { id: ThemeId; on: boolean; onPress: () => void }) {
  const t = useTheme();
  const tr = useT();
  const [name] = useDeviceSetting('theme');
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const def = THEMES[id];
  const { palette: p, mode } = paletteFor(def, name, system);
  const dark = mode === 'dark' || mode === 'contrast';
  const rad = (n: number) => (def.shape.radius ? (n >= 99 ? 12 : n <= 6 ? def.shape.radius.sm : def.shape.radius.lg) : n);
  const ef = def.variants.tabs === 'tag';
  const astralLook = def.variants.tabs === 'folder';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={tr(def.labelKey)}
      style={[styles.card, { borderColor: on ? t.accentInk : t.border, borderWidth: on ? 2 : 1, borderRadius: 10, backgroundColor: t.panel }]}
    >
      <View style={{ backgroundColor: astralLook && dark ? '#252b45' : p.bg, borderColor: p.border, borderWidth: 1, borderRadius: rad(8), padding: 8, gap: 5, overflow: 'hidden' }}>
        {ef && (
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
            {Array.from({ length: 16 }, (_, i) => <Line key={i} x1={i * 10 - 40} y1={60} x2={i * 10} y2={0} stroke={p.text} strokeWidth={0.6} opacity={0.08} />)}
          </Svg>
        )}
        {astralLook && (
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 134 62" preserveAspectRatio="xMidYMid slice">
            <Ellipse cx="96" cy="22" rx="70" ry="18" fill="none" stroke={p.borderStrong} strokeWidth={0.6} opacity={0.5} transform="rotate(-14 96 22)" />
            <Path d={starPath(118, 12, 5)} fill={p.accent} />
          </Svg>
        )}
        {ef && <View style={{ position: 'absolute', top: 8, left: 8, backgroundColor: p.text, height: 7, width: 26 }} />}
        <View style={{ backgroundColor: p.userBubble, borderRadius: rad(6), height: 12, width: '70%', alignSelf: 'flex-end', borderLeftWidth: ef ? 3 : 0, borderLeftColor: p.borderStrong, borderWidth: astralLook ? 1 : 0, borderColor: p.borderStrong }} />
        <View style={{ backgroundColor: p.botBubble, borderColor: p.border, borderWidth: 1, borderRadius: rad(6), height: 12, width: '80%', borderLeftWidth: ef ? 3 : 1, borderLeftColor: ef ? p.accentInk : p.border }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ backgroundColor: astralLook ? (dark ? '#ffffff' : '#564e45') : p.accent, borderRadius: def.variants.button === 'pill' ? 99 : rad(6), height: 12, width: 38 }} />
          {def.variants.badge !== 'none' && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.notify }} />}
        </View>
      </View>
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '600', marginTop: 6 }}>{tr(def.labelKey)}</Text>
      {id !== 'simple' && <View style={{ position: 'absolute', top: -7, right: -5 }}><NewTag text={tr('common.new')} /></View>}
    </Pressable>
  );
}

/** Live sample of the current theme: messages, staged progress, badge, tags and buttons (the phase display otherwise appears only while streaming). */
function ThemePreview() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const bv = th.def.variants.bubble;
  const steps: Step[] = [
    { key: 'thinking', label: tr('phase.step.thinking'), state: 'done' },
    { key: 'searching', label: tr('phase.step.searching'), state: 'current' },
    { key: 'answering', label: tr('phase.step.answering'), state: 'todo' },
  ];
  return (
    <View style={[styles.preview, { borderColor: t.border, backgroundColor: t.bg, borderRadius: th.r(10) }]}>
      <View style={[{ alignSelf: 'flex-end', maxWidth: '80%', backgroundColor: t.userBubble, padding: 10, borderRadius: th.r(12) }, bv === 'bar' && { borderLeftWidth: 3, borderLeftColor: t.borderStrong }, bv === 'card' && { borderWidth: 1, borderColor: t.borderStrong }]}>
        <Text style={{ color: t.text }}>{tr('appearance.previewUser')}</Text>
      </View>
      <View style={[{ alignSelf: 'flex-start', maxWidth: '80%', backgroundColor: t.botBubble, borderColor: t.border, borderWidth: 1, padding: 10, borderRadius: th.r(12), gap: 8 }, bv === 'bar' && { borderLeftWidth: 3, borderLeftColor: t.accentInk }]}>
        {th.def.variants.phase === 'loading'
          ? <LoadBar value={0.5} label={tr('phase.searchingNoLabel')} counter="02/03" />
          : <NodeTrack steps={steps} />}
        <Text style={{ color: t.text }}>{tr('appearance.previewBot')}</Text>
        {bv === 'bar' && <CornerTicks color={t.borderStrong} />}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Btn label={tr('appearance.previewBtn')} primary onPress={() => {}} small style={{ alignSelf: 'center' }} />
        <Btn label={tr('appearance.previewBtn')} onPress={() => {}} small style={{ alignSelf: 'center' }} />
        <View>
          <Icon name="settings" size={22} color={t.text} />
          <NotifyBadge label={tr('list.codeWaiting')} />
        </View>
        <Tag>{tr('hint.tips')}</Tag>
        <NewTag text={tr('common.new')} />
      </View>
    </View>
  );
}

/** Settings > Appearance: theme, code highlight scheme (with a live sample), font size, message width. */
export default function AppearancePage({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const tr = useT();
  const [theme, setTheme] = useDeviceSetting('theme');
  const [themeId, setThemeId] = useDeviceSetting('themeId');
  const [decorations, setDecorations] = useDeviceSetting('decorations');
  const [appIcon, setAppIcon] = useDeviceSetting('appIcon');
  const th = useThemeDef();
  const [scheme, setScheme] = useDeviceSetting('codeScheme');
  const [fontSize, setFontSize] = useDeviceSetting('fontSize');
  const [messageWidth, setMessageWidth] = useDeviceSetting('messageWidth');
  const [motionAmount, setMotionAmount] = useDeviceSetting('motionAmount');
  const [streamAnim, setStreamAnim] = useDeviceSetting('streamAnim');
  const [particleSize, setParticleSize] = useDeviceSetting('particleSize');
  const [particleIntensity, setParticleIntensity] = useDeviceSetting('particleIntensity');
  const [particleColorMode, setParticleColorMode] = useDeviceSetting('particleColorMode');
  const [particleColor, setParticleColor] = useDeviceSetting('particleColor');
  const [hexDraft, setHexDraft] = React.useState(particleColor);
  const [modelLogosOnline, setModelLogosOnline] = useDeviceSetting('modelLogosOnline');
  const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

  return (
    <PageFrame title={tr('settings.page.appearance')} onBack={onBack}>
      <Label>{tr('appearance.themeId')}</Label>
      <View style={styles.cards}>
        {THEME_IDS.map((id) => <ThemeCard key={id} id={id} on={themeId === id} onPress={() => setThemeId(id)} />)}
      </View>

      <Label>{tr('appearance.theme')}</Label>
      <Segmented<ThemeName>
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: tr('theme.system') },
          { value: 'light', label: tr('theme.light') },
          { value: 'dark', label: tr('theme.dark') },
          ...(themeId === 'simple'
            ? [{ value: 'sepia' as ThemeName, label: tr('theme.sepia') }, { value: 'contrast' as ThemeName, label: tr('theme.contrast') }]
            : []),
        ]}
      />

      <Label>{tr('appearance.appIcon')}</Label>
      <View style={styles.icons}>
        {APP_ICONS.map((ic) => {
          const label = `${tr(THEMES[ic.themeId].labelKey)} ${tr(`theme.${ic.mode}`)}`;
          const on = appIcon === ic.id;
          return (
            <Pressable
              key={ic.id}
              onPress={() => { setAppIcon(ic.id); void applyAppIcon(ic.id); }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              style={[styles.iconTile, { borderColor: on ? t.accentInk : 'transparent' }]}
            >
              <Image source={ic.image} style={styles.iconImg} />
              <Text style={{ color: t.sub, fontSize: 11, textAlign: 'center' }} numberOfLines={2}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Hint>{tr('appearance.appIconHint')}</Hint>

      {themeId !== 'simple' && (
        <>
          <Check
            label={`${tr('appearance.decorations')}${decorations === null ? ` (${tr('appearance.decorationsAuto')})` : ''}`}
            hint={tr('appearance.decorationsHint')}
            value={th.fx}
            onChange={setDecorations}
          />
          <Label>{tr('appearance.preview')}</Label>
          <ThemePreview />
        </>
      )}

      <Label>{tr('appearance.motion')}</Label>
      <Segmented<MotionAmount>
        value={motionAmount}
        onChange={setMotionAmount}
        options={(['off', 'reduced', 'standard', 'rich'] as const).map((v) => ({ value: v, label: tr(`appearance.motion.${v}`) }))}
      />
      <Hint>{tr('appearance.motionHint')}</Hint>

      <Label>{tr('appearance.streamAnim')}</Label>
      <Segmented<StreamAnim>
        value={streamAnim}
        onChange={setStreamAnim}
        options={(['smooth', 'particles', 'off'] as const).map((v) => ({ value: v, label: tr(`appearance.streamAnim.${v}`) }))}
      />
      <Hint>{tr('appearance.streamAnimHint')}</Hint>
      {streamAnim === 'particles' && (
        <>
          <SliderField label={tr('appearance.particleSize')} value={particleSize} min={0.2} max={3} step={0.1} onChange={setParticleSize} format={(v) => '×' + v.toFixed(1)} />
          <SliderField label={tr('appearance.particleIntensity')} value={particleIntensity} min={0.2} max={2.5} step={0.1} onChange={setParticleIntensity} format={(v) => (v < 0.4 ? tr('appearance.particleCalm') : v > 1.0 ? tr('appearance.particleFlashy') : tr('appearance.particleNormal')) + ' ×' + v.toFixed(1)} />
          <Label>{tr('appearance.particleColor')}</Label>
          <Segmented<ParticleColorMode>
            value={particleColorMode}
            onChange={setParticleColorMode}
            options={((['preset', 'text', 'custom'] as const)).map((v) => ({ value: v, label: tr(`appearance.particleColor.${v}`) }))}
          />
          {particleColorMode === 'preset' && <ColorDots colors={PARTICLE_PRESETS[themeId] ?? PARTICLE_PRESETS.simple} />}
          {particleColorMode === 'custom' && (
            <View style={{ marginTop: 8 }}>
              <ColorDots colors={PARTICLE_SWATCHES} selected={particleColor} onPick={(c) => { setParticleColor(c); setHexDraft(c); }} />
              <TextInput
                value={hexDraft}
                onChangeText={(v) => { const s = v.startsWith('#') ? v : '#' + v; setHexDraft(s); if (isHexColor(s)) setParticleColor(s.toLowerCase()); }}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                accessibilityLabel={tr('appearance.particleColor.custom')}
                style={{ marginTop: 8, borderWidth: 1, borderColor: t.border, color: t.text, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, width: 120, fontFamily: Platform.select({ default: 'monospace' }) }}
              />
            </View>
          )}
          <ParticlePreview />
        </>
      )}

      <Label>{tr('appearance.codeScheme')}</Label>
      <Segmented<CodeScheme>
        value={scheme}
        onChange={setScheme}
        options={[
          { value: 'midnight', label: tr('scheme.midnight') },
          { value: 'daylight', label: tr('scheme.daylight') },
          { value: 'solar', label: tr('scheme.solar') },
          { value: 'mono', label: tr('scheme.mono') },
        ]}
      />
      <View style={[styles.sample, { backgroundColor: t.code, borderColor: t.border, borderRadius: th.r(10) }]}>
        <Text style={{ fontFamily: mono, fontSize, color: t.codeText, lineHeight: fontSize * 1.45 }}>
          <Text style={{ color: t.hl.comment }}>{'// sample\n'}</Text>
          <Text style={{ color: t.hl.keyword }}>const </Text>
          <Text style={{ color: t.hl.fn }}>greet</Text>
          <Text style={{ color: t.codeText }}> = (</Text>
          <Text style={{ color: t.hl.type }}>name</Text>
          <Text style={{ color: t.codeText }}>) =&gt; </Text>
          <Text style={{ color: t.hl.string }}>{'"hi "'}</Text>
          <Text style={{ color: t.codeText }}> + </Text>
          <Text style={{ color: t.hl.number }}>42</Text>
          <Text style={{ color: t.codeText }}>;</Text>
        </Text>
      </View>

      <Label>{tr('appearance.fontSize')}</Label>
      <Stepper value={fontSize} min={12} max={24} step={1} format={(v) => tr('set.px', { n: v })} onChange={setFontSize} />

      <Label>{tr('appearance.messageWidth')}</Label>
      <Stepper value={messageWidth} min={560} max={1200} step={40} format={(v) => tr('set.px', { n: v })} onChange={setMessageWidth} />

      <Check
        label={tr('appearance.modelLogosOnline')}
        hint={tr('appearance.modelLogosOnlineHint')}
        value={modelLogosOnline}
        onChange={setModelLogosOnline}
      />

      <Section title={tr('appearance.pets')} />
      <PetsSettings />
    </PageFrame>
  );
}

const styles = StyleSheet.create({
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  iconTile: { width: 84, padding: 6, gap: 4, alignItems: 'center', borderWidth: 2, borderRadius: 12 },
  iconImg: { width: 56, height: 56, borderRadius: 12 },
  card: { width: 150, padding: 8 },
  preview: { borderWidth: 1, padding: 14, gap: 10 },
  sample: { borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  stepBtn: { width: 44, height: 40, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});

/** Runs a short fake reply through the Particles effect so the sliders can be tuned without waiting for the model. */
function ParticlePreview() {
  const tr = useT();
  const t = useTheme();
  const [n, setN] = React.useState(0);
  const [run, setRun] = React.useState(0);
  const sample = tr('appearance.particleSample');
  React.useEffect(() => {
    if (!run) return;
    setN(0);
    const id = setInterval(() => setN((v) => { if (v >= sample.length) { clearInterval(id); return v; } return v + 6; }), 120);
    return () => clearInterval(id);
  }, [run, sample]);
  const streaming = run > 0 && n < sample.length;
  const shown = useStreamText(run ? sample.slice(0, n) : '', streaming, 'particles');
  return (
    <View style={{ marginTop: 8 }}>
      <Btn label={tr('appearance.particlePreview')} onPress={() => setRun((r) => r + 1)} small />
      <View style={{ minHeight: 64, marginTop: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border }}>
        {run > 0 && <Markdown text={shown} t={t} streaming={streaming} />}
      </View>
    </View>
  );
}

/** A row of color dots: pickable swatches (custom) or a read-only preview of a theme preset. */
function ColorDots({ colors, selected, onPick }: { colors: string[]; selected?: string; onPick?: (c: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
      {colors.map((c) => (
        <Pressable
          key={c}
          disabled={!onPick}
          onPress={() => onPick?.(c)}
          accessibilityRole={onPick ? 'button' : undefined}
          accessibilityLabel={c}
          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c, borderWidth: selected?.toLowerCase() === c.toLowerCase() ? 3 : 1, borderColor: selected?.toLowerCase() === c.toLowerCase() ? t.text : t.border }}
        />
      ))}
    </View>
  );
}
