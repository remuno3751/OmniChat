// Pure helper for the Notification permission label in Settings (no React Native or store imports).

/**
 * i18n key for a Notification permission state, as a Japanese word in Settings (許可 / 拒否 / 未設定).
 * Null for 'unsupported' or anything unknown (the caller shows its own text then).
 */
export function permissionWordKey(perm: string): string | null {
  if (perm === 'granted') return 'notify.perm.granted';
  if (perm === 'denied') return 'notify.perm.denied';
  if (perm === 'default') return 'notify.perm.default';
  return null;
}
