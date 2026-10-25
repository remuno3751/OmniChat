/**
 * Host side of the settings and history search messages the Chat webview posts: the settings panel's save,
 * the effort chip, the search, and opening a hit (the message is then scrolled to once its conversation has
 * loaded). Toasts go through `toast`; the webview gets `scrollToMessage` through `post`. No `vscode` import.
 */
import type { ChatController } from "./controller";
import type { ChatSnapshot } from "./controllerTypes";
import type { SettingsInput } from "./chatSettings";
import type { SettingsMessage } from "./messages";
import type { V056dStrings } from "../ui/stringsV056d";

const SETTINGS_TYPES: ReadonlySet<string> = new Set(["requestSettings", "saveSettings", "setEffort", "searchHistory", "openHit"]);

/** True for the messages this module handles. */
export function isSettingsMessage(msg: { type: string }): msg is SettingsMessage {
  return SETTINGS_TYPES.has(msg.type);
}

export interface SettingsActionDeps {
  controller: Pick<ChatController, "requestSettings" | "saveSettings" | "searchHistory" | "openConversation" | "snapshot">;
  strings: V056dStrings;
  /** Shows a short line above the composer, on the surface that sent the message. */
  toast: (text: string) => void;
  /** Posts a message to every surface of the chat. */
  post: (message: unknown) => void;
}

export interface SettingsActions {
  handle(msg: SettingsMessage): void;
  /** Called after each state update: posts `scrollToMessage` once the opened hit's conversation has loaded. */
  afterUpdate(snap: ChatSnapshot): void;
}

export function createSettingsActions(d: SettingsActionDeps): SettingsActions {
  const { controller: c, strings: s } = d;
  let scroll: { conversationId: string; messageId: string } | null = null;

  /** Saves only with a conversation open; otherwise the user is asked to start one. */
  const save = (input: SettingsInput, onResult: (ok: boolean) => void): void => {
    if (c.snapshot().conversationId === null) return d.toast(s.csNeedConversation);
    c.saveSettings(input, onResult);
  };

  return {
    handle(msg) {
      switch (msg.type) {
        case "requestSettings":
          return c.requestSettings();
        case "saveSettings":
          return save(
            { systemPrompt: msg.systemPrompt, systemMode: msg.systemMode, effort: msg.effort },
            (ok) => d.toast(ok ? s.csSaved : s.csFailed),
          );
        case "setEffort":
          return save({ effort: msg.effort }, (ok) => {
            if (!ok) d.toast(s.csFailed);
          });
        case "searchHistory":
          return c.searchHistory(msg.query);
        case "openHit":
          scroll = msg.messageId === undefined ? null : { conversationId: msg.conversationId, messageId: msg.messageId };
          return c.openConversation(msg.conversationId);
      }
    },
    afterUpdate(snap) {
      if (scroll === null) return;
      if (snap.conversationId !== scroll.conversationId || snap.error !== null) {
        scroll = null; // another conversation is open now, or the load failed: nothing to scroll to
        return;
      }
      if (snap.loadingConversation) return;
      d.post({ type: "scrollToMessage", id: scroll.messageId });
      scroll = null;
    },
  };
}
