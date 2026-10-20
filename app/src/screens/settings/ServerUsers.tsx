import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { adminApi } from '../../apiAdmin';
import type { AdminRole, AdminUser } from '../../apiAdmin';
import { validatePassword, validateUsername } from '../../adminValidate';
import { useT } from '../../i18n';
import { useTheme, useThemeDef } from '../../theme';
import { confirmDialog } from '../../ui/confirm';
import UserGrantsSheet from './UserGrantsSheet';
import { Btn, Check, Field, Hint, Label, Segmented, Sheet, fmtAgo } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { formatTokens } from '../../usageFormat';

const GEN_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Random 12-character password without look-alike characters. */
function genPassword(): string {
  const buf = new Uint32Array(12);
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 4294967296);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += GEN_CHARS[buf[i] % GEN_CHARS.length];
  return out;
}

const errOf = (e: unknown, fallback: string) => (e as any)?.message || fallback;

/** Settings > Server > Users: the list of accounts and their actions. The parent renders the section heading. */
export default function ServerUsers({ onChanged }: { onChanged?: () => void }) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [data, setData] = useState<{ users: AdminUser[]; you: string } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [deleteFor, setDeleteFor] = useState<AdminUser | null>(null);
  const [grantsFor, setGrantsFor] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.users();
      setData({ users: r.users || [], you: r.you });
      setLoadErr('');
    } catch (e) {
      setLoadErr(errOf(e, tr('admin.users.loadFailed')));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => { void load(); }, [load]);

  /** After any successful change: a saved toast, a fresh list, and the parent's callback. */
  const changed = useCallback((msg: string) => {
    toast(msg, 'ok');
    void load();
    onChanged?.();
  }, [load, onChanged]);

  /** A list action on one user: busy state while it runs, an error toast on failure. */
  const run = async (u: AdminUser, fn: () => Promise<unknown>, okMsg: string) => {
    setBusyId(u.id);
    try {
      await fn();
      changed(okMsg);
    } catch (e) {
      toast(errOf(e, tr('admin.users.failed')), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleRole = (u: AdminUser) =>
    run(u, () => adminApi.patchUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }), tr('admin.users.saved'));

  const toggleDisabled = (u: AdminUser) =>
    run(u, () => adminApi.patchUser(u.id, { disabled: !u.disabled }), tr('admin.users.saved'));

  const signOutEverywhere = async (u: AdminUser) => {
    const ok = await confirmDialog(
      tr('admin.users.signOutTitle', { name: u.username }),
      tr('admin.users.signOutMsg'),
      tr('admin.users.signOutOk'),
    );
    if (!ok) return;
    await run(u, () => adminApi.revokeUser(u.id), tr('admin.users.signedOut'));
  };

  const users = data?.users ?? [];

  return (
    <View style={styles.root}>
      <Hint>{tr('admin.users.hint')}</Hint>
      <View style={styles.toolbar}>
        <Btn small primary label={tr('admin.users.add')} onPress={() => setAddOpen(true)} />
        <Btn small label={tr('common.refresh')} onPress={() => void load()} disabled={loading} />
      </View>
      {loading && !data && <ActivityIndicator color={t.accentInk} style={{ margin: 16 }} />}
      {!!loadErr && <Hint danger>{loadErr}</Hint>}
      {data && users.length === 0 && !loadErr && <Text style={{ color: t.sub }}>{tr('admin.users.empty')}</Text>}

      {users.map((u) => {
        const self = u.id === data?.you;
        const busy = busyId === u.id;
        const meta = [
          u.lastSeenAt ? tr('admin.users.lastSeen', { ago: fmtAgo(u.lastSeenAt) }) : tr('admin.users.neverSeen'),
          tr('admin.users.devices', { n: u.devices }),
          tr('admin.users.tokens30d', { n: formatTokens(u.tokens30d) }),
        ].join('  ·  ');
        return (
          <View key={u.id} style={[styles.card, { borderRadius: th.r(12), borderColor: t.border, backgroundColor: t.panel }]}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>{u.username}</Text>
              {self && <Badge label={tr('admin.users.you')} tone="muted" />}
              <Badge label={u.role === 'admin' ? tr('admin.users.roleAdmin') : tr('admin.users.roleUser')} tone={u.role === 'admin' ? 'accent' : 'muted'} />
              {u.disabled && <Badge label={tr('admin.users.disabled')} tone="danger" />}
            </View>
            <Text style={{ color: t.sub, fontSize: 12, lineHeight: 17 }}>{meta}</Text>
            <View style={styles.actions}>
              <Btn small disabled={busy} label={u.role === 'admin' ? tr('admin.users.makeUser') : tr('admin.users.makeAdmin')} onPress={() => void toggleRole(u)} />
              {!self && (
                <Btn small disabled={busy} label={u.disabled ? tr('admin.users.enable') : tr('admin.users.disable')} onPress={() => void toggleDisabled(u)} />
              )}
              <Btn small disabled={busy} label={tr('admin.users.resetPassword')} onPress={() => setResetFor(u)} />
              {u.role !== 'admin' && <Btn small disabled={busy} label={tr('shared.grant.btn')} onPress={() => setGrantsFor(u)} />}
              <Btn small disabled={busy} label={tr('admin.users.signOut')} onPress={() => void signOutEverywhere(u)} />
              {!self && <Btn small danger disabled={busy} label={tr('admin.users.delete')} onPress={() => setDeleteFor(u)} />}
            </View>
            {self && <Hint>{tr('admin.users.selfHint')}</Hint>}
          </View>
        );
      })}

      {addOpen && <AddSheet onClose={() => setAddOpen(false)} done={changed} />}
      {resetFor && <ResetSheet user={resetFor} onClose={() => setResetFor(null)} done={changed} />}
      {grantsFor && <UserGrantsSheet user={grantsFor} onClose={() => setGrantsFor(null)} done={(msg) => toast(msg, 'ok')} />}
      {deleteFor && <DeleteSheet user={deleteFor} onClose={() => setDeleteFor(null)} done={changed} />}
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: 'accent' | 'danger' | 'muted' }) {
  const t = useTheme();
  const th = useThemeDef();
  const bg = tone === 'accent' ? t.accent : tone === 'danger' ? t.danger : t.panel2;
  const fg = tone === 'muted' ? t.text : t.accentText;
  return (
    <Text style={{ backgroundColor: bg, color: fg, fontSize: 11, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, borderRadius: th.r(8), overflow: 'hidden' }}>
      {label}
    </Text>
  );
}

