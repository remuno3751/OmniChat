// Runs a parsed slash command in the Chat tab. No React here: ChatScreen supplies the state and callbacks through SlashEnv.
// Results are local system cards (never sent to the model, never stored on the server).
import { api, ApiError } from './api';
import { apiHistory, deliverText } from './apiHistory';
import { safeFilename } from './historyTypes';
import type { Conversation, Effort, Message, SearchMode, Settings } from './protocol';
import type { ModelSel } from './store';
import { setLastSel } from './store';
import { buildCompactCard, buildContextCard, buildHelpCard, buildUsageCard, textCard } from './slashCards';
import type { SysCard, Tr } from './slashCards';
import {
  SLASH_COMMANDS, commandAvailable, commandUsage, matchModel, parseEffortArg, parseExportArg, parseUsageArg,
} from './slashCommands';
import type { ModelCandidate, ParsedSlash } from './slashCommands';
import { slashPeriodRange, tzOffsetMinutes } from './usageFormat';
import { toast } from './ui/toast';

export interface SlashEnv {
  convId: string;
  /** the server conversation; undefined for a draft that is not created yet */
  conv: Conversation | undefined;
  /** ephemeral chat */
  eph: boolean;
  mode: 'chat' | 'code';
  streaming: boolean;
  tr: Tr;
  settings: Settings | null;
  /** the composer's effective model selection */
  sel: ModelSel | null;
  /** display name of the effective model (for /context) */
  modelName: string | null;
  /** web search mode and thinking effort of this chat (or of the draft) */
  chatSearch: SearchMode | null;
  chatEffort: Effort | null;
  /** every model of every provider, for /model */
  candidates: ModelCandidate[];
  /** visible messages of the current branch */
  path: Message[];
  /** regenerates an assistant message (same as the message's Regenerate button) */
  regenerate: (m: Message) => void;
  pushCard: (card: SysCard) => void;
  replaceCard: (id: string, card: SysCard) => void;
  newChat: () => void;
  openUsage: () => void;
  chooseModel: (sel: ModelSel) => void;
  pinEffort: (effort: Effort | null) => void;
  setPinned: (convId: string, pinned: boolean) => Promise<void>;
  openModelPicker: () => void;
  /** renames the chat on the server and updates the local store */
  putTitle: (title: string) => Promise<void>;
}

/** Settings a `/clear` chat carries into the next draft. Taken once by ChatScreen when the new chat opens. */
let carried: { search: SearchMode | null; effort: Effort | null } | null = null;

