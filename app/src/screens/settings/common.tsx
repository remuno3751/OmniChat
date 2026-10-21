import React, { createContext, useContext } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Icon from '../../components/Icon';
import { useTheme, useThemeDef } from '../../theme';
import { Enter, Rule, SectionTitle, useFaces } from '../../ui/skin';
import { ScreenHeader } from '../../ui/kit';

/** True while a settings page is shown inside the wide two-pane layout (no back-arrow header). */
export const EmbeddedContext = createContext(false);

/** A settings page: header with a back arrow, then a scrolling body. */
export function PageFrame({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  const t = useTheme();
  const themed = useThemeDef().def.id !== 'simple';
  const embedded = useContext(EmbeddedContext);
  // themes let the decorated background show through
  const bg = themed ? 'transparent' : t.bg;
  if (embedded) {
    return (
      <Enter style={[styles.root, { backgroundColor: bg }]}>
        <ScrollView contentContainerStyle={styles.body}>
          <PageTitle title={title} />
          {children}
        </ScrollView>
      </Enter>
    );
  }
  return (
    <Enter style={[styles.root, { backgroundColor: bg }]}>
      <ScreenHeader title={title} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
    </Enter>
  );
}

/** Page title of the wide layout. Frontier: big heading + hatched rule. Astral: gold rule with a star under it. */
function PageTitle({ title }: { title: string }) {
  const t = useTheme();
  const th = useThemeDef();
  const faces = useFaces();
  if (th.def.id === 'simple') return <Text accessibilityRole="header" style={[styles.pageTitle, { color: t.text }]}>{title}</Text>;
  return (
    <View style={{ marginBottom: 8, gap: 8 }}>
      <Text accessibilityRole="header" style={[styles.pageTitle, { color: t.text, fontSize: 24, marginBottom: 0 }, faces.headingBold]}>{title}</Text>
      <Rule />
    </View>
  );
}

/** A tappable row that opens a sub-screen: title, one-line hint and a chevron. */
export function NavRow({ title, hint, onPress }: { title: string; hint?: string; onPress: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[styles.navRow, { borderColor: t.border, backgroundColor: t.panel, borderRadius: th.r(12) }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{title}</Text>
        {!!hint && <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{hint}</Text>}
      </View>
      <Icon name="chevronRight" size={20} color={t.sub} />
    </Pressable>
  );
}

/** Section heading inside a page. */
export function Section({ title, first }: { title: string; first?: boolean }) {
  return <SectionTitle title={title} first={first} simpleStyle={styles.section} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 16, gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  section: { fontSize: 16, fontWeight: '700' },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  pageTitle: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
});
