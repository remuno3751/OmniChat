import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ZERO_INSETS, avoidPadding, keyboardOverlap } from '../keyboardMath';
import type { Insets } from '../keyboardMath';

/** Safe-area insets as plain numbers. Web has none (ZERO_INSETS); native reads the provider from App's root. */
const useNativeInsets: () => Insets = Platform.OS === 'web' ? () => ZERO_INSETS : useSafeAreaInsets;
export const useInsets = (): Insets => useNativeInsets();

interface KeyboardState { visible: boolean; top: number | null }

/** Soft keyboard state (native only; web is always hidden). `top` is the keyboard's top edge in window pixels. */
export function useKeyboard(): KeyboardState {
  const [kb, setKb] = useState<KeyboardState>({ visible: false, top: null });
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const pairs: [string, boolean][] = Platform.OS === 'ios'
      ? [['keyboardWillShow', true], ['keyboardWillChangeFrame', true], ['keyboardWillHide', false]]
      : [['keyboardDidShow', true], ['keyboardDidHide', false]];
    const subs = pairs.map(([name, visible]) =>
      Keyboard.addListener(name as any, (e: any) => setKb({ visible, top: e?.endCoordinates?.screenY ?? null })),
    );
    return () => subs.forEach((s) => s.remove());
  }, []);
  return kb;
}

interface KeyboardAvoidProps {
  style?: StyleProp<ViewStyle>;
  /** extra bottom padding while the keyboard is hidden (always added) */
  rest?: number;
  /** add the bottom safe-area inset while the keyboard is hidden */
  useInset?: boolean;
  pointerEvents?: ViewProps['pointerEvents'];
  children?: React.ReactNode;
}

/**
 * A View whose bottom padding keeps its content above the soft keyboard. The overlap is measured from the View's own
 * window position, so it stays correct when the window resizes a frame later (re-measured after each keyboard event).
 */
export function KeyboardAvoid({ style, rest = 0, useInset = false, pointerEvents, children }: KeyboardAvoidProps) {
  const insets = useInsets();
  const kb = useKeyboard();
  const ref = useRef<View>(null);
  const kbRef = useRef(kb);
  kbRef.current = kb;
  const [overlap, setOverlap] = useState(0);

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.measureInWindow((_x, y, _w, h) => setOverlap(keyboardOverlap(y + h, kbRef.current.top)));
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    measure();
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [kb.visible, kb.top, measure]);

  if (Platform.OS === 'web') return <View style={style} pointerEvents={pointerEvents}>{children}</View>;

  const paddingBottom = avoidPadding({ keyboardVisible: kb.visible, overlap, insetBottom: useInset ? insets.bottom : 0, rest });
  return (
    <View ref={ref} onLayout={measure} pointerEvents={pointerEvents} style={[style, { paddingBottom }]}>
      {children}
    </View>
  );
}
