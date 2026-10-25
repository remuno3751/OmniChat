import { db } from "./db.js";

/** A chat folder: a user-made group of chats (not a project; projects carry their own prompt and defaults). */
export interface ChatFolder { id: string; name: string; mode: "chat" | "code"; createdAt: number; updatedAt: number; deleted: boolean; seq: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
export const toFolder = (r: any): ChatFolder => ({
  id: r.id, name: r.name, mode: r.mode === "code" ? "code" : "chat",
  createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq,
});
export const getFolderRow = (id: string): any => db.prepare("SELECT * FROM chat_folders WHERE id = ?").get(id);
