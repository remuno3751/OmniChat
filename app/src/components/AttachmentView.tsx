// Attachments in a message bubble (PROTOCOL-v7): image thumbnails with a lightbox, file and audio rows, deleted ones.
import React, { useEffect, useState } from 'react';
import { Image, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { attachmentBlobUrl } from '../api';
import { formatBytes, INLINE_IMAGE_MAX_BYTES } from '../attachments';
import type { Attachment } from '../protocol';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import Icon from './Icon';

/** Loads the original of an image (object URL on web, data URI on native) and releases it on unmount. */
function useAttachmentUri(id: string, enabled: boolean): { uri: string | null; failed: boolean } {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let revoke: (() => void) | null = null;
    attachmentBlobUrl(id)
      .then((r) => { if (alive) { revoke = r.revoke; setUri(r.url); } else r.revoke(); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; revoke?.(); };
  }, [id, enabled]);
  return { uri, failed };
}

/** A small image preview. Originals above INLINE_IMAGE_MAX_BYTES are not loaded here (a placeholder instead). */
export function AttachThumb({ attachment, size = 64, onPress }: { attachment: Attachment; size?: number; onPress?: () => void }) {
  const t = useTheme();
  const tr = useT();
  const big = attachment.size > INLINE_IMAGE_MAX_BYTES;
  const { uri, failed } = useAttachmentUri(attachment.id, !big);
  const box = [styles.thumb, { width: size, height: size, borderColor: t.border, backgroundColor: t.input }];
  let body: React.ReactNode;
  if (big) body = <Text style={[styles.small, { color: t.sub }]} numberOfLines={3}>{tr('attach.bubble.bigImage')}</Text>;
  else if (failed) body = <Text style={[styles.small, { color: t.sub }]}>{tr('attach.bubble.loadFailed')}</Text>;
  else if (uri) body = <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" accessibilityLabel={attachment.name} />;
  else body = <Icon name="refresh" size={20} color={t.sub} />;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tr('attach.bubble.open')} style={box}>
      {body}
    </Pressable>
  );
}

/** Full-size view of one image; closes on the button or the backdrop. */
function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const t = useTheme();
  const tr = useT();
  const { uri, failed } = useAttachmentUri(attachment.id, true);
  const download = () => {
    if (Platform.OS !== 'web' || !uri) return;
    const doc = (globalThis as any).document;
    const a = doc.createElement('a');
    a.href = uri;
    a.download = attachment.name;
    doc.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={tr('attach.bubble.close')}>
        {uri ? <Image source={{ uri }} style={styles.full} resizeMode="contain" /> : <Text style={{ color: '#fff' }}>{failed ? tr('attach.bubble.loadFailed') : '…'}</Text>}
      </Pressable>
      <View style={styles.bar}>
        {Platform.OS === 'web' && uri ? (
          <Pressable onPress={download} accessibilityRole="button" style={[styles.barBtn, { borderColor: t.border }]}>
            <Text style={{ color: '#fff' }}>{tr('attach.bubble.download')}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} accessibilityRole="button" style={[styles.barBtn, { borderColor: t.border }]}>
          <Text style={{ color: '#fff' }}>{tr('attach.bubble.close')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** The attachments of one message, in the bubble. */
export default function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const t = useTheme();
  const tr = useT();
  const [open, setOpen] = useState<Attachment | null>(null);
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  if (!attachments.length) return null;

  // web: fetch the file and click a temporary link (the server sends it as an attachment)
  const saveFile = async (a: Attachment) => {
    if (Platform.OS !== 'web' || fileBusy) return;
    setFileBusy(a.id);
    try {
      const r = await attachmentBlobUrl(a.id);
      const doc = (globalThis as any).document;
      const el = doc.createElement('a');
      el.href = r.url;
      el.download = a.name;
      doc.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(r.revoke, 1000);
    } catch { /* the name stays; nothing else to show here */ } finally { setFileBusy(null); }
  };

  return (
    <View style={styles.wrap}>
      {attachments.map((a) => {
        if (a.status === 'deleted') {
          return (
            <View key={a.id} style={[styles.row, { borderColor: t.border }]}>
              <Text style={[styles.small, { color: t.sub, textDecorationLine: 'line-through' }]} numberOfLines={1}>{a.name}</Text>
              <Text style={[styles.small, { color: t.sub }]}>{tr('attach.bubble.deleted')}</Text>
            </View>
          );
        }
        if (a.kind === 'image') {
          return <AttachThumb key={a.id} attachment={a} onPress={() => setOpen(a)} />;
        }
        const icon = a.kind === 'audio' ? 'modeChat' : 'docWord';
        const row = (
          <View style={[styles.row, { borderColor: t.border }]}>
            <Icon name={icon} size={18} color={t.sub} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>{a.name}</Text>
              <Text style={[styles.small, { color: t.sub }]}>{formatBytes(a.size)}</Text>
            </View>
          </View>
        );
        return Platform.OS === 'web'
          ? <Pressable key={a.id} onPress={() => void saveFile(a)} accessibilityRole="button" accessibilityLabel={tr('attach.bubble.download')} style={styles.pressRow}>{row}</Pressable>
          : <View key={a.id} style={styles.pressRow}>{row}</View>;
      })}
      {open ? <Lightbox attachment={open} onClose={() => setOpen(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  thumb: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  pressRow: { maxWidth: '100%' },
  name: { fontSize: 13, fontWeight: '600' },
  small: { fontSize: 11 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  full: { width: '100%', height: '100%' },
  bar: { position: 'absolute', bottom: 24, right: 16, flexDirection: 'row', gap: 8 },
  barBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
});
