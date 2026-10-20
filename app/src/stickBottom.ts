/** how far from the bottom (px) still counts as "following" the stream */
export const STICK_THRESHOLD = 80;

export function isNearBottom(
  m: { contentOffsetY: number; contentHeight: number; layoutHeight: number },
  threshold = STICK_THRESHOLD,
): boolean {
  return m.contentHeight - (m.contentOffsetY + m.layoutHeight) <= threshold;
}
