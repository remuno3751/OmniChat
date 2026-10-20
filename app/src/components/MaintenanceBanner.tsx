import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { useT } from '../i18n';
import { formatEtaLocal, maintenanceView, parseMaintenance, type MaintenanceView } from '../maintenance';
import { useFaces } from '../ui/skin';
import { useTheme, useThemeDef } from '../theme';

/** Maintenance notice: title, the admin's message, the expected end time, and the admin note. */
export default function MaintenanceBanner({ view }: { view: MaintenanceView }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderColor: t.warn, borderWidth: th.bw, borderRadius: th.r(10), backgroundColor: t.panel2 }]}>
      <Text style={[styles.title, { color: t.text }, faces.labelBold]}>{tr('maint.bannerTitle')}</Text>
      {!!view.message && <Text style={{ color: t.text, fontSize: 13, lineHeight: 18 }}>{view.message}</Text>}
      {view.eta !== null && <Text style={{ color: t.sub, fontSize: 13 }}>{tr('maint.eta', { time: formatEtaLocal(view.eta) })}</Text>}
      {view.adminNote && <Text style={{ color: t.sub, fontSize: 12 }}>{tr('maint.adminNote')}</Text>}
    </View>
  );
}

/**
 * Before login: fetches GET /maintenance (no auth) and shows the notice when it is on.
 * Any failure (old server, offline) shows nothing.
 */
export function MaintenanceNotice() {
  const [view, setView] = useState<MaintenanceView | null>(null);
  useEffect(() => {
    let alive = true;
    api.getMaintenance()
      .then((r) => { if (alive) setView(maintenanceView(parseMaintenance(r?.maintenance), false)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return view && view.show ? <MaintenanceBanner view={view} /> : null;
}

const styles = StyleSheet.create({
  banner: { padding: 12, gap: 4, marginBottom: 10 },
  title: { fontSize: 14 },
});
