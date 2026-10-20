import React from 'react';
import { View } from 'react-native';
import { useT } from '../i18n';
import { Btn } from '../ui/kit';

/** Desktop shell signal: the native side intercepts this URL and returns to the launcher. */
export const DESKTOP_CHANGE_SERVER_URL = 'https://omnichat-desktop.invalid/change-server';

/** True only inside the OmniChat desktop app (the shell injects window.__OMNICHAT_DESKTOP__). */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__OMNICHAT_DESKTOP__;
}

/**
 * "Change server" button for the desktop app, which has no native menu bar on Windows/Linux.
 * Renders nothing outside the desktop shell.
 */
export default function DesktopServerSwitch() {
  const t = useT();
  if (!isDesktopShell()) return null;
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      <Btn
        small
        label={t('desktop.changeServer')}
        onPress={() => { (globalThis as any).location.href = DESKTOP_CHANGE_SERVER_URL; }}
      />
    </View>
  );
}
