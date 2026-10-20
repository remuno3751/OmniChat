import React, { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { api } from '../api';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Btn, Hint } from '../ui/kit';
import { compareSemver } from '../updateState';
import type { UpdateStatus } from '../updateTypes';

/** compareSemver throws on invalid input; a bad version string means "unknown", never a crash. */
function newerThan(a: string, b: string): boolean {
  try {
    return compareSemver(a, b) > 0;
  } catch {
    return false;
  }
}

/**
 * Plugin version line inside the DeepSeek Harness card: the installed bridge plugin version (from GET /bridges)
 * and, when the server knows a newer plugin release, the new version with a link to its release page.
 * Hidden entirely when neither the installed version nor a plugin release is known.
 */
export default function PluginUpdateRow() {
  const t = useTheme();
  const tr = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.updateStatus();
        if (alive) setStatus(s);
      } catch {
        // not logged in or server too old: nothing to show
      }
      try {
        const r = await api.bridges();
        const list = Array.isArray(r?.bridges) ? r.bridges : [];
        // prefer an online bridge that reports its plugin version
        const withVersion = list.filter((b) => typeof b.pluginVersion === 'string' && b.pluginVersion.length > 0);
        withVersion.sort((a, b) => Number(b.online) - Number(a.online));
        if (alive && withVersion.length > 0) setInstalled(withVersion[0].pluginVersion ?? null);
      } catch {
        // server predates /bridges
      }
    })();
    return () => { alive = false; };
  }, []);

  const plugin = status?.plugin ?? null;
  if (!installed && !plugin) return null;

  const newer = !!plugin && !!installed && newerThan(plugin.version, installed);

  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      {!!installed && <Text selectable style={{ color: t.text, fontSize: 13 }}>{tr('update.plugin.version', { version: installed })}</Text>}
      {newer && plugin && (
        <>
          <Text selectable style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{tr('update.plugin.available', { version: plugin.version })}</Text>
          <Hint>{tr('update.plugin.hint')}</Hint>
          <Btn small label={tr('update.plugin.open')} onPress={() => { Linking.openURL(plugin.downloadUrl).catch(() => {}); }} />
        </>
      )}
      {!newer && !installed && plugin && <Text selectable style={{ color: t.sub, fontSize: 13 }}>{tr('update.plugin.latest', { version: plugin.version })}</Text>}
    </View>
  );
}
