import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { ApiError } from '../api';
import { apiDev } from '../apiDev';
import type { TokenizeResponse } from '../protocol';
import { t as tt, useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { copyText } from '../ui/clipboard';
import { Btn, Hint, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const MAX_CHIPS = 3000;
const vis = (s: string) => s.replace(/\n/g, '↵\n').replace(/\t/g, '→').replace(/^ +/, (m) => '·'.repeat(m.length));

/** Developer-mode token viewer: POST /tokenize, colour-alternating chips, count, exact / estimated badge. */
export default function TokenViewer({ visible, text, providerId, model, onClose }: {
  visible: boolean; text: string; providerId?: string | null; model?: string | null; onClose: () => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [data, setData] = useState<TokenizeResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    setData(null); setErr(''); setSel(null);
    if (!text.trim()) { setErr(tt('sheet.tokens.empty')); return; }
    let alive = true;
    setBusy(true);
    apiDev.tokenize({ providerId, model, text })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setErr(e instanceof ApiError && e.status === 404 ? tt('sheet.tokens.unsupported') : e.message || String(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [visible, text, providerId, model]);

  const tokens = data?.tokens || [];
  const shown = useMemo(() => tokens.slice(0, MAX_CHIPS), [tokens]);
  const cur = sel != null ? tokens[sel] : null;
  const copy = async (s: string) => toast((await copyText(s)) ? tr('msg.copied') : tr('msg.copyFailed'), 'ok');
  const chipBg = [t.userBubble, t.border];

  return (
    <Sheet visible={visible} onClose={onClose} title={tr('sheet.tokens.title')} width={680}>
      {busy && <ActivityIndicator color={t.accentInk} style={{ margin: 20 }} />}
      {!!err && <Hint danger>{err}</Hint>}
      {data && (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }} accessibilityLabel={tr('sheet.tokens.count', { n: data.count })}>{tr('sheet.tokens.count', { n: data.count })}</Text>
            <View style={[{ borderWidth: 1, borderColor: data.exact ? t.good : t.warn, paddingHorizontal: 5 }, { borderRadius: th.r(6) }]}>
              <Text style={{ color: data.exact ? t.good : t.warn, fontSize: 11, fontWeight: '700' }}>{data.exact ? tr('sheet.tokens.exact') : tr('sheet.tokens.estimated')}</Text>
            </View>
            <Text style={{ color: t.sub, fontSize: 12 }}>{data.source} · {tr('sheet.tokens.chars', { n: text.length })}</Text>
          </View>
          <View style={[{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, borderWidth: 1, borderColor: t.border, padding: 6, backgroundColor: t.bg }, { borderRadius: th.r(8) }]}>
            {shown.map((tok, i) => (
              <Pressable
                key={i}
                onPress={() => setSel(i)}
                onLongPress={() => setSel(i)}
                {...(Platform.OS === 'web' ? ({ onHoverIn: () => setSel(i), title: tok.id != null ? tr('sheet.tokens.idTitle', { id: tok.id }) : tr('sheet.tokens.idUnknown') } as any) : {})}
                accessibilityLabel={tok.id != null ? tr('sheet.tokens.a11yId', { n: i + 1, id: tok.id }) : tr('sheet.tokens.a11y', { n: i + 1 })}
                style={[{ backgroundColor: chipBg[i % 2], paddingHorizontal: 2, paddingVertical: 1, margin: 1, outlineWidth: 0 } as any, { borderRadius: th.r(4) }]}
              >
                <Text style={{ color: t.text, fontFamily: mono, fontSize: 13, borderBottomWidth: sel === i ? 2 : 0, borderColor: t.accent }}>{vis(tok.text) || ' '}</Text>
              </Pressable>
            ))}
          </View>
          {tokens.length > MAX_CHIPS && <Hint>{tr('sheet.tokens.showing', { max: MAX_CHIPS, total: tokens.length })}</Hint>}
          <Text style={{ color: t.sub, fontSize: 12, marginTop: 8, minHeight: 18 }}>
            {cur ? tr('sheet.tokens.current', { n: sel! + 1, id: cur.id ?? tr('sheet.tokens.na'), text: JSON.stringify(cur.text) }) : tr('sheet.tokens.hint')}
          </Text>
          {!data.exact && <Hint>{tr('sheet.tokens.estimatedHint')}</Hint>}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn small label={tr('sheet.tokens.copyTokens')} onPress={() => copy(tokens.map((x) => x.text).join('|'))} />
            {tokens.some((x) => x.id != null) && <Btn small label={tr('sheet.tokens.copyIds')} onPress={() => copy(JSON.stringify(tokens.map((x) => x.id)))} />}
            <Btn small label={tr('msg.copyJson')} onPress={() => copy(JSON.stringify(data, null, 2))} />
          </View>
        </View>
      )}
    </Sheet>
  );
}
