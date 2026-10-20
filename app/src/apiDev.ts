// Phase-4 developer API (comparisons, benchmarks, tokenize, config files). Own fetch helper; every call can answer 404 on an old server.
import { ApiError, getServerUrl, getToken, httpStatusText, serverErrorText, unreachableError } from './api';
import { t } from './i18n';
import type { BenchRun, BenchSet, BenchTarget, ComparisonRow, TokenizeResponse } from './protocol';

async function dfetch(method: string, path: string, body?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(getServerUrl() + path, { method, headers, body });
  } catch {
    throw unreachableError();
  }
  if (!res.ok) {
    let msg = httpStatusText(res.status);
    try { const j = JSON.parse(await res.text()); if (j?.error) msg = serverErrorText(String(typeof j.error === 'string' ? j.error : j.error.message || msg)); } catch {}
    throw new ApiError(msg, res.status);
  }
  return res;
}
async function djson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await dfetch(method, path, body === undefined ? undefined : JSON.stringify(body));
  const text = await res.text();
  try { return (text ? JSON.parse(text) : null) as T; } catch { throw new ApiError(t('api.invalidResponse'), res.status); }
}
/** Accepts `[...]` or `{ key: [...] }` list shapes. */
function listOf<T>(r: any, ...keys: string[]): T[] {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  return [];
}

export interface ConfigImportResult { created?: Record<string, number>; updated?: Record<string, number>; skipped?: any[] }

export const apiDev = {
  tokenize: (b: { providerId?: string | null; model?: string | null; text: string }) => {
    const body: any = { text: b.text };
    if (b.providerId) body.providerId = b.providerId;
    if (b.model) body.model = b.model;
    return djson<TokenizeResponse>('POST', '/tokenize', body);
  },
  comparisons: async () => listOf<ComparisonRow>(await djson('GET', '/comparisons'), 'comparisons', 'items'),
  comparison: async (id: string) => {
    const r: any = await djson('GET', `/comparisons/${encodeURIComponent(id)}`);
    return (r?.comparison || r) as ComparisonRow;
  },
  deleteComparison: (id: string) => djson<unknown>('DELETE', `/comparisons/${encodeURIComponent(id)}`),

  benchSets: async () => listOf<BenchSet>(await djson('GET', '/bench/sets'), 'sets', 'items'),
  putBenchSet: (id: string, b: { name: string; prompts: string[]; systemPrompt?: string | null }) =>
    djson<BenchSet>('PUT', `/bench/sets/${encodeURIComponent(id)}`, b),
  deleteBenchSet: (id: string) => djson<unknown>('DELETE', `/bench/sets/${encodeURIComponent(id)}`),
  benchRuns: async () => listOf<BenchRun>(await djson('GET', '/bench/runs'), 'runs', 'items'),
  benchRun: async (id: string) => {
    const r: any = await djson('GET', `/bench/runs/${encodeURIComponent(id)}`);
    return (r?.run || r) as BenchRun;
  },
  startBench: (b: { setId: string; targets: BenchTarget[]; repeats?: number; warmup?: boolean; maxTokens?: number }) =>
    djson<{ runId: string }>('POST', '/bench/runs', b),
  cancelBench: (id: string) => djson<unknown>('POST', `/bench/runs/${encodeURIComponent(id)}/cancel`, {}),
  deleteBench: (id: string) => djson<unknown>('DELETE', `/bench/runs/${encodeURIComponent(id)}`),
  benchCsv: async (id: string): Promise<string> => (await dfetch('GET', `/bench/runs/${encodeURIComponent(id)}/export`)).text(),

  exportConfig: async (format: 'json' | 'yaml'): Promise<string> => (await dfetch('GET', `/config/export?format=${format}`)).text(),
  importConfig: (b: { format: 'json' | 'yaml'; content: string; mode?: 'merge' | 'replace' }) =>
    djson<ConfigImportResult>('POST', '/config/import', b),
};
