import * as Font from 'expo-font';
import { useEffect, useState } from 'react';
import type { ThemeDef } from './themes';

/**
 * Lazy font packs: the Google Fonts (SIL OFL / Apache 2.0) of a theme are only imported and
 * registered when that theme is first selected, so the Simple theme stays light.
 */
type Pack = NonNullable<ThemeDef['fonts']['pack']>;

const loaders: Record<Pack, () => Promise<Record<string, any>>> = {
  frontier: async () => ({
    ...(await import('@expo-google-fonts/space-grotesk/400Regular')),
    ...(await import('@expo-google-fonts/space-grotesk/500Medium')),
    ...(await import('@expo-google-fonts/space-grotesk/700Bold')),
    ...(await import('@expo-google-fonts/syncopate/400Regular')),
    ...(await import('@expo-google-fonts/syncopate/700Bold')),
  }),
  astral: async () => ({
    ...(await import('@expo-google-fonts/zen-maru-gothic/400Regular')),
    ...(await import('@expo-google-fonts/zen-maru-gothic/700Bold')),
    ...(await import('@expo-google-fonts/outfit/400Regular')),
    ...(await import('@expo-google-fonts/outfit/600SemiBold')),
    ...(await import('@expo-google-fonts/marcellus/400Regular')),
  }),
};

const ready = new Set<Pack>();
const pending = new Map<Pack, Promise<void>>();

function load(pack: Pack): Promise<void> {
  let p = pending.get(pack);
  if (!p) {
    p = loaders[pack]()
      .then((m) => Font.loadAsync(m))
      .then(() => { ready.add(pack); })
      .catch(() => { pending.delete(pack); }); // fonts unavailable: keep the system font
    pending.set(pack, p);
  }
  return p;
}

/** true once the theme's font pack is registered (always true for themes without one). */
export function useFontsReady(pack: Pack | null): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!pack || ready.has(pack)) return;
    let live = true;
    load(pack).then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [pack]);
  return !pack || ready.has(pack);
}
