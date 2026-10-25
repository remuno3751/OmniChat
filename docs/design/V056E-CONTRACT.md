# v0.5.6-E contract (VS 拡張: チェックポイント画面 / 出典カード / 最後のプロンプトの編集)

ブランチ `feat/v056-e`。拡張の版は変えない(D が 0.4.0)。CHANGELOG は「## Unreleased (E)」。
新フレーム型は **`server/src/vscode-bridge.ts` の `CHAT_FRAME_TYPES` と `vscode-ext/src/protocol/codec.ts` の `KNOWN_TYPES`(+ `frames.ts` の `FrameType`)の両方**に入れる。

## 1. フレーム

### チェックポイント一覧
- E→S `checkpoints_request { requestId, conversationId }`
- S→E `checkpoints { requestId, conversationId, items: CheckpointItem[] }`(新しい順、最大 50)
  `CheckpointItem = { id: string; createdAt: number; dirty: boolean; restorable: boolean; prompt: string; files: number; messageId: string }`
  - `restorable` = `ref` があり `unavailable` が無い。`prompt` = そのチェックポイントの assistant メッセージの直前のユーザーメッセージ本文(改行を空白に、120 文字で切る。無ければ "")。`files` = その assistant メッセージの `changes` のファイル数(無ければ 0)。
  - 会話が見つからない / 他人のもの → 既存の `error` フレーム(`code:"not_found"`, requestId 付き)。
- E→S `checkpoint_restore { requestId, conversationId, checkpointId, removeNew?: boolean }`
- S→E `checkpoint_restored { requestId, conversationId, checkpointId, ok: boolean, error?: "busy" | "dirty_editors" | "unavailable" | "not_found" | "failed", message?: string }`
  - 実装は `requestVscodeRewind`(既存、`POST /code/checkpoints/:id/rewind` と同じ流れ)。実行中(`isGenerating` / code_status running)は `busy`。ref が無ければ `unavailable`。戻す前の現在状態の退避は gitops `rewindTo` が `refs/omnichat/checkpoints/pre-rewind-<時刻>` を必ず作る(既存の仕組み)。これを説明文言に書く。
  - 自分の会話・自分のブリッジ名のものだけ(`ownConversation`)。checkpoint 行の conversation_id が一致しなければ `not_found`。

### 出典
- `transcript` の assistant 項目に任意の `sources?: Array<{ title: string; url: string; host: string }>`(最大 8)。ストリーミング中は送らなくてよい(最終フレームと `historyItems` に付ける)。
- 作り方(サーバー): `session.turn.sources`(`{index,title,url,snippet?}`)から。http/https の URL のみ。URL はユーザー情報(`user:pass@`)とフラグメントを除く。`host` = hostname。title は 200 文字、url は 500 文字で切る。snippet は送らない。保存済みは `messages.sources`(JSON)。
- 拡張: `validItem` で不正な source は捨てる(項目ごと落とさない)。リンクは `vscode.env.openExternal`、http/https のみ。

### 最後のプロンプトの編集
- `prompt` に任意 `replaceLast?: true`。`conversationId` 必須(無ければ ack `invalid_frame`)。
- サーバー(`vscode-chat-edit.ts`): 実行中でない会話で、最後の **ユーザー** メッセージ以降のメッセージ(ユーザー本人を含む。assistant・ツールの項目)を会話から消す(アプリの消し方に合わせる。物理削除かソフト削除かは既存の仕組みを調べて同じにする)→ そのあと通常の `handleSend`。ユーザーメッセージが無い会話は `invalid_frame`。ワークスペースのファイルは戻さない。
- 消した後は `broadcast` で他クライアントにも反映(アプリが使う既存の削除通知に合わせる)。拡張側は `conversation_request` を投げ直さず、host が transcript をローカルで最後のユーザー項目以降を切る → 続く `transcript` で置き換わる。

## 2. webview ↔ host

webview→host(`parseChatMessage` で検証):
- `{ type: "requestCheckpoints" }` — 一覧を取る(host が `checkpoints_request`)
- `{ type: "restoreCheckpoint", checkpointId: string }` — host がモーダル確認(下記)→ `checkpoint_restore`
- `{ type: "openExternal", url: string }` — http/https のみ(既にあれば流用)
- `send` / `sendInterrupt` に任意 `replaceLast?: true`(キューには入れない。実行中は toast `editBusy` で拒否)

