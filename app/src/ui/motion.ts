import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** OS "reduce motion" preference (prefers-reduced-motion on web). */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setReduce(mq.matches);
      const on = () => setReduce(mq.matches);
      mq.addEventListener?.('change', on);
      return () => mq.removeEventListener?.('change', on);
    }
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduce(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => { live = false; sub.remove(); };
  }, []);
  return reduce;
}
