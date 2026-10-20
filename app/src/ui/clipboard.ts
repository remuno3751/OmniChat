import { Platform, Share } from 'react-native';

/** Copies text to the clipboard. Web: navigator.clipboard; native: falls back to the share sheet (no clipboard module installed). */
export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    try {
      await (globalThis as any).navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const d: any = (globalThis as any).document;
        const ta = d.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        d.body.appendChild(ta);
        ta.select();
        const ok = d.execCommand('copy');
        d.body.removeChild(ta);
        return !!ok;
      } catch { return false; }
    }
  }
  try { await Share.share({ message: text }); return true; } catch { return false; }
}
