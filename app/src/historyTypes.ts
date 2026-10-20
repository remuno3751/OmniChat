// Types and pure helpers for the phase-3 history search / backup / export / import endpoints
// (PROTOCOL-v3-phase3.md sections 3 and 4).
import { getDevice } from './deviceSettings';
import { resolveLanguage, t } from './i18n';

export interface HistoryResult {
  /** null = the conversation title matched (no message) */
  messageId: string | null;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  role: 'user' | 'assistant' | null;
  /** plain text; the hit is wrapped in \u0001 ... \u0002 */
  snippet: string;
  createdAt: number;
}
export interface HistorySearchResponse { results: HistoryResult[]; total: number }
export interface BackupInfo { name: string; size: number; createdAt: number }
export type ExportFormat = 'md' | 'json';
export type ExportBranches = 'current' | 'all';
/** Counts returned by POST /import (shape not fixed by the protocol: every numeric field is shown). */
export type ImportCounts = Record<string, unknown>;

/** Epoch seconds or milliseconds -> ms. */
export const toMs = (n: number) => (n > 0 && n < 1e11 ? n * 1000 : n);
export function fmtDate(n: number): string {
  try { return new Date(toMs(n)).toLocaleString(resolveLanguage(getDevice().language), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return t('hist.size.b', { n });
  if (n < 1024 * 1024) return t('hist.size.kb', { n: (n / 1024).toFixed(1) });
  if (n < 1024 * 1024 * 1024) return t('hist.size.mb', { n: (n / 1024 / 1024).toFixed(1) });
  return t('hist.size.gb', { n: (n / 1024 / 1024 / 1024).toFixed(2) });
}

/** Splits a snippet on the \u0001 / \u0002 markers into plain and highlighted pieces (never produces HTML). */
export function parseSnippet(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let hit = false;
  let buf = '';
  const flush = () => { if (buf) out.push({ text: buf, hit }); buf = ''; };
  for (const ch of s || '') {
    if (ch === '\u0001') { flush(); hit = true; }
    else if (ch === '\u0002') { flush(); hit = false; }
    else if (ch === '\n' || ch === '\r' || ch === '\t') buf += ' ';
    else buf += ch;
  }
  flush();
  return out;
}

export function safeFilename(s: string, ext: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (s || 'conversation').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'conversation';
  return `${base}.${ext}`;
}
