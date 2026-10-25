# VS Code 拡張(vscode-bridge)

OmniChat の Code タブから、**VS Code で開いているフォルダ**を AI に操作させる機能です。設計の詳細は [design/VSCODE-BRIDGE.md](design/VSCODE-BRIDGE.md)。

```
OmniChat アプリ ──WS/REST──> OmniChat サーバー(モデル呼び出し + エージェントループ) <──外向き接続 /bridge?kind=vscode── VS Code 拡張(ツール実行)
```

- **エージェントのループはサーバー側**にあります。使うモデルは OmniChat に登録した任意のプロバイダー(ツール呼び出しに対応したもの)で、会話のモデルとして選びます。
- 拡張は「ファイルの読み書き・コマンド実行・Git 操作を実行する」「開いているフォルダを報告する」「承認の防御層になる」だけです。PC 側で受け付けるポートはありません(拡張からサーバーへの外向き接続のみ)。
- dsh(DeepSeek Harness)の遠隔操作とは別の経路です([DSH.md](DSH.md))。同じ Code タブに並びます。

## インストール

リリースに添付された `omnichat-vscode-<版>.vsix` を入れます。

```
code --install-extension omnichat-vscode-0.2.2.vsix
```

VS Code の拡張機能ビューの「…」→「VSIX からのインストール」でも入れられます。Marketplace には公開していません。

## ペアリング

1. OmniChat アプリの 設定 → **VS Code** カードで「ペアリングコード」を作ります(端末トークンが作られ、デバイス一覧に `VS Code (<名前>)` として出ます)。
2. VS Code で コマンドパレット → **OmniChat: Pair with Server** にコードを貼ります(ペアリングは、このコードのコピー&貼り付けだけです。リンクで VS Code を開く方式は廃止しました)。トークンは VS Code の SecretStorage に保存され、ログには出ません。
3. ステータスバーが「接続済み」になります。アプリのカードのスイッチで、`vscode-bridge` プロバイダーを自動で作れます(手動なら、種類 `vscode-bridge`・ベース URL に **端末名**・API キーなし)。
4. Code タブで新しい会話を作り、VS Code で開いているフォルダを選び、**モデル**(別のプロバイダーのモデル)を選んで送信します。

### サーバーのアドレス(http と https)

ペアリングコードのサーバーアドレスは、次のとおりに扱われます(拡張 0.2.1 以降)。

- **http を使えるもの**: ループバック(`localhost`、`127.0.0.1`、`[::1]`)、LAN(`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`)、リンクローカル(`169.254.0.0/16`)、Tailscale(`100.64.0.0/10`)、IPv6 のローカル(`fc00::/7`、`fe80::/10`)、`.local` / `.lan` / `.home.arpa` / `.ts.net` / `.internal` の名前、ドットを含まない名前(例: `http://my-pc:8787`)。接続は `ws://` になります。LAN は暗号化されないため、信頼できるネットワークでのみ使ってください(Tailscale は WireGuard で暗号化されます)。
- **https が必要なもの**: 上記以外の公開ホスト。https 以外は拒否されます。
- URL にユーザー名・パスワードを含めることはできません。

貼り付けは寛容です。前後の空白・改行、見えない文字、引用符が付いていても読み取れます。

### トラブルシュート

- **「Error loading webview … Could not register service worker: InvalidStateError」** — VS Code を開いたまま拡張を更新したときに出る、VS Code 側の既知の不具合です。コマンドパレットの「Developer: Reload Window」で直ります。直らないときは VS Code をすべて閉じて、`%APPDATA%\Code\Service Worker` を削除してから開き直してください(macOS は `~/Library/Application Support/Code/Service Worker`、Linux は `~/.config/Code/Service Worker`)。拡張 0.2.2 は、ビューの再生成で HTML を二重に設定しないようにして、起きにくくしています。
- **モデルが選べない / 送信しても返事がない / 履歴が空** — サーバーが 0.5.4 より古いことが多いです(チャットの上に案内が出ます)。サーバーを更新してください。「モデルがありません」と出る場合は、アプリで OpenAI 互換のプロバイダーを追加してください(VS Code ブリッジや DSH のプロバイダーはモデル一覧に出ません)。

### ペアリングできないとき

エラーには理由が表示されます。

