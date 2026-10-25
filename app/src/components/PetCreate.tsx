// Settings > Appearance > Pets > "Create a pet": the spec, a copy-able image-generator prompt, and the
// import of up to six state images (stills pets). Web uses a file input and canvas optimisation; native uses
// the document picker and uploads the original files (must be 600 KB or less).
import React, { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiV4 } from '../apiV4';
import { useDevice } from '../deviceSettings';
import { resolveLanguage, useT } from '../i18n';
import { pickStillFiles, prepareStills } from '../petImport';
import type { StillUpload } from '../petImport';
import { pickNativeStillFiles, prepareNativeStills } from '../petImportNative';
import { buildPetPrompt, cleanPetName, makeStillsPetId, stillSelectionProblem, STILL_STATES } from '../petStills';
import type { StillState } from '../petStills';
import type { PetInfo } from '../protocol';
import { useTheme, useThemeDef } from '../theme';
import { copyText } from '../ui/clipboard';
import { Btn, Field, Hint, Label } from '../ui/kit';
import { toast } from '../ui/toast';

/** Creates a stills pet: copy the prompt, generate the six images, pick them here, name the pet. */
export default function PetCreate({ onCreated }: { onCreated: (info: PetInfo) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const language = useDevice((s) => s.language);
  const prompt = buildPetPrompt(resolveLanguage(language) === 'ja' ? 'ja' : 'en');
  const web = Platform.OS === 'web';
  const [phase, setPhase] = useState<'reading' | 'creating' | null>(null);
  const [prepared, setPrepared] = useState<Partial<Record<StillState, StillUpload>> | null>(null);
  const [name, setName] = useState('');

  const copy = async () => {
    const ok = await copyText(prompt);
    toast(tr(ok ? 'pets.create.copied' : 'pets.create.copyFailed'), ok ? 'ok' : 'error');
  };

  /** pickStillFiles() is the first call so the file dialog keeps the press gesture. */
  const pick = async () => {
    let files: Array<{ name: string }>;
    try {
      files = web ? await pickStillFiles() : await pickNativeStillFiles();
    } catch (e: any) {
      toast(e?.message || tr('pets.create.importFailed'), 'error');
      return;
    }
    if (!files.length) return;
    const problem = stillSelectionProblem(files.map((f) => f.name));
    if (problem) {
      toast(tr(problem.key, { names: 'names' in problem ? problem.names : '' }), 'error');
      return;
    }
    setPhase('reading');
    try {
      setPrepared(web
        ? await prepareStills(files as File[])
        : await prepareNativeStills(files as any[], tr));
    } catch (e: any) {
      setPrepared(null);
      toast(e?.message || tr('pets.create.importFailed'), 'error');
    } finally {
      setPhase(null);
    }
  };

  const create = async () => {
    const displayName = cleanPetName(name);
    if (!displayName) { toast(tr('pets.create.needName'), 'error'); return; }
    if (!prepared?.idle) { toast(tr('pets.create.needIdle'), 'error'); return; }
    const images: Record<string, { mime: string; dataBase64: string }> = {};
    for (const s of STILL_STATES) {
      const im = prepared[s];
      if (im) images[s] = { mime: im.mime, dataBase64: im.dataBase64 };
    }
    setPhase('creating');
    try {
      const info = await apiV4.createStillsPet({ id: makeStillsPetId(displayName), displayName, images: images as any });
      onCreated(info);
      setPrepared(null);
      setName('');
      toast(tr('pets.create.created', { name: info.name || displayName }), 'ok');
    } catch (e: any) {
      toast(e?.message || tr('pets.create.createFailed'), 'error');
    } finally {
      setPhase(null);
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <Label>{tr('pets.create.title')}</Label>
      <Hint>{tr('pets.create.intro')}</Hint>
      <Hint>{tr('pets.create.spec')}</Hint>
      <View style={[styles.box, { borderColor: t.border, backgroundColor: t.input, borderRadius: th.r(8) }]}>
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
          <Text selectable style={{ color: t.text, fontSize: 12, lineHeight: 17 }}>{prompt}</Text>
        </ScrollView>
      </View>
      <View style={styles.row}>
        <Btn small primary label={tr('pets.create.copy')} onPress={copy} />
      </View>

      <Label>{tr('pets.create.importTitle')}</Label>
      <Hint>{tr('pets.create.importHint')}</Hint>
      <View style={styles.row}>
        <Btn small label={tr('pets.create.import')} disabled={!!phase} onPress={pick} />
      </View>
      {phase === 'reading' && <Hint>{tr('pets.create.reading')}</Hint>}
      {!!prepared && (
        <>
          <Hint>{tr('pets.create.found', { list: STILL_STATES.filter((s) => prepared[s]).join(', ') })}</Hint>
          <Field label={tr('pets.create.name')} value={name} onChangeText={setName} placeholder={tr('pets.create.namePlaceholder')} />
          <View style={styles.row}>
            <Btn small primary label={phase === 'creating' ? tr('pets.uploading') : tr('pets.create.create')} disabled={!!phase} onPress={create} />
            <Btn small label={tr('common.cancel')} disabled={!!phase} onPress={() => setPrepared(null)} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  box: { borderWidth: 1, padding: 10 },
});
