import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../api';
import { apiHistory, deliverBlobWeb, setAvail } from '../apiHistory';
import { useT } from '../i18n';
import { fmtBytes, fmtDate } from '../historyTypes';
import type { BackupInfo } from '../historyTypes';
import { useTheme, useThemeDef } from '../theme';
import { confirmDialog } from '../ui/confirm';
import { Btn, Hint, ScreenHeader } from '../ui/kit';
import { toast } from '../ui/toast';

export default function BackupScreen({ onBack }: { onBack: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 'create' | backup name
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await apiHistory.backups();
      setList([...r].sort((a, b) => b.createdAt - a.createdAt));
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 401)) { setForbidden(true); setAvail('admin', 'no'); }
      else setErr(e?.message || tr('backup.loadFailed'));
    }
  }, [tr]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy('create'); setNote('');
    try {
      await apiHistory.createBackup();
      toast(tr('backup.created'), 'ok');
      await load();
    } catch (e: any) { toast(e?.message || tr('backup.failed'), 'error'); }
    setBusy(null);
  };
  const download = async (b: BackupInfo) => {
    if (Platform.OS !== 'web') {
      setNote(tr('backup.nativeNote', { name: b.name }));
      return;
    }
    setBusy(b.name);
    try { deliverBlobWeb(b.name, await apiHistory.backupBlob(b.name)); }
    catch (e: any) { toast(e?.message || tr('backup.downloadFailed'), 'error'); }
    setBusy(null);
  };
  const del = async (b: BackupInfo) => {
    if (!(await confirmDialog(tr('backup.deleteTitle'), tr('backup.deleteMsg', { name: b.name }), tr('common.delete')))) return;
    setBusy(b.name);
    try { await apiHistory.deleteBackup(b.name); await load(); }
    catch (e: any) { toast(e?.message || tr('list.deleteFailed'), 'error'); }
    setBusy(null);
  };

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScreenHeader title={tr('backup.title')} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        {forbidden ? (
          <Text style={{ color: t.sub }}>{tr('backup.adminOnly')}</Text>
        ) : (
          <>
            <Text style={{ color: t.sub, fontSize: 13, lineHeight: 19 }}>
              {tr('backup.schedule')}
            </Text>
            <Btn primary label={busy === 'create' ? tr('backup.creating') : tr('backup.createNow')} disabled={busy !== null} onPress={create} style={{ marginTop: 12 }} />
            {!!note && <Hint>{note}</Hint>}
            {!!err && <View style={{ marginTop: 12, gap: 8 }}><Text style={{ color: t.danger }}>{err}</Text><Btn small label={tr('common.retry')} onPress={load} /></View>}
            {list === null && !err && <ActivityIndicator color={t.accentInk} style={{ marginTop: 20 }} />}
            {list !== null && list.length === 0 && <Text style={{ color: t.sub, marginTop: 20 }}>{tr('backup.empty')}</Text>}
            {list?.map((b) => (
              <View key={b.name} style={[styles.card, { borderRadius: th.r(12) }, { borderColor: t.border, backgroundColor: t.panel }]}>
                <View style={{ flex: 1, minWidth: 140 }}>
                  <Text numberOfLines={1} selectable style={{ color: t.text, fontWeight: '600' }}>{b.name}</Text>
                  <Text style={{ color: t.sub, fontSize: 12 }}>{fmtBytes(b.size)} · {fmtDate(b.createdAt)}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Btn small label={tr('backup.download')} disabled={busy !== null} onPress={() => download(b)} />
                  <Btn small danger label={tr('common.delete')} disabled={busy !== null} onPress={() => del(b)} />
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, width: '100%', maxWidth: 720, alignSelf: 'center', paddingBottom: 40 },
  card: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderWidth: 1, padding: 12, marginTop: 8 },
});
