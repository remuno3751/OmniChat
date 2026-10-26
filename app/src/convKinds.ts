// Which kind logos a conversation row shows (docs/design/ARIA-HOST.md). Pure, no React.
export type ConvKind = 'chat' | 'voice';

/** Logos to show before a conversation title, in fixed order (chat, then voice).
 *  Absent, empty or invalid kinds (old server) fall back to the chat logo. */
export function kindLogos(kinds: unknown): ConvKind[] {
  const list = Array.isArray(kinds) ? kinds : [];
  const out: ConvKind[] = [];
  if (list.includes('chat')) out.push('chat');
  if (list.includes('voice')) out.push('voice');
  return out.length ? out : ['chat'];
}
