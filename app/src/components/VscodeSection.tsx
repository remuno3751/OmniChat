import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BridgeInfo } from '../api';
import { api } from '../api';
import { codeChatFolders, cwdLabel, normCwd } from '../codeGroups';
import { activeProviders, applyUpsert, toggleCollapsed, useStore } from '../store';
import { refreshModels } from '../ModelPicker';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { toast } from '../ui/toast';
import { uuid } from '../api';
import { setPendingCodeStart, startTarget, vscodeProviderBody, vscodeSection, type VscodeDevice } from '../vscodeBridge';
import Icon from './Icon';

/**
 * Code tab: the "VS Code" section (device list). Shown only while the VS Code integration is enabled,
 * i.e. at least one vscode bridge is known (online now or paired earlier). Each PC is listed by name with its
 * online / offline state and workspaces; tapping a workspace starts a Code chat there with the vscode-bridge provider.
 */
export default function VscodeSection({ bridges, onStart }: { bridges: BridgeInfo[] | null; onStart: () => void }) {
  const t = useTheme();
  const tr = useT();
  const providersMap = useStore((s) => s.providers);
  const convsMap = useStore((s) => s.conversations);
  const collapsed = useStore((s) => s.collapsed);
  const devices = useMemo(
    () => vscodeSection(bridges, activeProviders(providersMap), Object.values(convsMap).filter((c) => !c.deleted), providersMap),
    [bridges, providersMap, convsMap],
  );
  // a folder that already has Code chats is a workspace group on the Code tab (its "+" starts a chat): not listed twice here
  const taken = useMemo(() => codeChatFolders(Object.values(convsMap).filter((c) => !c.deleted), providersMap), [convsMap, providersMap]);
  if (devices.length === 0) return null;
  const free = (device: string, w: string) => !taken.get(device)?.has(normCwd(w));

  const start = async (d: VscodeDevice, cwd: string) => {
    const target = startTarget(d, cwd);
    if (!target.ok) { toast(tr('code.vscode.offlineStart', { name: d.name }), 'info'); return; }
    let providerId = target.providerId;
    try {
      if (!providerId) {
        const p = await api.putProvider(uuid(), vscodeProviderBody(d.name));
        applyUpsert({ providers: [p] });
        refreshModels(true, true);
        providerId = p.id;
      }
    } catch (e: any) {
      toast(e?.message || tr('integ.addFailed'), 'error');
      return;
    }
    setPendingCodeStart({ providerId, cwd: target.cwd });
    onStart();
  };

  const key = 'vscode';
  return (
    <View>
      <View style={styles.head}>
        <Pressable style={styles.toggle} onPress={() => toggleCollapsed(key)} accessibilityRole="button" accessibilityState={{ expanded: !collapsed[key] }} accessibilityLabel={tr('code.vscode.title')}>
          <Icon name={collapsed[key] ? 'chevronRight' : 'expand'} size={16} color={t.sub} />
          <Text numberOfLines={1} style={{ color: t.sub, fontSize: 12, fontWeight: '700' }}>{tr('code.vscode.title')}</Text>
          <Text style={{ color: t.sub, fontSize: 12 }}>{devices.length}</Text>
        </Pressable>
      </View>
      {!collapsed[key] && devices.map((d) => {
        const workspaces = d.workspaces.filter((w) => free(d.name, w));
        const closed = d.closed.filter((w) => free(d.name, w));
        const hidden = workspaces.length < d.workspaces.length || closed.length < d.closed.length;
        return (
        <View key={d.name} style={{ paddingLeft: 12 }}>
          <View style={styles.dev} accessibilityLabel={`${d.name} ${tr(d.online ? 'code.device.online' : 'code.device.offline')}`}>
            <View style={[styles.dot, { backgroundColor: d.online ? t.accent : t.border }]} />
            <Text numberOfLines={1} style={{ color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{d.name}</Text>
            <Text style={{ color: t.sub, fontSize: 11 }}>{tr(d.online ? 'code.device.online' : 'code.device.offline')}</Text>
          </View>
          {d.workspaces.length === 0 && !hidden && (
            <Text style={{ color: t.sub, fontSize: 12, paddingLeft: 26, paddingVertical: 2 }}>{tr(d.online ? 'code.vscode.noWorkspace' : 'code.vscode.offlineHint')}</Text>
          )}
          {workspaces.map((w) => (
            <Pressable
              key={w}
              onPress={() => start(d, w)}
              accessibilityRole="button"
              accessibilityLabel={tr('code.vscode.startIn', { name: d.name, folder: cwdLabel(w) })}
              style={({ hovered }: any) => [styles.ws, hovered && { backgroundColor: t.border }, !d.online && { opacity: 0.55 }]}
              {...({ title: w } as any)}
            >
              <Icon name="folder" size={15} color={t.sub} />
              <Text numberOfLines={1} style={{ color: t.text, fontSize: 13, flex: 1 }}>{cwdLabel(w)}</Text>
              <Icon name="add" size={16} color={t.sub} />
            </Pressable>
          ))}
          {closed.map((w) => (
            <View
              key={'closed:' + w}
              accessibilityState={{ disabled: true }}
              accessibilityLabel={cwdLabel(w)}
              style={[styles.ws, { opacity: 0.45 }]}
              {...({ title: w } as any)}
            >
              <Icon name="folder" size={15} color={t.sub} />
              <Text numberOfLines={1} style={{ color: t.sub, fontSize: 13, flex: 1 }}>{cwdLabel(w)}</Text>
            </View>
          ))}
        </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  dev: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ws: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 26, paddingRight: 12, paddingVertical: 6, borderRadius: 6 },
});
