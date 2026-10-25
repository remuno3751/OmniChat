// The composer's attachments (PROTOCOL-v7): the attach button, the chips above the input, the vision warning,
// and (web) paste and drop of files anywhere on the chat screen.
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import Icon from './Icon';
import { AttachThumb } from './AttachmentView';

import { addPicked, loadLimits, removeChip, setVisionOverrides, useAttachSupport, useChips, useLimits, useVisionOverrides, type PickedFile } from '../attachmentState';
import { getIsAdmin, putModelVision } from '../api';
import { attachErrorKey, audioNote, codeChipRefused, effectiveVision, formatBytes, hasImage, imageWarning, splitForCode, visionKey, type Chip, type Vision } from '../attachments';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { toast } from '../ui/toast';

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** Adds files and tells the user when the per-message limit cut some of them, or Code refused images and audio. */
function addWithNotice(files: PickedFile[], tr: Tr, max: number, codeMode = false) {
  if (!files.length) return;
  const { allowed, refused } = splitForCode(files, codeMode);
  if (refused > 0) toast(tr('attach.code.refused', { n: refused }), 'error');
  if (!allowed.length) return;
  const { dropped } = addPicked(allowed);
  if (dropped > 0) toast(tr('attach.overflow', { max, dropped }), 'error');
}

const fromWeb = (f: any): PickedFile => ({ name: f.name || 'file', mime: f.type || 'application/octet-stream', size: f.size || 0, blob: f });

/** The attach button and its small menu ("写真" / "ファイル"). */
/** In a Code conversation the photo entry is hidden: the bridge takes only documents (images and audio are refused). */
export function AttachButton({ disabled, codeMode = false }: { disabled?: boolean; codeMode?: boolean }) {
  const t = useTheme();
  const tr = useT();
  const limits = useLimits();
  const [menu, setMenu] = useState(false);
  const supported = useAttachSupport();
  useEffect(() => { void loadLimits(!!getIsAdmin()); }, []);
  if (!supported) return null;
  const run = async (kind: 'photo' | 'file') => {
    setMenu(false);
    if (Platform.OS === 'web') {
      const doc = (globalThis as any).document;
      const input = doc.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (kind === 'photo') input.accept = 'image/*';
      input.onchange = () => addWithNotice(Array.from(input.files || []).map(fromWeb), tr, limits.maxPerMessage, codeMode);
      input.click();
      return;
    }
    try {
      if (kind === 'photo') {
        const r: any = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 1 });
        if (r.canceled) return;
        addWithNotice((r.assets || []).map((a: any) => ({ name: a.fileName || 'image.jpg', mime: a.mimeType || 'image/jpeg', size: a.fileSize || 0, uri: a.uri })), tr, limits.maxPerMessage, codeMode);
      } else {
        const r: any = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
        if (r.canceled) return;
        addWithNotice((r.assets || []).map((a: any) => ({ name: a.name || 'file', mime: a.mimeType || 'application/octet-stream', size: a.size || 0, uri: a.uri })), tr, limits.maxPerMessage, codeMode);
      }
    } catch (e: any) {
      toast(e?.message || tr('attach.err.generic'), 'error');
    }
  };
  return (
    <View style={styles.btnWrap}>
      {menu && (
        <View style={[styles.menu, { backgroundColor: t.panel, borderColor: t.border }]}>
          {!codeMode && (
            <Pressable onPress={() => void run('photo')} accessibilityRole="button" style={styles.menuItem}>
              <Text style={{ color: t.text }}>{tr('attach.pick.photo')}</Text>
            </Pressable>
          )}
          <Pressable onPress={() => void run('file')} accessibilityRole="button" style={styles.menuItem}>
            <Text style={{ color: t.text }}>{tr('attach.pick.file')}</Text>
          </Pressable>
          {Platform.OS === 'web' && <Text style={[styles.menuHint, { color: t.sub, borderColor: t.border }]}>{tr('attach.hint')}</Text>}
        </View>
      )}
      <Pressable
        onPress={() => setMenu((m) => !m)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={tr('attach.button')}
        {...({ title: tr('attach.button') } as any)}
        style={[styles.btn, { borderColor: t.border, opacity: disabled ? 0.5 : 1 }]}
      >
        <Icon name="add" size={22} color={t.sub} />
      </Pressable>
    </View>
  );
}

