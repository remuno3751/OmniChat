import type { ChatFolder, ChatMode, Conversation } from './protocol';

/* Chat folders: pure helpers (no React / api imports, so they run under node --test). */

export interface FolderGroups {
  /** folder id -> its chats, in input order (a folder without chats has no entry) */
  byFolder: Map<string, Conversation[]>;
  /** every chat not shown in a folder of this mode: unclassified, in a project, or in a deleted / other-mode folder */
  loose: Conversation[];
}

/** Splits the chats of one mode into their folders (`folders`: e.g. activeFolders(state.folders)). A project chat stays with its project (project wins). */
export function groupByFolder(conversations: Conversation[], folders: ChatFolder[], mode: ChatMode): FolderGroups {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const byFolder = new Map<string, Conversation[]>();
  const loose: Conversation[] = [];
  for (const c of conversations) {
    const f = c.folderId ? byId.get(c.folderId) : undefined;
    if (f && !f.deleted && f.mode === mode && !c.projectId) {
      const list = byFolder.get(f.id);
      if (list) list.push(c); else byFolder.set(f.id, [c]);
    } else {
      loose.push(c);
    }
  }
  return { byFolder, loose };
}

/** A new folder id: the same generator as api.uuid (not imported: api.ts pulls in react-native). */
export function newFolderId(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** dataTransfer type of a dragged conversation row (web drag & drop). */
export const CONV_DRAG_MIME = 'application/x-omnichat-conv';

/**
 * Where a dropped chat goes: `target` is a folder id, or null for Unclassified. Returns the server patch, or null when the
 * drop does nothing (not a chat of this mode, unknown / deleted / other-mode folder, or the chat is already there).
 * A chat in a project leaves the project when it lands in a folder or in Unclassified (the project wins over folders otherwise).
 */
export function folderDropPatch(
  conv: Pick<Conversation, 'mode' | 'folderId' | 'projectId'>,
  target: string | null,
  folders: ChatFolder[],
): { folderId: string | null; projectId?: null } | null {
  if ((conv.mode ?? 'chat') !== 'chat') return null;
  if (target !== null) {
    const f = folders.find((x) => x.id === target);
    if (!f || f.deleted || (f.mode ?? 'chat') !== 'chat') return null;
  }
  const current = conv.folderId ?? null;
  if (current === target && !conv.projectId) return null;
  if (target !== null) return { folderId: target, projectId: null };
  return conv.projectId ? { folderId: null, projectId: null } : { folderId: null };
}

/** Whether a dragged chat may be dropped on this target (the drop is shown as valid only then). */
export const canDropOn = (conv: Pick<Conversation, 'mode' | 'folderId' | 'projectId'>, target: string | null, folders: ChatFolder[]): boolean =>
  folderDropPatch(conv, target, folders) !== null;

/** Folder a new (not yet created) chat will go to, or null: only for the chat it was started for and while that folder is active. */
export function pendingFolderFor(pending: { id: string; folderId: string } | null, convId: string, folders: Record<string, ChatFolder>): ChatFolder | null {
  if (!pending || pending.id !== convId) return null;
  const f = folders[pending.folderId];
  return f && !f.deleted ? f : null;
}
