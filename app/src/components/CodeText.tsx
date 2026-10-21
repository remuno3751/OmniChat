import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '../theme';
import { tokenize } from './highlight';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
/** Same cut-off as Markdown code blocks: longer files are shown uncolored (keeps big files fast). */
const HIGHLIGHT_MAX_LINES = 600;

/** Language id for tokenize() from a file name or path ('src/app.ts' -> 'ts'); '' when there is no extension. */
export function langOfPath(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Code shown in a side / full-screen panel with the same colors as a chat code block (theme `code`, `codeText`, `hl`).
 * The text is selectable; long lines scroll sideways inside the panel's own vertical ScrollView.
 */
export default function CodeText({ body, lang, t, size = 12 }: { body: string; lang: string; t: Theme; size?: number }) {
  const tokens = useMemo(
    () => (body.split('\n').length > HIGHLIGHT_MAX_LINES ? null : tokenize(body, lang)),
    [body, lang],
  );
  return (
    <View style={[styles.box, { backgroundColor: t.code, borderColor: t.border }]}>
      <Text selectable style={[styles.text, { color: t.codeText, fontSize: size, lineHeight: Math.round(size * 1.5) }]}>
        {tokens
          ? tokens.map((tk, k) => (tk.kind === 'plain' ? tk.text : <Text key={k} style={{ color: t.hl[tk.kind] }}>{tk.text}</Text>))
          : body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10 },
  text: { fontFamily: MONO },
});
