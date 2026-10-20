// OS notifications for v4 `notify` WS frames. Web: Notification API. Native: in-app toast only.
import { Platform } from 'react-native';
import { getState } from './store';
import { onNotify, type NotifyFrame } from './v4Events';
import { toast } from './ui/toast';
import { showChatDone } from './ui/chatBanner';

type Kind = NotifyFrame['kind'];

let unsub: (() => void) | null = null;
let askedOnce = false;

/** The browser Notification constructor, or null (native, or a browser without the API). */
function webNotification(): any {
  if (Platform.OS !== 'web') return null;
  try {
    const N = (globalThis as any).Notification;
    return typeof N === 'function' ? N : null;
  } catch {
    return null;
  }
}

/** Synced setting `notify.<kind>`; defaults to enabled. */
function kindEnabled(kind: Kind): boolean {
  try {
    const n = getState().settings?.notify;
    return n?.[kind] ?? true;
  } catch {
    return true;
  }
}

/**
 * Asks the browser for notification permission. Browsers only show the prompt after a user
 * gesture, so call this from a button (e.g. Settings). Returns the resulting permission or 'unsupported'.
 */
export async function ensureNotificationPermission(): Promise<string> {
  const N = webNotification();
  if (!N) return 'unsupported';
  askedOnce = true;
  try {
    if (N.permission === 'default') return String(await N.requestPermission());
    return String(N.permission);
  } catch {
    return String(N.permission ?? 'denied');
  }
}

async function showOs(N: any, f: NotifyFrame) {
  try {
    let perm = String(N.permission);
    // lazy request on the first need only; a dismissed prompt would otherwise reappear for every frame
    if (perm === 'default' && !askedOnce) perm = await ensureNotificationPermission();
    if (perm !== 'granted') return;
    const n = new N(f.title, { body: f.body, tag: f.conversationId + f.kind });
    n.onclick = () => {
      try { window.focus(); } catch {}
      try { n.close(); } catch {}
    };
  } catch {}
}

function handle(f: NotifyFrame) {
  try {
    if (!kindEnabled(f.kind)) return;
    const N = webNotification();
    const kind = f.kind === 'error' ? 'error' : 'info';
    // finished chat: a banner at the top, only for chats that are not open (no toast above the composer)
    const banner = f.kind === 'done';
    if (banner) {
      const hidden = typeof document !== 'undefined' && !!document.hidden;
      if (!hidden) showChatDone(f.conversationId, getState().conversations[f.conversationId]?.title || f.title);
      if (hidden && N) void showOs(N, f);
      return;
    }
    if (!N) {
      toast(f.title, kind);
      return;
    }
    const hidden = typeof document !== 'undefined' && !!document.hidden;
    // in-app toast while the page is visible; OS notification when hidden or for approvals
    if (!hidden) toast(f.title, kind);
    if (hidden || f.kind === 'approval') void showOs(N, f);
  } catch {}
}

/** Subscribes to WS `notify` frames. Safe to call more than once. */
export function startOsNotifications() {
  if (unsub) return;
  unsub = onNotify(handle);
}

export function stopOsNotifications() {
  try { unsub?.(); } catch {}
  unsub = null;
}