| 表示の趣旨 | 原因と対処 |
|---|---|
| コードが空です | 何も貼られていません。アプリの VS Code カードでコードを作ってください |
| 貼り付けた内容が長すぎます | コード以外が含まれています。コードだけを貼ってください |
| コードの形式が正しくありません | コードが途中で切れています。全体をコピーし直してください |
| コードを読み取れませんでした(復号エラー) | コードが壊れています。コピーし直してください |
| コードの内容が正しくありません | アプリでコードを作り直してください |
| サーバーアドレスが正しくありません | アプリのサーバー URL を確認してください |
| 公開サーバーに http では接続できません | https にするか、LAN / Tailscale のアドレスを使ってください |
| トークン / デバイス名が正しくありません | アプリでコードを作り直してください |

接続を解除するには、アプリのデバイス一覧でその端末を失効させます(拡張は再ペアリングを促します)。

1 台の PC で VS Code を複数ウィンドウ開いても 1 つの端末名にまとまります。実行は、そのフォルダを開いているウィンドウに送られます(どのウィンドウも開いていなければ「`workspace_not_open`」)。1 ウィンドウで同時に走るのは 1 実行までです。

## 承認モード

会話ごとに設定します(Code 会話のヘッダー)。**サーバー側の既定は手動で、自動では戻りません**(アプリやサーバーを再起動しても、ユーザーが変えるまで保たれます)。

| 区分 | 手動 (manual) | 自動 (auto) | フルアクセス (full) |
|---|---|---|---|
| 読み取り(フォルダ内) | 自動 | 自動 | 自動 |
| 編集 `write_file` / `edit_file` | 確認 | 自動 | 自動 |
| コマンド `run_command` | 確認 | 許可リスト(`npm test`、`npx tsc --noEmit`、`pytest`、`cargo test`、`git status` など)だけ自動 | 自動 |
| `git_commit` | 確認 | 確認 | 自動 |
| **保護項目** | 確認 | 確認 | **確認** |

- フルアクセスにするには確認ダイアログ(`PUT /conversations/:id` に `approvalMode:"full"` と `confirmFull:true`)が必要です。
- 評価の順序は **拒否ルール > 保護項目 > 許可ルール > モード > 確認** です。承認ルールは Code タブの承認ルール(`approval-rules`)と共通で、拒否ルールは保護項目にも効きます。許可リストはシェルのメタ文字(`; & | < > `` ` `` `$(` と改行)を含むコマンドには効きません。
- 確認は、アプリのダイアログ(許可 / 拒否)と、VS Code 側の承認パネルのどちらでも答えられます(先に答えた方が有効)。タイムアウト(既定 120 秒)・中止は拒否として扱われます。**保護項目では「常に許可」は出ず、ルールも作られません。**

### 保護項目(要約)

フォルダの外のパス、`.git` の中身の編集、秘密情報(`.env*`、`*.pem`・`*.key`、`id_rsa` 類、`.ssh` `.aws` `.kube`、`.npmrc` など。**読み取りも**)、危険な Git 操作(`push`、`reset --hard`、`clean`、強制系オプション など)、再帰削除(`rm -r`、`rmdir /s` など)、`sudo`、`curl | sh` など。解析できないコマンドも保護項目として扱います。正式な一覧と判定ケースは [design/VSCODE-BRIDGE.md](design/VSCODE-BRIDGE.md) §4.3 と `vscode-ext/test/fixtures/protected-cases.json` にあります。

## チェックポイントと巻き戻し

実行の前に、**全モードで**Git のチェックポイントが作られます(Git のフォルダのみ。そうでなければ警告のみで続行)。実行後の変更は変更一覧に出ます。巻き戻しは既存の `POST /code/checkpoints/:id/rewind` で、そのフォルダを開いているウィンドウが実行します。実行中は 409、未保存の変更があるエディタがあれば 409 `dirty_editors` です。

## チェックポイント画面・出典・最後のプロンプトの編集(v0.5.6-E 以降)

- **チェックポイント**: チャットのヘッダーの「チェックポイント」ボタンで、実行の前の状態の一覧が開きます(新しい順、最大 50 件)。各行に時刻・依頼・変更ファイル数が出ます。「戻す」を押すと、確認のダイアログが出ます。確認したときだけ、ファイルが戻ります(会話は消えません)。戻す直前の状態は Git の退避ブランチ `refs/omnichat/checkpoints/pre-rewind-…` に自動で保存されます。「戻す(新しく作られたファイルも削除)」を選ぶと、その後に作られたファイルも消えます。実行中、未保存の変更があるエディタがあるとき、Git のリポジトリでないときは戻せません(理由を通知で出します)。戻すと、会話に「○○の時点に戻しました」の行が残ります。
- **出典**: Web 検索を使った回答の後ろに「情報源 (N)」が出ます。開くと、タイトルとサイトのホスト名の一覧で、クリックすると既定のブラウザで開きます。開くのは http / https のリンクだけです(ユーザー情報の付いた URL は出しません)。
- **最後のプロンプトの編集**: 最後のユーザーメッセージの「編集」で本文を入力欄に戻し、送信すると、そのメッセージ以降の回答とツールの記録が会話から消えて、編集した内容で送り直されます。ファイルの変更は戻りません(必要ならチェックポイントから戻します)。実行中は編集できません(通知で伝えます)。編集は待ち行列に入らず、すぐ送られます。

