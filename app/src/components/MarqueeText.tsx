import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, Text } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { marqueeDistance, marqueeDuration } from '../marquee';
import { useThemeDef } from '../theme';

/**
 * One line of text that scrolls to the end (one way, then jumps back to the start) when it is wider than its box (a truncated name would otherwise stay cut off).
 * With motion off (theme duration 0) it stays a plain truncated line.
 */
export default function MarqueeText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const th = useThemeDef();
  const [box, setBox] = useState(0);
  const [content, setContent] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const scroller = useRef<ScrollView>(null);
  const distance = marqueeDistance(content, box);
  const animate = distance > 0 && th.dur.base > 0;

  useEffect(() => {
    const id = x.addListener(({ value }) => scroller.current?.scrollTo({ x: value, animated: false }));
    return () => x.removeListener(id);
  }, [x]);

  useEffect(() => {
    x.setValue(0);
    if (!animate) return;
    const ms = marqueeDuration(distance);
    // one way only: pause -> scroll to the end -> pause -> jump back to the start -> (pause -> scroll again)
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(1500),
      Animated.timing(x, { toValue: distance, duration: ms, easing: Easing.linear, useNativeDriver: false }),
      Animated.delay(1200),
      Animated.timing(x, { toValue: 0, duration: 0, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [animate, distance, children]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      scrollEnabled={false}
      showsHorizontalScrollIndicator={false}
      onLayout={(e) => setBox(e.nativeEvent.layout.width)}
      onContentSizeChange={(w) => setContent(w)}
    >
      <Text numberOfLines={1} style={style}>{children}</Text>
    </ScrollView>
  );
}