host→webview: `ChatViewState.v056e`(1 フィールド、`src/chat/viewModelV056e.ts` で作る):
```ts
interface V056eView {
  checkpoints: { state: "idle" | "loading" | "ready" | "error"; items: CheckpointItem[]; restoring: string | null; error: string | null };
}
```
host の確認ダイアログ(`vscode.window.showWarningMessage(modal: true)`): 本文は「{時刻} の時点に戻します。依頼: {prompt}。これ以降にエージェントが変更したファイルがこの時点の内容に戻ります。戻す直前の状態は Git の退避ブランチ(refs/omnichat/checkpoints/pre-rewind-…)に自動で保存されます。」ボタン 2 つ:「戻す」「戻す(新しく作られたファイルも削除)」。キャンセルは何も送らない。結果: 成功 → toast `restored` と transcript に status 項目(ローカル)「{時刻}の時点に戻しました」、一覧を再取得。失敗 → toast にエラー文言(`dirty_editors` は「保存していない変更があるエディタがあります。保存または閉じてから、もう一度試してください」)。

## 3. UI 設計(webview。Sonnet が決めた見た目)

### チェックポイント画面
- Chat ヘッダーの既存ボタン列に履歴アイコン(codicon 相当の文字は使わず既存アイコンの流儀に合わせる)の「やり直し」ボタン(`data-tip`=「チェックポイント」)。押すと**ヘッダー下にパネル**(既存のモデル/デバイスのポップオーバーと同じ流儀、`pop.ts` を使う)が開き、`requestCheckpoints` を送る。開閉は同ボタンと Escape。
- 見出し: 「チェックポイント」+ 小さい説明「エージェントが実行する前の状態に、ファイルを戻せます(会話は消えません)。」
- 一覧(新しい順、最大 50、縦スクロール、パネル高さ 320px まで):
  各行 = 左に時刻(`HH:mm`、日付が今日でなければ `M/D HH:mm`)、中央に依頼の 1 行(省略、`title`/`data-tip` に全文)、右に「変更 N ファイル」(N=0 なら「変更なし」)、行末に「戻す」ボタン。
  `dirty` の行は時刻の横に小さい「作業中の変更あり」バッジ。`restorable:false` の行は薄く表示し「戻す」を無効、`data-tip` に「Git のリポジトリではないため、この時点は復元できません」。
  実行中は全部の「戻す」を無効(`data-tip`=「実行中は戻せません」)。復元中の行は「戻しています…」。
- 空: 「まだチェックポイントがありません。Code が実行されると、実行ごとに作られます。」/ 読み込み中: 「読み込み中…」/ 失敗: 「読み込めませんでした」+「再読み込み」ボタン。
- 新規 DOM のみ(innerHTML 禁止)、style 属性禁止、クラス切り替え。CSS は新ファイル `media/webview/chat-v056e.css`(`chatView.ts` の styles に追加)。既存の CSS 変数(`--vscode-*` と既存トークン)だけ使う。

### 出典カード
- assistant 項目の本文の後(ツール行より下、フッターのボタンの上)に `<details class="cm-sources">`。`<summary>` =「情報源 (N)」。閉じた状態が初期。
- 中身は 1 行 1 件のリンク風ボタン: 上段に title(1 行省略)、下段に小さく host。クリックで `openExternal`(`<a href>` は使わず button + data-url)。番号 `1.` から。
- ストリーミング中(status = streaming)は出さない。

### 編集と再送
- **最後のユーザー項目**(かつ実行中でない)のメッセージ操作列に「編集」ボタン(既存の `messageActions.ts` の流儀)。
- 押す → 入力欄に本文を入れフォーカス、**入力欄の上に細い帯**「最後のメッセージを編集中 — 送信すると、このメッセージ以降の回答とツールの記録が会話から消えます。ファイルの変更は戻りません(チェックポイントから戻せます)。」+「キャンセル」ボタン。送信ボタンの文言/`data-tip` は「編集して再送」。
- 送信 → `send` に `replaceLast: true`。キャンセル / 会話切替 / 新しい会話 → 編集状態を解除し入力欄は元の下書きに戻さず空にする(本文は編集前の下書きがあれば復元せず、単純に空)。
- 実行中は「編集」ボタン非表示。添付は編集時は引き継がない(本文のみ)。

