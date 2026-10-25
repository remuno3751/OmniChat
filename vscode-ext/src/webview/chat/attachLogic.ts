/** Pure attachment rules and text helpers for the composer (no DOM, unit tested). */
import type { AttachLimitsView } from "./types";

export const MIB = 1024 * 1024;

export interface CandidateFile {
  name: string;
  mime: string;
  size: number;
}
export interface AttachTotals {
  count: number;
  totalBytes: number;
}
export type AttachProblem = "badType" | "tooBig" | "totalBig" | "tooMany" | "noVision";

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * Pre-check of one file against the host's limits (the server enforces the same and decides the rest). Returns the
 * first problem, or null when the file may be added. Audio and video are refused; an image whose type is not in
 * `imageMimes`, or any image while the model is known not to read images, is refused too.
 */
export function checkAttachment(file: CandidateFile, totals: AttachTotals, limits: AttachLimitsView): AttachProblem | null {
  if (file.mime.startsWith("audio/") || file.mime.startsWith("video/")) return "badType";
  if (isImageMime(file.mime)) {
    if (!limits.imageMimes.includes(file.mime)) return "badType";
    if (limits.visionOk === false) return "noVision";
  }
  if (file.size > limits.maxFileBytes) return "tooBig";
  if (totals.count + 1 > limits.maxFiles) return "tooMany";
  if (totals.totalBytes + file.size > limits.maxTotalBytes) return "totalBig";
  return null;
}

/** Human size: "512 B", "3.4 KB", "1.2 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/** A limit in MB for the messages: whole numbers stay whole ("4"), others keep one decimal ("2.5"). */
export function limitMb(bytes: number): string {
  const mb = Math.round((bytes / MIB) * 10) / 10;
  return String(mb);
}

/** Replaces each `{key}` of a localised template with its value; unknown keys stay as they are. */
export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
