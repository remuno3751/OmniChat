import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import type { PetItem } from '../petItems';

const GREEN = '#2e8b57';
const RED = '#c0392b';

/**
 * One chat's bubble on the desktop pet (v2): the chat's title small on top, the state text below. An unread
 * finish shows a coloured circle (green check = done, red "!" = error) and a ✕ that dismisses it. The body
 * opens the chat. Used by the pager (one bubble) and the stack (several).
 */
export default function PetItemBubble({
  item,
  lines,
  onOpen,
  onDismiss,
}: {
  item: PetItem;
  /** lines of the state text (1 in the stack, 2 in the pager) */
  lines: 1 | 2;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const tr = useT();
  const failed = item.unread && item.mode === 'failed';
  const title = item.title.trim() || tr('pets.item.untitled');
  return (
    <View style={styles.box}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={tr('pets.item.open')}
        style={styles.main}
      >
        {item.unread && (
          <View style={[styles.badge, { backgroundColor: failed ? RED : GREEN }]}>
            <Text style={styles.glyph}>{failed ? '!' : '✓'}</Text>
          </View>
        )}
        <View style={styles.texts}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>{title}</Text>
          <Text numberOfLines={lines} ellipsizeMode="tail" style={styles.label}>{item.label}</Text>
        </View>
      </Pressable>
      {item.unread && (
        <Pressable
          onPress={onDismiss}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={tr('pets.item.dismiss')}
          style={styles.x}
        >
          <Text style={styles.xText}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 260,
    minWidth: 180,
    backgroundColor: '#fffdf7',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.28)',
    borderRadius: 12,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  texts: { flex: 1, minWidth: 0 },
  title: { color: '#6b6660', fontSize: 11, lineHeight: 14 },
  label: { color: '#1d1b1a', fontSize: 14, lineHeight: 19 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  glyph: { color: '#fff', fontSize: 13, fontWeight: '700', lineHeight: 16 },
  x: { paddingHorizontal: 6, paddingVertical: 4, marginLeft: 2 },
  xText: { color: '#6b6660', fontSize: 13 },
});