## 4. 文言(`vscode-ext/src/ui/stringsV056e.ts`、ja/en)
キー(`Strings` に型を足す。`strings.ts` には import 1 行のみ):
`cpTitle, cpHint, cpEmpty, cpLoading, cpError, cpReload, cpRestore, cpRestoring, cpDirty, cpUnavailable, cpBusy, cpFiles(n), cpNoChange, cpButtonTip, cpConfirm(time,prompt), cpConfirmRestore, cpConfirmRestoreRemove, cpRestored(time), cpFailed(msg), cpDirtyEditors, srcTitle(n), srcOpen, editLabel, editBannerText, editCancel, editSendTip, editBusy`
(関数型は既存 strings の流儀に合わせる。ja/en のキー一致テストあり。)

## 5. ファイル所有(重ならない)
- **W-S(サーバー)**: `server/src/vscode-chat-checkpoints.ts`(新), `server/src/vscode-chat-edit.ts`(新), `server/src/vscode-transcript.ts`(sources のみ), `server/src/code-agent.ts`(feed に sources を渡す 数行のみ), `server/src/vscode-chat.ts`(switch に 2 行 + onPrompt に replaceLast の分岐 数行のみ。行数が 300 を超えるなら不要な空行/コメントを詰めず、別ファイルへ関数を出して 1 行にする), `server/src/vscode-bridge.ts`(`CHAT_FRAME_TYPES` のみ), 新テスト `server/src/vscode-chat-v056e.test.ts`(新), `docs/API.md`。
- **W-H(拡張: プロトコル + host)**: `vscode-ext/src/protocol/chat-frames-v056e.ts`(新), `chat-frames.ts`(再エクスポート 1〜2 行 + `validItem` の sources + isValidChatSFrame の新 2 型。300 行制限に注意: 関数は新ファイルに出して呼ぶだけにする), `codec.ts`, `frames.ts`(FrameType), `src/chat/viewModelV056e.ts`(新), `src/chat/checkpointsHost.ts`(新: 要求・確認・結果), `src/chat/messages.ts`(parse), `src/chat/controller*.ts` / `sendPath.ts`(`replaceLast` の通し、transcript の切り詰め。最小差分), `src/chat/viewModel.ts`(v056e の 1 行), `src/ui/stringsV056e.ts`(新), `src/ui/strings.ts`(import 1 行), テスト `test/chat-v056e.test.ts`(新), `docs/VSCODE.md`, `vscode-ext/CHANGELOG.md`。
- **W-W(webview)**: `src/webview/chat/checkpoints.ts`(新), `sources.ts`(新), `editLast.ts`(新), 既存 `messages.ts` / `header.ts` / `composer.ts` / `main.ts` / `messageActions.ts` / `types.ts` には**呼び出しの最小フック**のみ, `media/webview/chat-v056e.css`(新), `src/ui/chatView.ts` は styles 1 行のみ, `media/webview/chat.js`(`npm run build` の生成物), テスト(純関数のみ)`test/chat-v056e-webview.test.ts`(新)。W-H の型(`CheckpointItem`, `V056eView`)は `protocol/chat-frames-v056e.ts` / `chat/viewModelV056e.ts` から import(W-H が先に書いた型。W-W は §1・§2 の形のとおりに書く)。

## 6. 制約
- CSP: インライン style 属性・`setAttribute("style")` 禁止(CSSOM の `style.setProperty` は可)。innerHTML は承認済み 2 箇所のみ(増やさない)。
- 各 `.ts` は 300 行以下(manifest.test.ts の対象ファイルは 301)。`extension.ts` / `ui/strings.ts` は触らない(strings は import 1 行のみ)。
- 触らない: `app/`, `desktop/`, 会話設定・検索・/rename・/effort・JSON エクスポート(D)。
- 版・タグ・リリースは触らない。公開リポジトリに push しない。