/** Web: paste (clipboard files) and drop anywhere on the page add attachments. */
function useWebFileInput(onFiles: (f: PickedFile[]) => void) {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const win = globalThis as any;
    const onPaste = (e: any) => {
      const files = Array.from(e.clipboardData?.files || []) as any[];
      if (!files.length) return;
      e.preventDefault();
      onFiles(files.map(fromWeb));
    };
    const onDragOver = (e: any) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); };
    const onDrop = (e: any) => {
      const files = Array.from(e.dataTransfer?.files || []) as any[];
      if (!files.length) return;
      e.preventDefault();
      onFiles(files.map(fromWeb));
    };
    win.addEventListener('paste', onPaste);
    win.addEventListener('dragover', onDragOver);
    win.addEventListener('drop', onDrop);
    return () => {
      win.removeEventListener('paste', onPaste);
      win.removeEventListener('dragover', onDragOver);
      win.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);
}

/** The chips, the warnings, and the vision choice for the current model. Mount once in the chat screen. */
export function AttachChips({ providerId, model, listed, codeMode = false }: { providerId?: string; model?: string; listed?: Vision; codeMode?: boolean }) {
  const t = useTheme();
  const tr = useT();
  const chips = useChips();
  const limits = useLimits();
  const overrides = useVisionOverrides();
  const supported = useAttachSupport();
  const [vision, setVision] = useState(false);
  const max = limits.maxPerMessage;
  const onFiles = useCallback((f: PickedFile[]) => { if (supported) addWithNotice(f, tr, max, codeMode); }, [tr, max, supported, codeMode]);
  useWebFileInput(onFiles);
  if (!supported || !chips.length) return null;

  const vis = effectiveVision(providerId ?? '', model ?? '', listed, overrides);
  // Code: images and audio are not passed to the AI at all, so the vision and audio notes do not apply (the chip says so).
  const imgWarn = codeMode ? null : imageWarning(vis, hasImage(chips));
  const audio = !codeMode && chips.some((c) => audioNote(c.kind, limits.transcribeModel));
  const serverWarn = chips.flatMap((c) => c.warnings);

  const choose = async (choice: 'auto' | 'yes' | 'no') => {
    if (!providerId || !model) return;
    const next: Record<string, boolean> = { ...(overrides ?? {}) };
    const key = visionKey(providerId, model);
    if (choice === 'auto') delete next[key];
    else next[key] = choice === 'yes';
    const map = Object.keys(next).length ? next : null;
    try { await putModelVision(map); setVisionOverrides(map); setVision(false); } catch (e: any) { toast(e?.message || 'error', 'error'); }
  };

  return (
    <View style={styles.bar}>
      <View style={styles.chipRow}>
        {chips.map((c) => <ChipView key={c.localId} c={c} t={t} tr={tr} maxFileMB={limits.maxFileMB} codeRefused={codeChipRefused(c, codeMode)} />)}
      </View>
      {imgWarn && (
        <View style={styles.warnRow}>
          <Icon name="warning" size={14} color={t.accent} />
          <Text style={[styles.warn, { color: t.sub }]} accessibilityRole="alert">
            {tr(imgWarn === 'no' ? 'attach.warn.no' : 'attach.warn.unknown')}
          </Text>
          {providerId && model ? (
            <Pressable onPress={() => setVision(true)} accessibilityRole="button"><Text style={[styles.link, { color: t.accent }]}>{tr('attach.warn.details')}</Text></Pressable>
          ) : null}
        </View>
      )}
      {audio && <Text style={[styles.warn, { color: t.sub }]}>{tr('attach.warn.audio')}</Text>}
      {serverWarn.map((w, i) => <Text key={i} style={[styles.warn, { color: t.sub }]}>{w}</Text>)}

      <Modal visible={vision} transparent animationType="fade" onRequestClose={() => setVision(false)}>
        <Pressable style={styles.scrim} onPress={() => setVision(false)} />
        <View style={[styles.sheet, { backgroundColor: t.panel, borderColor: t.border }]}>
          <Text style={[styles.sheetTitle, { color: t.text }]}>{tr('attach.settings.modelVision')}</Text>
          <Text style={[styles.warn, { color: t.sub }]}>{tr('attach.settings.modelVisionHint')}</Text>
          {(['auto', 'yes', 'no'] as const).map((c) => {
            const key = providerId && model ? visionKey(providerId, model) : '';
            const cur = key && overrides && key in overrides ? (overrides[key] ? 'yes' : 'no') : 'auto';
            return (
              <Pressable key={c} onPress={() => void choose(c)} accessibilityRole="radio" accessibilityState={{ selected: cur === c }} style={[styles.opt, { borderColor: t.border }]}>
                <Text style={{ color: t.text, fontWeight: cur === c ? '700' : '400' }}>{tr(`attach.settings.vision.${c}`)}</Text>
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </View>
  );
}

function ChipView({ c, t, tr, maxFileMB, codeRefused }: { c: Chip; t: ReturnType<typeof useTheme>; tr: Tr; maxFileMB: number; codeRefused: boolean }) {
  const uploading = c.status === 'uploading';
  const pct = Math.round(c.progress * 100);
  const status = uploading ? tr('attach.uploading', { pct }) : c.status === 'error' ? '' : formatBytes(c.size);
  return (
    <View style={[styles.chip, { borderColor: c.status === 'error' || codeRefused ? t.danger : t.border, backgroundColor: t.input }]}>
      {c.kind === 'image' && c.status === 'ready' && c.id ? (
        <AttachThumb attachment={{ id: c.id, name: c.name, mime: c.mime, kind: 'image', size: c.size, status: 'ready' }} size={36} />
      ) : (
        <Icon name={c.kind === 'audio' ? 'modeChat' : 'docWord'} size={18} color={t.sub} />
      )}
      <View style={styles.chipText}>
        <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>{c.name}</Text>
        {c.status === 'error' ? (
          <Text style={[styles.small, { color: t.danger }]}>{tr(attachErrorKey(c.errorCode), { max: maxFileMB })}</Text>
        ) : codeRefused ? (
          <Text style={[styles.small, { color: t.danger }]} accessibilityRole="alert">{tr('attach.code.warn')}</Text>
        ) : (
          <Text style={[styles.small, { color: t.sub }]}>{status}</Text>
        )}
        {uploading && (
          <View style={[styles.track, { backgroundColor: t.border }]}>
            <View style={{ height: 3, width: `${pct}%`, backgroundColor: t.accent, borderRadius: 2 }} />
          </View>
        )}
      </View>
      <Pressable onPress={() => removeChip(c.localId)} accessibilityRole="button" accessibilityLabel={tr('attach.remove')} style={styles.x}>
        <Icon name="close" size={16} color={t.sub} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // above the context bar and the chips: the menu opens upward into them
  btnWrap: { position: 'relative', zIndex: 30, elevation: 30 },
  btn: { width: 40, height: 40, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  menu: { position: 'absolute', bottom: 46, left: 0, borderWidth: 1, borderRadius: 10, paddingVertical: 4, minWidth: 120, zIndex: 30, elevation: 30 },
  menuItem: { paddingHorizontal: 14, paddingVertical: 9 },
  menuHint: { width: 240, paddingHorizontal: 14, paddingVertical: 8, marginTop: 4, borderTopWidth: 1, fontSize: 12, lineHeight: 17 },
  bar: { paddingHorizontal: 10, paddingTop: 8, gap: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingLeft: 6, paddingRight: 4, paddingVertical: 4, maxWidth: '100%', minWidth: 0 },
  chipText: { flexShrink: 1, minWidth: 80, maxWidth: 220 },
  name: { fontSize: 13, fontWeight: '600' },
  small: { fontSize: 11 },
  track: { height: 3, borderRadius: 2, marginTop: 3, overflow: 'hidden' },
  x: { padding: 6 },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  warn: { fontSize: 12 },
  link: { fontSize: 12, textDecorationLine: 'underline' },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { position: 'absolute', left: 16, right: 16, top: '30%', borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  sheetTitle: { fontSize: 15, fontWeight: '700' },
  opt: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
});
