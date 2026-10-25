import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { loadConfig } from '../api';
import { effectivePets, setDevice, useDevice } from '../deviceSettings';
import { useT } from '../i18n';
import { PET_CHANNEL, type PetChannelMessage } from '../desktopPet';
import { bubbleTtl } from '../petBubble';
import { itemsFromState, type PetItem } from '../petItems';
import { pageLabel, petSpriteMode, reconcileSelection, stackVisible, stepSelection } from '../petPager';
import { useTheme } from '../theme';
import PetBubble from './PetBubble';
import PetItemBubble from './PetItemBubble';
import PetSprite, { petBoxHeight, usePetAsset } from './PetSprite';

/** The pet window goes back to idle when the main app has sent nothing for this long (long enough for a minimized main window, whose timers are throttled). */
const SILENCE_MS = 75_000;
/** While only unread bubbles are shown, the pet waves this often. */
const WAVE_EVERY_MS = 12_000;

/** Makes the page transparent (the pet window has no background). Web only. */
function makeTransparent(): void {
  const doc = (globalThis as any).document;
  if (!doc) return;
  for (const el of [doc.documentElement, doc.body, doc.getElementById?.('root')]) {
    if (el) el.style.background = 'transparent';
  }
  doc.body.style.overflow = 'hidden';
}

/** Shell bridge call from the pet window (focus the main window). Ignored when the shell is not there. */
function petFocusApp(): void {
  try { (globalThis as any).window?.__OMNICHAT_DESKTOP__?.petFocusApp?.(); } catch { /* shell gone */ }
}

/**
 * The desktop pet window's page (opened as /?desktopPet=1 by the desktop shell): the pets, their speech
 * bubbles and a small menu. The state (one item per running or unread chat) comes from the main app over
 * BroadcastChannel('omnichat-pet'). Several chats: 'pager' (one bubble with < >) or 'stack' (bubbles above the
 * pet), per the device setting pets.multi. Pointer down on the pet starts a window drag (shell bridge);
 * double click waves; right click opens the menu.
 */
