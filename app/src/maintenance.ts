// Maintenance mode: pure helpers (no React, no storage) so the display rules can be unit-tested.
import type { Maintenance } from './protocol';

/** Longest maintenance message the admin may save (characters, after trim). */
export const MAINTENANCE_MESSAGE_MAX = 500;

/** Parses the server's Maintenance object. Returns null for anything that is not one (old servers send none). */
export function parseMaintenance(x: unknown): Maintenance | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  return {
    enabled: o.enabled,
    message: typeof o.message === 'string' ? o.message : '',
    eta: typeof o.eta === 'number' && Number.isFinite(o.eta) ? o.eta : null,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  };
}

export interface MaintenanceView {
  /** show the banner */
  show: boolean;
  /** a general user cannot send messages (admins always can) */
  blocksSend: boolean;
  /** the banner also tells an admin that admins can still use the server */
  adminNote: boolean;
  message: string;
  eta: number | null;
}

/** What the UI shows for the current state. `isAdmin` is true only for a known admin. */
export function maintenanceView(m: Maintenance | null | undefined, isAdmin: boolean): MaintenanceView {
  const on = !!m && m.enabled === true;
  return {
    show: on,
    blocksSend: on && !isAdmin,
    adminNote: on && isAdmin,
    message: on ? (m?.message ?? '').trim() : '',
    eta: on ? (m?.eta ?? null) : null,
  };
}

/** The send was refused with this error code (the server's maintenance refusal). */
export const isMaintenanceCode = (code: string | null | undefined): boolean => code === 'maintenance';

/** Returns an i18n key for an invalid message, or null when it is fine. */
export function validateMaintenanceMessage(s: string): string | null {
  return Array.from(s.trim()).length > MAINTENANCE_MESSAGE_MAX ? 'maint.messageTooLong' : null;
}

/** Admin choice for the expected end time: keep the stored value, clear it, or "N minutes from now". */
export type EtaChoice = 'keep' | 'none' | '30' | '60' | '180' | '360';
/** Minutes from now, as choice values (strings, for the segmented control). */
export const ETA_PRESETS: EtaChoice[] = ['30', '60', '180', '360'];

/** Value for the PUT body: undefined = leave the stored eta alone (omit the field), null = clear, number = epoch ms. */
export function etaFromChoice(c: EtaChoice, now: number): number | null | undefined {
  if (c === 'keep') return undefined;
  if (c === 'none') return null;
  return now + Number(c) * 60_000;
}

/** Local date and time text for an epoch-ms eta. */
export function formatEtaLocal(eta: number): string {
  return new Date(eta).toLocaleString();
}
