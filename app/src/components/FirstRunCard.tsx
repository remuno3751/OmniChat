import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { addDetectedProvider, visibleServers } from '../detectedProviders';
import type { LocalServer } from '../protocol';
import { activeProviders, useStore } from '../store';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Btn } from '../ui/kit';
import { toast } from '../ui/toast';

/** Re-detection on web focus is throttled to at most once per this many ms. */
const REDETECT_MIN_MS = 5000;

/**
 * Shown on an empty chat when no model provider is configured. Looks for local model servers
 * (LM Studio, Ollama) on the server PC and offers one-tap setup, or a way to a cloud API key.
 */
export default function FirstRunCard({ onOpenModels }: { onOpenModels: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const providersMap = useStore((s) => s.providers);
  const [found, setFound] = useState<LocalServer[]>([]);
  const [loading, setLoading] = useState(false);
  /** baseUrl of the server being added (LocalServer has no id) */
  const [adding, setAdding] = useState<string | null>(null);
  const lastRun = useRef(0);
  /** guards against an older detection finishing after a newer one */
  const seq = useRef(0);

  const detect = useCallback(async (throttled: boolean) => {
    const now = Date.now();
    if (throttled && now - lastRun.current < REDETECT_MIN_MS) return;
    lastRun.current = now;
    const my = ++seq.current;
    setLoading(true);
    let list: LocalServer[] = [];
    try {
      const r = await api.localServers();
      list = Array.isArray(r?.servers) ? r.servers : [];
    } catch {
      // any failure, including 404 from an older server, counts as "nothing found"
      list = [];
    }
    if (my !== seq.current) return;
    setFound(list);
    setLoading(false);
  }, []);

  useEffect(() => { void detect(false); }, [detect]);

  useEffect(() => {
    // web: the user may have just started LM Studio / Ollama in another window
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onVisible = () => { if (document.visibilityState === 'visible') void detect(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [detect]);

  const visible = useMemo(() => visibleServers(found, activeProviders(providersMap).flatMap((p) => (p.baseUrl ? [{ baseUrl: p.baseUrl }] : []))), [found, providersMap]);

  const add = async (s: LocalServer) => {
    if (adding) return;
    setAdding(s.baseUrl);
    try {
      await addDetectedProvider(s);
      toast(tr('firstrun.added', { name: s.name }), 'info');
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    } finally {
      setAdding(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(12), borderWidth: th.bw }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>{tr('firstrun.title')}</Text>

        {visible.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.headRow}>
              <Text style={[styles.sub, { color: t.sub }]}>{tr('firstrun.detected')}</Text>
              {loading && <ActivityIndicator size="small" color={t.accent} />}
            </View>
            {visible.map((s) => {
              const count = s.models === 1 ? tr('set.models.count1') : tr('set.models.countN', { n: s.models });
              return (
                <View key={s.baseUrl} style={[styles.row, { borderColor: t.border, borderRadius: th.r(10), borderWidth: th.bw }]}>
                  <View style={styles.rowText}>
                    <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>{s.name}</Text>
                    <Text style={[styles.meta, { color: t.sub }]} numberOfLines={1} ellipsizeMode="middle">{`${s.baseUrl} · ${count}`}</Text>
                  </View>
                  <Btn small primary label={tr('firstrun.addThis')} disabled={adding !== null} onPress={() => void add(s)} />
                </View>
              );
            })}
          </View>
        ) : loading ? (
          <View style={styles.section}>
            <ActivityIndicator color={t.accent} />
          </View>
        ) : (
          <View style={styles.section}>
            <Text style={[styles.body, { color: t.text }]}>{tr('firstrun.none')}</Text>
            <Text style={[styles.hint, { color: t.sub }]}>{tr('firstrun.docsHint')}</Text>
            <View style={styles.actions}>
              <Btn small label={tr('firstrun.detectAgain')} onPress={() => void detect(false)} />
            </View>
          </View>
        )}

        <View style={styles.footer}>
          <Btn label={tr('firstrun.cloud')} onPress={onOpenModels} />
          <Pressable
            onPress={onOpenModels}
            accessibilityRole="link"
            accessibilityLabel={tr('firstrun.openSettings')}
            style={styles.link}
          >
            <Text style={[styles.linkText, { color: t.accent }]}>{tr('firstrun.openSettings')}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center', width: '100%', maxWidth: 520, marginTop: 40, paddingHorizontal: 4 },
  card: { width: '100%', padding: 18, gap: 14 },
  title: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  section: { gap: 10 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sub: { fontSize: 13, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: 10 },
  rowText: { flex: 1, flexShrink: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
  body: { fontSize: 14, lineHeight: 21 },
  hint: { fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  link: { paddingVertical: 6 },
  linkText: { fontSize: 14, textDecorationLine: 'underline' },
});
