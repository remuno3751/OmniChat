# 設計: Code 側の HTML / CSS / JavaScript のプレビュー

状態: 段階 1(簡易版)は実装中、段階 2(本物版)は設計。2026-10-19。

## 目的
Code(PC 上の DSH にコードを書かせる機能)で、DSH が作った Web ページ(HTML / CSS / JavaScript)を、アプリの中で見られるようにする。

## 段階 1: 簡易版(新しい権限なし)
- 材料: Code のメッセージの `changes`(ファイルごとの差分)。新規ファイルは全文、編集は差分のハンク。
- 会話の古い順に差分を適用して、最新のファイルを**再現**する(`app/src/codePreview.ts`)。再現できない編集(元の内容を知らない、文脈が合わない)は `stale` と表示する。
- HTML に CSS・JS・SVG を**組み込んで 1 枚のページ**にし、隔離した枠で表示する。
- 隔離: Web は `<iframe sandbox="allow-scripts">`(`allow-same-origin` なし = 親のデータ・Cookie に触れない)、ネイティブは `WebView`(ネットワークと遷移を止める)。ページの先頭に **CSP** を入れ、既定では**外部への通信をすべて止める**(生成された JS が、データを外へ送れない)。CDN のライブラリを使いたいときは、画面で「外部ライブラリを許可」を ON にする(既定 OFF、注意文つき)。
- 限界: DSH が既存ファイルを部分編集した場合や、画像などのバイナリは、再現できないことがある。

## 段階 2: 本物版(PC のフォルダを読み取り専用で読む)
サーバーが、ブリッジ経由で、**作業フォルダの中のファイルを読み取り専用で取得**する。段階 1 の限界(部分編集、画像、編集のたびの追従)がなくなる。

### 信頼の境界と既定
- **ブリッジ(ユーザーの PC)が、最後の門番**。サーバーを信用せず、ブリッジ側で、すべての制限を強制する。
- **既定は OFF**。ブリッジを起動するとき、明示的に有効にする(デーモン型: `--allow-preview-fs`、プラグイン型: 設定 `previewFs: true`)。OFF のブリッジは、`fs` の要求を `{ ok:false, error:"preview is disabled on this bridge" }` で拒否し、`capabilities` に `fs` を出さない。
- 理由: 家族や友人と 1 台のサーバーを共有するとき、サーバーの管理者が、各自の PC のファイルを読めてしまうことを、**本人が選んだときだけ**許す。

### プロトコル(`BRIDGE-v2.md` の `rewind` と同じ、要求と応答のペア)
- ブリッジ → サーバー: `ready`(と、再接続時)に `capabilities?: { fs?: boolean }` を足す。
- サーバー → ブリッジ: `{ type: "fs", requestId, cwd, op: "list" | "read", path: string, maxBytes?: number }`。
- ブリッジ → サーバー: `{ type: "fs_result", requestId, ok: boolean, error?, entries?: [{ name, kind: "file"|"dir", size }], content?: string /*base64*/, size?: number, mime?: string, truncated?: boolean }`。
- `cwd` は、ブリッジの作業フォルダと一致しなければ拒否(`rewind` と同じ)。実行中(`run` の最中)でも読める(読み取りだけなので)。

### ブリッジ側の制限(必須)
- **作業フォルダの外は読まない**: パスは作業フォルダからの相対。`..`、絶対パス、ドライブ文字、UNC、`\\?\` を拒否。解決後(`realpath`)に、作業フォルダの中であることを確認する(シンボリックリンクで外に出るものは拒否。Windows は大文字小文字を無視して比較)。
- **読み取り専用**: 書き込み・削除・実行の操作は存在しない。
- **隠しファイルと秘密の拒否**: 名前が `.` で始まる(`.git`、`.env*`、`.ssh`、`.aws` など)、`node_modules` の中、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.keystore`、`id_rsa*`、`id_ed25519*`、`*credentials*`、`*secret*`(名前)は、一覧にも出さず、読ませない。
- **種類の許可リスト**(read): html、htm、css、js、mjs、json、svg、txt、md、csv、xml、png、jpg、jpeg、gif、webp、ico、woff、woff2、ttf、otf、mp3、wav、ogg、mp4、webm。ほかは拒否。
- **サイズ**: 1 回の read は 3MB まで(`maxBytes` で下げられる。超えたら `truncated: true` と先頭だけ)。list は 2000 件まで。
- **速度**: 1 秒に 20 要求まで。同時に 4 つまで。
- ログには、パスと結果の種類だけ(中身は出さない)。

