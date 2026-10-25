// Chat folder strings (FolderSheet, ConversationList). Merged into en.ts / ja.ts (same keys in both).
export const en: Record<string, string> = {
  'folder.new': 'New folder',
  'folder.renameTitle': 'Folder',
  'folder.namePh': 'Folder name',
  'folder.deleteTitle': 'Delete folder?',
  'folder.deleteMsg': 'Delete the folder "{name}"? Its chats are kept and moved to Unclassified.',
  'folder.deleteHint': 'Deleting a folder does not delete its chats. They move to Unclassified.',
  'folder.saveFailed': 'Could not save the folder',
  'folder.settings': 'Folder settings: {name}',
  'folder.moveTo': 'Move to folder',
  'folder.empty': 'No chats in this folder',
  'folder.add': 'New folder',
};

export const ja: Record<string, string> = {
  'folder.new': '新しいフォルダ',
  'folder.renameTitle': 'フォルダ',
  'folder.namePh': 'フォルダの名前',
  'folder.deleteTitle': 'フォルダを削除しますか?',
  'folder.deleteMsg': 'フォルダ「{name}」を削除します。中のチャットは消さずに、未分類へ戻します。',
  'folder.deleteHint': 'フォルダを削除しても、チャットは消えません。未分類へ戻ります。',
  'folder.saveFailed': 'フォルダを保存できませんでした',
  'folder.settings': 'フォルダの設定: {name}',
  'folder.moveTo': 'フォルダへ移動',
  'folder.empty': 'このフォルダにチャットはありません',
  'folder.add': '新しいフォルダ',
};