これらは拡張の機能で、サーバー側の対応(チェックポイント一覧・戻し・出典・最後のプロンプトの置き換え)が必要です。対応していないサーバーでは一覧が出ないだけで、チャットの他の機能は従来どおりです。

## OmniChat VS ビュー(拡張 0.2.0 以降)

左のアクティビティバーの **OmniChat VS** に、2 つのビューが出ます。

- **チャット**: 開いているフォルダの会話の一覧、会話の表示、モデル・承認モードの選択、送信と停止、ツールの実行状況、承認カード(今回だけ許可 / 拒否、保護バッジ、差分の表示)。承認待ちが出ると、このビューが前面に出ます。ステータスバーの OmniChat 表示を押してもここが開きます。
- **チャット(右のサイドバー、拡張 0.3.1 以降)**: 同じチャットを右のサイドバーに出せます。ビューのタイトルバーの「OmniChat: チャットを右のサイドバーで開く」(コマンドパレットにも)を押すと開きます。右のサイドバーは VS Code の機能で、拡張が右の「secondarySidebar」を登録します。古い VS Code で開けないときは案内が出るので、OmniChat VS のアイコンを右端にドラッグしてください。ヘッダーの「エディタで開く」「右へ移動」ボタンは削除しました(タイトルバーにあります)。3 つの表示は同じ会話・同じ状態を共有します。
- **設定**: サーバー URL、ペアリング(コードの貼り付け・解除)、ブリッジ名、テーマ(フロンティア(既定)/ シンプル / アストラル。0.2.3 以降)、装飾(auto / on / off)、編集後の自動保存、シェル、信頼の状態。トークンは表示されません(SecretStorage のみ)。

表示言語は VS Code の表示言語に従います(日本語 / English)。チャットを使うにはサーバー 0.5.4 以降が必要です。それより古いサーバーでも、ツールの利用は従来どおり動きます。

### VS Code 内チャットのフレーム(サーバー 0.5.4 以降)

拡張が `ready` で `capabilities.chat:true` と `capabilities.transcript:true` を送ったときだけ、サーバーは次のフレームを扱います(同じ `/bridge` の WS、1 接続あたり毎秒 30 フレームまで。超過分は破棄して `{"type":"error","code":"rate_limited"}`)。`capabilities.transcriptDelta:true` も送ると、実行中の本文を差分で受け取れます(下記)。

