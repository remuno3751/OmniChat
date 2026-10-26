import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeRemembered } from './modelLoad';
import type { RememberedPolicy } from './modelLoad';
import { CODE_LOCK_DEFAULTS, normalizeCodeLock } from './codeLock';
import type { CodeLockSettings } from './codeLock';
import { normalizePetPos } from './petPos';
import type { PetPos } from './petPos';
import { VOICE_DEFAULTS, normalizeVoice } from './voice/voiceSettings';
import type { VoiceSettings } from './voice/voiceSettings';

/** Per-device settings (never synced to the server). Persisted to AsyncStorage key `omnichat.device`. */

export type Language = 'auto' | 'ja' | 'en';
export type ThemeName = 'system' | 'light' | 'dark' | 'sepia' | 'contrast';
/** Visual theme family. `theme` (ThemeName) stays the light/dark/system mode (sepia/contrast belong to 'simple'). */
export type ThemeId = 'simple' | 'frontier' | 'astral';
/** App icon variant (theme + mode); see appIcon.ts. */
export type AppIconId =
  | 'simple-light' | 'simple-dark' | 'simple-sepia' | 'simple-contrast'
  | 'frontier-light' | 'frontier-dark' | 'astral-light' | 'astral-dark';
export type CodeScheme = 'midnight' | 'daylight' | 'solar' | 'mono';
export type PetActivity = 'low' | 'normal' | 'high';
/** several chats at once on the desktop pet: one bubble with < > ('pager') or the bubbles stacked ('stack') */
export type PetMulti = 'pager' | 'stack';
/** UI animation amount (Off disables all motion). */
export type MotionAmount = 'off' | 'reduced' | 'standard' | 'rich';
/** How streamed text appears: off / smooth steady reveal / particles condensing into glyphs. */
export type StreamAnim = 'off' | 'smooth' | 'particles';
/** particle color: follow the text, a random pick from the theme preset, or one custom #rrggbb */
export type ParticleColorMode = 'text' | 'preset' | 'custom';

export interface PetSettings {
  enabled: boolean;
  petId: string | null;
  /** px, 64-256 */
  size: number;
  activity: PetActivity;
  clickThrough: boolean;
  /** where the pet was dragged to (fractions of the free room); null = the default bottom-right spot */
  pos: PetPos | null;
  /** show the pet in its own window on the desktop (desktop app only) */
  desktop: boolean;
  /** show the pet inside the app too (only matters while `desktop` is on) */
  inApp: boolean;
  /** how several chats' bubbles are shown on the desktop pet */
  multi: PetMulti;
  /** the user chose the pet or the enabled switch on this device (false = follow the synced active pet) */
  explicit: boolean;
}

/** DeepSeek Harness relay on this device (local plugin port <-> OmniChat server bridge). */
export interface DshSettings {
  enabled: boolean;
  /** local port the dsh plugin listens on (1-65535) */
  port: number;
  pairing: string;
  bridgeName: string;
}

export type { VoiceSettings } from './voice/voiceSettings';

export interface DeviceSettings {
  language: Language;
  theme: ThemeName;
  themeId: ThemeId;
  /** background patterns, brackets and other ornaments; null = automatic (off on small phones) */
  decorations: boolean | null;
  codeScheme: CodeScheme;
  /** launcher / taskbar / tab icon */
  appIcon: AppIconId;
  /** px, 12-24 */
  fontSize: number;
  /** px, 560-1200 */
  messageWidth: number;
  pets: PetSettings;
  /** fetch model maker logos from the server (/model-logo); off = plain badges only */
  modelLogosOnline: boolean;
  motionAmount: MotionAmount;
  streamAnim: StreamAnim;
  /** particle dot size multiplier, 0.4-3 (Streaming animation: Particles) */
  particleSize: number;
  /** particle amount/spread multiplier, 0.2-2.5 */
  particleIntensity: number;
  particleColorMode: ParticleColorMode;
  /** #rrggbb, used when particleColorMode is custom */
  particleColor: string;
  dsh: DshSettings;
  /** Aria voice call (Settings > Voice call); see voice/voiceSettings.ts */
  voice: VoiceSettings;
  /** the first-use explanation of ephemeral chats has been dismissed on this device */
  ephemeralBannerSeen: boolean;
  /** what to do when a chat turn would load a model next to another loaded one (PROTOCOL-v7); 'ask' = show the dialog */
  modelLoadPolicy: RememberedPolicy;
  /** lock in front of the Code screens (PIN or OS authentication); see codeLock.ts */
  codeLock: CodeLockSettings;
  /** wide (desktop/web) layout: true = the left sidebar stays open; false = it hides and peeks on hover at the left edge */
  sidebarPinned: boolean;
  /** Code list with several PCs: group by device first, then workspace (default: off = one level, device shown as a badge) */
  codeGroupByDevice: boolean;
  /** Settings > VS Code: create a vscode-bridge provider by itself when a PC has none (default on) */
  vscodeAutoProvider: boolean;
}

