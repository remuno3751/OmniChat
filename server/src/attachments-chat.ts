/* Attachments on the chat path (docs/PROTOCOL-v7-attachments.md "LLM に渡す内容").
   Turns the attachments of user messages into the text notes / image parts the model receives.
   A message without attachments is never touched: its body stays the plain string. */
import { isAgentBridgeKind } from "./agent-kinds.js";
import type { ContentPart } from "./providers/index.js";
import { attachmentsForMessage, loadAttachmentForModel, type AttachmentRecord } from "./attachments.js";
import { readAttachmentSettings } from "./attachments-settings.js";
import { visionSupport, type VisionSupport } from "./vision.js";
import { getSettings } from "./projects.js";
import { modelsForUser } from "./models.js";
import { estimateTokens } from "./tokens.js";

/** Images of one request: the newest ones win. */
export const MAX_IMAGES = 4;
/** Fixed token cost of one image for the estimate. */
export const IMAGE_TOKENS = 800;

export interface WireItem {
  /** the text form of the body (notes + the original text); this is `content` of the ChatMessage */
  content: string;
  /** set when images are sent: the body as OpenAI content parts */
  parts?: ContentPart[];
  /** same as `content`, for token estimates */
  text: string;
  /** images sent */
  images: number;
  /** estimated tokens of the attachment part only (notes + 800 per image) */
  attachmentTokens: number;
}

export interface WireInput { id: string; role: string; content: string }

const unreadable = (name: string) => `[画像 ${name} は、このモデルでは読めません]`;

/** Does the model get image bytes on this provider? */
const canSendImages = (vision: VisionSupport, kind: string): boolean => vision === "yes" && kind === "openai-compatible";

/**
 * Wire form of every history item that has attachments. `recsOf(id)` gives the records (default: the stored ones);
 * `getVision` is called only when an image is present. Items without attachments are not in the map.
 */
export async function buildWire(
  items: WireInput[],
  recsOf: (id: string) => AttachmentRecord[],
  getVision: () => Promise<VisionSupport>,
  providerKind: string,
): Promise<Map<string, WireItem>> {
  const out = new Map<string, WireItem>();
  const recs = new Map<string, AttachmentRecord[]>();
  const loaded = new Map<string, ReturnType<typeof loadAttachmentForModel>>();
  let hasImage = false;
  for (const it of items) {
    if (it.role !== "user") continue;
    const rs = recsOf(it.id);
    if (!rs.length) continue;
    recs.set(it.id, rs);
    for (const r of rs) if (r.kind === "image" && r.status === "ready") hasImage = true;
  }
  if (!recs.size) return out;
  const bridge = isAgentBridgeKind(providerKind);
  // Code: the whole message's document text is held to the same limit as one document (extractMaxChars).
  const codeBudget = bridge ? readAttachmentSettings().extractMaxChars : 0;
  const sendImages = hasImage && !bridge && canSendImages(await getVision(), providerKind);

  // Which images go out: the newest MAX_IMAGES that can still be read.
  const sendSet = new Set<string>();
  if (sendImages) {
    const order: string[] = [];
    for (const it of items) for (const r of recs.get(it.id) ?? []) if (r.kind === "image") order.push(`${it.id}\u0000${r.id}`);
    for (let i = order.length - 1; i >= 0 && sendSet.size < MAX_IMAGES; i--) {
      const [mid, aid] = order[i].split("\u0000");
      const r = recs.get(mid)!.find((x) => x.id === aid)!;
      const m = loadAttachmentForModel(r);
      if (m?.dataUrl) { sendSet.add(order[i]); loaded.set(order[i], m as never); }
    }
  }

  for (const it of items) {
    const rs = recs.get(it.id);
    if (!rs) continue;
    const notes: string[] = [];
    const imageParts: ContentPart[] = [];
    let codeUsed = 0; // Code (dsh-bridge): characters of document text already in this message
    for (const r of rs) {
      if (r.kind === "image") {
        const key = `${it.id}\u0000${r.id}`;
        if (r.status !== "ready") notes.push(`[添付: ${r.name}(削除済み)]`);
        else if (sendSet.has(key)) imageParts.push({ type: "image_url", image_url: { url: (loaded.get(key) as { dataUrl: string }).dataUrl } });
        else if (sendImages) notes.push(`[画像: ${r.name}(省略)]`);
        else notes.push(unreadable(r.name));
        continue;
      }
      if (r.status !== "ready") { notes.push(`[添付: ${r.name}(削除済み)]`); continue; }
      if (bridge) { notes.push(codeDocumentNote(r, codeBudget - codeUsed, (n) => { codeUsed += n; })); continue; }
      const m = loadAttachmentForModel(r);
      if (!m) { notes.push(`[添付: ${r.name}(削除済み)]`); continue; }
      if (r.kind === "audio" && m.text === undefined) { notes.push(`[添付: ${r.name}(文字起こしなし)]`); continue; }
      let n = `[添付: ${r.name}]`;
      if (m.text) n += `\n${m.text}`;
      if (m.truncated) n += `\n(以下省略: 全 ${m.truncated.total} 文字中 ${m.truncated.shown} 文字)`;
      notes.push(n);
    }
    const head = notes.join("\n");
    const text = head ? `${head}\n\n${it.content}` : it.content;
    const images = imageParts.length;
    out.set(it.id, {
      content: text,
      ...(images ? { parts: [{ type: "text" as const, text }, ...imageParts] } : {}),
      text,
      images,
      attachmentTokens: (head ? estimateTokens(head) : 0) + IMAGE_TOKENS * images,
    });
  }
  return out;
}

/**
 * One document of a Code (dsh-bridge) message: its extracted text as the chat path gives it (`[添付: name]` + text,
 * cut by extractMaxChars), and cut again so the whole message stays within `budget` characters.
 * Images and audio never reach the bridge (the send is refused first; this is the defensive form).
 * `spend` reports the characters used.
 */
export function codeDocumentNote(r: AttachmentRecord, budget: number, spend: (n: number) => void): string {
  if (r.kind !== "document") return `[添付: ${r.name}(Code では AI に渡せません)]`;
  const m = loadAttachmentForModel(r);
  if (!m) return `[添付: ${r.name}(削除済み)]`;
  const full = m.text ?? "";
  const total = m.truncated?.total ?? full.length;
  const take = Math.max(0, Math.min(full.length, budget));
  spend(take);
  let n = `[添付: ${r.name}]`;
  if (take > 0) n += `\n${full.slice(0, take)}`;
  if (take < total) n += `\n(以下省略: 全 ${total} 文字中 ${take} 文字)`;
  return n;
}

/** Can the model read images? Looks at the (cached) model list of the provider and the user's own override. "unknown" on any failure. */
export async function resolveVision(userId: string, prov: any, model: string): Promise<VisionSupport> {
  try {
    let entry: { vision?: VisionSupport } | undefined;
    try {
      const res = await modelsForUser(userId, prov, false, false);
      entry = res.models.find((m) => m.id === model);
    } catch { entry = undefined; }
    return visionSupport(prov, model, entry, getSettings(userId).modelVision ?? undefined);
  } catch { return "unknown"; }
}

/** The stored attachments of a message (re-exported so context.ts has one import). */
export const storedAttachments = attachmentsForMessage;
