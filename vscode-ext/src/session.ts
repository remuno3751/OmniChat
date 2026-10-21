/**
 * One connection to the server bridge: client + per-connection run manager + tool registry
 * (spec docs/design/VSCODE-BRIDGE.md §2, §9). Pure wiring; the VS Code APIs are injected.
 *
 * A run manager is created on each `online` and disposed on any other status, so runs never
 * outlive their connection. Stale client callbacks (from a stopped or restarted session) are ignored.
 */
import * as gitops from "@gitops";
import { createClient, type Client, type ClientStatus } from "./conn/client";
import { createRewindHandler } from "./conn/rewind";
import { createRunManager, type RunManager } from "./conn/runs";
import { createServerApprovals } from "./conn/server-approvals";
import { createRunGit, createRunHooks } from "./git/checkpoint";
import type { Host } from "./host/types";
import { toWsUrl } from "./pairing";
import type { ApprovalReplyFrame, Frame, ToolName, WelcomeFrame } from "./protocol/frames";
import type { ApprovalInput } from "./ui/approvalModel";
import { registerEditTools } from "./tools/edit";
import { registerExecTool } from "./tools/exec";
import { registerFileTools } from "./tools/files";
import { registerGitTools } from "./tools/git";
import { registerGrepTools } from "./tools/grep";
import { createRegistry, type ToolRegistry } from "./tools/index";

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "get_diagnostics",
  "git_status",
  "git_diff",
  "git_log",
];

export const ALL_TOOLS: readonly ToolName[] = [
  ...READ_ONLY_TOOLS,
  "write_file",
  "edit_file",
  "run_command",
  "git_commit",
];

/** Tools advertised in `ready`. Untrusted workspaces get read-only tools only. */
export function toolsFor(trusted: boolean): ToolName[] {
  return trusted ? [...ALL_TOOLS] : [...READ_ONLY_TOOLS];
}

/** A fresh registry with every tool this extension implements. */
export function buildRegistry(shell: string | undefined): ToolRegistry {
  const registry = createRegistry();
  registerFileTools(registry);
  registerGrepTools(registry);
  registerEditTools(registry);
  registerExecTool(registry, { shell });
  registerGitTools(registry);
  return registry;
}

export interface PairedTarget {
  serverUrl: string;
  token: string;
  name: string;
}

export interface SessionOptions {
  host: Host;
  version: string;
  instance: string;
  isTrusted: () => boolean;
  shell: () => string | undefined;
  log: (line: string) => void;
  onStatus: (status: ClientStatus, detail?: string) => void;
  /** An accepted welcome from the server, before the status goes "online". */
  onWelcome?: (frame: WelcomeFrame) => void;
  /**
   * Read-only tap on every frame that crosses the connection (inbound, and outbound once sent).
   * It never changes what goes on the wire; errors thrown by it are ignored.
   */
  onFrame?: (frame: Frame) => void;
  /**
   * VS Code approval panel hooks. Cards come from server `approval_pending` frames (spec §4.4).
   * `pendingChanged` counts both server approvals and extension-originated waits.
   */
  approvals?: {
    show(input: ApprovalInput): void;
    dismiss(approvalId: string): void;
    pendingChanged(count: number): void;
  };
}

export interface Session {
  /** Answers an approval shown in the VS Code panel. Resolves the call and tells the server (spec §4.4). */
  answerApproval(reply: ApprovalReplyFrame): void;
  /** Sends a frame on the live connection (chat requests). False when not online. */
  send(frame: Frame): boolean;
  /** Stops any current connection and connects to `target`. Returns false if the URL is invalid. */
  start(target: PairedTarget): boolean;
  /** Stops the connection and forgets the target. */
  stop(): void;
  /** Reconnects with the last target, e.g. after workspace trust is granted. No-op when never started. */
  restart(): boolean;
  /** Sends the current workspace folders to the server. */
  refreshWorkspaces(): void;
}

