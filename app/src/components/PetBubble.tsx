import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Text, View, type StyleProp, type ViewStyle } from 'react-native';

const FADE_MS = 180;
const TAIL = 10;

/**
 * Speech bubble for the desktop pet: a light rounded box with a thin border (readable on any wallpaper),
 * a small tail pointing down at the pet, at most two lines. Fades in when `text` is set and out when it
 * becomes null (the last text stays until the fade ends). Position is set by the parent through `style`.
 */
export default function PetBubble({ text, style }: { text: string | null; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<string>(text ?? '');
  const native = Platform.OS !== 'web';

  useEffect(() => {
    if (text) setShown(text);
    const anim = Animated.timing(opacity, { toValue: text ? 1 : 0, duration: FADE_MS, useNativeDriver: native });
    anim.start();
    return () => anim.stop();
  }, [text, opacity, native]);

  return (
    <Animated.View pointerEvents="none" style={[{ opacity, alignItems: 'center' }, style]}>
      <View
        style={{
          maxWidth: 260,
          backgroundColor: '#fffdf7',
          borderWidth: 1,
          borderColor: 'rgba(0, 0, 0, 0.28)',
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 7,
          shadowColor: '#000',
          shadowOpacity: 0.15,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
          elevation: 2,
        }}
      >
        <Text numberOfLines={2} ellipsizeMode="tail" style={{ color: '#1d1b1a', fontSize: 14, lineHeight: 19 }}>
          {shown}
        </Text>
      </View>
      {/* Tail: a rotated square with a visible border on its lower-right sides, tucked under the box. */}
      <View
        style={{
          width: TAIL,
          height: TAIL,
          marginTop: -TAIL / 2 - 1,
          backgroundColor: '#fffdf7',
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderColor: 'rgba(0, 0, 0, 0.28)',
          transform: [{ rotate: '45deg' }],
          zIndex: -1,
        }}
      />
    </Animated.View>
  );
}
