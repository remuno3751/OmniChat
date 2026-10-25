// v0.5.6 session H: Code error texts (code_not_bridge, no tools, confirm_required), the hidden-devices line of the Code list. Merged into en.ts / ja.ts (same keys in both).
export const en: Record<string, string> = {
  'code.notBridge': 'This Code chat is not connected to a VS Code device. Pick the device again.',
  'code.noTools': 'The VS Code device offers no tools for this folder. Check that the folder is open and trusted in VS Code.',
  'code.confirmRequired': 'Full access needs confirmation.',
  'code.hiddenChats': "Hidden devices' chats: {n}",
  'code.hiddenShow': 'Show',
  'code.hiddenHide': 'Hide',
};
export const ja: Record<string, string> = {
  'code.notBridge': 'この Code の会話は VS Code の端末に接続されていません。端末を選び直してください。',
  'code.noTools': 'この端末の VS Code からは、このフォルダで使えるツールがありません。フォルダが VS Code で開かれ、信頼されているか確認してください。',
  'code.confirmRequired': 'フルアクセスには確認が必要です。',
  'code.hiddenChats': '非表示の端末の会話: {n} 件',
  'code.hiddenShow': '表示する',
  'code.hiddenHide': '非表示にする',
};