/** Password input with Show/Hide and Generate. Generate fills a random password and shows it in plain text. */
function PasswordRow({ label, value, onChange, shown, setShown, error, hint }: {
  label: string; value: string; onChange: (v: string) => void; shown: boolean; setShown: (v: boolean) => void;
  error: string | null; hint?: string;
}) {
  const tr = useT();
  return (
    <View style={{ gap: 6 }}>
      <Field label={label} value={value} onChangeText={onChange} secure={!shown} />
      <View style={styles.actions}>
        <Btn small label={shown ? tr('admin.users.hide') : tr('admin.users.show')} onPress={() => setShown(!shown)} />
        <Btn small label={tr('admin.users.generate')} onPress={() => { onChange(genPassword()); setShown(true); }} />
      </View>
      {!!error && <Hint danger>{tr(error)}</Hint>}
      {!error && !!hint && <Hint>{hint}</Hint>}
    </View>
  );
}

function AddSheet({ onClose, done }: { onClose: () => void; done: (msg: string) => void }) {
  const t = useTheme();
  const tr = useT();
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState(false);
  const [role, setRole] = useState<AdminRole>('user');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const userErr = username ? validateUsername(username) : null;
  const pwErr = pw ? validatePassword(pw) : null;
  const canSubmit = !validateUsername(username) && !validatePassword(pw) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr('');
    const name = username.trim();
    try {
      await adminApi.createUser({ username: name, password: pw, role });
      setPw('');
      setCreated(name);
      done(tr('admin.users.added'));
    } catch (e) {
      setErr(errOf(e, tr('admin.users.failed')));
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={tr('admin.users.addTitle')}
      width={440}
      footer={created === null ? (
        <>
          <Btn primary label={tr('admin.users.createUser')} disabled={!canSubmit} onPress={() => void submit()} />
          <Btn label={tr('common.cancel')} onPress={onClose} />
        </>
      ) : (
        <Btn primary label={tr('admin.users.done')} onPress={onClose} />
      )}
    >
      {created === null ? (
        <View style={{ gap: 6 }}>
          <Field label={tr('admin.users.username')} value={username} onChangeText={setUsername} />
          {!!userErr && <Hint danger>{tr(userErr)}</Hint>}
          <PasswordRow label={tr('admin.users.tempPassword')} value={pw} onChange={setPw} shown={shown} setShown={setShown} error={pwErr} hint={tr('admin.users.passwordHint')} />
          <Label>{tr('admin.users.role')}</Label>
          <Segmented<AdminRole>
            value={role}
            onChange={setRole}
            options={[{ value: 'user', label: tr('admin.users.roleUser') }, { value: 'admin', label: tr('admin.users.roleAdmin') }]}
          />
          {!!err && <Hint danger>{err}</Hint>}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: t.text }}>{created}</Text>
          <Hint>{tr('admin.users.addedNote')}</Hint>
        </View>
      )}
    </Sheet>
  );
}

