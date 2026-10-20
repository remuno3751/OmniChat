import { getSearchConfig, engineApiKey, type SearchConfig } from "../config.js";
import { bingRss } from "./bing-rss.js";
import { brave } from "./brave.js";
import { duckduckgo } from "./duckduckgo.js";
import type { EngineDef } from "./types.js";
import { tavily } from "./tavily.js";
import { wikipedia } from "./wikipedia.js";

/** Registration table for built-in engines. Add a new engine module here. */
export const ENGINES: EngineDef[] = [bingRss, wikipedia, duckduckgo, brave, tavily];

export type EngineGroup = EngineDef["group"];

export const engineById = (id: string): EngineDef | undefined => ENGINES.find((e) => e.id === id);

/** Key engines: true only when their API key is set (DB or env default). Keyless engines are always true. */
export function keyIsSet(def: EngineDef): boolean {
  return def.keyEnv ? !!engineApiKey(def.keyEnv) : true;
}

/** Enabled engine ids of one group, in config order (unknown or other-group ids dropped). */
export function enabledEngineIds(group: EngineGroup, cfg: SearchConfig = getSearchConfig()): string[] {
  const known = new Set(ENGINES.filter((e) => e.group === group).map((e) => e.id));
  return cfg.engines[group].filter((id) => known.has(id));
}
