import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { resolveConflictPrompt } from '../chatActions';
import { usePrompt } from '../modelLoadState';
import { CHOICE_ORDER, RECOMMENDED, formatBytes, loadedSummary } from '../modelLoad';
import type { Choice, ModelConflictInfo } from '../modelLoad';
import type { ConflictPrompt } from '../modelLoadState';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Check, Sheet } from '../ui/kit';
import { pressStyle } from '../ui/skin';

/**
 * Asks what to do when a chat needs a model while another chat model is loaded (PROTOCOL-v7-modelload.md).
 * Mount once (App.tsx, next to ConfirmHost). Shown while usePrompt() is non-null; the answer goes to resolveConflictPrompt.
 */
export function ModelConflictHost() {
  const prompt = usePrompt();
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [remember, setRemember] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const recRef = useRef<any>(null);

  // a new prompt (or a re-opened one after an error) starts unchecked; the picked model defaults to the first loaded one
  useEffect(() => { if (!prompt) { setRemember(false); setPick(null); } }, [prompt]);
  // initial keyboard focus on the recommended option (web); Enter then activates it
  useEffect(() => {
    if (!prompt || Platform.OS !== 'web') return;
    const id = setTimeout(() => recRef.current?.focus?.(), 0);
    return () => clearTimeout(id);
  }, [prompt]);

  const conflict = prompt?.conflict ?? null;
  const selId = conflict && pick && conflict.loaded.some((l) => l.id === pick) ? pick : conflict?.loaded[0]?.id ?? null;
  const warnTint = t.warn ?? t.danger;
  const onClose = () => { if (prompt) resolveConflictPrompt('cancel'); };
  const choose = (c: Choice) => resolveConflictPrompt(c, { remember, useModel: c === 'use_loaded' ? selId ?? undefined : undefined });

  return (
    <Sheet visible={!!prompt} onClose={onClose} title={prompt ? tr('modelload.title') : undefined} width={520}>
      {!!prompt && !!conflict && (
        <View style={{ gap: 8 }}>
          {!!prompt.error && (
            <Text accessibilityRole="alert" style={{ color: t.danger, fontSize: 13, fontWeight: '600', lineHeight: 18 }}>{prompt.error}</Text>
          )}
          <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>
            {tr('modelload.subtitle', { model: modelName(prompt, tr), loaded: loadedSummary(conflict) })}
          </Text>
          {CHOICE_ORDER.map((c) => {
            const recommended = c === RECOMMENDED;
            const isUse = c === 'use_loaded';
            const isBoth = c === 'load_both';
            const isCancel = c === 'cancel';
            const title = isUse
              ? tr('modelload.choice.use.title', { model: selId ?? '' })
              : tr(`modelload.choice.${titleKey(c)}.title`);
            const desc = tr(`modelload.choice.${titleKey(c)}.desc`);
            const ink = recommended ? t.accentText : t.text;
            const sub = recommended ? t.accentText : t.sub;
            return (
              <View
                key={c}
                style={[
                  styles.row,
                  { borderRadius: th.r(10), borderWidth: th.bw, borderColor: recommended ? t.accent : isBoth ? warnTint : t.border, backgroundColor: recommended ? t.accent : t.panel2 },
                ]}
              >
                <Pressable
                  ref={recommended ? recRef : undefined}
                  onPress={() => choose(c)}
                  accessibilityRole="button"
                  accessibilityLabel={title}
                  style={({ pressed }: any) => [styles.main, pressStyle(th, pressed)]}
                >
                  <View style={styles.titleLine}>
                    <Text style={[styles.title, { color: ink }]}>{title}</Text>
                    {recommended && (
                      <Text style={[styles.badge, { color: ink, borderColor: ink, borderRadius: th.r(6) }]}>{tr('modelload.recommended')}</Text>
                    )}
                  </View>
                  <Text style={[styles.desc, { color: sub }]}>{desc}</Text>
                  {isBoth && <Text accessibilityRole="alert" style={[styles.warn, { color: warnTint }]}>{tr('modelload.warnBoth')}</Text>}
                </Pressable>
                {isUse && conflict.loaded.length > 1 && (
                  <View style={styles.picks}>
                    {conflict.loaded.map((l) => {
                      const on = l.id === selId;
                      const size = formatBytes(l.sizeBytes);
                      return (
                        <Pressable
                          key={l.id}
                          onPress={() => setPick(l.id)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={l.id}
                          style={({ pressed }: any) => [styles.pick, { borderRadius: th.r(6), borderWidth: th.bw, borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent' }, pressStyle(th, pressed)]}
                        >
                          <Text style={{ color: on ? t.accentText : t.text, fontSize: 13, fontWeight: on ? '600' : '400' }}>
                            {size ? `${l.id} (${size})` : l.id}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
          <Check
            label={tr('modelload.remember')}
            hint={tr('modelload.rememberHint')}
            value={remember}
            onChange={setRemember}
          />
        </View>
      )}
    </Sheet>
  );
}

const titleKey = (c: Choice): string => (c === 'unload_then_load' ? 'unload' : c === 'use_loaded' ? 'use' : c === 'load_both' ? 'both' : 'cancel');

/** "model (4.2 GB)" when the size is known. */
function modelName(p: ConflictPrompt, tr: (k: string, v?: Record<string, string | number>) => string): string {
  const c: ModelConflictInfo = p.conflict;
  const size = formatBytes(c.modelSizeBytes);
  return size ? tr('modelload.modelWithSize', { model: c.model, size }) : c.model;
}

const styles = StyleSheet.create({
  row: { overflow: 'hidden' },
  main: { paddingHorizontal: 12, paddingVertical: 10, gap: 3 },
  titleLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  badge: { fontSize: 11, fontWeight: '700', borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  desc: { fontSize: 13, lineHeight: 18 },
  warn: { fontSize: 12, lineHeight: 17, fontWeight: '600', marginTop: 2 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingBottom: 10 },
  pick: { paddingHorizontal: 10, paddingVertical: 5, maxWidth: '100%' },
});