| 方向 | フレーム | 内容 |
|---|---|---|
| 拡張 → サーバー | `prompt` `{requestId, cwd, text(≤100 KB), conversationId?, model?("<providerId>::<modelId>"), approvalMode?, confirmFull?, searchMode?(`off`/`smart`/`always`), interrupt?(true)}` | 会話を探すか作り(ブリッジ名の `vscode-bridge` プロバイダーも自動作成)、アプリの `send` と同じ経路で実行。`searchMode` は会話に保存されます(省略時は今の値のまま、新しい会話は設定の既定)。`interrupt:true` は、その会話で実行中の生成を止め、終わるまで(最大 5 秒)待ってから送ります。不正な `searchMode` は `error {code:"invalid_frame", requestId}`。アプリや他の端末にも通常の WS で届きます |
| サーバー → 拡張 | `prompt_ack` `{requestId, ok, conversationId}` / `{ok:false, error, message}` | `error`: `workspace_not_open` `busy` `outdated` `untrusted_workspace` `forbidden_model` `quota` `no_model` `confirm_required` `not_found` `invalid_frame` |
| 拡張 → サーバー | `models_request` / `conversations_request {cwd}` / `conversation_request {conversationId}` | 返信は `models` `{items:[{ref,label,provider}], defaultRef?}`(ツール呼び出し可能な openai-compatible のモデル、200 件まで)、`conversations` `{items:[{id,title,updatedAt,approvalMode,searchMode,cwd}]}`(そのブリッジの Code 会話、新しい順、30 件まで。`searchMode` は `off`/`smart`/`always`、未設定は `smart`)、`transcript` `{reset:true, items}`(全履歴) |
| サーバー → 拡張 | `transcript` `{conversationId, runId?, items}` | 実行中、このブリッジのチャット対応ウィンドウ全部へ。項目は `user` / `assistant`(`status`: streaming/done/error/stopped)/ `tool`(`status`: pending/running/done/error/denied)/ `status`。同じ `id` の再送は全文の更新。毎秒 10 フレームまで。`tool` には `edit_file` / `write_file` の変更内容 `diff` `{path, added, removed, truncated?, lines}` が付きます(`lines` は `+` `-` か空白で始まり、最大 200 行、1 行 300 文字まで。拒否・失敗した呼び出しには付きません)。 |
| 拡張 → サーバー | `set_approval_mode {conversationId, mode, confirmFull?}` | 返信 `approval_mode {conversationId, mode, ok}`(`full` は `confirmFull:true` が無いと `error:"confirm_required"`) |
| 拡張 → サーバー | `stop {conversationId}` | アプリの停止と同じ |
| 拡張 → サーバー | `context_request {requestId, conversationId}` | 返信 `context {requestId, total, limit, fits, estimated, used, reasoning, last?}`(トークン数。`limit` は不明のとき 0。`used` は `{system, history, attachments, tools, input}`、`reasoning` は推論トークン、`last` は直近の完了したアシスタント返信の `{prompt, completion, reasoning}` で、無いか全て 0 のときは省略)。他人の会話や無い会話は `error {code:"not_found", requestId}` |
| 拡張 → サーバー | `prompt.attachments` `[{name, mime, data(base64)}]` | 4 件まで、1 件 4 MiB・合計 5 MiB まで(展開後)。文書は添付ストアの通常の規則でテキスト化。画像は png/jpeg/webp/gif で、実際のモデルが画像対応(vision)のときだけ(新しい 4 枚まで)。音声は不可。失敗は `prompt_ack` の `error`: `attachment_invalid` `attachment_too_large` `attachment_not_supported`(何も保存しません) |
| 拡張 → サーバー | `devices_request {requestId}` | 返信 `devices {requestId, items:[{name, kind:"vscode"\|"dsh", online, self, workspaces[]}]}`(接続中のブリッジのみ、50 件まで) |
| 拡張 → サーバー | `compact_request {requestId, conversationId}` | 返信 `compacted {requestId, conversationId, ok:true, before, after}`(トークン数)。実行中は `error {code:"busy"}`、他人の会話は `not_found` |
| サーバー → 拡張 | `models` の項目 | `contextLength?`(トークン)と `vision?`(`yes`/`no`/`unknown`)が加わります |

`transcriptDelta:true` の拡張には、実行中(`status: streaming`)の `assistant` を差分で送ります。最初のフレームと、最後のフレーム(`status` が streaming 以外)、`transcript` の全履歴は全文です。差分には `from`(受け取った側の現在の `text` の長さ、UTF-16 単位)が付き、`text` はその後ろに足す部分だけです。`reasoning` が変わったときは `reasoningFrom` 付きの `reasoning` 差分も入ります。`from` が現在の長さと一致しない、または項目が分からないときは、状態を保ったまま `conversation_request` で再同期を要求してください。`from` の無いフレームは従来どおり全文で置き換えます。

承認待ちの間、`tool` 項目は `pending` のままで、従来の `approval_pending` / `approval_settled` / `approval_decision` もそのまま使えます。

### チャットの設定・検索・スラッシュコマンド(拡張 0.4.0 / サーバー 0.5.6-d 以降)

| 方向 | フレーム | 内容 |
|---|---|---|
| 拡張 → サーバー | `conversation_settings_request {requestId, conversationId}` | 返信 `conversation_settings {requestId, conversationId, title, systemPrompt, systemMode, effort}`(`effort` は `off`/`low`/`medium`/`high`/`max` か `null` = 既定)。失敗は `error {requestId}`(`not_found`) |
| 拡張 → サーバー | `conversation_settings_set {requestId, conversationId, systemPrompt?, systemMode?, effort?, title?}` | 省いた項目は今の値のまま。返信 `conversation_settings_ack {requestId, conversationId, ok, settings?, title?}`、失敗は `ok:false` と `error`(`invalid_frame` `not_found`)。空のシステムプロンプトは保存しません。題名は 1〜200 字 |
| 拡張 → サーバー | `history_search_request {requestId, query, limit?}` | 返信 `history_search {requestId, query, results}`(最大 30 件)。この端末の Code 会話だけ。`results` は `{conversationId, title, messageId?, role?, snippet, at}` |

