// Admin (Settings > Server) strings. Merged into en.ts / ja.ts; the main/users/maint files are written separately.
import { en as mainEn, ja as mainJa } from './adminStrings';
import { en as usersEn, ja as usersJa } from './adminStringsUsers';
import { en as maintEn, ja as maintJa } from './adminStringsMaint';

const OWN_EN: Record<string, string> = {
  'settings.page.server': 'Server',
  'admin.err.username': 'Username must be 3-32 characters',
  'admin.err.password': 'Password must be at least 8 characters',
  'admin.err.name': 'Name is too long (max 60) or has control characters',
  'admin.err.desc': 'Description is too long (max 280)',
};

const OWN_JA: Record<string, string> = {
  'settings.page.server': 'サーバー',
  'admin.err.username': 'ユーザー名は 3〜32 文字で入力してください',
  'admin.err.password': 'パスワードは 8 文字以上にしてください',
  'admin.err.name': '名前が長すぎるか (最大 60 文字)、制御文字が含まれています',
  'admin.err.desc': '説明が長すぎます (最大 280 文字)',
};

export const ADMIN_EN: Record<string, string> = { ...OWN_EN, ...mainEn, ...usersEn, ...maintEn };
export const ADMIN_JA: Record<string, string> = { ...OWN_JA, ...mainJa, ...usersJa, ...maintJa };
