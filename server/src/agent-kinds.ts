/** Provider kinds whose conversations are "agent bridge" conversations: Code mode, linear history, no ephemeral/regenerate,
 *  documents only as attachments. `dsh-bridge` = the DSH plugin runs the agent; `vscode-bridge` = the server runs the agent loop
 *  and the VS Code extension executes tools (docs/design/VSCODE-BRIDGE.md). */
export const AGENT_BRIDGE_KINDS = ["dsh-bridge", "vscode-bridge"] as const;

export function isAgentBridgeKind(kind: unknown): boolean {
  return kind === "dsh-bridge" || kind === "vscode-bridge";
}

export const isVscodeBridgeKind = (kind: unknown): boolean => kind === "vscode-bridge";

/**
 * Validation of a vscode-bridge provider on create/update: `baseUrl` is the bridge name (not a URL) and there is no api key.
 * Returns an error text or null. Other kinds are not checked here.
 */
export function vscodeProviderRefusal(kind: unknown, baseUrl: unknown, apiKey: unknown): string | null {
  if (kind !== "vscode-bridge") return null;
  const name = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!name) return "baseUrl: a vscode-bridge provider needs a bridge name";
  if (name.length > 100) return "baseUrl: the bridge name is too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "baseUrl: invalid bridge name";
  if (typeof apiKey === "string" && apiKey.length > 0) return "apiKey: a vscode-bridge provider takes no api key";
  return null;
}
