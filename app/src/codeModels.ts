import { isAgentBridgeKind, VSCODE_KIND } from './codeGroups';
import type { Conversation, ModelGroup, ModelInfo } from './protocol';

/**
 * Pure helpers for the Code tab model picker (PROTOCOL-v7 section 1.3).
 * No React / React Native imports so the logic can be unit-tested under node.
 */

/** A Code selection: a provider and a model (same shape as store's ModelSel). */
export interface ModelSel { providerId: string; model: string | null }

export interface CodeModelLabels {
  /** suffix appended to the name of the model currently selected in the dsh GUI */
  current: string;
  /** suffix appended to the name of a model imported from OmniChat into dsh */
  imported: string;
}

/** Id prefix before '::' (e.g. "lmstudio::qwen3" -> "lmstudio"), or '' when there is none. */
function idPrefix(id: string): string {
  const i = id.indexOf('::');
  return i >= 0 ? id.slice(0, i) : '';
}

/** The dsh group name of a bridge model: ModelInfo.group, else derived from the id prefix. */
function subgroupName(m: ModelInfo): string {
  return m.group ?? idPrefix(m.id);
}

/** Model name with the current / imported suffixes ("current" first). */
function decoratedName(m: ModelInfo, labels: CodeModelLabels): string {
  let name = m.name;
  if (m.current) name += ` · ${labels.current}`;
  if (m.imported) name += ` · ${labels.imported}`;
  return name;
}

/** Looks up the provider kind of a provider id (undefined when unknown). */
export type KindOf = (providerId: string) => string | null | undefined;

/**
 * A model entry a bridge lists only as a placeholder (e.g. the VS Code extension's "custom model" rows), not a real model.
 * Real models have an id and a name that is not the custom placeholder.
 */
export function isPlaceholderModel(m: ModelInfo): boolean {
  return !m.id.trim() || /\bcustom\b/i.test(m.id) || /カスタム|\bcustom\b/i.test(m.name);
}

/**
 * The model groups shown by the Code tab picker.
 *
 * - Only `dsh-bridge` / `vscode-bridge` groups with at least one real (non-placeholder) model are considered, and their
 *   placeholder entries are dropped.
 * - If none exist (old plugin, DSH unreachable, VS Code PC without a model list) the bridges themselves are never listed:
 *   the groups of the user's model providers are returned with `fallback: true`. `dshNote` says whether the picker should
 *   explain the fallback (false when the selected device is a VS Code PC).
 * - Otherwise only the bridge group matching `selProviderId` is used when the
 *   selection is a bridge; in every other case all bridge groups are used.
 * - Each used bridge group is split into one pseudo-group per distinct dsh group
 *   name (`ModelInfo.group`, or the id prefix for old plugins), in first-appearance
 *   order. A pseudo-group keeps the original providerId/kind/capabilities/etc.,
 *   sets `subKey` to the dsh group name and `providerName` to
 *   "<bridge name> · <dsh group name>" (just the bridge name when the dsh name is empty).
 * - Model names get " · <current>" and " · <imported>" suffixes from `labels`.
 *   Model order inside a subgroup is the incoming order.
 *
 * Pure: the input groups and models are never mutated; new objects are returned.
 */
export function codeModelView(
  groups: ModelGroup[] | null,
  selProviderId: string | null,
  labels: CodeModelLabels,
): { groups: ModelGroup[]; fallback: boolean; dshNote: boolean } {
  const all = groups ?? [];
  const selKind = all.find((g) => g.providerId === selProviderId)?.kind;
  const bridges = all.filter((g) => isAgentBridgeKind(g.kind) && g.models.some((m) => !isPlaceholderModel(m)));
  if (bridges.length === 0) {
    return { groups: all.filter((g) => !isAgentBridgeKind(g.kind)), fallback: true, dshNote: selKind !== VSCODE_KIND };
  }

  const selected = selProviderId ? bridges.filter((g) => g.providerId === selProviderId) : [];
  const used = selected.length > 0 ? selected : bridges;

  const out: ModelGroup[] = [];
  for (const bridge of used) {
    const order: string[] = [];
    const byName = new Map<string, ModelInfo[]>();
    for (const m of bridge.models) {
      if (isPlaceholderModel(m)) continue;
      const name = subgroupName(m);
      let list = byName.get(name);
      if (!list) {
        list = [];
        byName.set(name, list);
        order.push(name);
      }
      list.push({ ...m, name: decoratedName(m, labels) });
    }
    for (const name of order) {
      out.push({
        ...bridge,
        subKey: name,
        providerName: name ? `${bridge.providerName} · ${name}` : bridge.providerName,
        models: byName.get(name) ?? [],
      });
    }
  }
  return { groups: out, fallback: false, dshNote: false };
}

