import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiV4 } from './apiV4';
import type { FileChange } from './protocol';
import { useStore } from './store';
import { buildVirtualFs, listPreviewEntries } from './codePreview';
import { loadPcFs } from './codePreviewPc';
import type { PcResult } from './codePreviewPc';
import type { ChangeRun, VirtualFs } from './codePreview';

/** Only these file kinds are rebuilt for the preview. */
const TEXT_PATH = /\.(html?|css|m?js|svg|json|txt)$/i;

/** Full-patch lookups per message id (a failed lookup is retried later). */
const fullChanges = new Map<string, Promise<FileChange[]>>();
function loadFull(messageId: string): Promise<FileChange[]> {
  let p = fullChanges.get(messageId);
  if (!p) {
    p = apiV4.messageChanges(messageId).catch((e) => {
      fullChanges.delete(messageId);
      throw e;
    });
    fullChanges.set(messageId, p);
  }
  return p;
}

const EMPTY_FS: VirtualFs = new Map();

export interface CodePreviewFs {
  fs: VirtualFs;
  entries: string[];
  /** true until the first rebuild of this conversation finishes */
  loading: boolean;
  /** drops cached full patches and rebuilds */
  refresh: () => void;
  /** where the files come from: the PC folder (latest) or rebuilt from the change records */
  source: 'pc' | 'records';
  /** why the PC folder is not used (only when source is records and the panel is open) */
  pcReason: string | null;
  pcLoading: boolean;
}

/**
 * Rebuilds the virtual files of a Code conversation from its assistant changes.
 * Must be called before any early return in the host component (lint:hooks).
 */
export function useCodePreviewFs(convId: string, enabled = false): CodePreviewFs {
  const msgMap = useStore((s) => s.messages[convId]);
  const candidates = useMemo(() => {
    const list = Object.values(msgMap ?? {}).filter(
      (m) => m.role === 'assistant' && m.status !== 'streaming' && (m.changes?.length ?? 0) > 0,
    );
    list.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    return list;
  }, [msgMap]);
  const key = candidates
    .map((m) => `${m.id}:${(m.changes ?? []).map((c) => `${c.path}\u0001${c.status}\u0001${c.patch != null ? 1 : 0}`).join('\u0002')}`)
    .join('|');

  const [runs, setRuns] = useState<ChangeRun[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => {
    fullChanges.clear();
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: ChangeRun[] = [];
      for (const m of candidates) {
        let list = (m.changes ?? []) as FileChange[];
        if (list.some((c) => c.patch == null && TEXT_PATH.test(c.path))) {
          try {
            const all = await loadFull(m.id);
            list = list.map((c) => {
              if (c.patch != null) return c;
              const f = all.find((x) => x.path === c.path);
              return f ? { ...c, patch: f.patch } : c;
            });
          } catch {
            // keep the synced list; the affected files come out as stale
          }
        }
        const text = list.filter((c) => TEXT_PATH.test(c.path));
        if (text.length) out.push({ messageId: m.id, changes: text });
        if (!alive) return;
      }
      if (alive) setRuns(out);
    })();
    return () => { alive = false; };
    // key covers candidates' ids, paths and patch presence
  }, [convId, key, nonce]);

  // stage 2: real files of the PC folder while the panel is open (falls back to the change records)
  const [pc, setPc] = useState<PcResult | null>(null);
  useEffect(() => {
    if (!enabled) { setPc(null); return undefined; }
    let alive = true;
    setPc(null);
    loadPcFs(convId, {
      status: apiV4.codePreviewStatus,
      tree: apiV4.codePreviewTree,
      file: apiV4.codePreviewFile,
    }).then((r) => { if (alive) setPc(r); });
    return () => { alive = false; };
  }, [convId, enabled, nonce]);

  const recFs = useMemo(() => (runs ? buildVirtualFs(runs) : EMPTY_FS), [runs]);
  const usePc = pc?.ok === true;
  const fs = usePc && pc?.ok ? pc.fs : recFs;
  const entries = useMemo(() => listPreviewEntries(fs), [fs]);
  return {
    fs, entries, loading: usePc ? false : runs === null, refresh,
    source: usePc ? 'pc' : 'records',
    pcReason: pc && !pc.ok ? pc.reason : null,
    pcLoading: enabled && pc === null,
  };
}
