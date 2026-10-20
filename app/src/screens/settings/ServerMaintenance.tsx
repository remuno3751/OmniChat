import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../../api';
import { adminApi } from '../../apiAdmin';
import type { AdminLogLevel } from '../../apiAdmin';
import { apiHistory, deliverText } from '../../apiHistory';
import { useT } from '../../i18n';
import { fmtBytes, fmtDate } from '../../historyTypes';
import type { BackupInfo } from '../../historyTypes';
import { useTheme, useThemeDef } from '../../theme';
import { confirmDialog } from '../../ui/confirm';
import { Btn, Hint, Label, Segmented, Sheet } from '../../ui/kit';
import { toast } from '../../ui/toast';

type RestartPhase = 'idle' | 'starting' | 'waiting' | 'back' | 'timeout' | 'failed';
type LogCount = '50' | '100' | '200';

const HEALTH_INTERVAL_MS = 1500;
const HEALTH_TIMEOUT_MS = 60000;
// Fallback when the server never seems to go down (for example a very fast respawn).
const NO_DOWN_FALLBACK_MS = 8000;

const MONO = Platform.select({
  web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  ios: 'Menlo',
  default: 'monospace',
}) as string;

/** Settings > Server > Maintenance section body (the parent renders the heading). Admin only. */
export default function ServerMaintenance({ onChanged }: { onChanged?: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();

  // ---- restart ----
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rPhase, setRPhase] = useState<RestartPhase>('idle');
  const [rMode, setRMode] = useState<'supervised' | 'respawn' | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /** Polls /version until the server answers again (after it has gone down), up to 60 s. */
  const pollHealth = useCallback(() => {
    const started = Date.now();
    let wentDown = false;
    const tick = async () => {
      if (!alive.current) return;
      let ok = false;
      try { await api.version(); ok = true; } catch { ok = false; }
      if (!alive.current) return;
      const elapsed = Date.now() - started;
      if (!ok) wentDown = true;
      if (ok && (wentDown || elapsed >= NO_DOWN_FALLBACK_MS)) {
        setRPhase('back');
        toast(tr('admin.maint.restart.back'), 'ok');
        return;
      }
      if (elapsed >= HEALTH_TIMEOUT_MS) {
        setRPhase('timeout');
        return;
      }
      timer.current = setTimeout(tick, HEALTH_INTERVAL_MS);
    };
    timer.current = setTimeout(tick, HEALTH_INTERVAL_MS);
  }, [tr]);

  const restart = async () => {
    setConfirmOpen(false);
    setRPhase('starting');
    setRMode(null);
    try {
      const r = await adminApi.restart();
      if (!alive.current) return;
      setRMode(r.mode);
      setRPhase('waiting');
      onChanged?.();
      pollHealth();
    } catch (e: any) {
      if (!alive.current) return;
      setRPhase('failed');
      toast(e?.message || tr('admin.maint.restart.failed'), 'error');
    }
  };

  const restarting = rPhase === 'starting' || rPhase === 'waiting';

  // ---- backups ----
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [backupErr, setBackupErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 'create' | backup name

  const loadBackups = useCallback(async () => {
    try {
      const r = await apiHistory.backups();
      setBackups([...r].sort((a, b) => b.createdAt - a.createdAt));
      setBackupErr(false);
    } catch {
      setBackupErr(true);
    }
  }, []);
  useEffect(() => { void loadBackups(); }, [loadBackups]);

  const createBackup = async () => {
    setBusy('create');
    try {
      await apiHistory.createBackup();
      toast(tr('admin.maint.backup.created'), 'ok');
      await loadBackups();
      onChanged?.();
    } catch (e: any) {
      toast(e?.message || tr('admin.maint.backup.failed'), 'error');
    }
    setBusy(null);
  };

  const deleteBackup = async (b: BackupInfo) => {
    if (!(await confirmDialog(tr('admin.maint.backup.deleteTitle'), tr('admin.maint.backup.deleteMsg', { name: b.name }), tr('common.delete')))) return;
    setBusy(b.name);
    try {
      await apiHistory.deleteBackup(b.name);
      toast(tr('admin.maint.backup.deleted'), 'ok');
      await loadBackups();
      onChanged?.();
    } catch (e: any) {
      toast(e?.message || tr('list.deleteFailed'), 'error');
    }
    setBusy(null);
  };

  // ---- logs ----
  const [level, setLevel] = useState<AdminLogLevel>('all');
  const [count, setCount] = useState<LogCount>('100');
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logErr, setLogErr] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const logRef = useRef<ScrollView>(null);

  const loadLogs = useCallback(async () => {
    setLogBusy(true);
    try {
      const r = await adminApi.logs(level, Number(count));
      setLogLines(Array.isArray(r?.lines) ? r.lines : []);
      setLogErr(false);
    } catch {
      setLogErr(true);
    } finally {
      setLogBusy(false);
    }
  }, [level, count]);
  useEffect(() => { void loadLogs(); }, [loadLogs]);

  // ---- diagnostics ----
  const [diagBusy, setDiagBusy] = useState(false);
  const exportDiagnostics = async () => {
    setDiagBusy(true);
    try {
      const md = await adminApi.diagnostics();
      await deliverText('omnichat-diagnostics.md', md, 'text/markdown');
    } catch (e: any) {
      toast(e?.message || tr('admin.maint.diag.failed'), 'error');
    }
    setDiagBusy(false);
  };

  return (
    <View style={styles.root}>
      {/* Restart */}
      <View style={styles.block}>
        <View style={styles.row}>
          <Btn danger label={restarting ? tr('admin.maint.restart.restarting') : tr('admin.maint.restart.btn')} disabled={restarting} onPress={() => setConfirmOpen(true)} />
        </View>
        {rPhase === 'waiting' && (
          <View style={styles.inline}>
            <ActivityIndicator color={t.accent} />
            <Text style={{ color: t.text, fontSize: 14, flex: 1, minWidth: 0 }}>{tr('admin.maint.restart.restarting')}</Text>
          </View>
        )}
        {rPhase === 'waiting' && rMode && (
          <Hint>{tr(rMode === 'supervised' ? 'admin.maint.restart.mode.supervised' : 'admin.maint.restart.mode.respawn')}</Hint>
        )}
        {rPhase === 'back' && <Hint>{tr('admin.maint.restart.back')}</Hint>}
        {rPhase === 'timeout' && <Hint danger>{tr('admin.maint.restart.timeout')}</Hint>}
      </View>

      <Sheet
        visible={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={tr('admin.maint.restart.title')}
        footer={<><Btn danger label={tr('admin.maint.restart.confirm')} onPress={restart} /><Btn label={tr('common.cancel')} onPress={() => setConfirmOpen(false)} /></>}
      >
        <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{tr('admin.maint.restart.body')}</Text>
      </Sheet>

      {/* Backups */}
      <View style={styles.block}>
        <Label>{tr('admin.maint.backup.title')}</Label>
        <View style={styles.row}>
          <Btn primary label={busy === 'create' ? tr('admin.maint.backup.creating') : tr('admin.maint.backup.create')} disabled={busy !== null} onPress={createBackup} />
        </View>
        <Hint>{tr('admin.maint.backup.restoreHint')}</Hint>
        {backupErr && (
          <View style={styles.inline}>
            <Hint danger>{tr('admin.maint.backup.loadFailed')}</Hint>
            <Btn small label={tr('common.retry')} onPress={loadBackups} />
          </View>
        )}
        {backups === null && !backupErr && <ActivityIndicator color={t.accent} />}
        {backups !== null && backups.length === 0 && <Hint>{tr('admin.maint.backup.empty')}</Hint>}
        {backups?.map((b) => (
          <View key={b.name} style={[styles.card, { borderRadius: th.r(10), borderColor: t.border, backgroundColor: t.panel }]}>
            <View style={styles.cardText}>
              <Text numberOfLines={1} selectable style={{ color: t.text, fontWeight: '600', fontSize: 13 }}>{b.name}</Text>
              <Text style={{ color: t.sub, fontSize: 12 }}>{fmtBytes(b.size)} · {fmtDate(b.createdAt)}</Text>
            </View>
            <Btn small danger label={tr('common.delete')} disabled={busy !== null} onPress={() => deleteBackup(b)} />
          </View>
        ))}
      </View>

      {/* Logs */}
      <View style={styles.block}>
        <Label>{tr('admin.maint.logs.title')}</Label>
        <Label>{tr('admin.maint.logs.level')}</Label>
        <Segmented<AdminLogLevel>
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: tr('admin.maint.logs.level.all') },
            { value: 'error', label: tr('admin.maint.logs.level.error') },
            { value: 'warn', label: tr('admin.maint.logs.level.warn') },
            { value: 'info', label: tr('admin.maint.logs.level.info') },
          ]}
        />
        <Label>{tr('admin.maint.logs.lines')}</Label>
        <Segmented<LogCount>
          value={count}
          onChange={setCount}
          options={[
            { value: '50', label: '50' },
            { value: '100', label: '100' },
            { value: '200', label: '200' },
          ]}
        />
        <View style={styles.row}>
          <Btn small label={tr('admin.maint.logs.refresh')} disabled={logBusy} onPress={loadLogs} />
          {logBusy && <ActivityIndicator color={t.accent} />}
        </View>
        {logErr && <Hint danger>{tr('admin.maint.logs.failed')}</Hint>}
        <ScrollView
          ref={logRef}
          nestedScrollEnabled
          style={[styles.logBox, { maxHeight: 260, borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(8) }]}
          onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: false })}
        >
          {logLines === null ? (
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('admin.maint.logs.loading')}</Text>
          ) : logLines.length === 0 ? (
            <Text style={{ color: t.sub, fontSize: 12 }}>{tr('admin.maint.logs.empty')}</Text>
          ) : (
            logLines.map((line, i) => (
              <Text key={i} selectable style={[styles.logLine, { color: t.text }]}>{line}</Text>
            ))
          )}
        </ScrollView>
      </View>

      {/* Diagnostics */}
      <View style={styles.block}>
        <Label>{tr('admin.maint.diag.title')}</Label>
        <View style={styles.row}>
          <Btn label={diagBusy ? tr('admin.maint.diag.exporting') : tr('admin.maint.diag.export')} disabled={diagBusy} onPress={exportDiagnostics} />
        </View>
        <Hint>{tr('admin.maint.diag.hint')}</Hint>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 18, minWidth: 0, maxWidth: '100%' },
  block: { gap: 8, minWidth: 0, maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, maxWidth: '100%' },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0, maxWidth: '100%' },
  card: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderWidth: 1, padding: 10, maxWidth: '100%' },
  cardText: { flex: 1, minWidth: 140, gap: 2 },
  logBox: { borderWidth: 1, padding: 8, maxWidth: '100%' },
  logLine: { fontFamily: MONO, fontSize: 12, lineHeight: 17, ...(Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as any) : {}) },
});
