import type { Message } from './protocol';

export interface Tree {
  /** messages in stable creation order */
  list: Message[];
  byId: Map<string, Message>;
  /** effective parent: parentId, or the previous message for rows from an old server (no parentId field) */
  parent: Map<string, string | null>;
  /** parent -> children ids ordered by createdAt */
  children: Map<string | null, string[]>;
}

const cmp = (a: Message, b: Message) => a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildTree(msgs: Message[]): Tree {
  const list = [...msgs].sort(cmp);
  const byId = new Map(list.map((m) => [m.id, m]));
  const parent = new Map<string, string | null>();
  const children = new Map<string | null, string[]>();
  let prev: string | null = null;
  for (const m of list) {
    const p: string | null = m.parentId !== undefined ? m.parentId : prev; // old server: linear chain
    parent.set(m.id, p);
    const arr = children.get(p) || [];
    arr.push(m.id);
    children.set(p, arr);
    prev = m.id;
  }
  return { list, byId, parent, children };
}

/** Deepest, latest leaf below (and including) id: follow the newest child until none. */
export function deepestLeaf(tree: Tree, id: string): string {
  let cur = id;
  for (let i = 0; i < 10000; i++) {
    const kids = tree.children.get(cur);
    if (!kids || !kids.length) return cur;
    cur = kids[kids.length - 1];
  }
  return cur;
}

/** The newest leaf overall (fallback when headId is unknown). */
function latestLeaf(tree: Tree): string | null {
  let best: Message | null = null;
  for (const m of tree.list) {
    if (tree.children.get(m.id)?.length) continue;
    if (!best || cmp(best, m) < 0) best = m;
  }
  return best ? best.id : null;
}

/** The visible path root -> headId. */
export function visiblePath(tree: Tree, headId: string | null | undefined): Message[] {
  let cur: string | null = headId && tree.byId.has(headId) ? headId : latestLeaf(tree);
  const out: Message[] = [];
  const seen = new Set<string>();
  while (cur && tree.byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(tree.byId.get(cur)!);
    cur = tree.parent.get(cur) ?? null;
  }
  return out.reverse();
}

/** Sibling ids (same parent, ordered) of a message, including itself. */
export function siblingsOf(tree: Tree, id: string): string[] {
  const p = tree.parent.get(id) ?? null;
  return tree.children.get(p) || [id];
}
