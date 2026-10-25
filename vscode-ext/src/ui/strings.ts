/**
 * Tiny i18n table for the Chat and Settings views. The host picks one language from
 * `vscode.env.language` (ja -> Japanese, anything else -> English) and sends the whole table to the
 * webview, so the webview scripts hold no wording.
 */
import type { Lang } from "./approvalModel";
import type { PairReason } from "../pairing";
import { chatEn, chatJa, type ChatStrings } from "./stringsChat";
import { connEn, connJa, type ConnStrings } from "./stringsConn";
import { inputEn, inputJa, type InputStrings } from "./stringsInput";
import { v056dEn, v056dJa, type V056dStrings } from "./stringsV056d";
import { v056eEn, v056eJa, type V056eStrings } from "./stringsV056e";

export type { Lang };

export interface Strings extends ChatStrings, ConnStrings, InputStrings, V056dStrings, V056eStrings {
  chat: string;
  settings: string;
  // Chat
  placeholder: string;
  send: string;
  stop: string;
  newConversation: string;
  recent: string;
  noConversations: string;
  noMessages: string;
  model: string;
  defaultModel: string;
  approvalMode: string;
  modeManual: string;
  modeAuto: string;
  modeFull: string;
  folder: string;
  you: string;
  assistant: string;
  reasoning: string;
  working: string;
  offline: string;
  connecting: string;
  refresh: string;
  close: string;
  confirmFull: string;
  confirmFullYes: string;
  pendingApprovals: string;
  tool: Record<"pending" | "running" | "done" | "error" | "denied", string>;
  assistantStatus: Record<"streaming" | "done" | "error" | "stopped", string>;
  // Pairing
  pairTitle: string;
  pairBody: string;
  pairCode: string;
  pairButton: string;
  pairInvalid: string;
  /** Why a pasted pairing code was rejected (shown instead of the generic text). */
  pairReasons: Record<PairReason, string>;
  // Settings
  server: string;
  serverUrl: string;
  pairing: string;
  paired: string;
  notPaired: string;
  connection: string;
  status: Record<"connecting" | "online" | "offline" | "incompatible" | "unauthorized" | "closed" | "unpaired", string>;
  deviceName: string;
  theme: string;
  themeSimple: string;
  themeFrontier: string;
  themeAstral: string;
  decorations: string;
  decorAuto: string;
  decorOn: string;
  decorOff: string;
  autoSave: string;
  shell: string;
  shellHint: string;
  save: string;
  unpair: string;
  openLog: string;
  trusted: string;
  untrusted: string;
  trustNote: string;
  tokenNote: string;
  saved: string;
  invalidUrl: string;
  invalidUrlHttp: string;
  version: string;
}

const ja: Strings = {
  ...chatJa,
  ...connJa,
  ...inputJa,
  ...v056dJa,
  ...v056eJa,
  chat: "チャット",
  settings: "設定",
  placeholder: "OmniChat に依頼する(Enter で送信、Shift+Enter で改行)",
  send: "送信",
  stop: "停止",
  newConversation: "新しい会話",
  recent: "最近の会話",
  noConversations: "このフォルダの会話はまだありません。",
  noMessages: "メッセージを送ると、ここに会話が表示されます。",
  model: "モデル",
  defaultModel: "既定のモデル",
  approvalMode: "承認モード",
  modeManual: "手動",
  modeAuto: "自動",
  modeFull: "フルアクセス",
  folder: "フォルダ",
  you: "あなた",
  assistant: "OmniChat",
  reasoning: "思考",
  working: "実行中…",
  offline: "サーバーに接続していません。",
  connecting: "接続しています…",
  refresh: "更新",
  close: "閉じる",
  confirmFull: "フルアクセスでは、保護項目以外のツールが確認なしに実行されます。自分のコードで、チェックポイントを前提に使ってください。有効にしますか?",
  confirmFullYes: "有効にする",
  pendingApprovals: "承認待ち",
  tool: { pending: "待機", running: "実行中", done: "完了", error: "エラー", denied: "拒否" },
  assistantStatus: { streaming: "生成中", done: "完了", error: "エラー", stopped: "停止" },
  pairTitle: "OmniChat とペアリング",
  pairBody: "OmniChat アプリの「VS Code」カードでペアリングコードを作り、ここに貼り付けてください。",
  pairCode: "ペアリングコード",
  pairButton: "ペアリング",
  pairInvalid: "有効なペアリングコードではありません。",
  pairReasons: {
    empty: "ペアリングコードが空です。アプリの VS Code カードでコードを作り、貼り付けてください。",
    too_long: "貼り付けた内容が長すぎます。ペアリングコードだけを貼り付けてください。",
    uri: "リンクが OmniChat のペアリング用ではありません(vscode://omnichat.omnichat-vscode/pair?code=… の形式が必要です)。",
    format: "コードの形式が正しくありません。コードの一部が欠けていないか、全体をコピーできているか確認してください。",
    decode: "コードを読み取れませんでした(復号エラー)。コピーし直してください。",
    shape: "コードの内容が正しくありません。アプリでコードを作り直してください。",
    server_url: "コードに含まれるサーバーアドレスが正しくありません。アプリのサーバー URL を確認してください。",
    http_public: "インターネット上のサーバーに http では接続できません。https を使うか、LAN / Tailscale のアドレスを使ってください。",
    credential: "コードに含まれるトークンが正しくありません。アプリでコードを作り直してください。",
    device_name: "コードに含まれるデバイス名が正しくありません。アプリでコードを作り直してください。",
  },
  server: "サーバー",
  serverUrl: "サーバー URL",
  pairing: "ペアリング",
  paired: "ペアリング済み",
  notPaired: "未ペアリング",
  connection: "接続",
  status: {
    connecting: "接続中",
    online: "オンライン",
    offline: "オフライン",
    incompatible: "非互換",
    unauthorized: "認証エラー",
    closed: "切断",
    unpaired: "未ペアリング",
  },
  deviceName: "ブリッジ名",
  theme: "テーマ",
  themeSimple: "シンプル",
  themeFrontier: "フロンティア",
  themeAstral: "アストラル",
  decorations: "装飾",
  decorAuto: "自動",
  decorOn: "オン",
  decorOff: "オフ",
  autoSave: "編集後に自動保存",
  shell: "シェル",
  shellHint: "空欄なら標準のシェル",
  save: "保存",
  unpair: "ペアリング解除",
  openLog: "ログを開く",
  trusted: "このウィンドウは信頼されています(書き込み・実行ツールが使えます)。",
  untrusted: "このウィンドウは信頼されていません(読み取り専用)。",
  trustNote: "信頼されていないフォルダでは、書き込みと実行はできません。VS Code の Workspace Trust で信頼できます。",
  tokenNote: "トークンは SecretStorage に保存され、ここには表示されません。",
  saved: "保存しました。",
  invalidUrl: "サーバー URL が正しくありません。https://… または http://192.168.x.x:8787 の形式で入力してください。",
  invalidUrlHttp: "インターネット上のサーバーに http は使えません。https を使うか、LAN / Tailscale のアドレスを入力してください。",
  version: "拡張のバージョン",
};

