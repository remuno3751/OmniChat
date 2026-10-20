/**
 * Pure builders for the local "system cards" shown in the chat after a slash command
 * (/context, /usage, /compact, /help). No React, no i18n: the caller passes `tr`.
 */
import { formatTokens } from './usageFormat';
import type { CompactResult, ContextUsage, Settings, UsageChatRow, UsageSummary } from './protocol';
import type { UsagePeriod } from './slashCommands';

export type Tr = (key: string, params?: Record<string, string | number>) => string;

export interface SysCardRow { label: string; value?: string; pct?: number /* 0..100 -> thin proportional bar */ }

export interface SysCard {
  id: string;
  tone: 'info' | 'error' | 'busy';
  title: string;
  lines: string[];
  bar?: { pct: number; warn?: boolean };
  rowsTitle?: string;
  rows?: SysCardRow[];
  action?: { label: string; kind: 'openUsage' };
}

const WARN_PCT = 85;
const TOP_CHATS = 3;

let cardSeq = 0;
function nextId(): string {
  cardSeq += 1;
  return `sc-${Date.now().toString(36)}-${cardSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** Share of `part` in `whole` as an integer 0..100 (0 when whole is not positive). */
function sharePctOf(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return clampPct(Math.round((part / whole) * 100));
}

export function textCard(tone: SysCard['tone'], title: string, lines: string[] = []): SysCard {
  return { id: nextId(), tone, title, lines };
}

export function buildContextCard(
  u: ContextUsage,
  o: { model: string | null; settings: Pick<Settings, 'contextCompressAt' | 'contextCompressTarget' | 'contextOverflow'> | null },
  tr: Tr,
): SysCard {
  const total = u.total;
  const hasLimit = u.limit != null && u.limit > 0;
  const lines: string[] = [];
  const card: SysCard = {
    id: nextId(),
    tone: 'info',
    title: tr('slash.card.contextTitle'),
    lines,
  };

  if (hasLimit) {
    const limit = u.limit as number;
    const rawPct = Math.round((total / limit) * 100);
    lines.push(tr('slash.card.contextUsed', { used: formatTokens(total), limit: formatTokens(limit), pct: rawPct }));
    const pct = clampPct(rawPct);
    card.bar = { pct, warn: pct >= WARN_PCT };
  } else {
    lines.push(tr('slash.card.contextNoLimit', { used: formatTokens(total) }));
  }

  const summaryTokens = u.summaryTokens ?? 0;
  const system = Math.max(0, u.used.system - summaryTokens);
  const candidates: SysCardRow[] = [];
  const addRow = (key: string, value: number, always = false) => {
    if (!always && !(value > 0)) return;
    candidates.push({ label: tr(key), value: formatTokens(value), pct: sharePctOf(value, total) });
  };
  addRow('slash.card.ctxSystem', system);
  if (summaryTokens > 0) addRow('slash.card.ctxSummary', summaryTokens);
  addRow('slash.card.ctxHistory', u.used.history, true);
  addRow('slash.card.ctxAttach', u.used.attachments);
  addRow('slash.card.ctxTools', u.used.tools);
  addRow('slash.card.ctxInput', u.used.input);
  card.rows = candidates;

  if (o.model) lines.push(tr('slash.card.ctxModel', { model: o.model }));
  const s = o.settings;
  if (s) {
    if (s.contextCompressAt != null) {
      lines.push(tr('slash.card.ctxAuto', { at: s.contextCompressAt, target: s.contextCompressTarget ?? '' }));
    } else {
      lines.push(tr('slash.card.ctxAutoOff'));
    }
    lines.push(tr('slash.card.ctxOverflow', { mode: s.contextOverflow ?? 'truncate' }));
  }
  if (u.estimated) lines.push(tr('slash.card.ctxEstimated'));

  return card;
}

export function buildUsageCard(
  o: { period: UsagePeriod; summary: UsageSummary | null; chat: UsageSummary | null; chats: UsageChatRow[] },
  tr: Tr,
): SysCard {
  const periodLabel = tr(`slash.period.${o.period}`);
  const lines: string[] = [];
  const card: SysCard = {
    id: nextId(),
    tone: 'info',
    title: tr('slash.card.usageTitle', { period: periodLabel }),
    lines,
    action: { label: tr('slash.card.usageOpen'), kind: 'openUsage' },
  };

  const hasData = !!o.summary && o.summary.totals.messages > 0;
  const chatHasData = !!o.chat && o.chat.totals.messages > 0;

  if (!hasData || !o.summary) {
    lines.push(tr('slash.card.usageEmpty'));
    if (chatHasData && o.chat) {
      lines.push(tr('slash.card.usageThisChat', { total: formatTokens(o.chat.totals.totalTokens), messages: o.chat.totals.messages }));
    }
    return card;
  }

  const t = o.summary.totals;
  lines.push(`${tr('usage.kpi.total')}: ${formatTokens(t.totalTokens)}`);
  lines.push(
    tr('slash.card.usageTotals', {
      in: formatTokens(t.promptTokens),
      out: formatTokens(Math.max(0, t.completionTokens - t.reasoningTokens)),
      reasoning: formatTokens(t.reasoningTokens),
    }),
  );
  const top = o.summary.topModel;
  if (top) {
    lines.push(tr('slash.card.usageTopModel', { model: top.model ?? '-', total: formatTokens(top.totalTokens) }));
  }
  if (chatHasData && o.chat) {
    lines.push(tr('slash.card.usageThisChat', { total: formatTokens(o.chat.totals.totalTokens), messages: o.chat.totals.messages }));
  }
  if (o.summary.estimated) lines.push(tr('usage.estimatedNote'));

  const sorted = [...o.chats].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, TOP_CHATS);
  if (sorted.length > 0) {
    const max = sorted[0].totalTokens;
    card.rowsTitle = tr('slash.card.usageTopChats');
    card.rows = sorted.map((c) => ({
      label: c.title || tr('usage.noTitle'),
      value: formatTokens(c.totalTokens),
      pct: sharePctOf(c.totalTokens, max),
    }));
  }

  return card;
}

export function buildCompactCard(r: CompactResult, tr: Tr): SysCard {
  if (r.compacted) {
    return {
      id: nextId(),
      tone: 'info',
      title: tr('slash.card.compacted', { before: formatTokens(r.tokensBefore), after: formatTokens(r.tokensAfter) }),
      lines: [tr('slash.card.compactedNote', { n: r.summarizedMessages, k: r.keptMessages })],
    };
  }
  return { id: nextId(), tone: 'info', title: tr('slash.card.tooShort'), lines: [] };
}

export function buildHelpCard(
  entries: { name: string; argHint?: string; description: string }[],
  tr: Tr,
): SysCard {
  return {
    id: nextId(),
    tone: 'info',
    title: tr('slash.card.helpTitle'),
    lines: [],
    rows: entries.map((e) => ({
      label: '/' + e.name + (e.argHint ? ' ' + e.argHint : ''),
      value: e.description,
    })),
  };
}