export function takeCarriedChat(): { search: SearchMode | null; effort: Effort | null } | null {
  const c = carried;
  carried = null;
  return c;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Runs one command. Never throws: any failure becomes an error card. */
export async function runSlashCommand(cmd: ParsedSlash, env: SlashEnv): Promise<void> {
  try {
    await run(cmd, env);
  } catch (e) {
    env.pushCard(textCard('error', errText(e)));
  }
}

async function run(cmd: ParsedSlash, env: SlashEnv): Promise<void> {
  const { tr } = env;
  const def = SLASH_COMMANDS.find((d) => d.name === cmd.name);
  if (!def) return;

  const avail = commandAvailable(def, { mode: env.mode, ephemeral: env.eph });
  if (avail === 'code') { env.pushCard(textCard('info', tr('slash.card.notInCode'))); return; }
  if (avail === 'ephemeral') { env.pushCard(textCard('info', tr('slash.card.notInEphemeral'))); return; }
  if (def.needsConv && !env.conv) { env.pushCard(textCard('info', tr('slash.card.noChat'))); return; }

  switch (cmd.name) {
    case 'compact': {
      if (env.streaming) { env.pushCard(textCard('info', tr('slash.card.busy'))); return; }
      const busy = textCard('busy', tr('slash.card.compacting'));
      env.pushCard(busy);
      try {
        const r = await api.compact(env.convId, { instructions: cmd.arg || undefined });
        env.replaceCard(busy.id, buildCompactCard(r, tr));
      } catch (e) {
        const card = e instanceof ApiError && e.status === 409
          ? textCard('info', tr('slash.card.busy'))
          : textCard('error', tr('slash.card.compactFailed', { msg: errText(e) }));
        env.replaceCard(busy.id, card);
      }
      return;
    }

    case 'context': {
      const u = await api.contextUsage(env.convId);
      env.pushCard(buildContextCard(u, { model: env.modelName, settings: env.settings }, tr));
      return;
    }

    case 'usage': {
      const period = parseUsageArg(cmd.arg);
      if (!period) { env.pushCard(textCard('info', tr('slash.card.usageHint', { usage: commandUsage('usage') }))); return; }
      const tz = tzOffsetMinutes();
      const from = slashPeriodRange(period, Date.now(), tz).from ?? undefined;
      const chatScoped = !!env.conv && !env.eph;
      try {
        const [summary, chat, chats] = await Promise.all([
          api.usageSummary({ from, tz }),
          chatScoped ? api.usageSummary({ from, tz, conversationId: env.convId }) : Promise.resolve(null),
          api.usageChats({ from, limit: 3 }),
        ]);
        env.pushCard(buildUsageCard({ period, summary, chat, chats: chats.chats }, tr));
      } catch (e) {
        const msg = e instanceof ApiError && e.status === 404 ? tr('usage.noServer') : tr('slash.card.usageFailed', { msg: errText(e) });
        env.pushCard(textCard('error', msg));
      }
      return;
    }

    case 'clear': {
      if (env.sel) setLastSel(env.sel);
      carried = { search: env.chatSearch, effort: env.chatEffort };
      env.newChat();
      return;
    }

    case 'help': {
      const ctx = { mode: env.mode, ephemeral: env.eph };
      const entries = SLASH_COMMANDS
        .filter((d) => commandAvailable(d, ctx) === 'ok')
        .map((d) => ({ name: d.name, argHint: d.argHint, description: tr(d.descKey) }));
      env.pushCard(buildHelpCard(entries, tr));
      return;
    }

    case 'rename': {
      const title = cmd.arg.trim();
      if (!title) { env.pushCard(textCard('info', tr('slash.card.usageHint', { usage: commandUsage('rename') }))); return; }
      await env.putTitle(title);
      env.pushCard(textCard('info', tr('slash.card.renamed', { title })));
      return;
    }

    case 'model': {
      if (!cmd.arg) { env.openModelPicker(); return; }
      const { best, ambiguous } = matchModel(cmd.arg, env.candidates);
      if (best) {
        env.chooseModel({ providerId: best.providerId, model: best.model });
        env.pushCard(textCard('info', tr('slash.card.modelSet', { model: best.label })));
      } else if (ambiguous.length > 0) {
        env.pushCard(textCard('info', tr('slash.card.modelAmbiguous', { q: cmd.arg, list: ambiguous.map((c) => c.label).join(', ') })));
      } else {
        env.pushCard(textCard('info', tr('slash.card.modelNone', { q: cmd.arg })));
      }
      return;
    }

    case 'effort': {
      const v = parseEffortArg(cmd.arg);
      if (!v) { env.pushCard(textCard('info', tr('slash.card.usageHint', { usage: commandUsage('effort') }))); return; }
      env.pinEffort(v === 'default' ? null : v);
      env.pushCard(textCard('info', tr('slash.card.effortSet', { value: v })));
      return;
    }

    case 'export': {
      const fmt = parseExportArg(cmd.arg);
      if (!fmt) { env.pushCard(textCard('info', tr('slash.card.usageHint', { usage: commandUsage('export') }))); return; }
      const conv = env.conv;
      if (!conv) return;
      try {
        const text = await apiHistory.exportConversation(conv.id, fmt, 'current', false);
        await deliverText(safeFilename(conv.title, fmt), text, fmt === 'md' ? 'text/markdown' : 'application/json');
        toast(tr('sheet.export.ready'), 'ok');
      } catch {
        toast(tr('sheet.export.failed'), 'error');
      }
      return;
    }

    case 'pin':
    case 'unpin': {
      const pinned = cmd.name === 'pin';
      await env.setPinned(env.convId, pinned);
      env.pushCard(textCard('info', tr(pinned ? 'slash.card.pinned' : 'slash.card.unpinned')));
      return;
    }

    case 'retry': {
      if (env.streaming) { env.pushCard(textCard('info', tr('slash.card.busy'))); return; }
      const last = [...env.path].reverse().find((m) => m.role === 'assistant');
      if (!last) { env.pushCard(textCard('info', tr('slash.card.retryNone'))); return; }
      env.regenerate(last);
      return;
    }

    default:
      return;
  }
}
