import { api, uuid } from './api';
import type { LocalServer, Provider } from './protocol';
import { refreshModels } from './ModelPicker';
import { applyUpsert, setLastSel } from './store';
import { pickAddModel } from './detectedServers';

export { normalizeUrl, visibleServers, pickAddModel } from './detectedServers';

/** Creates an openai-compatible provider from a detected local server and selects its model. */
export async function addDetectedProvider(s: LocalServer): Promise<{ provider: Provider; model: string }> {
  const model = pickAddModel(s);
  const p = await api.putProvider(uuid(), { name: s.name, kind: 'openai-compatible', baseUrl: s.baseUrl, model });
  applyUpsert({ providers: [p] });
  refreshModels(true, true);
  setLastSel({ providerId: p.id, model });
  return { provider: p, model };
}