function ResetSheet({ user, onClose, done }: { user: AdminUser; onClose: () => void; done: (msg: string) => void }) {
  const tr = useT();
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pwErr = pw ? validatePassword(pw) : null;
  const canSubmit = !validatePassword(pw) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr('');
    try {
      await adminApi.resetPassword(user.id, pw);
      done(tr('admin.users.reset'));
      onClose();
    } catch (e) {
      setErr(errOf(e, tr('admin.users.failed')));
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={tr('admin.users.resetTitle', { name: user.username })}
      width={440}
      footer={(
        <>
          <Btn primary label={tr('admin.users.setPassword')} disabled={!canSubmit} onPress={() => void submit()} />
          <Btn label={tr('common.cancel')} onPress={onClose} />
        </>
      )}
    >
      <View style={{ gap: 6 }}>
        <Hint>{tr('admin.users.resetHint')}</Hint>
        <PasswordRow label={tr('admin.users.password')} value={pw} onChange={setPw} shown={shown} setShown={setShown} error={pwErr} hint={tr('admin.users.passwordHint')} />
        {!!err && <Hint danger>{err}</Hint>}
      </View>
    </Sheet>
  );
}

function DeleteSheet({ user, onClose, done }: { user: AdminUser; onClose: () => void; done: (msg: string) => void }) {
  const tr = useT();
  const [hard, setHard] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canSubmit = typed === user.username && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr('');
    try {
      const r = await adminApi.deleteUser(user.id, typed, hard);
      done(r.mode === 'deleted' ? tr('admin.users.deleted') : tr('admin.users.disabledDone'));
      onClose();
    } catch (e) {
      setErr(errOf(e, tr('admin.users.failed')));
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible
      onClose={onClose}
      title={tr('admin.users.deleteTitle', { name: user.username })}
      width={440}
      footer={(
        <>
          <Btn danger label={hard ? tr('admin.users.deleteBtnHard') : tr('admin.users.deleteBtnSoft')} disabled={!canSubmit} onPress={() => void submit()} />
          <Btn label={tr('common.cancel')} onPress={onClose} />
        </>
      )}
    >
      <View style={{ gap: 6 }}>
        <Hint>{tr('admin.users.deleteExplain')}</Hint>
        <Check label={tr('admin.users.deleteHard')} value={hard} onChange={setHard} hint={tr('admin.users.deleteHardHint')} />
        <View style={{ marginTop: 10 }}>
          <Field label={tr('admin.users.deleteTypeHint', { name: user.username })} value={typed} onChangeText={setTyped} placeholder={user.username} />
        </View>
        {!!err && <Hint danger>{err}</Hint>}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10, width: '100%', maxWidth: 720, alignSelf: 'center' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  card: { borderWidth: 1, padding: 12, gap: 6 },
  nameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  name: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
});
