// Stills pets (server kind "stills"): one image per state, plus the pure helpers for creating them.
// Pure: no React Native imports, so node:test can cover it (see __tests__/petStills.test.ts).
import type { PetMode } from './petState';

export const STILL_STATES = ['idle', 'thinking', 'working', 'tool', 'done', 'error'] as const;
export type StillState = (typeof STILL_STATES)[number];

/** Each image is at most 600 KB after decoding (the server enforces the same limit). */
export const STILL_MAX_BYTES = 600 * 1024;
/** Images are scaled so the longest side is at most this many px before upload. */
export const STILL_EXPORT_PX = 512;
/** The server accepts 16..1024 px per side. */
export const STILL_MIN_PX = 16;
export const STILL_MAX_PX = 1024;
export const STILL_MAX_FILES = 6;
export const STILL_WEBP_QUALITY = 0.85;

/** Animation state -> still image state. */
export function petStateKey(mode: PetMode): StillState {
  switch (mode) {
    case 'idle': return 'idle';
    case 'thinking': return 'thinking';
    case 'running': return 'working';
    case 'searching': return 'tool';
    case 'waiting': return 'thinking';
    case 'failed': return 'error';
    case 'jumping':
    case 'waving': return 'done';
    default: return 'idle';
  }
}

/** State named by a file name ("Idle.png" -> idle). Only .png and .webp names count; anything else gives null. */
export function stillStateOf(fileName: string): StillState | null {
  const base = String(fileName || '').split(/[\\/]/).pop() || '';
  const m = /^(.+)\.(png|webp)$/i.exec(base.trim());
  if (!m) return null;
  const stem = m[1].trim().toLowerCase();
  return (STILL_STATES as readonly string[]).includes(stem) ? (stem as StillState) : null;
}

export interface StillMatch<T> {
  images: Partial<Record<StillState, T>>;
  /** file names that do not name a state */
  unmatched: string[];
  /** states that more than one file claims */
  duplicates: StillState[];
}

/** Assigns picked files to states by name. The first file wins for a duplicate state (it is reported). */
export function matchStillFiles<T extends { name: string }>(files: T[]): StillMatch<T> {
  const images: Partial<Record<StillState, T>> = {};
  const unmatched: string[] = [];
  const dup: StillState[] = [];
  for (const f of files) {
    const s = stillStateOf(f.name);
    if (!s) { unmatched.push(f.name); continue; }
    if (images[s]) { if (!dup.includes(s)) dup.push(s); continue; }
    images[s] = f;
  }
  return { images, unmatched, duplicates: dup };
}

export type StillProblem =
  | { key: 'pets.create.tooMany' }
  | { key: 'pets.create.unmatched'; names: string }
  | { key: 'pets.create.duplicate'; names: string }
  | { key: 'pets.create.needIdle' };

/** First problem with a file selection (by names only), or null when the selection can be processed. */
export function stillSelectionProblem(names: string[]): StillProblem | null {
  if (names.length > STILL_MAX_FILES) return { key: 'pets.create.tooMany' };
  const m = matchStillFiles(names.map((name) => ({ name })));
  if (m.unmatched.length) return { key: 'pets.create.unmatched', names: m.unmatched.join(', ') };
  if (m.duplicates.length) return { key: 'pets.create.duplicate', names: m.duplicates.join(', ') };
  if (!m.images.idle) return { key: 'pets.create.needIdle' };
  return null;
}

/** true when a decoded image is within the size limit. */
export function stillBytesOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= STILL_MAX_BYTES;
}

/** Input images only need at least 16 px on the short side (larger ones are scaled down). */
export function stillInputOk(w: number, h: number): boolean {
  return Math.min(w, h) >= STILL_MIN_PX;
}

/** Target size: longest side at most STILL_EXPORT_PX, aspect kept, never upscaled. */
export function stillExportSize(w: number, h: number, maxSide = STILL_EXPORT_PX): { w: number; h: number } {
  const s = Math.min(1, maxSide / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Pet name as typed: trimmed, at most 60 characters; null when empty. */
export function cleanPetName(name: string): string | null {
  const s = String(name || '').trim().slice(0, 60);
  return s || null;
}

/** Server id for a new stills pet: an ASCII slug of the name plus a random suffix (unique per upload). */
export function makeStillsPetId(name: string, rand: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  const slug = String(name || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'pet'}-${rand()}`;
}

const PROMPT_EN = `Create six images of ONE original character, to be used as a desktop pet. Every image must show the same character with the same design, proportions, outfit, colors and art style.

Format for every image:
- Transparent background (PNG or WebP with alpha). No background, no shadow on the ground, no frame or text.
- Square, 512 x 512 px.
- The character faces the viewer (front view), centered, with about 10% empty margin on every side. Keep the whole character inside the margin.
- Same scale and position in all six images, so they can replace each other without jumping.

The six images (one pose or expression each):
1. idle.png - relaxed, calm, a gentle smile. Standing or sitting at rest.
2. thinking.png - hand on the chin, eyes looking up, a thoughtful expression.
3. working.png - focused, typing on an invisible keyboard, eyes on the screen.
4. tool.png - holding a wrench or a magnifying glass, ready to use a tool.
5. done.png - happy and proud, both arms raised, a big smile.
6. error.png - troubled, a small sweat drop on the head, a worried face.

Name the files exactly: idle.png, thinking.png, working.png, tool.png, done.png, error.png. Do not add any other text to the images.`;

const PROMPT_JA = `同じ一人のオリジナルキャラクターの画像を6枚作ってください。デスクトップのペットとして使います。6枚すべてで、同じキャラクター・同じデザイン・同じ体の比率・同じ服装・同じ色づかい・同じ画風にしてください。

すべての画像の条件:
- 背景は透過(アルファ付きの PNG または WebP)。背景・地面の影・枠・文字は入れない。
- 正方形、512 x 512 px。
- キャラクターは正面を向き、中央に配置。四辺に約10%の余白をとり、全身が余白の内側に収まるようにする。
- 6枚とも大きさと位置をそろえる(差し替えたときにガタつかないように)。

6枚の内容(それぞれ1つのポーズ・表情):
1. idle.png - リラックスして落ち着いた様子。かすかにほほえむ。立つか座るかの休んだ姿勢。
2. thinking.png - あごに手を当て、目線を上に向けて考えている表情。
3. working.png - 集中した表情で、見えないキーボードを打っている。目は画面を見ている。
4. tool.png - レンチか虫めがねを持って、道具を使う構え。
5. done.png - うれしそうに誇らしげな表情。両腕を上げ、大きくほほえむ。
6. error.png - 困った表情。頭に小さな汗のしずく。

ファイル名は次のとおりに正確につけてください: idle.png, thinking.png, working.png, tool.png, done.png, error.png。画像に余計な文字は入れないでください。`;

/** Copy-and-paste prompt for an image generator (Claude, GPT image). Japanese or English by app language. */
export function buildPetPrompt(lang: 'ja' | 'en'): string {
  return lang === 'ja' ? PROMPT_JA : PROMPT_EN;
}