export default function DesktopPetPage() {
  const tr = useT();
  const t = useTheme();
  const dev = useDevice((s) => s.pets);
  const { size, multi } = dev;
  const [syncedPetId, setSyncedPetId] = useState<string | null>(null);
  const petId = effectivePets(dev, syncedPetId).petId;
  const [authed, setAuthed] = useState(false);
  const { pet } = usePetAsset(authed, petId);
  const [items, setItems] = useState<PetItem[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [waveSeq, setWaveSeq] = useState(0);
  const [walk, setWalk] = useState<'left' | 'right' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<any>(null);
  const walkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAt = useRef(0);
  const chRef = useRef<BroadcastChannel | null>(null);
  const prevItems = useRef<PetItem[]>([]);

  useEffect(() => { makeTransparent(); return () => { if (walkTimer.current) clearInterval(walkTimer.current); }; }, []);

  // Sign-in is the app's own: the pet is loaded with the saved server URL and token.
  useEffect(() => {
    let alive = true;
    loadConfig().finally(() => { if (alive) setAuthed(true); });
    return () => { alive = false; };
  }, []);

  // State from the main app. Say hello on start so the main app answers with its current state.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(PET_CHANNEL);
    chRef.current = ch;
    let legacyTimer: ReturnType<typeof setTimeout> | null = null;
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data as PetChannelMessage | undefined;
      if (!m || m.type !== 'state') return;
      lastAt.current = Date.now();
      if (m.activePetId !== undefined) setSyncedPetId(m.activePetId ?? null);
      setItems(itemsFromState(m));
      // an older publisher (no v) sends one state with no end: its bubble goes after the usual time
      if (!m.v) {
        if (legacyTimer) clearTimeout(legacyTimer);
        const ttl = m.mode ? bubbleTtl(m.mode) : null;
        legacyTimer = ttl == null ? null : setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== 'legacy')), ttl);
      }
    };
    ch.postMessage({ type: 'hello' });
    return () => {
      if (legacyTimer) clearTimeout(legacyTimer);
      chRef.current = null;
      ch.close();
    };
  }, []);

  // Silence watchdog: nothing from the main app for SILENCE_MS -> no bubbles.
  useEffect(() => {
    const id = setInterval(() => {
      if (lastAt.current && Date.now() - lastAt.current > SILENCE_MS) {
        lastAt.current = 0;
        setItems((prev) => (prev.length ? [] : prev));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // The selected chat (pager) follows the list: it stays while it exists, else its nearest neighbour.
  useEffect(() => {
    setSel((prev) => reconcileSelection(prev, prevItems.current, items));
    prevItems.current = items;
  }, [items]);

  const hasPet = !!petId && !!pet;
  const boxH = pet ? petBoxHeight(pet.info.kind === 'stills', size) : 0;
  const shown = multi === 'stack' ? stackVisible(items, boxH) : null;
  const current = multi === 'pager' ? (items.find((i) => i.id === sel) ?? null) : null;
  const spriteMode = petSpriteMode(items, multi, sel);
  const anyUnread = items.some((i) => i.unread);

  // With only unread chats to show, the pet waves now and then (reuses the wave of the sprite).
  const idleRef = useRef(false);
  idleRef.current = spriteMode === 'idle';
  useEffect(() => {
    if (!anyUnread) return;
    const id = setInterval(() => { if (idleRef.current) setWaveSeq((n) => n + 1); }, WAVE_EVERY_MS);
    return () => clearInterval(id);
  }, [anyUnread]);

  // Web pointer handling on the pet's box: a DOM listener, since RN's View does not expose these events.
  useEffect(() => {
    const el = boxRef.current as HTMLElement | null;
    if (!el || Platform.OS !== 'web') return;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      (globalThis as any).window?.__OMNICHAT_DESKTOP__?.petDrag?.();
      // The OS owns the drag, so the page sees no moves: follow the window's own position for the walking animation.
      const w = (globalThis as any).window;
      let last = w.screenX, idle = 0, ticks = 0;
      if (walkTimer.current) clearInterval(walkTimer.current);
      walkTimer.current = setInterval(() => {
        const x = w.screenX;
        ticks++;
        if (x !== last) { setWalk(x > last ? 'right' : 'left'); last = x; idle = 0; } else idle++;
        if (idle >= 5 || ticks > 300) { setWalk(null); if (walkTimer.current) clearInterval(walkTimer.current); walkTimer.current = null; }
      }, 80);
    };
    const dbl = () => setWaveSeq((n) => n + 1);
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('dblclick', dbl);
    el.addEventListener('contextmenu', ctx);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('dblclick', dbl);
      el.removeEventListener('contextmenu', ctx);
    };
  }, [hasPet]);

  /** A bubble's body: open that chat in the app (the main app navigates; the shell brings it forward). */
  const openItem = (id: string) => {
    try { chRef.current?.postMessage({ type: 'open', id }); } catch { /* channel closed */ }
    petFocusApp();
    setItems((prev) => prev.filter((i) => !(i.id === id && i.unread)));
  };
  /** The ✕ of an unread bubble: the main app clears its unread mark. */
  const dismissItem = (id: string) => {
    try { chRef.current?.postMessage({ type: 'dismiss', id }); } catch { /* channel closed */ }
    setItems((prev) => prev.filter((i) => !(i.id === id && i.unread)));
  };

  const hide = () => {
    setMenu(null);
    try { (globalThis as any).window?.__OMNICHAT_DESKTOP__?.petHide?.(); } catch { /* shell gone */ }
    setDevice({ pets: { desktop: false } });
  };

  const noPet = !petId;
  const bubbleText = noPet ? tr('pets.bubble.noPet') : null;

  return (
    <View style={[styles.root, { backgroundColor: 'transparent' }]}>
      {bubbleText ? (
        <PetBubble text={bubbleText} style={styles.bubble} />
      ) : multi === 'stack' ? (
        shown && (
          <View style={styles.stack}>
            {shown.more > 0 && (
              <View style={styles.moreWrap}>
                <Text style={styles.more}>{tr('pets.stack.more', { n: shown.more })}</Text>
              </View>
            )}
            {[...shown.shown].reverse().map((i) => (
              <View key={i.id} style={styles.stackRow}>
                <PetItemBubble item={i} lines={1} onOpen={() => openItem(i.id)} onDismiss={() => dismissItem(i.id)} />
              </View>
            ))}
          </View>
        )
      ) : (
        current && (
          <View style={styles.pager}>
            {items.length > 1 && (
              <View style={styles.nav}>
                <Pressable onPress={() => setSel(stepSelection(sel, items, -1))} accessibilityRole="button" accessibilityLabel={tr('pets.pager.prev')} hitSlop={6} style={styles.navBtn}>
                  <Text style={styles.navText}>‹</Text>
                </Pressable>
                <Text style={styles.navCount}>{pageLabel(sel, items)}</Text>
                <Pressable onPress={() => setSel(stepSelection(sel, items, 1))} accessibilityRole="button" accessibilityLabel={tr('pets.pager.next')} hitSlop={6} style={styles.navBtn}>
                  <Text style={styles.navText}>›</Text>
                </Pressable>
              </View>
            )}
            <PetItemBubble item={current} lines={2} onOpen={() => openItem(current.id)} onDismiss={() => dismissItem(current.id)} />
          </View>
        )
      )}
      {!!pet && (
        <View ref={boxRef} style={[styles.pet, { width: size, height: boxH, bottom: 0 }]}>
          <PetSprite
            info={pet.info}
            sheetUrl={pet.url}
            mode={spriteMode}
            size={size}
            activity="normal"
            waveSeq={waveSeq}
            walk={walk}
            accessible={false}
            style={styles.sprite}
          />
        </View>
      )}
      {!noPet && !pet && !authed && <ActivityIndicator color={t.accent} style={styles.loading} />}
      {menu && (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} accessibilityRole="button" />
          <View style={[styles.menu, { left: Math.min(menu.x, 320 - 170), top: Math.min(menu.y, 360 - 48) }]}>
            <Pressable onPress={hide} accessibilityRole="menuitem" style={styles.menuItem}>
              <Text style={styles.menuText}>{tr('pets.desktop.menuHide')}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' },
  // The bubble and the pet are stacked at the bottom centre of the window, the bubble directly above the pet.
  bubble: { alignItems: 'center', marginBottom: 6 },
  pager: { alignItems: 'center', marginBottom: 6, gap: 4 },
  // the pager's controls and the "+N" count sit on small light pills, so they read on any wallpaper
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fffdf7', borderWidth: 1, borderColor: 'rgba(0, 0, 0, 0.28)', borderRadius: 10, paddingHorizontal: 4 },
  navBtn: { paddingHorizontal: 6, paddingVertical: 1 },
  navText: { color: '#1d1b1a', fontSize: 16, fontWeight: '700' },
  navCount: { color: '#1d1b1a', fontSize: 12, minWidth: 28, textAlign: 'center' },
  stack: { alignItems: 'center', marginBottom: 6, gap: 6 },
  stackRow: { alignItems: 'center' },
  moreWrap: { alignItems: 'center' },
  more: { color: '#1d1b1a', fontSize: 12, fontWeight: '600', backgroundColor: '#fffdf7', borderWidth: 1, borderColor: 'rgba(0, 0, 0, 0.28)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  pet: { alignItems: 'center', justifyContent: 'flex-end' },
  sprite: {},
  loading: { position: 'absolute', bottom: 20 },
  menu: {
    position: 'absolute',
    width: 170,
    backgroundColor: '#fffdf7',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.28)',
    borderRadius: 8,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  menuItem: { paddingHorizontal: 12, paddingVertical: 8 },
  menuText: { color: '#1d1b1a', fontSize: 14 },
});