拡張の動き: 設定は会話を開いたときに取り直し、保存後にも取り直します。検索は新しいものだけを採用します。検索結果を押すと、その会話を開き、一致した項目へスクロールします(読み込み後、項目が無ければ何もしません)。

スラッシュコマンド(拡張 0.4.0 で追加・変更):

| コマンド | 内容 |
|---|---|
| `/effort <off\|low\|medium\|high\|max\|default>` | この会話の思考の強さを変えます。引数が無い・不正なら案内を出します |
| `/rename <題名>` | 会話の題名を変えます(引数が無ければ案内) |
| `/export` / `/export json` | 会話を Markdown、または JSON で開きます。JSON は `{title, conversationId, exportedAt, items:[{kind, id, text \| tool+summary, status?, at?}]}` で、トークン・鍵・作業フォルダ・端末名は含みません |

Webview → 拡張のメッセージ: `requestSettings` / `saveSettings {systemPrompt, systemMode, effort}` / `setEffort {effort}` / `searchHistory {query}`(200 字まで)/ `openHit {conversationId, messageId?}`。`slash` は `arg`(2000 字まで)を持てます。拡張 → Webview: `scrollToMessage {id}`。

### テーマ(拡張 0.2.3 以降)

- **フロンティア**(既定): アプリのフロンティアの見た目。角の四角いパネル(角に括弧)、メッセージの左 3px の帯、大文字の `//` 見出し、反転したタグ、斜線の背景。フォントは Syncopate と Space Grotesk(拡張に同梱)。
- **シンプル**: 0.2.2 までの見た目(丸いカード、装飾なし)。以前 `simple` を選んだ人はそのまま残ります。
- **アストラル**: シンプルの形でアストラルの色。
- 装飾(角の括弧、帯、斜線)は、ハイコントラスト、`omnichat.decorations` が `off`、視差や動きを減らす設定、狭い表示では出ません。
- 設定の変更は開いているビューにすぐ反映されます。`omnichat.theme` が未設定、または不明な値なら、フロンティアになります。

スキンの CSS は `media/webview/skin-frontier*.css` です。`:root[data-oc-theme="frontier"]` の下に層として書かれており、シンプルとアストラルでは効きません。

### フォントと文字の役割(拡張 0.2.4 以降)

アプリ(`app/src/themes/*.ts`、`app/src/fonts.ts`、`app/src/ui/skin.tsx`)と同じ書体・同じウェイトを使います。ファイルは `media/fonts/` に同梱(WOFF2、`@fontsource/*` 由来。アプリの `@expo-google-fonts/*` と同じ書体)。`src/ui/html.ts` の `FONT_FACES` が、テーマごとに実ウェイトで `@font-face` を登録します。太字は本物の太字フェイスで描画され(`font-synthesis: style` で太字の疑似生成は無効)、斜体だけは、斜体を持たない書体でブラウザが擬似生成します。

| 役割 | フロンティア | アストラル | シンプル |
|---|---|---|---|
| 本文(標準 / 太字) | Space Grotesk 400 / 700 | Zen Maru Gothic 400 / 700 | システムフォント |
| 見出し(`--oc-font-head`) | Syncopate 400 / 700(日本語は本文書体) | Marcellus 400(日本語は Zen Maru Gothic) | システムフォント |
| ラベル(`--oc-font-label`) | Space Grotesk 500 / 700、大文字、字間 1.2px | Outfit 400 / 600、字間 0.6px | システムフォント |
| 行間の加算(`--oc-lh-boost`) | +0.10 | +0.08 | 0 |
| コード(`--oc-font-mono`) | `monospace`(アプリの Web 版と同じ) | 同左 | 同左 |

トークンは `scripts/lib/tokens-core.mjs` がアプリのテーマから生成します(`--oc-font-*`、`--oc-label-w` / `-wb` / `-case` / `-tracking`、`--oc-lh-boost`)。Markdown の見出しは全テーマで本文書体の太字です(フロンティアは左に 4px のアクセントの帯、アストラルは下に細い線)。ボタンは本文書体の太字(大文字にしません)。Zen Maru Gothic は日本語の大きなファイルに、小さなラテン文字用ファイルを `unicode-range` で重ねています。

### UI の作り(拡張 0.2.2 以降)

