// Shared providers (PROTOCOL-v7): pure display rules, no React and no storage, so they can be unit-tested.
import type { Provider } from './protocol';

/** A user's grant choice on one shared provider in the admin screen. 'default' = no row (follows defaultSharedAccess). */
export type GrantChoice = 'default' | 'all' | 'list' | 'none';

/** One row of GET /admin/users/:id/grants. */
export interface GrantRow { providerId: string; mode: 'all' | 'list' | 'none'; models: string[] }

/** A shared provider as the admin screen lists it (GET /admin/shared-providers). */
export interface SharedProviderInfo { id: string; name: string; kind: string; ownerUserId: string }

/** Server setting values (GET/PUT /admin/settings). */
export type DefaultSharedAccess = 'none' | 'all';

export const GRANT_MODELS_MAX = 500;
export const GRANT_MODEL_CHARS_MAX = 300;

/** What the UI shows and allows for one provider in the provider list. */
export interface ProviderActions {
  /** another user owns it: read-only here */
  readOnly: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** the admin may switch "shared" on their own provider (dsh-bridge never) */
  canShare: boolean;
  /** show the "shared" badge (the owner's flag, or a provider shared with this user) */
  showSharedBadge: boolean;
}

export function providerActions(p: Pick<Provider, 'kind' | 'shared' | 'readOnly'>, isAdmin: boolean): ProviderActions {
  const readOnly = p.readOnly === true;
  return {
    readOnly,
    canEdit: !readOnly,
    canDelete: !readOnly,
    canShare: isAdmin && !readOnly && p.kind !== 'dsh-bridge',
    showSharedBadge: readOnly || p.shared === true,
  };
}

/** An ordinary user may add a provider unless the server turned that off. Unknown (old server) = allowed, as before. */
export function canAddOwnProvider(isAdmin: boolean, allowOwnProviders: boolean | undefined): boolean {
  return isAdmin || allowOwnProviders !== false;
}

/** The models of a shared provider as this user may use them. */
export function allowedModelsOf(p: Pick<Provider, 'allowedModels'>): 'all' | string[] {
  return Array.isArray(p.allowedModels) ? p.allowedModels : 'all';
}

/** Server default for users with no grant row. Anything but 'all' is 'none' (the safe default). */
export function parseDefaultSharedAccess(x: unknown): DefaultSharedAccess {
  return x === 'all' ? 'all' : 'none';
}

/** The grant choice of a user on one provider, from the row (undefined = no row). */
export function grantChoiceOf(row: GrantRow | undefined): GrantChoice {
  return row ? row.mode : 'default';
}

/**
 * The PUT body for a choice, or null when the row should be removed (DELETE, 'default').
 * 'list' keeps distinct, trimmed, non-empty model ids in their order.
 */
export function grantBodyFor(choice: GrantChoice, models: string[]): { mode: 'all' | 'list' | 'none'; models?: string[] } | null {
  if (choice === 'default') return null;
  if (choice === 'list') return { mode: 'list', models: distinctModels(models) };
  return { mode: choice };
}

function distinctModels(models: string[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    const v = m.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** An i18n key for an invalid 'list' selection, or null when it can be saved. */
export function validateGrantModels(models: string[]): string | null {
  const list = distinctModels(models);
  if (list.length === 0) return 'shared.grant.needModel';
  if (list.length > GRANT_MODELS_MAX) return 'shared.grant.tooMany';
  if (list.some((m) => Array.from(m).length > GRANT_MODEL_CHARS_MAX)) return 'shared.grant.modelTooLong';
  return null;
}

/** One line of the admin's per-user grant editor. */
export interface GrantLine { providerId: string; name: string; choice: GrantChoice; models: string[] }

/**
 * The rows the grant editor shows: one per shared provider (name from the shared list),
 * with the user's current choice. Grants on providers that are no longer shared are not listed here.
 */
export function buildGrantLines(shared: SharedProviderInfo[], grants: GrantRow[]): GrantLine[] {
  return shared.map((sp) => {
    const row = grants.find((g) => g.providerId === sp.id);
    return { providerId: sp.id, name: sp.name, choice: grantChoiceOf(row), models: row && row.mode === 'list' ? row.models : [] };
  });
}

/** Grants whose provider is no longer shared: shown as a note, they stay in force only while the provider is shared. */
export function orphanGrants(shared: SharedProviderInfo[], grants: GrantRow[]): GrantRow[] {
  const ids = new Set(shared.map((s) => s.id));
  return grants.filter((g) => !ids.has(g.providerId));
}

/** Name for a grant's provider id: the provider's name, or the id when it is unknown. */
export function grantDisplayName(providerId: string, providers: Pick<Provider, 'id' | 'name'>[]): string {
  return providers.find((p) => p.id === providerId)?.name || providerId;
}

/** Whether the grant editor should show the "turn sharing on first" hint. */
export function needsSharedHint(shared: SharedProviderInfo[]): boolean {
  return shared.length === 0;
}
