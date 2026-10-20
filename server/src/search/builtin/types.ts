import type { SearchResult } from "../index.js";

export interface EngineSearchOpts { limit: number; signal?: AbortSignal }

/** One built-in web search engine. Register new engines in table.ts. */
export interface EngineDef {
  id: string;
  label: string;
  /** Enabled when SEARCH_ENGINES is not set. */
  defaultOn: boolean;
  /** "builtin": keyless engines (built-in mode). "api": engines that need an API key (API mode). */
  group: "builtin" | "api";
  /** Environment variable holding the API key this engine needs (never returned by any endpoint). */
  keyEnv?: "BRAVE_API_KEY" | "TAVILY_API_KEY";
  search(query: string, opts: EngineSearchOpts): Promise<SearchResult[]>;
}
