/* Attachment format checks (docs/design/ATTACHMENTS.md "上限と形式"). The client's name and MIME are not trusted:
   the extension must agree with the magic bytes (and, for OOXML / ZIP, with the entries inside). */
import JSZip from "jszip";

export type AttachmentKind = "image" | "document" | "audio";

export interface DetectedType {
  kind: AttachmentKind;
  mime: string;
  /** the extension(s) this content may carry */
  exts: string[];
  /** true for text-like content (served as attachment, text extracted by attachments-extract.ts) */
  text: boolean;
}

export class AttachmentTypeError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const MAX_NAME_CHARS = 200;

/** Extensions refused outright, whatever the content (executables, installers, packages, scripts). */
const DENY_EXT = new Set([
  "exe", "dll", "bat", "cmd", "ps1", "msi", "msp", "apk", "jar", "app", "com", "scr", "vbs", "vbe", "wsf", "hta",
  "lnk", "reg", "so", "dylib", "deb", "rpm", "pkg", "dmg", "iso", "svg", "svgz",
]);
/** Archives: refused, except Office Open XML containers (checked by their entries). */
const ARCHIVE_EXT = new Set(["zip", "7z", "rar", "gz", "tgz", "tar", "bz2", "xz", "zst"]);

/** Text extensions and their MIME types. Code files map to text/plain. */
const TEXT_MIME: Record<string, string> = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  xml: "application/xml", html: "text/html", htm: "text/html",
};
const CODE_EXT = [
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs",
  "rb", "php", "sh", "sql", "yaml", "yml", "toml", "ini", "css", "scss", "kts", "gradle", "r", "scala", "lua", "dart",
  "vue", "svelte", "tex", "rst", "env", "conf", "cfg",
];
for (const e of CODE_EXT) TEXT_MIME[e] ??= "text/plain";

const OFFICE_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const hex = (b: Buffer, off: number, bytes: number[]) => bytes.every((x, i) => b[off + i] === x);
const ascii = (b: Buffer, off: number, s: string) => b.length >= off + s.length && b.toString("latin1", off, off + s.length) === s;

/** The base name for storage and display: no path parts, no control characters, no leading dots, at most 200 characters. */
export function sanitizeFileName(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  try { s = decodeURIComponent(s); } catch { /* keep the raw value */ }
  s = s.split(/[\\/]/).pop() ?? "";
  s = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/[<>:"|?*]/g, "_").trim().replace(/^[.\s]+/, "").trim();
  if (s.length > MAX_NAME_CHARS) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return s || "file";
}

/** Lower-case extension without the dot ("" when none). */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const reject = (code: string, message: string, status = 415): never => {
  throw new AttachmentTypeError(status, code, message);
};

/** Text that holds no NUL byte and decodes as UTF-8 (BOM allowed) or Shift_JIS. Returns the decoded text, or null. */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { /* not UTF-8 */ }
  try { return new TextDecoder("shift_jis", { fatal: true }).decode(body); } catch { return null; }
}

/** Office Open XML kind from the entry names (ZIP central directory only, nothing is inflated). */
async function officeKind(buf: Buffer): Promise<"docx" | "pptx" | "xlsx" | null> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { return null; }
  const names = Object.keys(zip.files);
  if (names.length > 10_000) return null;
  if (!names.includes("[Content_Types].xml")) return null;
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  return null;
}

/**
 * Decides what the bytes are. Throws AttachmentTypeError (415 attachment_type_not_allowed) when the file is refused,
 * or when its extension does not match its content. `name` must already be sanitised.
 */
export async function detectType(name: string, buf: Buffer): Promise<DetectedType> {
  const ext = extOf(name);
  const deny = "attachment_type_not_allowed";
  if (buf.length === 0) reject(deny, "empty file", 400);
  if (DENY_EXT.has(ext)) reject(deny, `files of type .${ext} are not allowed`);
  if (ARCHIVE_EXT.has(ext)) reject(deny, `archives (.${ext}) are not allowed`);

  // Executables, whatever the name says.
  if (hex(buf, 0, [0x4d, 0x5a])) reject(deny, "executable content is not allowed");
  if (hex(buf, 0, [0x7f, 0x45, 0x4c, 0x46])) reject(deny, "executable content is not allowed");
  if (hex(buf, 0, [0xfe, 0xed, 0xfa, 0xce]) || hex(buf, 0, [0xfe, 0xed, 0xfa, 0xcf]) || hex(buf, 0, [0xce, 0xfa, 0xed, 0xfe])
    || hex(buf, 0, [0xcf, 0xfa, 0xed, 0xfe]) || hex(buf, 0, [0xca, 0xfe, 0xba, 0xbe])) reject(deny, "executable content is not allowed");

  const expect = (d: DetectedType): DetectedType => {
    if (!d.exts.includes(ext)) reject(deny, `the file content does not match its extension (.${ext || "none"})`);
    return d;
  };

  if (hex(buf, 0, [0x89, 0x50, 0x4e, 0x47])) return expect({ kind: "image", mime: "image/png", exts: ["png"], text: false });
  if (hex(buf, 0, [0xff, 0xd8, 0xff])) return expect({ kind: "image", mime: "image/jpeg", exts: ["jpg", "jpeg"], text: false });
  if (ascii(buf, 0, "GIF8")) return expect({ kind: "image", mime: "image/gif", exts: ["gif"], text: false });
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return expect({ kind: "image", mime: "image/webp", exts: ["webp"], text: false });
  if (ascii(buf, 0, "%PDF")) return expect({ kind: "document", mime: "application/pdf", exts: ["pdf"], text: false });

  if (hex(buf, 0, [0x50, 0x4b, 0x03, 0x04]) || hex(buf, 0, [0x50, 0x4b, 0x05, 0x06]) || hex(buf, 0, [0x50, 0x4b, 0x07, 0x08])) {
    const kind = (await officeKind(buf)) ?? reject(deny, "zip archives are not allowed (only Office documents)");
    return expect({ kind: "document", mime: OFFICE_MIME[kind]!, exts: [kind], text: false });
  }

  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WAVE")) return expect({ kind: "audio", mime: "audio/wav", exts: ["wav"], text: false });
  if (ascii(buf, 0, "ID3") || hex(buf, 0, [0xff, 0xfb]) || hex(buf, 0, [0xff, 0xf3]) || hex(buf, 0, [0xff, 0xf2])) {
    return expect({ kind: "audio", mime: "audio/mpeg", exts: ["mp3"], text: false });
  }
  if (ascii(buf, 0, "OggS")) return expect({ kind: "audio", mime: "audio/ogg", exts: ["ogg", "oga", "opus"], text: false });
  if (ascii(buf, 0, "fLaC")) return expect({ kind: "audio", mime: "audio/flac", exts: ["flac"], text: false });
  if (ascii(buf, 4, "ftyp") && ext === "m4a") return { kind: "audio", mime: "audio/mp4", exts: ["m4a"], text: false };
  if (hex(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return expect({ kind: "audio", mime: "audio/webm", exts: ["webm"], text: false });

  // Text: no NUL, valid UTF-8 or Shift_JIS, and the extension must be a text one.
  const text = decodeText(buf);
  if (text !== null) {
    if (buf[0] === 0x23 && buf[1] === 0x21 && ext !== "sh") reject(deny, "scripts (#!) are only allowed as .sh");
    const mime = TEXT_MIME[ext];
    if (!mime) reject(deny, `text files with the extension .${ext || "none"} are not allowed`);
    return { kind: "document", mime, exts: [ext], text: true };
  }
  return reject(deny, "unknown or binary content is not allowed");
}