export type DevicePatch = Partial<Omit<DeviceSettings, 'pets' | 'dsh' | 'codeLock' | 'voice'>> & {
  voice?: Partial<VoiceSettings>;
  pets?: Partial<PetSettings>;
  dsh?: Partial<DshSettings>;
  codeLock?: Partial<CodeLockSettings>;
};

export const DEVICE_KEY = 'omnichat.device';

export const DEVICE_DEFAULTS: DeviceSettings = {
  language: 'auto',
  theme: 'system',
  themeId: 'frontier',
  decorations: null,
  codeScheme: 'midnight',
  appIcon: 'simple-contrast',
  fontSize: 16,
  messageWidth: 820,
  pets: { enabled: false, petId: null, size: 128, activity: 'normal', clickThrough: true, pos: null, desktop: false, inApp: false, multi: 'pager', explicit: false },
  modelLogosOnline: true,
  motionAmount: 'standard',
  streamAnim: 'smooth',
  particleSize: 0.5,
  particleIntensity: 0.5,
  particleColorMode: 'preset',
  particleColor: '#f9c837',
  dsh: { enabled: false, port: 19401, pairing: '', bridgeName: 'my-pc' },
  voice: VOICE_DEFAULTS,
  ephemeralBannerSeen: false,
  modelLoadPolicy: 'ask',
  codeLock: CODE_LOCK_DEFAULTS,
  sidebarPinned: true,
  codeGroupByDevice: false,
  vscodeAutoProvider: true,
};

const LANGUAGES: Language[] = ['auto', 'ja', 'en'];
const THEMES: ThemeName[] = ['system', 'light', 'dark', 'sepia', 'contrast'];
const THEME_IDS: ThemeId[] = ['simple', 'frontier', 'astral'];
const APP_ICON_IDS: AppIconId[] = [
  'simple-light', 'simple-dark', 'simple-sepia', 'simple-contrast', 'frontier-light', 'frontier-dark', 'astral-light', 'astral-dark',
];
const SCHEMES: CodeScheme[] = ['midnight', 'daylight', 'solar', 'mono'];
const MOTION_AMOUNTS: MotionAmount[] = ['off', 'reduced', 'standard', 'rich'];
const PARTICLE_COLOR_MODES: ParticleColorMode[] = ['text', 'preset', 'custom'];
const STREAM_ANIMS: StreamAnim[] = ['off', 'smooth', 'particles'];
const ACTIVITIES: PetActivity[] = ['low', 'normal', 'high'];
const PET_MULTIS: PetMulti[] = ['pager', 'stack'];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const pick = <T>(v: unknown, allowed: T[], fallback: T): T =>
  (allowed as unknown[]).includes(v) ? (v as T) : fallback;
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Normalizes an arbitrary (possibly stored or partial) object into a valid DeviceSettings. */
function normalize(raw: any): DeviceSettings {
  const d = DEVICE_DEFAULTS;
  const p = raw && typeof raw === 'object' && raw.pets && typeof raw.pets === 'object' ? raw.pets : {};
  const q = raw && typeof raw === 'object' && raw.dsh && typeof raw.dsh === 'object' ? raw.dsh : {};
  return {
    language: pick(raw?.language, LANGUAGES, d.language),
    theme: pick(raw?.theme, THEMES, d.theme),
    themeId: pick(raw?.themeId, THEME_IDS, d.themeId),
    decorations: typeof raw?.decorations === 'boolean' ? raw.decorations : null,
    codeScheme: pick(raw?.codeScheme, SCHEMES, d.codeScheme),
    appIcon: pick(raw?.appIcon, APP_ICON_IDS, d.appIcon),
    fontSize: clamp(Math.round(num(raw?.fontSize, d.fontSize)), 12, 24),
    messageWidth: clamp(Math.round(num(raw?.messageWidth, d.messageWidth)), 560, 1200),
    pets: {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : d.pets.enabled,
      petId: typeof p.petId === 'string' ? p.petId : null,
      size: clamp(Math.round(num(p.size, d.pets.size)), 64, 256),
      activity: pick(p.activity, ACTIVITIES, d.pets.activity),
      clickThrough: typeof p.clickThrough === 'boolean' ? p.clickThrough : d.pets.clickThrough,
      pos: normalizePetPos(p.pos),
      desktop: typeof p.desktop === 'boolean' ? p.desktop : d.pets.desktop,
      inApp: typeof p.inApp === 'boolean' ? p.inApp : d.pets.inApp,
      multi: pick(p.multi, PET_MULTIS, d.pets.multi),
      explicit: typeof p.explicit === 'boolean' ? p.explicit : d.pets.explicit,
    },
    modelLogosOnline: typeof raw?.modelLogosOnline === 'boolean' ? raw.modelLogosOnline : d.modelLogosOnline,
    motionAmount: pick(raw?.motionAmount, MOTION_AMOUNTS, d.motionAmount),
    streamAnim: pick(raw?.streamAnim, STREAM_ANIMS, d.streamAnim),
    particleSize: clamp(Math.round(num(raw?.particleSize, d.particleSize) * 10) / 10, 0.2, 3),
    particleColorMode: pick(raw?.particleColorMode, PARTICLE_COLOR_MODES, d.particleColorMode),
    particleColor: typeof raw?.particleColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.particleColor) ? raw.particleColor : d.particleColor,
    particleIntensity: clamp(Math.round(num(raw?.particleIntensity, d.particleIntensity) * 10) / 10, 0.2, 2.5),
    dsh: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : d.dsh.enabled,
      port: clamp(Math.round(num(q.port, d.dsh.port)), 1, 65535),
      pairing: typeof q.pairing === 'string' ? q.pairing.trim().slice(0, 200) : d.dsh.pairing,
      bridgeName: (typeof q.bridgeName === 'string' ? q.bridgeName.trim().slice(0, 200) : '') || d.dsh.bridgeName,
    },
    voice: normalizeVoice(raw?.voice),
    ephemeralBannerSeen: typeof raw?.ephemeralBannerSeen === 'boolean' ? raw.ephemeralBannerSeen : d.ephemeralBannerSeen,
    modelLoadPolicy: normalizeRemembered(raw?.modelLoadPolicy),
    codeLock: normalizeCodeLock(raw?.codeLock),
    sidebarPinned: typeof raw?.sidebarPinned === 'boolean' ? raw.sidebarPinned : d.sidebarPinned,
    codeGroupByDevice: typeof raw?.codeGroupByDevice === 'boolean' ? raw.codeGroupByDevice : d.codeGroupByDevice,
    vscodeAutoProvider: typeof raw?.vscodeAutoProvider === 'boolean' ? raw.vscodeAutoProvider : d.vscodeAutoProvider,
  };
}

