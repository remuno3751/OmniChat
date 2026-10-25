/**
 * Wording for the v0.5.5-beta.2 composer features: attachments, slash commands, the model popover and the
 * device / folder popover. Merged into `Strings` in strings.ts (both languages must have the same keys).
 */
export interface InputStrings {
  attachBtn: string;
  attachDrop: string;
  attachRemove: string;
  attachTooMany: string;
  attachTooBig: string;
  attachTotalBig: string;
  attachBadType: string;
  attachNoVision: string;
  errAttachInvalid: string;
  errAttachTooLarge: string;
  errAttachNotSupported: string;
  slashTitle: string;
  slashNone: string;
  slashClear: string;
  slashContext: string;
  slashModel: string;
  slashHelp: string;
  slashCompact: string;
  slashContextResult: string;
  slashContextUnknown: string;
  slashCompactStart: string;
  slashCompactDone: string;
  slashCompactFail: string;
  slashNeedConversation: string;
  slashUsage: string;
  slashRetry: string;
  slashPin: string;
  slashExport: string;
  slashPinned: string;
  slashUnpinned: string;
  slashRetryNotNow: string;
  slashExportFail: string;
  modelSearch: string;
  modelNone: string;
  modelCtx: string;
  modelVision: string;
  deviceLabel: string;
  deviceThis: string;
  deviceOthers: string;
  deviceOtherHint: string;
  deviceLoading: string;
  deviceError: string;
  folderOpen: string;
  folderPinned: string;
  folderNotOpen: string;
  folderPin: string;
  folderUnpin: string;
  folderNone: string;
  regenerate: string;
  regenerateTip: string;
  copyMessage: string;
  queueRun: string;
  queueRunTip: string;
  tokensTitle: string;
  tokSystem: string;
  tokHistory: string;
  tokAttach: string;
  tokTools: string;
  tokInput: string;
  tokReasoning: string;
  tokLast: string;
  tokPrompt: string;
  tokCompletion: string;
  tokCache: string;
  tokTotal: string;
  openInEditor: string;
}

export const inputJa: InputStrings = {
  attachBtn: "ファイルを添付",
  attachDrop: "ここにドロップして添付",
  attachRemove: "添付を外す",
  attachTooMany: "添付は {n} 件までです",
  attachTooBig: "{name} は大きすぎます (1件 {mb} MB まで)",
  attachTotalBig: "添付の合計が大きすぎます ({mb} MB まで)",
  attachBadType: "{name} は添付できない形式です",
  attachNoVision: "このモデルは画像を読めません",
  errAttachInvalid: "添付ファイルを受け付けられません",
  errAttachTooLarge: "添付ファイルが大きすぎます",
  errAttachNotSupported: "このモデルでは、その添付は使えません",
  slashTitle: "コマンド",
  slashNone: "一致するコマンドはありません",
  slashClear: "新しい会話を始める",
  slashContext: "コンテキストの使用量を表示",
  slashModel: "モデルを選ぶ",
  slashHelp: "コマンドの一覧を表示",
  slashCompact: "会話を要約して軽くする",
  slashContextResult: "コンテキスト: {used} / {limit} ({pct}%)",
  slashContextUnknown: "コンテキストの使用量はまだ分かりません",
  slashCompactStart: "要約しています…",
  slashCompactDone: "要約しました ({before} → {after} トークン)",
  slashCompactFail: "要約できませんでした",
  slashNeedConversation: "会話がまだありません",
  slashUsage: "トークンの内訳を表示",
  slashRetry: "直前のメッセージをもう一度送る",
  slashPin: "この会話のピン留めを切り替える",
  slashExport: "会話をMarkdownで開く",
  slashPinned: "会話をピン留めしました",
  slashUnpinned: "ピン留めを外しました",
  slashRetryNotNow: "今は再送できません",
  slashExportFail: "書き出せませんでした",
  modelSearch: "モデルを検索",
  modelNone: "一致するモデルがありません",
  modelCtx: "{n}k コンテキスト",
  modelVision: "画像対応",
  deviceLabel: "デバイスとフォルダ",
  deviceThis: "このPC",
  deviceOthers: "ほかのデバイス",
  deviceOtherHint: "ほかのデバイスのフォルダは、そのデバイスの VS Code から選びます",
  deviceLoading: "読み込み中…",
  deviceError: "デバイスの一覧を取得できませんでした",
  folderOpen: "開いているフォルダ",
  folderPinned: "固定したフォルダ",
  folderNotOpen: "このウィンドウでは開いていません",
  folderPin: "固定する",
  folderUnpin: "固定を外す",
  folderNone: "フォルダがありません",
  regenerate: "もう一度実行",
  regenerateTip: "直前の質問を、同じモデルと設定でもう一度送ります",
  copyMessage: "メッセージをコピー",
  queueRun: "今すぐ実行",
  queueRunTip: "実行中の処理を止めて、これを先に実行します (Ctrl+Enter と同じ)",
  tokensTitle: "トークンの内訳",
  tokSystem: "システム",
  tokHistory: "履歴",
  tokAttach: "添付",
  tokTools: "ツール定義",
  tokInput: "入力欄",
  tokReasoning: "推論",
  tokLast: "直近の応答",
  tokPrompt: "入力",
  tokCompletion: "出力",
  tokCache: "キャッシュ: 取得できません",
  tokTotal: "合計 / 上限",
  openInEditor: "エディタで開く",
};

