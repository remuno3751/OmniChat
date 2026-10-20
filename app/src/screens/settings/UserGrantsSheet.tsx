import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { api } from '../../api';
import type { AdminUser } from '../../apiAdmin';
import type { ModelInfo } from '../../protocol';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { toast } from '../../ui/toast';
import { Btn, Check, Hint, Segmented, Sheet } from '../../ui/kit';
import {
  buildGrantLines, grantBodyFor, grantDisplayName, orphanGrants, parseDefaultSharedAccess, validateGrantModels,
  type DefaultSharedAccess, type GrantChoice, type GrantLine, type GrantRow, type SharedProviderInfo,
} from '../../sharedProviders';
import { useTheme } from '../../theme';

const errOf = (e: unknown, fallback: string) => (e as any)?.message || fallback;

interface Loaded {
  shared: SharedProviderInfo[];
  defaultAccess: DefaultSharedAccess;
  grants: GrantRow[];
  /** model lists of the shared providers (null = could not be read) */
  models: Record<string, ModelInfo[] | null>;
}

/**
 * Admin: the models one user may use, per shared provider. Saved with PUT (mode all / list / none) or DELETE (default).
 * Opened from the user list (ServerUsers).
 */
export default function UserGrantsSheet({ user, onClose, done }: { user: AdminUser; onClose: () => void; done: (msg: string) => void }) {
  const t = useTheme();
  const tr = useT();
  const providersMap = useStore((s) => s.providers);
  const [data, setData] = useState<Loaded | null>(null);
  const [lines, setLines] = useState<GrantLine[]>([]);
  const [original, setOriginal] = useState<GrantLine[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [sp, ug] = await Promise.all([api.sharedProviders(), api.userGrants(user.id)]);
        const shared = sp.providers || [];
        const models: Record<string, ModelInfo[] | null> = {};
        await Promise.all(shared.map(async (s) => {
          try { models[s.id] = (await api.providerModels(s.id)).models || []; } catch { models[s.id] = null; }
        }));
        if (!alive) return;
        const grants = ug.grants || [];
        const ls = buildGrantLines(shared, grants);
        setData({ shared, defaultAccess: parseDefaultSharedAccess(ug.defaultSharedAccess), grants, models });
        setLines(ls);
        setOriginal(ls);
      } catch (e) {
        if (alive) setLoadErr(errOf(e, tr('shared.grant.loadFailed')));
      }
    })();
    return () => { alive = false; };
  }, [user.id, tr]);

  const orphans = useMemo(() => (data ? orphanGrants(data.shared, data.grants) : []), [data]);
  const allProviders = useMemo(() => Object.values(providersMap), [providersMap]);

  const setChoice = (providerId: string, choice: GrantChoice) =>
    setLines((ls) => ls.map((l) => (l.providerId === providerId ? { ...l, choice } : l)));

  const toggleModel = (providerId: string, modelId: string) =>
    setLines((ls) => ls.map((l) => {
      if (l.providerId !== providerId) return l;
      const has = l.models.includes(modelId);
      return { ...l, models: has ? l.models.filter((m) => m !== modelId) : [...l.models, modelId] };
    }));

  const changed = (a: GrantLine, b: GrantLine | undefined) => {
    if (!b) return false;
    if (a.choice !== b.choice) return true;
    return a.choice === 'list' && (a.models.length !== b.models.length || a.models.some((m) => !b.models.includes(m)));
  };

  const save = async () => {
    setErr('');
    for (const l of lines) {
      if (l.choice !== 'list') continue;
      const k = validateGrantModels(l.models);
      if (k) { setErr(`${l.name}: ${tr(k)}`); return; }
    }
    const todo = lines.filter((l) => changed(l, original.find((o) => o.providerId === l.providerId)));
    if (todo.length === 0) { onClose(); return; }
    setSaving(true);
    try {
      for (const l of todo) {
        const body = grantBodyFor(l.choice, l.models);
        if (body === null) await api.deleteUserGrant(user.id, l.providerId);
        else await api.putUserGrant(user.id, l.providerId, body);
      }
      done(tr('shared.grant.saved'));
      onClose();
    } catch (e) {
      setErr(errOf(e, tr('shared.grant.failed')));
    } finally {
      setSaving(false);
    }
  };

  const choiceLabel = (c: GrantChoice) => tr(`shared.grant.choice.${c}`);

  return (
    <Sheet visible onClose={onClose} title={tr('shared.grant.title', { name: user.username })}>
      {!!loadErr && <Hint danger>{loadErr}</Hint>}
      {!data && !loadErr && <ActivityIndicator color={t.accentInk} style={{ margin: 16 }} />}
      {data && (
        <View style={{ gap: 12 }}>
          <Hint>{tr('shared.grant.hint')}</Hint>
          <Hint>{tr('shared.grant.defaultNote', { value: data.defaultAccess === 'all' ? tr('shared.card.all') : tr('shared.card.none') })}</Hint>
          {data.shared.length === 0 && <Text style={{ color: t.sub, fontSize: 14 }}>{tr('shared.grant.noShared')}</Text>}

          {lines.map((l) => {
            const models = data.models[l.providerId];
            return (
              <View key={l.providerId} style={[styles.block, { borderColor: t.border }]}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{l.name}</Text>
                <Segmented<GrantChoice>
                  options={(['default', 'all', 'list', 'none'] as GrantChoice[]).map((c) => ({ value: c, label: choiceLabel(c) }))}
                  value={l.choice}
                  onChange={(c) => setChoice(l.providerId, c)}
                />
                {l.choice === 'list' && (
                  <View style={{ gap: 2 }}>
                    {models === null && <Hint danger>{tr('shared.grant.loadModels')}</Hint>}
                    {models?.length === 0 && <Hint>{tr('shared.grant.noModels')}</Hint>}
                    {(models ?? []).map((m) => (
                      <Check
                        key={m.id}
                        label={m.name || m.id}
                        value={l.models.includes(m.id)}
                        onChange={() => toggleModel(l.providerId, m.id)}
                      />
                    ))}
                  </View>
                )}
              </View>
            );
          })}

          {orphans.map((g) => (
            <Hint key={g.providerId}>{tr('shared.grant.orphan', { name: grantDisplayName(g.providerId, allProviders) })}</Hint>
          ))}

          {!!err && <Hint danger>{err}</Hint>}
          <View style={styles.actions}>
            <Btn primary disabled={saving || data.shared.length === 0} onPress={() => void save()} label={saving ? tr('admin.server.saving') : tr('shared.grant.save')} />
            <Btn label={tr('common.cancel')} onPress={onClose} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
});
