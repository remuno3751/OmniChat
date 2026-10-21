/** Shared contract of the chat webview modules (all DOM code runs in the webview only). */
import type { ChatMessage, ChatViewState } from "../../chat/viewModel";

export type { ChatMessage, ChatViewState };
/** Posts one message to the extension host. */
export type Send = (msg: ChatMessage) => void;
/** A mounted piece of UI that is re-rendered from each new state. */
export interface Part {
  el: HTMLElement;
  update(state: ChatViewState): void;
}
