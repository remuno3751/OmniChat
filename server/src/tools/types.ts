/* Tool layer types (PROTOCOL-v3-phase3.md section 1). */

export type ToolPermission = "network" | "filesystem-read" | "filesystem-write" | "shell";
export const TOOL_PERMISSIONS: readonly ToolPermission[] = ["network", "filesystem-read", "filesystem-write", "shell"];
export const TOOL_NAME_RE = /^[a-z0-9_]{1,40}$/;

export interface ToolManifest { name: string; description: string; parameters: Record<string, unknown>; permissions: ToolPermission[] }
/** Where a plugin tool runs: "process" = separate Node child (plugin-sandbox.ts), "inproc" = this process. */
export type PluginIsolation = "process" | "inproc";
export interface ToolInfo extends ToolManifest {
  source: "builtin" | "plugin";
  pluginId: string | null;
  available: boolean;
  error?: string;
  needsApproval: boolean;
  /** plugin tools only (additive) */
  isolation?: PluginIsolation;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  status: "pending" | "running" | "done" | "error" | "denied";
  result?: string;
  error?: string;
  durationMs?: number;
  startedAt: number;
  /** Who settled the call without a plain prompt answer: "rule:<id>" (approval rule), "user", "timeout", "abort". */
  decidedBy?: string;
}
export interface SearchSource { index: number; title: string; url: string; snippet?: string }

export type SearchMode = "off" | "auto" | "always" | "smart";
export const SEARCH_MODES: readonly SearchMode[] = ["off", "auto", "always", "smart"];

export const MAX_TOOL_ROUNDS = 6;
export const TOOL_RESULT_CAP = 8 * 1024;
