/** How far (px) a line of text wider than its box must travel to show its end; 0 when it fits. */
export function marqueeDistance(contentWidth: number, boxWidth: number): number {
  if (!(contentWidth > 0) || !(boxWidth > 0)) return 0;
  const d = Math.ceil(contentWidth - boxWidth);
  return d > 1 ? d : 0;
}

/** Travel time (ms) at a calm reading speed (about 40 px/s), never shorter than a second. */
export function marqueeDuration(distance: number): number {
  return Math.max(1000, Math.round((distance / 40) * 1000));
}
