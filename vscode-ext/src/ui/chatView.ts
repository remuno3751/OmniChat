/**
 * The "Chat" sidebar view: transcript, composer, model and approval-mode pickers, recent
 * conversations, live tool rows, and the inline approval cards (which replace the former separate
 * approval panel). State comes from `ChatController` and the pending approvals; the webview
 * (media/webview/chat.js) renders it. `vscode` is injected.
 */
import type * as VS from "vscode";
import type { ChatController } from "../chat/controller";
import { interruptQueued, regenerateItem } from "../chat/actions";
import { checkAttachments } from "../chat/attach";
import { visionOf } from "../chat/extrasModel";
import { readFavorites, toggleFavorite, type MementoLike } from "../chat/favorites";
import { parseSlash, runSlash, slashArg } from "../chat/slash";
import { createSettingsActions, isSettingsMessage } from "../chat/settingsActions";
import { createCheckpointsHost } from "../chat/checkpointsHost";
import { pinFirst, readPins } from "../chat/pins";
import { buildChatState, parseChatMessage, type LinkInfo } from "../chat/viewModel";
import type { Decorations, Theme } from "../config";
import type { PairReason } from "../pairing";
import type { PromptAttachment } from "../protocol/chat-frames";
import type { ApprovalReplyFrame } from "../protocol/frames";
import { hasDiffContent, type ApprovalInput } from "./approvalModel";
import { createChatPanel, type ChatPanel } from "./chatPanel";
import { openWorkspaceFile } from "./openFile";
import { openNativeDiff } from "./panels";

export { resolveOpenFile, openWorkspaceFile } from "./openFile";
import type { StatusState } from "./status";
import { stringsFor, type Lang } from "./strings";
import { createViewProvider, type PageOptions, type ViewHandle } from "./viewProvider";
import { openUntitled } from "../host/vscode";

export const CHAT_VIEW_ID = "omnichat.chat";
/** The same chat in the right (secondary) side bar; VS Code shows it when the extension contributes that container. */
export const CHAT_RIGHT_VIEW_ID = "omnichat.chatRight";

export interface ChatViewOptions {
  vscode: typeof VS;
  extensionUri: VS.Uri;
  controller: ChatController;
  lang: Lang;
  getTheme: () => Theme;
  getDecorations: () => Decorations;
  isPaired: () => boolean;
  getStatus: () => StatusState;
  /** Last ping round trip and the scheduled reconnect, from the connection. */
  getLink: () => LinkInfo;
  /** Workspace folder roots: the only places openFile may open from. */
  roots: () => readonly string[];
  /** Opens or closes the Settings view. */
  toggleSettings: () => void;
  /** Pairs with a pasted code; false when the code is not valid. */
  pair: (code: string) => Promise<PairReason | null>;
  onReply: (reply: ApprovalReplyFrame) => void;
  /** Brings the Chat view to the front (a card needs attention). */
  focus: () => void;
  openSettings: () => void;
  /** The extension's global state: the pinned devices and folders are kept here. */
  globalState: MementoLike;
}

export interface ChatView {
  handle: ViewHandle;
  /** The same chat page in the right side bar. Every message the view posts goes to it too. */
  right: ViewHandle;
  /** The same chat page in the editor area. Every message the view posts goes to it too. */
  panel: ChatPanel;
  /** Opens the right side bar chat; a VS Code without right-side views gets an information message. */
  focusRight(): Promise<void>;
  /** Pushes the current state to the webview. */
  update(): void;
  /** Approval hooks for the session: cards live in the Chat view. */
  approvals: { show(input: ApprovalInput): void; dismiss(approvalId: string): void };
  pendingCount(): number;
}

