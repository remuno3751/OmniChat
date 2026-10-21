/**
 * Japanese wording for the English reasons the server attaches to an approval (vscode-policy.ts and
 * the vscode-protected*.ts rules). English stays as it came; an unknown text is shown unchanged.
 */
import type { Lang } from "./approvalModel";

const EXACT: Record<string, string> = {
  "cwd is outside the workspace": "作業ディレクトリがワークスペースの外です",
  "path is outside the workspace": "パスがワークスペースの外です",
  "path outside the workspace": "パスがワークスペースの外です",
  "write inside .git": ".git の中への書き込みです",
  "secret-looking path": "秘密情報らしいパスです",
  "literal secret or .git path": "秘密情報または .git のパスを直接指定しています",
  "recursive rm": "再帰的な rm です",
  "rm of workspace root, home, parent or dynamic target": "ワークスペースのルート・ホーム・親ディレクトリ、または動的な対象の rm です",
  "download or decode piped into a shell": "ダウンロードまたはデコードした内容をシェルへ渡しています",
  "fetch or decode combined with a shell": "取得またはデコードとシェルの組み合わせです",
  "git push": "git push です",
  "git clean": "git clean です",
  "git reset --hard": "git reset --hard です",
  "forced checkout": "強制チェックアウトです",
  "forced branch delete": "ブランチの強制削除です",
  "git stash drop or clear": "git stash の drop または clear です",
  "git filter-branch": "git filter-branch です",
  "git update-ref -d": "git update-ref -d です",
  "git reflog expire or delete": "git reflog の expire または delete です",
  "git gc --prune": "git gc --prune です",
  "force option": "強制オプションが付いています",
  "privilege escalation": "権限の昇格です",
  "recursive chmod or chown": "再帰的な chmod / chown です",
  "recursive delete (/s)": "再帰的な削除(/s)です",
  "Remove-Item -Recurse": "Remove-Item -Recurse です",
  "destructive disk or file tool": "ディスクやファイルを壊すおそれのあるツールです",
  "find -delete": "find -delete です",
  "encoded PowerShell": "エンコードされた PowerShell です",
  "commands nested too deeply": "コマンドの入れ子が深すぎます",
  "command name is not a literal word": "コマンド名が固定の文字列ではありません",
  "command could not be parsed": "コマンドを解析できませんでした",
  "could not be checked": "安全かどうかを確認できませんでした",
  "unknown tool": "未知のツールです",
  "path is not a string": "パスが文字列ではありません",
  "paths must be strings": "パスは文字列である必要があります",
};

const CLASS_JA: Record<string, string> = { read: "読み取り", edit: "編集", exec: "コマンド実行", gitwrite: "Git の書き込み" };
const MODE_JA: Record<string, string> = { manual: "手動", auto: "自動", full: "フル" };

function one(text: string): string {
  const t = text.trim();
  if (EXACT[t]) return EXACT[t];
  let m = /^extension: (.+)$/s.exec(t);
  if (m) return `拡張機能からの確認: ${one(m[1])}`;
  m = /^(read|edit|exec|gitwrite) needs approval in (\w+) mode$/.exec(t);
  if (m) return `${CLASS_JA[m[1]]}は${MODE_JA[m[2]] ?? m[2]}モードでは承認が必要です`;
  m = /^deny rule (.+)$/.exec(t);
  if (m) return `拒否ルール ${m[1]} に一致しました`;
  m = /^allow rule (.+)$/.exec(t);
  if (m) return `許可ルール ${m[1]} に一致しました`;
  m = /^(\w+) mode$/.exec(t);
  if (m && MODE_JA[m[1]]) return `${MODE_JA[m[1]]}モード`;
  // "P1-outside: path is outside the workspace" / "C-git: git push"
  m = /^([A-Za-z][\w.-]*): (.+)$/s.exec(t);
  if (m && (EXACT[m[2].trim()] || /^[PC]-/.test(m[1]))) return `${m[1]}: ${one(m[2])}`;
  return t;
}

/** Translates one server reason for `lang` (English is returned unchanged). */
export function localizeReason(text: string, lang: Lang): string {
  return lang === "en" ? text : one(text);
}