チャットは、アプリの見た目に寄せるために、アプリのコードを共有して作り直しました。決めたことと理由:

- **採用: アプリの純粋なモジュールを webview にバンドルする。** esbuild の別名 `@app` で `app/src/components/markdownParse.ts`(Markdown のパーサー。アプリの `Markdown.tsx` から切り出した、React を使わない部分)と `app/src/components/highlight.ts`(コードの色分け)をそのまま使います。色・角丸・フォントは従来どおり `app/src/themes` から生成するトークン(`media/generated/tokens.css`)です。描画(吹き出し、コードブロックとコピー、考え中ブロック、ツールカード、承認カード、入力欄、ロゴの送信ボタン、履歴の引き出し、モデル / 承認モードのピッカー)は DOM で組み直しています。
- **不採用: サーバーの Web アプリを iframe で埋め込む。** webview の CSP(`default-src 'none'`)、混在コンテンツ、認証(トークンを URL に載せない)の制約で動く保証がなく、VS Code 無しでは検証できないため。
- **不採用: アプリの React Native コードをそのまま動かす。** react-native-web 一式で拡張が大きくなり、CSP や VS Code のテーマとも噛み合わないため。
- 安全面: モデルの文章は信頼しません。Markdown は HTML に直す前にすべてエスケープし、リンクは `http:` / `https:` / `vscode:` のみ(`rel="noopener noreferrer"`)、画像は読み込まず(CSP)リンクとして表示します。6 万文字を超える分は Markdown にせずプレーンテキストで表示します。
- 出ない物: 出典リストと速度表示(TTFT / tok/s)は、VS Code 用のトランスクリプトに含まれないため出ません。

## 制限

- エージェントは 1 回の送信につき最大 **50 ラウンド**(環境変数 `OMNICHAT_CODE_MAX_ROUNDS`、最大 200)と **30 分**で止まります。止まったときは理由が回答に出ます。「続けて」と送ると続けられます。
- コンテキストの 70% を超えると、古いツール結果は 1 行の要約に置き換えられます。
- ツールは `read_file` `list_dir` `glob` `grep` `write_file` `edit_file` `run_command` `get_diagnostics` `git_status` `git_diff` `git_log` `git_commit` の 12 個です。`run_command` は標準入力が閉じられた非対話実行で、出力は切り詰められます。amend・`--no-verify`・push はありません。
- 会話は一本道です(分岐・再生成・一時チャットは使えません)。添付は文書(テキスト)のみです。
- Workspace Trust されていないフォルダでは実行できません(読み取り専用の扱いです)。

## 互換性

| サーバー | VS Code 拡張 | ワイヤ(protocol) |
|---|---|---|
| 0.5.4 以降 | 0.1.0 以降(ツールのみ) | 1 |
| 0.5.4 以降 | 0.2.0 以降(チャット・設定ビュー)。ペアリングの http 対応は 0.2.1 以降。アプリ風 UI・履歴・タイムアウトは 0.2.2 以降。フロンティアのスキン(既定)とテーマ選択は 0.2.3 以降。アプリと同じフォント(全ウェイト)と文字の役割は 0.2.4 以降 | 1 |

サーバーの `welcome` は `features:["chat"]` を返します(この変更を含むサーバー版から)。拡張 0.2.2 は、`features` があればそれで、無ければ `serverVersion` が 0.5.4 以降かどうかでチャット対応を判定し、未対応なら「このサーバーは VS Code のチャットに未対応です…」と表示します。チャットの各リクエスト(送信・モデル・会話一覧・履歴)は 10 秒(送信の確認は 15 秒)で打ち切られ、エラーを表示して送信ボタンが元に戻ります。

サーバーは拡張が古いと実行を拒否し(`VS Code extension x.y.z is outdated`)、`GET /bridges` の `compat.ok` が false になります。拡張も、サーバーが古いと通知します。

## セキュリティ

- 保護リストと許可リストは**安全網であって、サンドボックスではありません**。信頼できないリポジトリでは、VS Code の Workspace Trust を使い、承認モードは手動のままにしてください。フルアクセスは、自分のコードで、チェックポイントを前提に使うものです。
- ツールの結果(ファイルの中身、コマンド出力)はモデルに渡され、モデルのプロバイダーに送られます。秘密情報の読み取りが保護項目になっているのはそのためです。
- AI は、ツールの結果の中に書かれた指示には従わないよう指示されていますが、完全ではありません。見知らぬリポジトリの扱いには注意してください。
- トークンは SecretStorage に保存され、拡張はテレメトリを送りません。