export const inputEn: InputStrings = {
  attachBtn: "Attach files",
  attachDrop: "Drop files to attach",
  attachRemove: "Remove attachment",
  attachTooMany: "At most {n} attachments",
  attachTooBig: "{name} is too large (max {mb} MB each)",
  attachTotalBig: "Attachments are too large in total (max {mb} MB)",
  attachBadType: "{name} cannot be attached",
  attachNoVision: "This model cannot read images",
  errAttachInvalid: "The attachments were not accepted",
  errAttachTooLarge: "The attachments are too large",
  errAttachNotSupported: "This model cannot use that attachment",
  slashTitle: "Commands",
  slashNone: "No matching command",
  slashClear: "Start a new conversation",
  slashContext: "Show context usage",
  slashModel: "Choose the model",
  slashHelp: "List the commands",
  slashCompact: "Summarise the conversation to free context",
  slashContextResult: "Context: {used} / {limit} ({pct}%)",
  slashContextUnknown: "Context usage is not known yet",
  slashCompactStart: "Compacting…",
  slashCompactDone: "Compacted ({before} → {after} tokens)",
  slashCompactFail: "Could not compact",
  slashNeedConversation: "There is no conversation yet",
  slashUsage: "Show the token breakdown",
  slashRetry: "Send the last message again",
  slashPin: "Pin or unpin this conversation",
  slashExport: "Open the conversation as Markdown",
  slashPinned: "Pinned the conversation",
  slashUnpinned: "Unpinned the conversation",
  slashRetryNotNow: "The last message cannot be sent again now",
  slashExportFail: "Could not open the export",
  modelSearch: "Search models",
  modelNone: "No matching model",
  modelCtx: "{n}k context",
  modelVision: "Vision",
  deviceLabel: "Device and folder",
  deviceThis: "This PC",
  deviceOthers: "Other devices",
  deviceOtherHint: "Open folders of other devices from their own VS Code",
  deviceLoading: "Loading…",
  deviceError: "Could not load the devices",
  folderOpen: "Open folders",
  folderPinned: "Pinned folders",
  folderNotOpen: "Not open in this window",
  folderPin: "Pin",
  folderUnpin: "Unpin",
  folderNone: "No folders",
  regenerate: "Run again",
  regenerateTip: "Send the previous prompt again with the same model and settings",
  copyMessage: "Copy message",
  queueRun: "Run now",
  queueRunTip: "Stop the current run and run this first (same as Ctrl+Enter)",
  tokensTitle: "Token breakdown",
  tokSystem: "System",
  tokHistory: "History",
  tokAttach: "Attachments",
  tokTools: "Tools",
  tokInput: "Draft",
  tokReasoning: "Reasoning",
  tokLast: "Last reply",
  tokPrompt: "Prompt",
  tokCompletion: "Completion",
  tokCache: "Cache: not reported",
  tokTotal: "Total / limit",
  openInEditor: "Open in editor",
};
