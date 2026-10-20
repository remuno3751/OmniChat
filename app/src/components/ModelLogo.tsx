import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { markLogoFailed, useModelLogoUri } from '../modelLogoCache';
import { useT } from '../i18n';
import { MARK_PATHS } from './modelLogoData';
import { resolveFamily } from './modelFamily';

/** The maker's real logo (server lookup, see modelLogoCache) on a light chip, or the built-in family badge as fallback. */
export default function ModelLogo({ model, size = 22, publisher }: { model: string; size?: number; publisher?: string }) {
  const t = useT();
  const logo = useModelLogoUri(model, publisher);
  const fam = resolveFamily(model, publisher);
  const label = fam.key === '' ? t('model.logo.unknown') : fam.name;
  const radius = size * 0.22;
  const path = fam.mark ? MARK_PATHS[fam.mark] : undefined;
  const glyph = size * 0.62;

  if (logo) {
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={label}
        style={[styles.logoChip, { width: size, height: size, borderRadius: radius, padding: size * 0.08 }]}
      >
        <Image
          source={logo}
          resizeMode="contain"
          style={{ width: '100%', height: '100%' }}
          onError={() => markLogoFailed(model, publisher)}
        />
      </View>
    );
  }

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: fam.bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      {path ? (
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={path} fill="#FFFFFF" />
        </Svg>
      ) : (
        <Text
          style={{ color: '#FFFFFF', fontSize: size * (fam.monogram.length > 1 ? 0.36 : 0.46), fontWeight: '700', lineHeight: size, textAlign: 'center' }}
          allowFontScaling={false}
        >
          {fam.monogram}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  logoChip: { backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
});