export function createSession(opts: SessionOptions): Session {
  const { host } = opts;
  let client: Client | null = null;
  let manager: RunManager | null = null;
  let target: PairedTarget | null = null;
  let generation = 0;
  const git = createRunGit({ gitops });
  const hooks = createRunHooks(git);
  const rewind = createRewindHandler({
    send: (f) => client?.send(f) ?? false,
    activeRunId: () => manager?.activeRunId() ?? null,
    roots: () => host.roots,
    openDocuments: () => host.openDocuments,
    git,
  });

  // Both approval sources report one combined count to the status bar.
  let escalationCount = 0;
  let serverCount = 0;
  const reportCount = (): void => opts.approvals?.pendingChanged(escalationCount + serverCount);
  const serverApprovals = createServerApprovals({
    send: (f) => client?.send(f) ?? false,
    show: (input) => opts.approvals?.show(input),
    dismiss: (id) => opts.approvals?.dismiss(id),
    onCount: (n) => {
      serverCount = n;
      reportCount();
    },
  });

  const tap = (frame: Frame): void => {
    if (!opts.onFrame) return;
    try {
      opts.onFrame(frame);
    } catch {
      // A tap is observational only; it must never affect the bridge.
    }
  };

  /**
   * Reports frames the run manager sends, after they actually went out. A `done` also closes the
   * server approval cards (a run cannot end with one still open).
   */
  const tapClient = (c: Client): Client => ({
    send: (frame) => {
      const sent = c.send(frame);
      if (sent) tap(frame);
      if (frame.type === "done") serverApprovals.cancelAll();
      return sent;
    },
    sendWorkspaces: () => c.sendWorkspaces(),
    close: () => c.close(),
  });

  const dropManager = (): void => {
    manager?.dispose();
    manager = null;
    serverApprovals.cancelAll();
  };

  const stop = (): void => {
    generation += 1;
    dropManager();
    const current = client;
    client = null;
    current?.close();
  };

  const attach = (current: Client): void => {
    dropManager();
    manager = createRunManager({
      client: tapClient(current),
      registry: buildRegistry(opts.shell()),
      host,
      getRoots: () => host.roots,
      isTrusted: opts.isTrusted,
      beforeRun: hooks.beforeRun,
      afterRun: hooks.afterRun,
      escalation: {
        onPendingChange: (n) => {
          escalationCount = n;
          reportCount();
        },
      },
    });
  };

  const start = (next: PairedTarget): boolean => {
    stop();
    const url = toWsUrl(next.serverUrl);
    if (url === null) {
      opts.log("server URL is not valid; pair again");
      opts.onStatus("offline", "invalid server URL");
      return false;
    }
    target = next;
    const my = generation;
    client = createClient({
      url,
      token: next.token,
      name: next.name,
      instance: opts.instance,
      version: opts.version,
      tools: toolsFor(opts.isTrusted()),
      workspaces: () => [...host.roots],
      trusted: opts.isTrusted,
      onWelcome: (frame: WelcomeFrame) => {
        if (my !== generation) return;
        opts.onWelcome?.(frame);
      },
      onFrame: (frame: Frame) => {
        if (my !== generation) return;
        tap(frame);
        if (frame.type === "rewind") {
          void rewind(frame);
          return;
        }
        if (frame.type === "approval_pending") serverApprovals.pending(frame);
        else if (frame.type === "approval_settled") serverApprovals.settled(frame.approvalId);
        else if (frame.type === "cancel") serverApprovals.cancelAll();
        manager?.handleFrame(frame);
      },
      onStatus: (status, detail) => {
        if (my !== generation) return;
        if (status === "online") {
          if (client) attach(client);
        } else {
          dropManager();
        }
        opts.onStatus(status, detail);
      },
    });
    return true;
  };

  return {
    answerApproval(reply) {
      serverApprovals.answer(reply.approvalId, reply.decision);
    },
    send(frame) {
      return client?.send(frame) ?? false;
    },
    start(next) {
      return start(next);
    },
    stop() {
      target = null;
      stop();
    },
    restart() {
      return target === null ? false : start(target);
    },
    refreshWorkspaces() {
      client?.sendWorkspaces();
    },
  };
}
