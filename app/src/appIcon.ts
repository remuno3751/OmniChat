import { Platform } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { setAlternateAppIcon, supportsAlternateIcons } from 'expo-alternate-app-icons';
import type { AppIconId, ThemeId, ThemeName } from './deviceSettings';

/** Selectable app icons: one per theme + mode. PNGs come from app/scripts/gen-icons.mjs. */
export const APP_ICONS: { id: AppIconId; themeId: ThemeId; mode: ThemeName; image: ImageSourcePropType }[] = [
  { id: 'simple-light', themeId: 'simple', mode: 'light', image: require('../assets/app-icons/simple-light.png') },
  { id: 'simple-dark', themeId: 'simple', mode: 'dark', image: require('../assets/app-icons/simple-dark.png') },
  { id: 'simple-sepia', themeId: 'simple', mode: 'sepia', image: require('../assets/app-icons/simple-sepia.png') },
  { id: 'simple-contrast', themeId: 'simple', mode: 'contrast', image: require('../assets/app-icons/simple-contrast.png') },
  { id: 'frontier-light', themeId: 'frontier', mode: 'light', image: require('../assets/app-icons/frontier-light.png') },
  { id: 'frontier-dark', themeId: 'frontier', mode: 'dark', image: require('../assets/app-icons/frontier-dark.png') },
  { id: 'astral-light', themeId: 'astral', mode: 'light', image: require('../assets/app-icons/astral-light.png') },
  { id: 'astral-dark', themeId: 'astral', mode: 'dark', image: require('../assets/app-icons/astral-dark.png') },
];

/** Android alternate icon name registered by the expo-alternate-app-icons plugin in app.json ('simple-light' -> 'SimpleLight'); null = the default icon (simple-contrast: app.json icon + adaptiveIcon). */
const nativeName = (id: AppIconId) => (id === 'simple-contrast' ? null : id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()));

/** The browser tab icon follows the setting (web build and the desktop app's page). */
export function applyFavicon(id: AppIconId) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `/icons/app/${id}.png`;
}

/** Applies a newly picked icon to the OS: Android launcher icon, or the desktop app's taskbar/Dock icon. */
export async function applyAppIcon(id: AppIconId) {
  applyFavicon(id);
  if (Platform.OS === 'android') {
    if (supportsAlternateIcons) await setAlternateAppIcon(nativeName(id));
  } else if (Platform.OS === 'web' && typeof window !== 'undefined' && (window as any).__OMNICHAT_DESKTOP__?.appIcon) {
    // The desktop shell gives server pages no IPC: it intercepts this navigation, swaps the icon and cancels it.
    window.location.assign(`https://omnichat-desktop.invalid/icon/${id}`);
  }
}
