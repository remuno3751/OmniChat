import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cwdLabel, normCwd } from '../codeGroups';
import type { CodeDevice } from '../codeWorkspace';
import { useT } from '../i18n';
import { useTheme } from '../theme';

interface Props {
  devices: CodeDevice[];
  providerId: string | null;
  onDevice: (providerId: string) => void;
  /** show the folder list (online bridge that reports workspaces) */
  showWorkspaces: boolean;
  options: string[];
  cwd: string | null;
  onCwd: (cwd: string | null) => void;
  /** VS Code PC: the folder open in VS Code, shown as the default chip (instead of the DSH "default") */
  defaultCwd?: string;
}

/** New Code chat: choose the PC (when there are several) and the working folder before the first message. */
export default function WorkspacePicker({ devices, providerId, onDevice, showWorkspaces, options, cwd, onCwd, defaultCwd }: Props) {
  const t = useTheme();
  const tr = useT();
  const chip = (key: string, label: string, on: boolean, onPress: () => void, hint?: string, dot?: boolean) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={hint ? `${label} ${hint}` : label}
      style={[styles.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.panel2 : 'transparent' }]}
      {...(hint ? ({ title: hint } as any) : {})}
    >
      {dot !== undefined && <View style={[styles.dot, { backgroundColor: dot ? t.accent : t.border }]} />}
      <Text numberOfLines={1} style={{ color: on ? t.text : t.sub, fontSize: 12, maxWidth: 160 }}>{label}</Text>
    </Pressable>
  );
  if (devices.length < 2 && !showWorkspaces) return null;
  return (
    <View style={styles.root}>
      {devices.length > 1 && (
        <View style={styles.line}>
          <Text style={[styles.label, { color: t.sub }]}>{tr('code.pick.device')}</Text>
          {devices.map((d) => chip(d.providerId, d.name, d.providerId === providerId, () => onDevice(d.providerId), tr(d.online ? 'code.device.online' : 'code.device.offline'), d.online))}
        </View>
      )}
      {showWorkspaces && (
        <View style={styles.line}>
          <Text style={[styles.label, { color: t.sub }]}>{tr('code.pick.workspace')}</Text>
          {defaultCwd
            ? chip('default', cwdLabel(defaultCwd), !cwd || normCwd(cwd) === normCwd(defaultCwd), () => onCwd(defaultCwd), defaultCwd)
            : chip('default', tr('code.pick.default'), !cwd, () => onCwd(null), tr('code.pick.defaultHint'))}
          {options
            .filter((o) => !defaultCwd || normCwd(o) !== normCwd(defaultCwd))
            .map((o) => chip(o, cwdLabel(o), !!cwd && normCwd(cwd) === normCwd(o), () => onCwd(o), o))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 10, paddingTop: 8, gap: 6 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  label: { fontSize: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