/**
 * The selection of a Code chat is the bridge (device) plus, for a model of a normal provider, the model stored as
 * `<providerId>::<model>`. `toCodeSel` builds it from the current selection and the picked model: the bridge stays,
 * the model is wrapped. Picking a bridge (a device) returns it as it is. Outside a bridge selection `next` is returned.
 */
export function toCodeSel(cur: ModelSel | null, next: ModelSel, kindOf: KindOf): ModelSel {
  if (!cur || !isAgentBridgeKind(kindOf(cur.providerId))) return next;
  if (isAgentBridgeKind(kindOf(next.providerId))) return next;
  return { providerId: cur.providerId, model: next.model ? `${next.providerId}::${next.model}` : null };
}

/**
 * The provider and model a Code selection shows (picker highlight and label). A model stored as `<providerId>::<model>`
 * is split on its first '::' when the prefix is a known model provider (not a bridge). Anything else (a bridge's own
 * model ids such as "lmstudio::a") is returned unchanged.
 */
export function fromCodeSel(sel: ModelSel, kindOf: KindOf): ModelSel {
  const model = sel.model ?? '';
  const i = model.indexOf('::');
  if (i <= 0) return sel;
  const prefix = model.slice(0, i);
  const k = kindOf(prefix);
  if (!k || isAgentBridgeKind(k)) return sel;
  return { providerId: prefix, model: model.slice(i + 2) };
}

/** True when the selection holds a model of a normal provider (stored under a bridge). */
export function isWrappedCodeSel(sel: ModelSel, kindOf: KindOf): boolean {
  return isAgentBridgeKind(kindOf(sel.providerId)) && fromCodeSel(sel, kindOf).providerId !== sel.providerId;
}

/** The most recent Code conversation's wrapped model, as a selection on its bridge (null when none). */
export function lastCodeSel(convs: Conversation[], kindOf: KindOf): ModelSel | null {
  const sel = [...convs]
    .filter((c) => c.mode === 'code' && !!c.providerId && !!c.model)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ providerId: c.providerId as string, model: c.model }))
    .find((s) => isWrappedCodeSel(s, kindOf));
  return sel ?? null;
}

/**
 * The selection a new Code chat starts with on `device`: the first prior selection (newest first) whose model is a
 * normal provider's model, kept on the device; else the device's own model `own` (a DSH list); else null (the user must pick).
 */
export function codeStartSel(device: string, prior: (ModelSel | null | undefined)[], kindOf: KindOf, own: string | null): ModelSel | null {
  for (const s of prior) if (s && s.model && isWrappedCodeSel(s, kindOf)) return { providerId: device, model: s.model };
  return own ? { providerId: device, model: own } : null;
}

/** Error text of a server/send failure in the Code tab: the i18n key to show instead, or null to show the text as it is. */
export function codeErrorKey(message: string | null | undefined, code?: string | null): string | null {
  if (code === 'code_not_bridge') return 'code.notBridge';
  if (code === 'confirm_required') return 'code.confirmRequired';
  if (message && /Choose a model for this Code chat|モデルが選ばれていません/i.test(message)) return 'code.pickModelFirst';
  if (message && /使えるツールがありません|no tools? (?:is |are )?(?:available|offered)|offers? no tools/i.test(message)) return 'code.noTools';
  return null;
}
