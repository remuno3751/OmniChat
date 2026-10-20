/**
 * Pure update-popup logic for the app (no React, no storage access).
 * Device-side state lives under AsyncStorage key `omnichat.update.v1` (see updateStore.ts).
 */
import type { UpdateStatus } from './updateTypes';

export const UPDATE_STORAGE_KEY = 'omnichat.update.v1';

/** "Remind me later" hides the update popup for one version for this long. */
export const REMIND_LATER_MS = 24 * 3600_000;

export interface DeviceUpdateState {
  /** versions this device chose to skip (never shown as an update popup again) */
  skipped: string[];
  /** version -> epoch ms; the update popup for that version is hidden while now < value */
  remindAfter: Record<string, number>;
  /** the server version seen on the previous app start (drives the reload toast) */
  lastSeenServerVersion: string | null;
}

export type PopupDecision =
  | { kind: 'none' }
  | { kind: 'update'; version: string }
  | { kind: 'failure'; message: string; version: string };

const MAX_VERSION_LEN = 64;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;

export function emptyUpdateState(): DeviceUpdateState {
  return { skipped: [], remindAfter: {}, lastSeenServerVersion: null };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A version-looking string (kept loose on purpose: the server owns the exact semver rules). */
function isVersionString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_VERSION_LEN && VERSION_RE.test(v);
}

/**
 * Tolerant loader for the parsed stored value. Accepts anything (null, numbers, strings, arrays,
 * partial or mistyped objects); wrong fields fall back to empty values, unknown keys are dropped.
 * Never throws.
 */
