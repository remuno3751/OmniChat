/** Normalises a model-written title: first line, no <think> blocks, quotes / markdown / trailing punctuation stripped, max 60 chars. */
export function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l);
  if (!line) return null;
  s = line.replace(/^(title|タイトル)\s*[:：]\s*/i, "");
  s = s.replace(/^[\s"'`“”‘’「」『』*#_>\-–—]+/, "")
    .replace(/[\s"'`“”‘’「」『』*_.。!！?？,，;；:：…]+$/, "")
    .replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s || null;
}

/** Phrase boundaries a short title may end at: spaces and the usual punctuation (Japanese and Latin). */
const TITLE_BOUNDARY = /[\s、。，,.!?！？;；:：]/;

/**
 * The placeholder title of a first user message: its first line, at most `max` characters (code points). A longer line is
 * clipped at the last word or phrase boundary in its second half, else cut hard; trailing punctuation is dropped. "" for empty text.
 */
export function clipTitle(text: unknown, max = 30): string {
  const line = (typeof text === "string" ? text : "").split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? "";
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const head = chars.slice(0, max);
  let cut = head.length;
  for (let i = head.length - 1; i >= Math.floor(max / 2); i--) {
    if (TITLE_BOUNDARY.test(head[i])) { cut = i; break; }
  }
  return head.slice(0, cut).join("").replace(/[\s、。，,.!?！？;；:：]+$/, "").trim() || head.join("");
}
