import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useThemeDef } from '../theme';
import { canHover, createTip } from '../tip';

export type TipPlacement = 'top' | 'bottom';

/**
 * Hover hint: shows `label` after the pointer rests on the child for TIP_DELAY_MS.
 * Web with a fine pointer only; elsewhere the children render untouched.
 */
export default function Tip({ label, placement = 'top', children }: { label: string; placement?: TipPlacement; children: React.ReactNode }) {
  if (!canHover(Platform.OS)) return <>{children}</>;
  return <WebTip label={label} placement={placement}>{children}</WebTip>;
}

function WebTip({ label, placement, children }: { label: string; placement: TipPlacement; children: React.ReactNode }) {
  const th = useThemeDef();
  const [open, setOpen] = useState(false);
  const tip = useMemo(() => createTip(setOpen), []);

  useEffect(() => () => tip.dispose(), [tip]);
  // Scrolling anywhere closes the tip.
  useEffect(() => {
    if (!open) return;
    const close = () => tip.hide();
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [open, tip]);

  const wrapProps = {
    onMouseEnter: () => tip.enter(),
    onMouseLeave: () => tip.leave(),
    onMouseDown: () => tip.hide(),
  } as any;

  return (
    <View {...wrapProps}>
      {children}
      {open && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', left: 0, right: 0, zIndex: 1000,
            ...(placement === 'top' ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 6 }),
            alignItems: 'center',
          }}
        >
          <View style={{ backgroundColor: 'rgba(20,20,24,0.92)', borderRadius: th.r(8), paddingHorizontal: 8, paddingVertical: 4, maxWidth: 240 }}>
            <Text style={{ color: '#fff', fontSize: 12, lineHeight: 16 }}>{label}</Text>
          </View>
        </View>
      )}
    </View>
  );
}