export function loadUpdateState(raw: unknown): DeviceUpdateState {
  const o = isRecord(raw) ? raw : {};
  const skipped: string[] = [];
  if (Array.isArray(o.skipped)) {
    for (const v of o.skipped) if (isVersionString(v) && !skipped.includes(v)) skipped.push(v);
  }
  const remindAfter: Record<string, number> = {};
  if (isRecord(o.remindAfter)) {
    for (const [k, v] of Object.entries(o.remindAfter)) {
      // "__proto__" is skipped so a crafted key can never touch the prototype
      if (k === '__proto__' || !isVersionString(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) remindAfter[k] = v;
    }
  }
  const lastSeenServerVersion = isVersionString(o.lastSeenServerVersion) ? o.lastSeenServerVersion : null;
  return { skipped, remindAfter, lastSeenServerVersion };
}

/** Parses the stored JSON text. Missing, corrupt or non-JSON text gives the empty state. Never throws. */
export function parseUpdateState(text: string | null | undefined): DeviceUpdateState {
  if (!text) return emptyUpdateState();
  try {
    return loadUpdateState(JSON.parse(text));
  } catch {
    return emptyUpdateState();
  }
}

/** JSON text for storage (always the cleaned shape). */
export function serializeUpdateState(s: DeviceUpdateState): string {
  return JSON.stringify(loadUpdateState(s));
}

/** Idempotent: skipping an already skipped version returns the same object. */
export function skipVersion(s: DeviceUpdateState, v: string): DeviceUpdateState {
  if (!isVersionString(v) || s.skipped.includes(v)) return s;
  return { ...s, skipped: [...s.skipped, v] };
}

/** Idempotent: unskipping a version that is not skipped returns the same object. */
export function unskipVersion(s: DeviceUpdateState, v: string): DeviceUpdateState {
  if (!s.skipped.includes(v)) return s;
  return { ...s, skipped: s.skipped.filter((x) => x !== v) };
}

/** Hides the update popup for `v` until now + REMIND_LATER_MS (suppressed while now < that time). */
export function remindLater(s: DeviceUpdateState, v: string, now: number): DeviceUpdateState {
  if (!isVersionString(v)) return s;
  return { ...s, remindAfter: { ...s.remindAfter, [v]: now + REMIND_LATER_MS } };
}

/** Key used in `sessionDismissed` for the failure popup of a given apply version. */
export function failureDismissKey(version: string): string {
  return `failure:${version}`;
}

/**
 * Which popup to show now. Rules, in order:
 * - no status, or not an admin -> none (only admins can apply, skip or ack).
 * - failure popup: lastApply failed and not acknowledged, and not dismissed this session
 *   (sessionDismissed contains failureDismissKey(version)).
 * - update popup: updateAvailable and latest present; not skipped on the server; not skipped on this
 *   device; not inside the remind-later window; not dismissed this session; and either self-update is
 *   possible (selfUpdate true and a bundle asset exists) or the install is docker (the popup then shows
 *   status.dockerCommand instead of an apply button).
 */
export function decidePopup(input: {
  status: UpdateStatus | null;
  device: DeviceUpdateState;
  now: number;
  isAdmin: boolean;
  sessionDismissed: string[];
}): PopupDecision {
  const { status, device, now, isAdmin, sessionDismissed } = input;
  if (!status || !isAdmin) return { kind: 'none' };

  const a = status.lastApply;
  if (a && a.status === 'failed' && !a.acknowledged && !sessionDismissed.includes(failureDismissKey(a.version))) {
    return { kind: 'failure', message: a.message, version: a.version };
  }

  const latest = status.latest;
  if (!status.updateAvailable || !latest) return { kind: 'none' };
  const v = latest.version;
  if (status.skipped) return { kind: 'none' };
  if (device.skipped.includes(v)) return { kind: 'none' };
  const remindUntil = device.remindAfter[v];
  if (typeof remindUntil === 'number' && now < remindUntil) return { kind: 'none' };
  if (sessionDismissed.includes(v)) return { kind: 'none' };
  const canSelfUpdate = status.selfUpdate && status.bundleAssetFound;
  const isDocker = status.installType === 'docker';
  if (!canSelfUpdate && !isDocker) return { kind: 'none' };
  return { kind: 'update', version: v };
}

/** True when the server version changed since the last app start (no toast on the very first start). */
export function serverVersionChanged(prev: string | null, cur: string | null): boolean {
  return prev !== null && cur !== null && prev !== cur;
}

/** Parsed semver: numeric core plus prerelease identifiers (build metadata is ignored). */
interface ParsedSemver {
  core: [string, string, string];
  pre: string[];
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(s: string): ParsedSemver {
  const m = SEMVER_RE.exec(s.startsWith('v') ? s.slice(1) : s);
  if (!m) throw new Error(`invalid version: ${s}`);
  return { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split('.') : [] };
}

/** Compares two non-negative integer strings without precision loss. */
function cmpNumStr(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const isNumericId = (id: string) => /^\d+$/.test(id);

function cmpPreId(a: string, b: string): number {
  const an = isNumericId(a);
  const bn = isNumericId(b);
  if (an && bn) return cmpNumStr(a, b);
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0 precedence compare: -1 | 0 | 1. A leading "v" is accepted, build metadata is ignored.
 * Throws on invalid input (callers that must not throw use canApkUpdate or catch).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const c = cmpNumStr(pa.core[i], pb.core[i]);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  // a version without prerelease ranks above the same version with one
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const c = cmpPreId(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1; // shorter prefix ranks lower
}

/** True when `latest` is a newer version than the app build. Invalid input gives false (never throws). */
export function canApkUpdate(latest: string, appVersion: string): boolean {
  try {
    return compareSemver(latest, appVersion) > 0;
  } catch {
    return false;
  }
}

export type UpdateErrorKey =
  | 'update.err.network'
  | 'update.err.notFound'
  | 'update.err.forbidden'
  | 'update.err.unauthorized'
  | 'update.err.rateLimited'
  | 'update.err.badResponse'
  | 'update.err.checksumMissing'
  | 'update.err.checksumMismatch'
  | 'update.err.download'
  | 'update.err.unsupported'
  | 'update.err.bundleInvalid'
  | 'update.err.busy'
  | 'update.err.other';

export interface UpdateErrorText {
  key: UpdateErrorKey;
  params: Record<string, string | number>;
}

const ERROR_KEYS: Record<string, UpdateErrorKey> = {
  network: 'update.err.network',
  'not-found': 'update.err.notFound',
  forbidden: 'update.err.forbidden',
  unauthorized: 'update.err.unauthorized',
  'rate-limited': 'update.err.rateLimited',
  'bad-response': 'update.err.badResponse',
  'checksum-missing': 'update.err.checksumMissing',
  'checksum-mismatch': 'update.err.checksumMismatch',
  download: 'update.err.download',
  unsupported: 'update.err.unsupported',
  'bundle-invalid': 'update.err.bundleInvalid',
  busy: 'update.err.busy',
  other: 'update.err.other',
};

/**
 * Maps an UpdateError code to an i18n key (ja + en strings must exist for every key).
 * Unknown codes map to update.err.other. The raw server message is not shown to users.
 */
export function updateErrorText(err: { code: string }): UpdateErrorText {
  const key = Object.prototype.hasOwnProperty.call(ERROR_KEYS, err.code) ? ERROR_KEYS[err.code] : 'update.err.other';
  return { key, params: {} };
}