let state: DeviceSettings = normalize(null);
let written = false; // a setDevice() before the async load finished wins over the stored value
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function persist() {
  AsyncStorage.setItem(DEVICE_KEY, JSON.stringify(state)).catch(() => {});
}

/** Loads the stored settings. Runs once at import; until it resolves the defaults are in effect. */
async function load() {
  try {
    const raw = await AsyncStorage.getItem(DEVICE_KEY);
    if (!raw || written) return;
    state = normalize(JSON.parse(raw));
    emit();
  } catch {
    // corrupt or unavailable storage: keep defaults
  }
}
void load();

export function getDevice(): DeviceSettings {
  return state;
}

/** Shallow-merges `patch` (deep for `pets`), validates the result, persists and notifies subscribers. */
export function setDevice(patch: DevicePatch): void {
  const { pets, dsh, codeLock, voice, ...rest } = patch;
  state = normalize({
    ...state,
    ...rest,
    pets: pets ? { ...state.pets, ...pets } : state.pets,
    dsh: dsh ? { ...state.dsh, ...dsh } : state.dsh,
    voice: voice ? { ...state.voice, ...voice } : state.voice,
    codeLock: codeLock ? { ...state.codeLock, ...codeLock } : state.codeLock,
  });
  written = true;
  persist();
  emit();
}

/**
 * Pet id and enabled switch in effect: the device's own choice, else the synced active pet (settings.activePetId).
 * A device that never touched the pet setting (`explicit` false) shows the synced pet by default.
 */
export function effectivePets(pets: PetSettings, syncedActivePetId: string | null | undefined): { enabled: boolean; petId: string | null } {
  const synced = syncedActivePetId || null;
  const petId = pets.petId || synced;
  const enabled = pets.explicit ? pets.enabled : pets.enabled || !!synced;
  return { enabled, petId };
}

/**
 * Applies a stored value written by another window of the same origin (the desktop pet window hides the pet
 * through localStorage; see the 'storage' listener below). Does not write back.
 */
export function applyStoredDevice(raw: string | null): void {
  if (!raw) return;
  try {
    state = normalize(JSON.parse(raw));
    emit();
  } catch {
    // not our JSON: keep the current settings
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === DEVICE_KEY) applyStoredDevice(e.newValue);
  });
}

export function subscribeDevice(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Selects a slice of the device settings. The selector should return a stable reference
 * (a primitive, or a sub-object such as `s.pets`) so the component does not re-render needlessly.
 */
export function useDevice<T>(selector: (s: DeviceSettings) => T): T {
  return useSyncExternalStore(subscribeDevice, () => selector(state));
}

/** `[value, setter]` for one top-level setting. */
export function useDeviceSetting<K extends keyof DeviceSettings>(
  key: K,
): [DeviceSettings[K], (v: DeviceSettings[K]) => void] {
  const value = useDevice((s) => s[key]);
  const set = (v: DeviceSettings[K]) => setDevice({ [key]: v } as DevicePatch);
  return [value, set];
}
