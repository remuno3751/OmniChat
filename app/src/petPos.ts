// Pet position inside the chat area, stored as fractions (0..1) of the free room:
// fx = 0 is the left edge, fx = 1 the right edge (the pet's own width is excluded). Pure, no React Native.

export interface PetPos { fx: number; fy: number }
export interface PetBox { w: number; h: number }
export interface PetPx { left: number; top: number }

const unit = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

/** Validates a stored position. Out-of-range numbers are clamped into 0..1; anything else gives null (default spot). */
export function normalizePetPos(raw: unknown): PetPos | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const fx = unit(r.fx);
  const fy = unit(r.fy);
  if (fx === null || fy === null) return null;
  return { fx, fy };
}

/** Room the pet can move in: container minus pet size, never negative. */
function room(area: PetBox, pet: PetBox): { x: number; y: number } {
  return { x: Math.max(0, area.w - pet.w), y: Math.max(0, area.h - pet.h) };
}

/** Keeps the whole pet inside the container. */
export function clampPetPx(px: PetPx, area: PetBox, pet: PetBox): PetPx {
  const r = room(area, pet);
  return {
    left: Math.min(r.x, Math.max(0, px.left)),
    top: Math.min(r.y, Math.max(0, px.top)),
  };
}

/** Fractions -> pixels (top-left corner of the pet inside the container). */
export function petPosToPx(pos: PetPos, area: PetBox, pet: PetBox): PetPx {
  const r = room(area, pet);
  return { left: pos.fx * r.x, top: pos.fy * r.y };
}

/** Pixels -> fractions, clamped and rounded to 4 decimals so the stored value stays small. */
export function petPxToPos(px: PetPx, area: PetBox, pet: PetBox): PetPos {
  const r = room(area, pet);
  const frac = (v: number, max: number) => (max > 0 ? Math.min(1, Math.max(0, v / max)) : 0);
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return { fx: round(frac(px.left, r.x)), fy: round(frac(px.top, r.y)) };
}

/** Left offset (inside the pet box) that centres a grip of the given width on the pet's top edge. */
export function petGripLeft(pet: PetBox, gripW: number): number {
  return Math.max(0, (pet.w - gripW) / 2);
}

/** Bottom anchor (px above the bottom of the chat area) of the in-app pet on a wide screen. */
export const PET_ANCHOR_BOTTOM = 110;
/** Below this width the composer is taller (wrapped send row), so the pet sits above it. */
export const PET_NARROW_WIDTH = 560;
/** Composer height assumed on narrow screens (not measured; tune on a device). */
export const PET_NARROW_COMPOSER_PX = 138;

/** Bottom anchor for the in-app pet: above the composer on narrow screens, so it never covers the send button. */
export function petAnchorBottom(width: number, composerPx: number = PET_NARROW_COMPOSER_PX): number {
  return width < PET_NARROW_WIDTH ? composerPx + 12 : PET_ANCHOR_BOTTOM;
}
