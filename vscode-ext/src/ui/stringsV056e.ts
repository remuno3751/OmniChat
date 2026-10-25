/**
 * Wording for the v0.5.6-E features: the checkpoints panel and its restore confirmation, the sources of an
 * answer, and editing the last prompt. Merged into `Strings` in strings.ts (both languages must have the
 * same keys). Templates use `{name}` placeholders, replaced by the caller.
 */
export interface V056eStrings {
  cpTitle: string;
  cpHint: string;
  cpEmpty: string;
  cpLoading: string;
  cpError: string;
  cpReload: string;
  cpRestore: string;
  cpRestoring: string;
  cpDirty: string;
  cpUnavailable: string;
  cpBusy: string;
  /** `{n}` files. */
  cpFiles: string;
  cpNoChange: string;
  cpButtonTip: string;
  /** `{time}`, `{prompt}`. */
  cpConfirm: string;
  cpConfirmRestore: string;
  cpConfirmRestoreRemove: string;
  /** `{time}`. */
  cpRestored: string;
  /** `{msg}`. */
  cpFailed: string;
  cpDirtyEditors: string;
  /** `{n}` sources. */
  srcTitle: string;
  srcOpen: string;
  editLabel: string;
  editBannerText: string;
  editCancel: string;
  editSendTip: string;
  editBusy: string;
}

export const v056eJa: V056eStrings = {
  cpTitle: "チェックポイント",
  cpHint: "エージェントが実行する前の状態に、ファイルを戻せます(会話は消えません)。",
  cpEmpty: "まだチェックポイントがありません。Code が実行されると、実行ごとに作られます。",
  cpLoading: "読み込み中…",
  cpError: "読み込めませんでした",
  cpReload: "再読み込み",
  cpRestore: "戻す",
  cpRestoring: "戻しています…",
  cpDirty: "作業中の変更あり",
  cpUnavailable: "Git のリポジトリではないため、この時点は復元できません",
  cpBusy: "実行中は戻せません",
  cpFiles: "変更 {n} ファイル",
  cpNoChange: "変更なし",
  cpButtonTip: "チェックポイント",
  cpConfirm:
    "{time} の時点に戻します。依頼: {prompt}。これ以降にエージェントが変更したファイルがこの時点の内容に戻ります。戻す直前の状態は Git の退避ブランチ(refs/omnichat/checkpoints/pre-rewind-…)に自動で保存されます。",
  cpConfirmRestore: "戻す",
  cpConfirmRestoreRemove: "戻す(新しく作られたファイルも削除)",
  cpRestored: "{time} の時点に戻しました",
  cpFailed: "戻せませんでした: {msg}",
  cpDirtyEditors: "保存していない変更があるエディタがあります。保存または閉じてから、もう一度試してください",
  srcTitle: "情報源 ({n})",
  srcOpen: "リンクを開く",
  editLabel: "編集",
  editBannerText:
    "最後のメッセージを編集中 — 送信すると、このメッセージ以降の回答とツールの記録が会話から消えます。ファイルの変更は戻りません(チェックポイントから戻せます)。",
  editCancel: "キャンセル",
  editSendTip: "編集して再送",
  editBusy: "実行中は編集できません",
};

export const v056eEn: V056eStrings = {
  cpTitle: "Checkpoints",
  cpHint: "You can restore the files to the state before an agent run. The conversation is kept.",
  cpEmpty: "No checkpoints yet. One is made each time Code runs.",
  cpLoading: "Loading…",
  cpError: "Could not load",
  cpReload: "Reload",
  cpRestore: "Restore",
  cpRestoring: "Restoring…",
  cpDirty: "Unsaved changes",
  cpUnavailable: "Not a Git repository, so this point cannot be restored",
  cpBusy: "Cannot restore while a run is in progress",
  cpFiles: "{n} files changed",
  cpNoChange: "No changes",
  cpButtonTip: "Checkpoints",
  cpConfirm:
    "Restore to the point at {time}. Request: {prompt}. Files the agent changed after this point go back to their content at this point. The state just before the restore is saved automatically in a Git backup branch (refs/omnichat/checkpoints/pre-rewind-…).",
  cpConfirmRestore: "Restore",
  cpConfirmRestoreRemove: "Restore (also delete files created since)",
  cpRestored: "Restored to the point at {time}",
  cpFailed: "Could not restore: {msg}",
  cpDirtyEditors: "Some open editors have unsaved changes. Save or close them, then try again.",
  srcTitle: "Sources ({n})",
  srcOpen: "Open link",
  editLabel: "Edit",
  editBannerText:
    "Editing the last message: when sent, the answer and tool records after this message are removed from the conversation. Files the agent changed are not restored (you can restore them from a checkpoint).",
  editCancel: "Cancel",
  editSendTip: "Edit and resend",
  editBusy: "Cannot edit while a run is in progress",
};
