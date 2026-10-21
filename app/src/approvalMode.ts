/* Code approval mode (docs/design/VSCODE-BRIDGE.md section 4): pure helpers, no React. */

import type { ApprovalMode } from './protocol';
export type { ApprovalMode };
export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'auto', 'full'];

/** The mode for a server value. Unknown, absent or older values (`ask`, `rules`) map to manual / auto. */
export function normalizeApprovalMode(v: unknown): ApprovalMode {
  if (v === 'auto' || v === 'rules') return 'auto';
  if (v === 'full') return 'full';
  return 'manual';
}

/** The mode a slash action id (`approval_mode:ask|rules|manual|auto|full`) asks for, or null when it is not one. */
export function approvalModeOfAction(id: string): ApprovalMode | null {
  if (!id.startsWith('approval_mode:')) return null;
  const v = id.slice('approval_mode:'.length);
  if (v === 'ask' || v === 'manual') return 'manual';
  if (v === 'rules' || v === 'auto') return 'auto';
  if (v === 'full') return 'full';
  return null;
}

export interface ApprovalModeAction {
  mode: ApprovalMode;
  /** the server's current value: always exactly one entry is selected */
  selected: boolean;
  /** true: choosing it opens the full-access warning first */
  needsConfirm: boolean;
}

/** The three switch segments. `current` is the conversation's value from the server (absent = manual). */
export function approvalModeActions(current: unknown): ApprovalModeAction[] {
  const cur = normalizeApprovalMode(current);
  return APPROVAL_MODES.map((mode) => ({ mode, selected: mode === cur, needsConfirm: mode === 'full' && cur !== 'full' }));
}

/** Request body for PUT /conversations/:id. Full access is only sent together with confirmFull. */
export function approvalModePatch(mode: ApprovalMode, confirmed: boolean): { approvalMode: ApprovalMode; confirmFull?: true } {
  return mode === 'full' && confirmed ? { approvalMode: mode, confirmFull: true } : { approvalMode: mode };
}

/* ---- full-access warning dialog state ---- */
export interface FullDialogState { open: boolean; checked: boolean }
export const closedFullDialog: FullDialogState = { open: false, checked: false };
/** Opens the dialog with the checkbox cleared every time. */
export const openFullDialog = (): FullDialogState => ({ open: true, checked: false });
export const toggleFullDialogCheck = (s: FullDialogState): FullDialogState => (s.open ? { ...s, checked: !s.checked } : s);
/** The confirm button works only while the dialog is open and the checkbox is ticked. */
export const canConfirmFull = (s: FullDialogState): boolean => s.open && s.checked;

/* ---- approval card (tool_approval) ---- */
export interface ApprovalCardView {
  protectedItem: boolean;
  reasons: string[];
  /** "Always allow" is hidden for protected items */
  showAlways: boolean;
}

export function approvalCardView(a: { protected?: boolean; reasons?: unknown }): ApprovalCardView {
  const protectedItem = a.protected === true;
  const reasons = Array.isArray(a.reasons) ? a.reasons.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  return { protectedItem, reasons, showAlways: !protectedItem };
}

/** Who decided a tool call: `rule:<id>`, `mode:<mode>`, `user`, `timeout`, `abort`. Returns an i18n key and params, or null for nothing to show. */
export function decidedByLabel(decidedBy: unknown): { key: string; params: Record<string, string> } | null {
  if (typeof decidedBy !== 'string' || !decidedBy) return null;
  if (decidedBy === 'user' || decidedBy === 'timeout' || decidedBy === 'abort') return { key: `decidedBy.${decidedBy}`, params: {} };
  if (decidedBy.startsWith('rule:')) return { key: 'decidedBy.rule', params: { id: decidedBy.slice(5) } };
  if (decidedBy.startsWith('mode:')) return { key: 'decidedBy.mode', params: { mode: normalizeApprovalMode(decidedBy.slice(5)) } };
  return null;
}
