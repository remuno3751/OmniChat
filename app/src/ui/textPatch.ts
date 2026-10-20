import { StyleSheet, Text } from 'react-native';
import { activeFonts } from '../theme';

/**
 * Applies the active theme's body font to every <Text> that has no explicit fontFamily
 * (code uses an explicit monospace family, so it is left alone). Simple has no font: a no-op.
 * Bold text switches to the bold face instead of synthesising one.
 */
const T = Text as any;
if (T && typeof T.render === 'function' && !T.__themePatched) {
  const orig = T.render;
  T.__themePatched = true;
  T.render = function patched(props: any, ref: any) {
    const f = activeFonts?.body;
    if (!f) return orig.call(this, props, ref);
    const flat = StyleSheet.flatten(props.style) || {};
    if (flat.fontFamily) return orig.call(this, props, ref);
    const w = flat.fontWeight;
    const bold = w === 'bold' || (w != null && Number(w) >= 600);
    return orig.call(this, { ...props, style: [props.style, { fontFamily: bold ? f.bold : f.regular, fontWeight: 'normal' }] }, ref);
  };
}
