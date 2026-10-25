/** Wording for 0.4.0: per-conversation settings, effort chip, /effort /rename /export json, history search. ja + en must have the same keys. */
export interface V056dStrings {
  csTitle: string;
  csOpen: string;
  csSystemPrompt: string;
  csSystemHint: string;
  csModeAppend: string;
  csModeReplace: string;
  csEffort: string;
  csEffortDefault: string;
  csEffortOff: string;
  csEffortLow: string;
  csEffortMedium: string;
  csEffortHigh: string;
  csEffortMax: string;
  csSave: string;
  csCancel: string;
  csLoading: string;
  csSaved: string;
  csFailed: string;
  csNeedConversation: string;
  effortChipTip: string;
  slashEffort: string;
  slashRename: string;
  slashExportJson: string;
  effortSet: string;
  effortBad: string;
  renameDone: string;
  renameNeedTitle: string;
  searchPlaceholder: string;
  searchNone: string;
  searchSearching: string;
  searchFailed: string;
  searchMessageHit: string;
  searchTitleHit: string;
}

export const v056dJa: V056dStrings = {
  csTitle: "このチャットの設定",
  csOpen: "このチャットの設定",
  csSystemPrompt: "システムプロンプト",
  csSystemHint: "この会話だけに効く指示です。空なら使いません。",
  csModeAppend: "既定の指示の後ろに追記",
  csModeReplace: "既定の指示を置き換え",
  csEffort: "思考の強さ",
  csEffortDefault: "既定",
  csEffortOff: "オフ",
  csEffortLow: "低",
  csEffortMedium: "中",
  csEffortHigh: "高",
  csEffortMax: "最大",
  csSave: "保存",
  csCancel: "キャンセル",
  csLoading: "読み込み中…",
  csSaved: "設定を保存しました",
  csFailed: "設定を保存できませんでした",
  csNeedConversation: "先に会話を始めてください",
  effortChipTip: "思考の強さ(この会話)",
  slashEffort: "思考の強さを変える: /effort off|low|medium|high|max|default",
  slashRename: "会話の題名を変える: /rename <題名>",
  slashExportJson: "会話を JSON で開く: /export json",
  effortSet: "思考の強さ: {level}",
  effortBad: "off / low / medium / high / max / default のどれかを指定してください",
  renameDone: "題名を変更しました",
  renameNeedTitle: "新しい題名を続けて入力してください: /rename <題名>",
  searchPlaceholder: "全会話を検索",
  searchNone: "見つかりませんでした",
  searchSearching: "検索中…",
  searchFailed: "検索できませんでした",
  searchMessageHit: "本文",
  searchTitleHit: "題名",
};

export const v056dEn: V056dStrings = {
  csTitle: "Chat settings",
  csOpen: "Settings for this chat",
  csSystemPrompt: "System prompt",
  csSystemHint: "Applies to this conversation only. Empty = unused.",
  csModeAppend: "Append to the default instructions",
  csModeReplace: "Replace the default instructions",
  csEffort: "Thinking effort",
  csEffortDefault: "Default",
  csEffortOff: "Off",
  csEffortLow: "Low",
  csEffortMedium: "Medium",
  csEffortHigh: "High",
  csEffortMax: "Max",
  csSave: "Save",
  csCancel: "Cancel",
  csLoading: "Loading…",
  csSaved: "Settings saved",
  csFailed: "Could not save the settings",
  csNeedConversation: "Start a conversation first",
  effortChipTip: "Thinking effort (this chat)",
  slashEffort: "Set thinking effort: /effort off|low|medium|high|max|default",
  slashRename: "Rename the conversation: /rename <title>",
  slashExportJson: "Open the conversation as JSON: /export json",
  effortSet: "Thinking effort: {level}",
  effortBad: "Use one of off / low / medium / high / max / default",
  renameDone: "Renamed",
  renameNeedTitle: "Add the new title: /rename <title>",
  searchPlaceholder: "Search all conversations",
  searchNone: "No results",
  searchSearching: "Searching…",
  searchFailed: "Search failed",
  searchMessageHit: "Message",
  searchTitleHit: "Title",
};
