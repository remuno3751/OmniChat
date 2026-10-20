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
