import React, { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import { apiV4 } from '../apiV4';
import { setDevice, useDevice } from '../deviceSettings';
import type { PetActivity } from '../deviceSettings';
import { useT } from '../i18n';
import { buildPetUpload, pickPetFiles, pickPetFolder } from '../petImport';
import type { PetInfo } from '../protocol';
import { patchSettingsLocal, useStore } from '../store';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Check, Hint, Label, Segmented } from '../ui/kit';
import { toast } from '../ui/toast';

// Sprite sheet geometry: a frame cell is 192x208; the sheet is 8 columns wide,
// 11 rows tall for v2 (1536x2288) and 9 rows for v1 (1536x1872).
const CELL_W = 192;
const CELL_H = 208;
const THUMB_W = 48;
const THUMB_H = 52;
const THUMB_SCALE = THUMB_W / CELL_W; // 0.25 (== THUMB_H / CELL_H)

/** First idle frame (row 0, column 0) of a pet's sheet, cropped to a 48x52 thumbnail. */
function PetThumb({ id, version }: { id: string; version: 1 | 2 }) {
  const t = useTheme();
  const th = useThemeDef();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiV4.petSheetBlobUrl(id).then((u) => { if (alive) setUrl(u); }, () => {});
    return () => { alive = false; };
  }, [id]);
  const sheetH = version === 1 ? 1872 : 2288;
  return (
    <View style={[styles.thumb, { backgroundColor: t.input, borderColor: t.border, borderRadius: th.r(6) }]}>
      {!!url && (
        <Image
          source={{ uri: url }}
          accessibilityIgnoresInvertColors
          style={{ position: 'absolute', left: 0, top: 0, width: 1536 * THUMB_SCALE, height: sheetH * THUMB_SCALE }}
        />
      )}
    </View>
  );
}

const ACTIVITIES: { value: PetActivity; label: string }[] = [
  { value: 'low', label: 'pets.activity.low' },
  { value: 'normal', label: 'pets.activity.normal' },
  { value: 'high', label: 'pets.activity.high' },
];

/** Settings > Appearance > Pets: visibility, the user's imported pets, import, size, activity, click-through. */
export default function PetsSettings() {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const pets = useDevice((s) => s.pets);
  const activePetId = useStore((s) => s.settings?.activePetId ?? null);
  const [list, setList] = useState<PetInfo[] | null>(null);
  const [phase, setPhase] = useState<'reading' | 'uploading' | null>(null);
  const web = Platform.OS === 'web';

  useEffect(() => {
    let alive = true;
    apiV4.pets().then(
      (r) => { if (alive) setList(r); },
      (e: any) => { if (alive) { setList([]); toast(e?.message || tr('pets.loadFailed'), 'error'); } },
    );
    return () => { alive = false; };
  }, []);

  const syncActive = async (id: string | null) => {
    await apiV4.putNotify({ activePetId: id });
    patchSettingsLocal({ activePetId: id });
  };

  const select = async (id: string) => {
    setDevice({ pets: { petId: id } });
    try {
      await syncActive(id);
    } catch (e: any) {
      toast(e?.message || tr('pets.saveFailed'), 'error');
    }
  };

  /** `pick` is called synchronously from the press handler so the file dialog keeps the user gesture. */
  const importWith = async (pick: () => Promise<File[]>) => {
    try {
      const files = await pick();
      if (!files.length) return;
      setPhase('reading');
      const body = await buildPetUpload(files);
      setPhase('uploading');
      const info = await apiV4.uploadPet(body);
      setList((prev) => [info, ...(prev || []).filter((p) => p.id !== info.id)]);
      toast(tr('pets.imported', { name: info.name }), 'ok');
      await select(info.id);
    } catch (e: any) {
      toast(e?.message || tr('pets.importFailed'), 'error');
    } finally {
      setPhase(null);
    }
  };

  const remove = async (p: PetInfo) => {
    const ok = await confirmDialog(tr('pets.deleteTitle'), tr('pets.deleteMsg', { name: p.name }), tr('pets.deleteOk'), true);
    if (!ok) return;
    try {
      await apiV4.deletePet(p.id);
      setList((prev) => (prev || []).filter((x) => x.id !== p.id));
      if (pets.petId === p.id) setDevice({ pets: { petId: null } });
      if (activePetId === p.id) await syncActive(null);
      toast(tr('pets.deleted'), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('pets.deleteFailed'), 'error');
    }
  };

  const stepSize = (delta: number) => setDevice({ pets: { size: Math.min(256, Math.max(64, pets.size + delta)) } });

  return (
    <View style={{ gap: 6 }}>
      <Check label={tr('pets.enabled')} value={pets.enabled} onChange={(v) => setDevice({ pets: { enabled: v } })} />

      <Label>{tr('pets.list')}</Label>
      {list !== null && list.length === 0 && <Hint>{tr('pets.none')}</Hint>}
      {(list || []).map((p) => {
        const selected = pets.petId === p.id;
        return (
          <View key={p.id} style={[styles.card, { borderColor: selected ? t.accent : t.border, backgroundColor: t.panel, borderRadius: th.r(10) }]}>
            <PetThumb id={p.id} version={p.spriteVersionNumber} />
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{p.name}</Text>
              {!!p.description && <Hint>{p.description}</Hint>}
              <Text style={[styles.badge, { color: t.sub, borderColor: t.border, borderRadius: th.r(6) }]}>{tr('pets.version', { version: p.spriteVersionNumber })}</Text>
            </View>
            <View style={styles.row}>
              <Btn
                small
                primary={selected}
                disabled={selected}
                label={selected ? tr('pets.selected') : tr('pets.select')}
                onPress={() => select(p.id)}
              />
              <Btn small danger label={tr('pets.delete')} onPress={() => remove(p)} />
            </View>
          </View>
        );
      })}

      {web ? (
        <>
          <View style={[styles.row, { marginTop: 8 }]}>
            <Btn small label={tr('pets.importFiles')} disabled={!!phase} onPress={() => importWith(pickPetFiles)} />
            <Btn small label={tr('pets.importFolder')} disabled={!!phase} onPress={() => importWith(pickPetFolder)} />
          </View>
          {!!phase && <Hint>{tr(phase === 'reading' ? 'pets.reading' : 'pets.uploading')}</Hint>}
        </>
      ) : (
        <Hint>{tr('pets.webOnly')}</Hint>
      )}

      <Label>{tr('pets.size')}</Label>
      <View style={styles.row}>
        <Btn small label="-" disabled={pets.size <= 64} onPress={() => stepSize(-16)} />
        <Text style={{ color: t.text, minWidth: 70, textAlign: 'center', fontSize: 15 }}>{tr('pets.sizePx', { n: pets.size })}</Text>
        <Btn small label="+" disabled={pets.size >= 256} onPress={() => stepSize(16)} />
      </View>

      <Label>{tr('pets.activity')}</Label>
      <Segmented<PetActivity>
        value={pets.activity}
        onChange={(v) => setDevice({ pets: { activity: v } })}
        options={ACTIVITIES.map((o) => ({ value: o.value, label: tr(o.label) }))}
      />

      <Check label={tr('label.pets.clickThrough')} value={pets.clickThrough} onChange={(v) => setDevice({ pets: { clickThrough: v } })} />

      <Hint>{tr('pets.note')}</Hint>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  card: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10 },
  thumb: { width: THUMB_W, height: THUMB_H, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  badge: { alignSelf: 'flex-start', fontSize: 11, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1, marginTop: 4, overflow: 'hidden' },
});