export function createChatView(opts: ChatViewOptions): ChatView {
  const { vscode, controller } = opts;
  const pending = new Map<string, ApprovalInput>();
  const s = stringsFor(opts.lang);

  /** Every message goes to the sidebar view, the right side bar view and the editor panel (when open). */
  const broadcast = (message: unknown): void => {
    handle.post(message);
    right.post(message);
    panel.post(message);
  };
  const update = (): void => {
    const state = buildChatState({
      lang: opts.lang,
      paired: opts.isPaired(),
      status: opts.getStatus(),
      snapshot: controller.snapshot(),
      approvals: [...pending.values()],
      link: opts.getLink(),
      favorites: readFavorites(opts.globalState),
    });
    // Pinned conversations (the /pin command) come first in the history list.
    state.recent = pinFirst(state.recent, readPins(opts.globalState));
    broadcast({ type: "state", state });
    settingsActions.afterUpdate(state.snapshot);
  };
  /** The surface whose message is being handled: its toasts go back to that surface only. */
  let origin: "view" | "panel" | "right" = "view";
  const toast = (text: string): void =>
    (origin === "panel" ? panel : origin === "right" ? right : handle).post({ type: "toast", text });
  const fromSurface = (surface: "view" | "panel" | "right") => (raw: unknown): void => {
    origin = surface;
    onMessage(raw);
  };

  /** Checks the attachments on the host first; a refused set is toasted and nothing is sent. An edit of the last prompt waits for no run. */
  const sendText = (text: string, attachments: PromptAttachment[] = [], interrupt = false, replaceLast = false): void => {
    if (replaceLast && controller.snapshot().busy) return toast(s.editBusy);
    if (attachments.length > 0) {
      const check = checkAttachments(attachments, visionOf(controller.snapshot()), s);
      if (!check.ok) return toast(check.toast);
    }
    controller.sendPrompt(text, { interrupt, attachments, ...(replaceLast ? { replaceLast } : {}) });
  };
  const checkpoints = createCheckpointsHost({
    controller,
    strings: s,
    now: Date.now,
    confirm: (message, buttons) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true }, ...buttons)),
    toast: (text) => toast(text),
  });

  const slashDeps = {
    strings: s,
    controller,
    toast,
    globalState: opts.globalState,
    onPinsChanged: update,
    openDocument: (text: string, language: "markdown" | "json" = "markdown") => {
      openUntitled(vscode, text, language).catch(() => toast(s.slashExportFail));
    },
  };
  const settingsActions = createSettingsActions({ controller, strings: s, toast, post: (m) => broadcast(m) });

  const setMode = async (mode: "manual" | "auto" | "full"): Promise<void> => {
    if (mode !== "full") return controller.setApprovalMode(mode);
    const yes = await vscode.window.showWarningMessage(s.confirmFull, { modal: true }, s.confirmFullYes);
    if (yes === s.confirmFullYes) controller.setApprovalMode("full", true);
    else update(); // put the picker back
  };

  const onMessage = (raw: unknown): void => {
    // Host slash commands are checked here: the shared parser only knows the first three.
    const slash = parseSlash(raw);
    if (slash) return runSlash(slash, slashDeps, slashArg(raw));
    const msg = parseChatMessage(raw);
    if (!msg) return;
    if (isSettingsMessage(msg)) return settingsActions.handle(msg);
    switch (msg.type) {
      case "send":
        return sendText(msg.text, msg.attachments, false, msg.replaceLast === true);
      case "sendInterrupt":
        return sendText(msg.text, msg.attachments, true, msg.replaceLast === true);
      case "requestCheckpoints":
        return checkpoints.request();
      case "restoreCheckpoint":
        return checkpoints.restore(msg.checkpointId);
      case "openExternal":
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "requestDevices":
        return controller.requestDevices();
      case "toggleFavorite":
        void toggleFavorite(opts.globalState, msg.kind, msg.key).then(() => update());
        return;
      case "cancelQueued":
        return controller.cancelQueued(msg.id);
      case "interruptQueued":
        interruptQueued(controller, msg.id);
        return;
      case "regenerate":
        if (regenerateItem(controller, msg.id) === "busy") toast(s.errors.busy);
        return;
      case "openInEditor":
        return panel.open();
      case "dockRight":
        void vscode.commands.executeCommand("omnichat.moveToSecondarySideBar");
        return;
      case "setSearchMode":
        return controller.setSearchMode(msg.mode);
      case "draftChanged":
        return controller.draftChanged();
      case "toggleSettings":
        return opts.toggleSettings();
      case "openFile":
        void openWorkspaceFile(vscode, opts.roots(), msg.path, msg.line, s.openFileRefused);
        return;
      case "stop":
        return controller.stop();
      case "newConversation":
        return controller.newConversation();
      case "refresh":
      case "refreshHistory":
        return controller.refresh();
      case "copy":
        void vscode.env.clipboard.writeText(msg.text);
        return;
      case "openSettings":
        return opts.openSettings();
      case "dismissError":
        return controller.clearError();
      case "openConversation":
        return controller.openConversation(msg.id);
      case "setModel":
        return controller.setModel(msg.ref);
      case "setCwd":
        return controller.setCwd(msg.cwd);
      case "setApprovalMode":
        void setMode(msg.mode);
        return;
      case "pair":
        void opts.pair(msg.code).then((reason) => {
          if (reason) broadcast({ type: "notice", text: s.pairReasons[reason] ?? s.pairInvalid });
        });
        return;
      case "viewDiff": {
        const frame = pending.get(msg.approvalId);
        if (frame && hasDiffContent(frame)) void openNativeDiff(vscode, frame);
        return;
      }
      case "approval_reply":
        if (pending.delete(msg.approvalId)) {
          opts.onReply({ type: "approval_reply", approvalId: msg.approvalId, decision: msg.decision });
          update();
        }
        return;
      case "ready":
        return;
    }
  };

  // The sidebar view and the editor panel share one page and one message handler.
  const page: PageOptions = {
    vscode,
    extensionUri: opts.extensionUri,
    title: `OmniChat VS: ${s.chat}`,
    script: "chat.js",
    styles: ["chat.css", "chat-main.css", "chat-cards.css", "chat-state.css", "chat-input.css", "chat-pop.css", "chat-v056d.css", "chat-v056e.css"],
    skin: "chat",
    getTheme: opts.getTheme,
    getDecorations: opts.getDecorations,
  };
  const handle = createViewProvider(CHAT_VIEW_ID, { ...page, onReady: update, onMessage: fromSurface("view") });
  const right = createViewProvider(CHAT_RIGHT_VIEW_ID, { ...page, onReady: update, onMessage: fromSurface("right") });
  const panel = createChatPanel({ ...page, onReady: update, onMessage: fromSurface("panel") });

  return {
    handle,
    right,
    panel,
    update,
    focusRight: () =>
      Promise.resolve(vscode.commands.executeCommand(CHAT_RIGHT_VIEW_ID + ".focus")).then(
        () => undefined,
        () => void vscode.window.showInformationMessage(s.rightDockUnsupported),
      ),
    approvals: {
      show(input) {
        pending.set(input.approvalId, input);
        if (!handle.isVisible() && !right.isVisible()) opts.focus();
        update();
      },
      dismiss(approvalId) {
        if (pending.delete(approvalId)) update();
      },
    },
    pendingCount: () => pending.size,
  };
}
