import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SlashEntry } from '../templates';
import { useTheme, useThemeDef } from '../theme';

const ROW_HEIGHT = 52;
const MAX_HEIGHT = 240;

/**
 * Floating list above the composer, shown while the draft starts with '/'. Positioned absolutely
 * (bottom: 100%) inside the composer container. Keyboard handling lives in ChatScreen.
 */
export default function SlashMenu({ entries, active, onPick }: {
  entries: SlashEntry[]; active: number; onPick: (e: SlashEntry) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const scroller = useRef<ScrollView>(null);

  // keep the highlighted row visible when moving with the arrow keys
  useEffect(() => {
    const top = active * ROW_HEIGHT;
    scroller.current?.scrollTo({ y: Math.max(0, top - (MAX_HEIGHT - ROW_HEIGHT) / 2), animated: false });
  }, [active]);

  return (
    <View
      accessibilityRole={'menu' as any}
      style={[styles.box, { backgroundColor: t.panel, borderColor: t.border, borderRadius: th.r(12) }]}
    >
      <ScrollView ref={scroller} style={{ maxHeight: MAX_HEIGHT }} keyboardShouldPersistTaps="always">
        {entries.map((e, i) => {
          const on = i === active;
          return (
            <Pressable
              key={e.key}
              onPress={() => onPick(e)}
              accessibilityRole={'menuitem' as any}
              accessibilityState={{ selected: on }}
              style={[styles.row, { minHeight: ROW_HEIGHT, backgroundColor: on ? t.border : 'transparent', borderRadius: th.r(8) }]}
            >
              <Text style={{ color: t.text, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                {`/${e.name}`}
              </Text>
              {!!e.description && (
                <Text style={{ color: t.sub, fontSize: 12 }} numberOfLines={1}>{e.description}</Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute', bottom: '100%', left: 10, right: 10, marginBottom: 6,
    borderWidth: 1, borderRadius: 12, padding: 4, zIndex: 50, elevation: 50,
  },
  row: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, justifyContent: 'center' },
});
