import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getState } from './store';
import { isEphemeralId } from './ephemeral';

const key = (convKey: string) => `omnichat.draft.${getState().user?.userId || '_'}.${convKey}`;

/**
 * Composer text that survives reloads and disconnects: persisted per conversation in AsyncStorage
 * (a chat that does not exist yet shares the 'new' slot).
 */
export function useDraftText(convId: string, exists: boolean): [string, (v: string) => void] {
  const slot = exists ? convId : 'new';
  const [text, setText] = useState('');
  const slotRef = useRef(slot);
  const prev = useRef({ convId, slot });
  const timer = useRef<any>(null);

  useEffect(() => {
    const p = prev.current;
    prev.current = { convId, slot };
    slotRef.current = slot;
    // v7: an ephemeral chat's draft lives in React state only (never AsyncStorage)
    if (isEphemeralId(convId)) {
      if (p.convId !== convId) setText('');
      return;
    }
    // the same chat just got created on the server ('new' -> its own id): keep the text
    if (p.convId === convId && p.slot === 'new' && slot !== 'new') {
      AsyncStorage.removeItem(key('new')).catch(() => {});
      return;
    }
    let alive = true;
    setText('');
    AsyncStorage.getItem(key(slot)).then((v) => { if (alive && v && slotRef.current === slot) setText((cur) => cur || v); }).catch(() => {});
    return () => { alive = false; };
  }, [slot, convId]);

  const set = (v: string) => {
    setText(v);
    if (isEphemeralId(convId)) return;
    const k = key(slotRef.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      (v ? AsyncStorage.setItem(k, v) : AsyncStorage.removeItem(k)).catch(() => {});
    }, 250);
  };
  return [text, set];
}
