import React, { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useT } from '../i18n';
import { Btn, Field, Hint, Label } from '../ui/kit';
import { toast } from '../ui/toast';
import { AriaHttpError } from '../voice/ariaRest';
import { checkVoiceFile, VOICE_PARTS, type VoiceFileKind } from '../voice/ariaVoices';
import {
  isNotSupportedYet, isUnprocessable, isUnsupportedFormat, PIPER_ID_RE, piperUploadPath, voiceModelUploadPath,
} from '../voice/voiceApi';
import { ctx, errText, uploadWithProgress } from './voiceUi';

/** A picked file, read only when it is sent. */
interface Picked { name: string; size: number; getBlob: () => Promise<Blob> }
type Picks = { model?: Picked; config?: Picked; zip?: Picked };

/** Standard: one .aivmx, sent at once. Fast (piper): the .onnx and its .json together, or one .zip with both. */
export default function VoiceModelUpload({ kind, onUploaded }: { kind: VoiceFileKind; onUploaded: (name: string) => void }) {
  const tr = useT();
  const [picks, setPicks] = useState<Picks>({});
  const [id, setId] = useState('');
  const [upName, setUpName] = useState('');
  const [pct, setPct] = useState(0);
  const abort = useRef<(() => void) | null>(null);
  const fileRef = useRef<any>(null);
  const uploading = !!upName;
  const piperReady = PIPER_ID_RE.test(id) && (!!picks.zip || (!!picks.model && !!picks.config));

  /** Sends the steps in order under one label; then reports the name (the id for piper). */
  const run = async (label: string, steps: { path: string; file: Picked }[]) => {
    const { base, token } = ctx();
    setUpName(label);
    setPct(0);
    try {
      for (const st of steps) await uploadWithProgress(`${base}${st.path}`, token, await st.file.getBlob(), setPct, abort);
      toast(tr('voice.voices.uploaded', { name: label }), 'info');
      setPicks({});
      setId('');
      onUploaded(label);
    } catch (e) {
      if (!(e instanceof AriaHttpError && e.message === 'aborted')) {
        toast(
          isUnprocessable(e) ? tr('host.set.piper422')
            : isUnsupportedFormat(e) ? tr('host.set.uploadUnsupported')
              : isNotSupportedYet(e) ? tr('host.set.notSupported')
                : tr('voice.voices.err.upload', { msg: errText(tr, e) }),
          'error',
        );
      }
    }
    abort.current = null;
    setUpName('');
  };

  /** Every picked file goes through checkVoiceFile; a standard .aivmx is sent at once. */
  const accept = (p: Picked) => {
    const c = checkVoiceFile(kind, p.name, p.size);
    if (!c.ok) {
      const key = c.reason === 'ext' ? (kind === 'piper' ? 'host.set.errExtPiper' : 'voice.voices.err.ext') : `voice.voices.err.${c.reason}`;
      toast(tr(key), 'error');
      return;
    }
    if (c.part === 'aivmx') { void run(c.name, [{ path: voiceModelUploadPath(c.name), file: p }]); return; }
    // a .zip replaces the two files, and the two files replace a .zip
    setPicks((cur) => (c.part === 'zip' ? { zip: p } : { ...cur, zip: undefined, ...(c.part === 'model' ? { model: p } : { config: p }) }));
  };

  const openPicker = async () => {
    if (Platform.OS === 'web') { fileRef.current?.click(); return; }
    try {
      const DocumentPicker = await import('expo-document-picker');
      const r: any = await DocumentPicker.getDocumentAsync({ multiple: kind === 'piper', copyToCacheDirectory: true, type: '*/*' });
      if (r.canceled || !r.assets?.length) return;
      for (const a of r.assets) accept({ name: a.name || '', size: a.size || 0, getBlob: async () => (await fetch(a.uri)).blob() });
    } catch (e: any) { toast(tr('voice.voices.err.upload', { msg: e?.message ? String(e.message).slice(0, 200) : '' }), 'error'); }
  };

  const uploadPiper = () => {
    const steps = picks.zip
      ? [{ path: piperUploadPath(id, 'zip'), file: picks.zip }]
      : [{ path: piperUploadPath(id, 'model'), file: picks.model! }, { path: piperUploadPath(id, 'config'), file: picks.config! }];
    void run(id, steps);
  };

  const picked = (p?: Picked) => (p ? tr('host.set.picked', { name: p.name }) : tr('host.set.notPicked'));

  let body: React.ReactNode;
  if (uploading) {
    body = (
      <>
        <Hint>{tr('voice.voices.uploading', { name: upName, pct })}</Hint>
        <View style={{ flexDirection: 'row' }}><Btn small label={tr('voice.voices.cancel')} onPress={() => abort.current?.()} /></View>
      </>
    );
  } else if (kind === 'aivmx') {
    body = (
      <>
        <View style={{ flexDirection: 'row' }}><Btn label={tr('voice.voices.add')} onPress={() => void openPicker()} /></View>
        <Hint>{tr('host.set.addHint')}</Hint>
      </>
    );
  } else {
    body = (
      <>
        <Hint>{tr('host.set.piperHint')}</Hint>
        <Label>{tr('host.set.piperPickOnnx')}</Label>
        <Hint>{picked(picks.model)}</Hint>
        <Label>{tr('host.set.piperPickConfig')}</Label>
        <Hint>{picked(picks.config)}</Hint>
        <Label>{tr('host.set.piperPickZip')}</Label>
        <Hint>{picked(picks.zip)}</Hint>
        <View style={{ flexDirection: 'row' }}><Btn small label={tr('host.set.piperPick')} onPress={() => void openPicker()} /></View>
        <Field label={tr('host.set.piperId')} value={id} onChangeText={setId} placeholder="my-voice" />
        <Hint danger={!!id && !PIPER_ID_RE.test(id)}>{!!id && !PIPER_ID_RE.test(id) ? tr('host.set.piperIdBad') : tr('host.set.piperIdHint')}</Hint>
        {!piperReady && <Hint>{tr('host.set.piperNeedFiles')}</Hint>}
        <View style={{ flexDirection: 'row' }}><Btn label={tr('host.set.piperAdd')} disabled={!piperReady} onPress={uploadPiper} /></View>
      </>
    );
  }

  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      {body}
      {Platform.OS === 'web' && React.createElement('input', {
        ref: fileRef,
        type: 'file',
        accept: Object.keys(VOICE_PARTS[kind]).join(','),
        multiple: kind === 'piper',
        style: { display: 'none' },
        onChange: (e: any) => {
          // copy the list first: clearing the input empties it
          const files: File[] = Array.from(e.target.files ?? []);
          e.target.value = '';
          for (const f of files) accept({ name: f.name, size: f.size, getBlob: async () => f });
        },
      })}
    </View>
  );
}
