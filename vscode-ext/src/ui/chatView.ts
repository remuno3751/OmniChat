/**
 * The "Chat" sidebar view: transcript, composer, model and approval-mode pickers, recent
 * conversations, live tool rows, and the inline approval cards (which replace the former separate
 * approval panel). State comes from `ChatController` and the pending approvals; the webview
 * (media/webview/chat.js) renders it. `vscode` is injected.
 */
import type * as VS from "vscode";
import type { ChatController } from "../chat/controller";
import { buildChatState, parseChatMessage } from "../chat/viewModel";
import type { Decorations, Theme } from "../config";
import type { PairReason } from "../pairing";
import type { ApprovalReplyFrame } from "../protocol/frames";
import { hasDiffContent, type ApprovalInput } from "./approvalModel";
import { openNativeDiff } from "./panels";
import type { StatusState } from "./status";
import { stringsFor, type Lang } from "./strings";
import { createViewProvider, type ViewHandle } from "./viewProvider";

export const CHAT_VIEW_ID = "omnichat.chat";

export interface ChatViewOptions {
  vscode: typeof VS;
  extensionUri: VS.Uri;
  controller: ChatController;
  lang: Lang;
  getTheme: () => Theme;
  getDecorations: () => Decorations;
  isPaired: () => boolean;
  getStatus: () => StatusState;
  /** Pairs with a pasted code; false when the code is not valid. */
  pair: (code: string) => Promise<PairReason | null>;
  onReply: (reply: ApprovalReplyFrame) => void;
  /** Brings the Chat view to the front (a card needs attention). */
  focus: () => void;
  openSettings: () => void;
}

export interface ChatView {
  handle: ViewHandle;
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

  const update = (): void => {
    handle.post({
      type: "state",
      state: buildChatState({
        lang: opts.lang,
        paired: opts.isPaired(),
        status: opts.getStatus(),
        snapshot: controller.snapshot(),
        approvals: [...pending.values()],
      }),
    });
  };

  const setMode = async (mode: "manual" | "auto" | "full"): Promise<void> => {
    if (mode !== "full") return controller.setApprovalMode(mode);
    const yes = await vscode.window.showWarningMessage(s.confirmFull, { modal: true }, s.confirmFullYes);
    if (yes === s.confirmFullYes) controller.setApprovalMode("full", true);
    else update(); // put the picker back
  };

  const onMessage = (raw: unknown): void => {
    const msg = parseChatMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "send":
        controller.sendPrompt(msg.text);
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
          if (reason) handle.post({ type: "notice", text: s.pairReasons[reason] ?? s.pairInvalid });
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

  const handle = createViewProvider(CHAT_VIEW_ID, {
    vscode,
    extensionUri: opts.extensionUri,
    title: `OmniChat VS: ${s.chat}`,
    script: "chat.js",
    styles: ["chat.css", "chat-main.css", "chat-cards.css"],
    skin: "chat",
    getTheme: opts.getTheme,
    getDecorations: opts.getDecorations,
    onReady: update,
    onMessage,
  });

  return {
    handle,
    update,
    approvals: {
      show(input) {
        pending.set(input.approvalId, input);
        if (!handle.isVisible()) opts.focus();
        update();
      },
      dismiss(approvalId) {
        if (pending.delete(approvalId)) update();
      },
    },
    pendingCount: () => pending.size,
  };
}
