import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useTheme } from '../theme';

/*
 * Web-only drag & drop for the chat list. It is built on pointer events, not on the
 * HTML5 drag API: the desktop client (WebView2 inside Tauri) takes HTML5 drags for itself, so the drop never arrived.
 * RN-web Views do not expose DOM events, so the node is taken from the ref and the listeners are attached in an effect.
 * On native both wrappers only render their children (no listeners, no extra styles).
 */

const domOf = (ref: React.RefObject<View | null>): HTMLElement | null => (ref.current as unknown as HTMLElement | null) ?? null;

/** Pointer travel (px) before a press becomes a drag. */
const DRAG_START_PX = 6;
const ZONE_ATTR = 'data-omni-drop';
const zoneKey = (target: string | null): string => (target === null ? 'none' : 'folder:' + target);

interface Zone { target: string | null; accepts: (convId: string, target: string | null) => boolean; onDrop: (convId: string, target: string | null) => void }
/** Drop targets that are mounted, by zone key; the dragged row looks the zone under the pointer up here. */
const zones = new Map<string, Zone>();
/** The zone under the pointer while a chat is dragged (null = none), shared with every DropZone. */
let hoverKey: string | null = null;
const hoverListeners = new Set<() => void>();
function setHover(key: string | null): void {
  if (key === hoverKey) return;
  hoverKey = key;
  hoverListeners.forEach((fn) => fn());
}

/** True while a mouse (or pen) button is held on a chat row: a long press then means "about to drag", not "open the menu". */
let pressHeld = false;
export const mousePressHeld = (): boolean => pressHeld;

/** A small label that follows the pointer while dragging. */
function makeGhost(row: HTMLElement): HTMLElement {
  const g = document.createElement('div');
  g.textContent = (row.innerText || '').split('\n')[0].slice(0, 40);
  g.setAttribute('aria-hidden', 'true');
  Object.assign(g.style, {
    position: 'fixed', zIndex: '99999', pointerEvents: 'none', padding: '4px 10px', borderRadius: '8px', fontSize: '13px',
    background: 'rgba(30,30,30,0.85)', color: '#fff', maxWidth: '220px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  });
  document.body.appendChild(g);
  return g;
}

/** Wraps one conversation row: draggable on web (mouse and pen) when `enabled`; `dragging` dims it while it is dragged. */
export function DragRow({ convId, enabled, dragging, onStart, onEnd, children }: {
  convId: string;
  enabled: boolean;
  dragging: boolean;
  onStart: (convId: string) => void;
  onEnd: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<View>(null);
  const latest = useRef({ convId, onStart, onEnd });
  latest.current = { convId, onStart, onEnd };
  const web = Platform.OS === 'web';
  useEffect(() => {
    const el = web && enabled ? domOf(ref) : null;
    if (!el) return;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      pressHeld = true;
      const sx = e.clientX;
      const sy = e.clientY;
      let started = false;
      let ghost: HTMLElement | null = null;
      const zoneAt = (x: number, y: number): string | null => {
        const hit = document.elementFromPoint(x, y)?.closest(`[${ZONE_ATTR}]`);
        return hit ? hit.getAttribute(ZONE_ATTR) : null;
      };
      const move = (m: PointerEvent) => {
        if (!started) {
          if (Math.hypot(m.clientX - sx, m.clientY - sy) < DRAG_START_PX) return;
          started = true;
          latest.current.onStart(latest.current.convId);
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
          ghost = makeGhost(el);
        }
        if (ghost) { ghost.style.left = m.clientX + 12 + 'px'; ghost.style.top = m.clientY + 12 + 'px'; }
        setHover(zoneAt(m.clientX, m.clientY));
      };
      const finish = (u: PointerEvent | null) => {
        pressHeld = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        if (!started) return;
        const key = u ? zoneAt(u.clientX, u.clientY) : null;
        const zone = key ? zones.get(key) : undefined;
        ghost?.remove();
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        setHover(null);
        // the click that ends this press must not open the chat
        const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', swallow, true);
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        const id = latest.current.convId;
        latest.current.onEnd();
        if (zone && zone.accepts(id, zone.target)) zone.onDrop(id, zone.target);
      };
      const up = (u: PointerEvent) => finish(u);
      const cancel = () => finish(null);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    };
    el.addEventListener('pointerdown', down);
    return () => el.removeEventListener('pointerdown', down);
  }, [web, enabled]);
  if (!web || !enabled) return <>{children}</>;
  return <View ref={ref} style={dragging ? { opacity: 0.5 } : undefined}>{children}</View>;
}

/** `#rrggbb` with an alpha, for the tinted drop target (null when the colour is not a 6-digit hex). */
export function tintOf(hex: string, alpha: number): string | undefined {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return hex + a;
}

/**
 * Wraps a drop target (a folder header, or Unclassified when `target` is null). `dragId` is the chat being dragged (null when no drag);
 * `accepts` says whether it may land here (only then the target lights up); `onDrop` moves it.
 */
export function DropZone({ target, dragId, accepts, onDrop, children }: {
  target: string | null;
  dragId: string | null;
  accepts: (convId: string, target: string | null) => boolean;
  onDrop: (convId: string, target: string | null) => void;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const ref = useRef<View>(null);
  const [over, setOver] = useState(false);
  const key = zoneKey(target);
  const web = Platform.OS === 'web';
  const latest = useRef<Zone>({ target, accepts, onDrop });
  latest.current = { target, accepts, onDrop };
  useEffect(() => {
    const el = web ? domOf(ref) : null;
    if (!el) return;
    el.setAttribute(ZONE_ATTR, key);
    // the registry entry reads the latest props, so a re-render needs no re-registration
    zones.set(key, { target, accepts: (id, tg) => latest.current.accepts(id, tg), onDrop: (id, tg) => latest.current.onDrop(id, tg) });
    const sync = () => setOver(hoverKey === key);
    hoverListeners.add(sync);
    return () => {
      hoverListeners.delete(sync);
      zones.delete(key);
      el.removeAttribute(ZONE_ATTR);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web, key]);
  // the highlight is only on while a valid chat is over this target; it goes away with the drag
  const lit = over && dragId !== null && accepts(dragId, target);
  if (!web) return <>{children}</>;
  return (
    <View
      ref={ref}
      style={lit ? {
        backgroundColor: tintOf(t.accent, 0.14),
        outlineColor: t.accent,
        outlineWidth: 2,
        outlineStyle: 'solid',
        outlineOffset: -2,
      } as any : undefined}
    >
      {children}
    </View>
  );
}
