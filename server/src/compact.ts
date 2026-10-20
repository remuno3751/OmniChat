import { db, getConversationRow } from "./db.js";
import { AuthError } from "./auth.js";
import { measureContext, summarizeItems } from "./context.js";
import { quotaRefusal } from "./quota.js";

/* /compact: a manual, persisted summary. The summary covers the path up to compact_upto (the last summarized message);
   the messages themselves are never changed. buildContext (prompts.ts) sends the summary plus the messages after it. */

export type CompactResult =
  | {
      compacted: true;
      tokensBefore: number;
      tokensAfter: number;
      summarizedMessages: number;
      keptMessages: number;
      summaryTokens: number;
      estimated: boolean;
    }
  | { compacted: false; reason: "too_short" };

export interface CompactOpts {
  instructions?: string;
  /** Last N user messages and everything after them stay verbatim (default 2, clamped to 0..20). */
  keepTurns?: number;
}

const MAX_WORDS = 300;
const DEFAULT_LIMIT = 8000;

export async function compactConversation(userId: string, conv: any, opts: CompactOpts): Promise<CompactResult> {
  const keepTurns = Math.min(20, Math.max(0, Math.trunc(opts.keepTurns ?? 2)));
  const m = await measureContext({ userId, conv });
  const history = m.built.history;

  // Cut before the keepTurns-th user message counting from the end (keepTurns 0 summarizes the whole path).
  let cutAt = 0;
  if (keepTurns === 0) cutAt = history.length;
  else {
    let seen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role !== "user") continue;
      seen++;
      if (seen === keepTurns) { cutAt = i; break; }
    }
  }
  const cut = history.slice(0, cutAt);
  if (cut.length < 2) return { compacted: false, reason: "too_short" };

  if (m.prov?.kind !== "openai-compatible") throw new AuthError("This provider cannot summarize", 400);
  // An applied earlier compaction is folded into the new summary (its messages are no longer in `cut`).
  const previous = m.built.compactedTokens ? String(conv.compact_summary) : undefined;
  // a summary on a shared provider spends the owner's tokens: held to the same limits as a chat turn
  const quota = quotaRefusal(userId, m.prov);
  if (quota) throw new AuthError(quota.message, 429);
  const summary = await summarizeItems(m.prov, m.model, cut, m.usage.limit ?? DEFAULT_LIMIT, {
    instructions: opts.instructions, previous, maxWords: MAX_WORDS, userId,
  });
  if (!summary) throw new AuthError("Summarization failed", 502);

  db.prepare("UPDATE conversations SET compact_summary = ?, compact_upto = ?, compact_at = ? WHERE id = ?")
    .run(summary, cut[cut.length - 1].id, Date.now(), conv.id);

  const after = await measureContext({ userId, conv: getConversationRow(conv.id) });
  return {
    compacted: true,
    tokensBefore: m.usage.total,
    tokensAfter: after.usage.total,
    summarizedMessages: cut.length,
    keptMessages: history.length - cut.length,
    summaryTokens: after.built.compactedTokens ?? 0,
    estimated: m.usage.estimated || after.usage.estimated,
  };
}