### サーバー側
- `GET /code/preview/tree?conversationId=<id>&path=<dir>`: `{ entries }`。`GET /code/preview/file?conversationId=<id>&path=<file>`: ファイルのバイト列(`Content-Type` は拡張子から。`X-Content-Type-Options: nosniff`)。
- 検査: 認証済みのユーザーの、Code モードの会話であること。その会話に紐づくブリッジ(そのユーザーのもの)が、`fs` を有効にしていること。無ければ `409 { code: "preview_unavailable" }`。パスの形(`..` など)は、サーバーでも先に拒否。タイムアウト 10 秒。1 ユーザーあたりのレート制限。
- メンテナンスモード中でも、読み取りなので止めない。共有プロバイダー・モデル許可とは無関係。
- **実装(段階 2 サーバー部)**: `server/src/code-preview.ts`(パス検査 `safeRelPath`、会話からブリッジを決める `resolveConversationBridge`、Content-Type、レート制限)、`server/src/routes-code-preview.ts`(ルート)、`server/src/bridges.ts`(`requestFs` と `fs_result` の処理、ready の `capabilities`)。
- **ルート**(すべて認証が必要。`Authorization: Bearer`):
  - `GET /code/preview/status?conversationId=` → `{ available: true }` または `{ available: false, reason }`。
  - `GET /code/preview/tree?conversationId=&path=` → `{ entries: [{ name, kind: "file"|"dir", size }] }`。`path` 省略はフォルダ自身。隠し名と `node_modules` は、ブリッジが返しても落とす。
  - `GET /code/preview/file?conversationId=&path=&maxBytes=` → ファイルのバイト列。`maxBytes` は 1 以上、3MB 以下に丸める(既定 3MB。範囲外・不正は 400)。ヘッダー: `Content-Type`(拡張子から。拡張子が表にない場合だけ、ブリッジの `mime` を許可リストの種類で採用し、それ以外は `application/octet-stream`)、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、`Cache-Control: no-store`、`truncated` のときだけ `X-Truncated: 1`。`Content-Disposition` は付けない(本文は `fetch` でバイト列として読む)。
  - 共通の失敗の形: `{ error, code }`。`409 { code: "preview_unavailable", reason }`、`400 { code: "bad_path" | "bad_max_bytes" }`、`404`(他人・存在しない会話)、`413 { code: "too_large" }`、`429 { code: "rate_limited" }`(1 ユーザー 20 要求まで、毎秒 20 回補充)、`502 { code: "bridge_error" }`(ブリッジが報告した失敗。`error` はブリッジの文)、`504 { code: "timeout" }`。
  - `reason` の値: `not_code`(Code モードでない)、`no_bridge`(dsh-bridge のプロバイダーでない)、`bridge_offline`(接続されていない、または途中で切れた)、`fs_disabled`(ブリッジが `capabilities.fs` を出していない)。
- **二重の門**: サーバーは、パスの形を先に検査し、拒否したものはブリッジへ送らない(`..`、絶対パス、`\`、`:`、ドライブ文字、UNC、制御文字、`.` 始まりのセグメント、`node_modules`、空のセグメント、500 字超)。`fs_result` の `content` は base64 で 4MB(文字列の長さ)を超えたら拒否(`too_large`)。タイムアウトは 10 秒(テストでは `OMNICHAT_FS_TIMEOUT_MS` で短くできる)。

### クライアント
- 段階 1 のプレビューを拡張する: サーバーが使える(`409` でない)なら、入口の HTML を取り、`<link>` `<script>` `<img>` などの相対参照を、**必要になった順に取得して組み込む**(同じ組み立ての関数を使う)。画像は `data:` URL に。
- 画面に「PC 上のファイル(最新)/ 変更記録から再現」の表示。使えない理由(ブリッジが無効、オフライン)も出す。
- 「再読み込み」で取り直す。DSH が実行中でも読める。

## テスト
- ブリッジ: パス検査(`..`、絶対パス、シンボリックリンク、Windows の大文字小文字、UNC)、隠し・秘密ファイル、許可リスト、サイズ・件数の上限、レート制限、無効時の拒否。
- サーバー: 認可(他人の会話、Code でない会話、ブリッジなし)、パスの拒否、タイムアウト、応答の形。
- 統合: 偽の DSH(`bridge/src/fake-dsh.mjs`)を使って、実際に作らせたファイルを、サーバー経由で取得する。

## 工数の目安
ブリッジ(デーモン + プラグイン)1〜1.5 日、サーバー 0.5〜1 日、クライアント 1 日。
