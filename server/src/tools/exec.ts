import { setMessageTools, getConversationRow } from "../db.js";
import { broadcast } from "../hub.js";
import { evaluateRules, addToolAllowRule } from "../approval-rules.js";
import { getTool, runTool, type TurnState } from "./registry.js";
import { hasGrant, addGrant, requestApproval } from "./approvals.js";
import type { ToolCall } from "./types.js";

/** Command / path for approval rules, read from the call's arguments (`command`|`cmd`, `path`|`file_path`). */
function ruleTargets(args: unknown): { command?: string; path?: string } {
  if (typeof args !== "object" || args === null) return {};
  const a = args as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof a[k] === "string") return a[k] as string;
    return undefined;
  };
  return { command: pick("command", "cmd"), path: pick("path", "file_path") };
}

/** Tool calls of ONE assistant message: approval, execution, WS `tool` events and persistence in message.toolCalls / sources. */
export class ToolSession {
  readonly calls: ToolCall[] = [];
  readonly turn: TurnState = { sources: [] };

  constructor(
    private readonly userId: string,
    private readonly conversationId: string,
    private readonly messageId: string,
    private readonly signal: AbortSignal,
  ) {}

  private emit(call: ToolCall): void {
    try { setMessageTools(this.messageId, this.calls, this.turn.sources); } catch (e) { console.error("tool trace save failed", e); }
    broadcast(this.userId, { type: "tool", messageId: this.messageId, conversationId: this.conversationId, call: { ...call } });
  }

  /**
   * Runs one call. Never throws. `offered` = names the model was allowed to call.
   * Returns ok + the text handed back to the model (errors / denials are `Error: ...` strings).
   */
  async execute(id: string, name: string, rawArgs: unknown, offered: ReadonlySet<string>): Promise<{ ok: boolean; text: string }> {
    let args: unknown = rawArgs;
    let argError: string | null = null;
    if (typeof rawArgs === "string") {
      try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { argError = "arguments are not valid JSON"; }
    }
    const tool = getTool(name);
    const call: ToolCall = {
      id, name, arguments: args ?? {}, startedAt: Date.now(),
      status: tool && tool.needsApproval && !hasGrant(this.userId, name) ? "pending" : "running",
    };
    this.calls.push(call);
    const fail = (error: string, status: ToolCall["status"] = "error") => {
      call.status = status;
      call.error = error;
      call.durationMs = Date.now() - call.startedAt;
      this.emit(call);
      return { ok: false, text: `Error: ${error}` };
    };

    if (!tool || !offered.has(name)) { this.emit(call); return fail(!tool ? `unknown tool "${name}"` : `tool "${name}" is not enabled`); }
    if (argError) { this.emit(call); return fail(argError); }
    if (!tool.available) { this.emit(call); return fail(tool.error ?? "tool unavailable"); }

    // Approval rules: a deny rule always wins; an allow rule answers without a prompt; otherwise grant or prompt.
    const projectId: string | null = getConversationRow(this.conversationId)?.project_id ?? null;
    const rule = evaluateRules(this.userId, projectId, { tool: name, ...ruleTargets(call.arguments) });
    if (rule.action === "deny") {
      call.decidedBy = `rule:${rule.ruleId}`;
      this.emit(call);
      return fail("denied by rule", "denied");
    }
    if (rule.action === "allow") {
      call.decidedBy = `rule:${rule.ruleId}`;
      call.status = "running";
    }
    this.emit(call);

    if (call.status === "pending") {
      const decision = await requestApproval({
        userId: this.userId, messageId: this.messageId, conversationId: this.conversationId,
        tool: name, arguments: call.arguments, permissions: tool.permissions, signal: this.signal,
      });
      if (decision === "deny") return fail("denied by user", "denied");
      if (decision === "always") {
        addGrant(this.userId, name);
        addToolAllowRule(this.userId, null, name);
      }
      call.status = "running";
      this.emit(call);
    }

    const t0 = performance.now();
    try {
      const text = await runTool(name, call.arguments, { userId: this.userId, signal: this.signal, turn: this.turn });
      call.status = "done";
      call.result = text;
      call.durationMs = Math.round(performance.now() - t0);
      this.emit(call);
      return { ok: true, text };
    } catch (e: any) {
      call.durationMs = Math.round(performance.now() - t0);
      return fail(String(e?.message ?? e).slice(0, 500));
    }
  }
}
