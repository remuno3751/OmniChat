import type { ModelGroup, ModelInfo } from './protocol';
import { isAgentBridgeKind } from './codeGroups';

/**
 * Pure helpers for the Code tab model picker (PROTOCOL-v7 section 1.3).
 * No React / React Native imports so the logic can be unit-tested under node.
 */

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

/**
 * The model groups shown by the Code tab picker.
 *
 * - Only `dsh-bridge` groups that have at least one model are considered.
 * - If none exist (old plugin, DSH unreachable, bridge offline) the full list is
 *   returned unchanged with `fallback: true` so the picker can show a note.
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
): { groups: ModelGroup[]; fallback: boolean } {
  const all = groups ?? [];
  const bridges = all.filter((g) => isAgentBridgeKind(g.kind) && g.models.length > 0);
  if (bridges.length === 0) return { groups: all, fallback: true };

  const selected = selProviderId ? bridges.filter((g) => g.providerId === selProviderId) : [];
  const used = selected.length > 0 ? selected : bridges;

  const out: ModelGroup[] = [];
  for (const bridge of used) {
    const order: string[] = [];
    const byName = new Map<string, ModelInfo[]>();
    for (const m of bridge.models) {
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
  return { groups: out, fallback: false };
}