const en: Strings = {
  ...chatEn,
  ...connEn,
  ...inputEn,
  ...v056dEn,
  ...v056eEn,
  chat: "Chat",
  settings: "Settings",
  placeholder: "Ask OmniChat (Enter to send, Shift+Enter for a new line)",
  send: "Send",
  stop: "Stop",
  newConversation: "New conversation",
  recent: "Recent conversations",
  noConversations: "No conversations for this folder yet.",
  noMessages: "Send a message and the conversation appears here.",
  model: "Model",
  defaultModel: "Default model",
  approvalMode: "Approval mode",
  modeManual: "Manual",
  modeAuto: "Auto",
  modeFull: "Full access",
  folder: "Folder",
  you: "You",
  assistant: "OmniChat",
  reasoning: "Reasoning",
  working: "Working…",
  offline: "Not connected to the server.",
  connecting: "Connecting…",
  refresh: "Refresh",
  close: "Close",
  confirmFull:
    "Full access runs every tool except protected items without asking. Use it on your own code, with checkpoints. Enable it?",
  confirmFullYes: "Enable",
  pendingApprovals: "Waiting for approval",
  tool: { pending: "Queued", running: "Running", done: "Done", error: "Error", denied: "Denied" },
  assistantStatus: { streaming: "Generating", done: "Done", error: "Error", stopped: "Stopped" },
  pairTitle: "Pair with OmniChat",
  pairBody: "Create a pairing code in the OmniChat app (VS Code card) and paste it here.",
  pairCode: "Pairing code",
  pairButton: "Pair",
  pairInvalid: "This is not a valid pairing code.",
  pairReasons: {
    empty: "The pairing code is empty. Create a code in the app's VS Code card and paste it.",
    too_long: "The pasted text is too long. Paste only the pairing code.",
    uri: "This link is not an OmniChat pairing link (expected vscode://omnichat.omnichat-vscode/pair?code=...).",
    format: "The code format is wrong. Check that the whole code was copied and nothing is missing.",
    decode: "The code could not be read (decode error). Copy it again.",
    shape: "The code content is not valid. Create a new code in the app.",
    server_url: "The server address inside the code is not valid. Check the server URL in the app.",
    http_public: "Plain http is not allowed for a public host. Use https, or a LAN / Tailscale address.",
    credential: "The token inside the code is not valid. Create a new code in the app.",
    device_name: "The device name inside the code is not valid. Create a new code in the app.",
  },
  server: "Server",
  serverUrl: "Server URL",
  pairing: "Pairing",
  paired: "Paired",
  notPaired: "Not paired",
  connection: "Connection",
  status: {
    connecting: "Connecting",
    online: "Online",
    offline: "Offline",
    incompatible: "Incompatible",
    unauthorized: "Unauthorized",
    closed: "Closed",
    unpaired: "Not paired",
  },
  deviceName: "Bridge name",
  theme: "Theme",
  themeSimple: "Simple",
  themeFrontier: "Frontier",
  themeAstral: "Astral",
  decorations: "Decorations",
  decorAuto: "Auto",
  decorOn: "On",
  decorOff: "Off",
  autoSave: "Save files after OmniChat edits",
  shell: "Shell",
  shellHint: "Empty uses the default shell",
  save: "Save",
  unpair: "Unpair",
  openLog: "Open log",
  trusted: "This window is trusted (write and run tools are available).",
  untrusted: "This window is not trusted (read-only).",
  trustNote: "Untrusted folders cannot write files or run commands. Trust the folder with VS Code Workspace Trust.",
  tokenNote: "The token is kept in SecretStorage and is never shown here.",
  saved: "Saved.",
  invalidUrl: "The server URL is not valid. Use https://... or http://192.168.x.x:8787.",
  invalidUrlHttp: "Plain http is not allowed for a public host. Use https, or a LAN / Tailscale address.",
  version: "Extension version",
};

/** `vscode.env.language` -> display language. ja* is Japanese; everything else is English. */
export function pickLang(language: string | undefined): Lang {
  return typeof language === "string" && /^ja(\b|-|_|$)/i.test(language) ? "ja" : "en";
}

export function stringsFor(lang: Lang): Strings {
  return lang === "ja" ? ja : en;
}
