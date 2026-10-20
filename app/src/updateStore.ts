import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  UPDATE_STORAGE_KEY,
  emptyUpdateState,
  parseUpdateState,
  remindLater as remindLaterPure,
  serializeUpdateState,
  skipVersion as skipPure,
  unskipVersion as unskipPure,
} from './updateState';
import type { DeviceUpdateState } from './updateState';

/**
 * Per-device update state (never synced to the server). Persisted to AsyncStorage key `omnichat.update.v1`.
 * Mirrors deviceSettings.ts: in-memory cache, a write before the async load wins, storage errors are ignored.
 */

let state: DeviceUpdateState = emptyUpdateState();
let written = false; // a change made before the async load finished wins over the stored value
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function persist() {
  try {
    AsyncStorage.setItem(UPDATE_STORAGE_KEY, serializeUpdateState(state)).catch(() => {});
  } catch {
    // storage unavailable: the in-memory state still works for this session
  }
}

/** Loads the stored state (once at import, and callable again). Resolves with the current state. */
export async function loadDeviceUpdateState(): Promise<DeviceUpdateState> {
  try {
    const raw = await AsyncStorage.getItem(UPDATE_STORAGE_KEY);
    if (!raw || written) return state;
    state = parseUpdateState(raw);
    emit();
  } catch {
    // corrupt or unavailable storage: keep the current state
  }
  return state;
}

/** Writes the current state to storage now. Never throws. */
export async function saveDeviceUpdateState(): Promise<void> {
  try {
    await AsyncStorage.setItem(UPDATE_STORAGE_KEY, serializeUpdateState(state));
  } catch {
    // ignored: see persist()
  }
}

export function getDeviceUpdateState(): DeviceUpdateState {
  return state;
}

function apply(next: DeviceUpdateState) {
  if (next === state) return;
  state = next;
  written = true;
  persist();
  emit();
}

export function skipDeviceUpdate(version: string): void {
  apply(skipPure(state, version));
}

export function unskipDeviceUpdate(version: string): void {
  apply(unskipPure(state, version));
}

export function remindLaterDeviceUpdate(version: string, now: number = Date.now()): void {
  apply(remindLaterPure(state, version, now));
}

export function setLastSeenServerVersion(version: string | null): void {
  if (state.lastSeenServerVersion === version) return;
  apply({ ...state, lastSeenServerVersion: version });
}

export function subscribeDeviceUpdate(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The per-device update state; re-renders when it changes. */
export function useDeviceUpdate(): DeviceUpdateState {
  return useSyncExternalStore(subscribeDeviceUpdate, getDeviceUpdateState);
}

// Version of an available, non-skipped update (set by the update watch); drives the Settings > Updates badge.
let availableVersion: string | null = null;
const availListeners = new Set<() => void>();

export function setAvailableUpdateVersion(v: string | null): void {
  if (availableVersion === v) return;
  availableVersion = v;
  availListeners.forEach((l) => l());
}

/** True while an update is available and not skipped (on the server or on this device). */
export function useUpdateBadge(): boolean {
  const device = useDeviceUpdate();
  const v = useSyncExternalStore(
    (l) => { availListeners.add(l); return () => { availListeners.delete(l); }; },
    () => availableVersion,
  );
  return v !== null && !device.skipped.includes(v);
}

void loadDeviceUpdateState();
