import React, { useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, api, defaultDeviceName, getServerUrl, saveAuth, setServerUrl } from '../api';
import { setNotice, useStore } from '../store';
import { MaintenanceNotice } from '../components/MaintenanceBanner';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { APP_ICONS } from '../appIcon';
import { useDeviceSetting } from '../deviceSettings';
import { Barcode, useFaces } from '../ui/skin';
import { serverOriginForPage, shouldShowServerUrlField } from '../serverUrlField';
import { DESKTOP_CHANGE_SERVER_URL, isDesktopShell } from '../components/DesktopServerSwitch';

// Web served by the OmniChat server itself: the server is this page's origin, so the URL field is hidden.
const pageLocation = () => (Platform.OS === 'web' ? (globalThis as any).location : undefined);

export default function LoginScreen({ onAuthed }: { onAuthed: (a: { userId: string; username: string; token: string; deviceId?: string }) => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const faces = useFaces();
  const [appIcon] = useDeviceSetting('appIcon');
  const logo = (APP_ICONS.find((i) => i.id === appIcon) ?? APP_ICONS[0]).image;
  const plate = th.def.variants.tabs === 'tag' && th.fx;
  const showUrlField = shouldShowServerUrlField(Platform.OS, pageLocation());
  const pageOrigin = serverOriginForPage(pageLocation());
  const [url, setUrl] = useState(getServerUrl());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const notice = useStore((s) => s.notice);

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) { setErr(tr('login.enterCredentials')); return; }
    setBusy(true); setErr('');
    try {
      await setServerUrl(showUrlField ? url : (pageOrigin ?? url));
      const fn = mode === 'login' ? api.login : api.register;
      const r = await fn(username.trim(), password, deviceName.trim() || defaultDeviceName());
      setNotice('');
      const a = { userId: r.userId, username: r.username, token: r.token, deviceId: r.deviceId, isAdmin: r.isAdmin };
      await saveAuth(a);
      onAuthed(a);
    } catch (e) {
      setErr(e instanceof ApiError && mode === 'register' && (e.status === 403 || /disabled/i.test(e.message)) ? tr('login.regDisabled') : e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, { borderRadius: th.r(10) }, { color: t.text, borderColor: t.border, backgroundColor: t.input }];
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <MaintenanceNotice />
          <Image source={logo} style={[styles.logo, { borderRadius: th.r(16) }, plate && { borderWidth: 1, borderColor: t.border }]} accessibilityLabel="OmniChat" />
          {plate ? (
            <View style={styles.plate} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={{ width: 8, height: 8, backgroundColor: th.dark ? t.accent : t.accent2, borderWidth: th.dark ? 0 : 1, borderColor: t.text }} />
              <Text numberOfLines={1} style={[{ color: t.text, fontSize: 13, fontWeight: '700', flexShrink: 0 }, faces.headingBold, { letterSpacing: 3 }]}>OMNICHAT</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
              <Barcode width={48} height={10} color={t.sub} />
            </View>
          ) : (
            <Text style={[styles.title, { color: t.text }, faces.headingBold]}>OmniChat</Text>
          )}
          {showUrlField && (
            <>
              <Text style={[styles.label, { color: t.sub }, faces.label]}>{tr('login.serverUrl')}</Text>
              <TextInput style={input} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} placeholderTextColor={t.sub} />
            </>
          )}
          <Text style={[styles.label, { color: t.sub }, faces.label]}>{tr('login.username')}</Text>
          <TextInput style={input} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholderTextColor={t.sub} />
          <Text style={[styles.label, { color: t.sub }, faces.label]}>{tr('login.password')}</Text>
          <TextInput style={input} value={password} onChangeText={setPassword} secureTextEntry onSubmitEditing={submit} placeholderTextColor={t.sub} />
          <Text style={[styles.label, { color: t.sub }, faces.label]}>{tr('login.deviceName')}</Text>
          <TextInput style={input} value={deviceName} onChangeText={setDeviceName} placeholderTextColor={t.sub} />
          {!!notice && !err && <Text style={[styles.err, { color: t.danger }]} accessibilityRole="alert">{notice}</Text>}
          {!!err && <Text style={[styles.err, { color: t.danger }]} accessibilityRole="alert">{err}</Text>}
          <Pressable style={[styles.btn, { borderRadius: th.r(10) }, { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 }]} onPress={submit} accessibilityRole="button">
            {busy ? <ActivityIndicator color={t.accentText} /> : <Text style={[styles.btnText, { color: t.accentText }]}>{mode === 'login' ? tr('login.logIn') : tr('login.register')}</Text>}
          </Pressable>
          <Pressable onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
            <Text style={[styles.link, { color: t.accentInk }]}>{mode === 'login' ? tr('login.noAccount') : tr('login.haveAccount')}</Text>
          </Pressable>
          {mode === 'login' && <Text style={[styles.link, { color: t.sub, fontSize: 12, marginTop: 12 }]}>{tr('login.forgot')}</Text>}
          {isDesktopShell() && (
            // the desktop app shows the server's own login page: a wrong address needs a way back to the launcher without logging in
            <Pressable onPress={() => { (globalThis as any).location.href = DESKTOP_CHANGE_SERVER_URL; }} accessibilityRole="link">
              <Text style={[styles.link, { color: t.accentInk, marginTop: 8 }]}>{tr('desktop.changeServer')} ({String((globalThis as any).location?.host ?? '')})</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380 },
  title: { fontSize: 32, fontWeight: '700', marginBottom: 24, textAlign: 'center' },
  logo: { width: 72, height: 72, alignSelf: 'center', marginBottom: 14 },
  plate: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  label: { fontSize: 13, marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  err: { marginTop: 12 },
  btn: { marginTop: 20, paddingVertical: 12, alignItems: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
  link: { marginTop: 16, textAlign: 'center', fontSize: 14 },
});
