# @omnichat/dsh-bridge — DeepSeek Harness(dsh)プラグイン版 OmniChat ブリッジ

dsh の**プロセス内で動く**プラグインです。OmniChat のアプリから、稼働中の dsh セッションを操作できます。dsh の GUI で入力した発言・応答もリアルタイムで OmniChat に反映されます。接続の仕方は 2 通りあります。既定はローカルモードです。

```
[ローカルモード(既定)]
dsh プロセス内: このプラグイン(127.0.0.1:19401 で待ち受け)
   ⇅ ローカル WebSocket(ペアリングコードで認証)
OmniChat アプリ(Web タブ / デスクトップ版。フレームを中継)
   ⇅ WebSocket /bridge(ユーザーのログイン)
OmniChat サーバー

[リモートモード]
OmniChat アプリ ⇄ OmniChat サーバー ⇐(外向き WS)= [dsh プロセス内: このプラグイン] ⇄ sessionController(同一プロセス)
```

- **ローカルモード**: PC に入ってくるポートはなく、サーバー用のトークンも環境変数に置きません。中継は、アプリが開いてログインしている間だけ動きます。
- **リモートモード**: プラグインが PC からサーバーへ直接接続します。アプリを開いていなくても動きます。ヘッドレスの PC 向けです。
- サーバー側は**無改修**です(`BRIDGE.md` / `BRIDGE-v2.md` と同じワイヤプロトコルを話します)。アプリ側は、設定画面のプリセット「DeepSeek Harness (PC bridge)」でプロバイダーを作り、`baseUrl` にブリッジの名前を入れます。
- 実行時依存ゼロ(Node 組み込みの `WebSocket` / `fetch` のみ)、ビルド不要の ESM です。`npm pack` の成果物がそのまま入ります。
- 動作確認: 下記「検証の状況」を参照してください。実 dsh でのローカルモードは未検証です。

## 従来のデーモン型ブリッジ(`bridge/`)との違い

| | デーモン(`bridge/`) | プラグイン(ローカル・既定) | プラグイン(リモート) |
|---|---|---|---|
| 実行形態 | 別プロセス。`dsh headless` を都度 spawn | dsh プロセス内。spawn しない | dsh プロセス内。spawn しない |
| 接続の向き | PC → サーバー | アプリ → PC(127.0.0.1)、アプリ → サーバー | PC → サーバー |
| GUI で入力した内容の反映 | zstd セッションログを 1.5 秒ごとに監視 | `session/event` を購読(リアルタイム、ログ解析なし) | 同左 |
| 実行中判定 | ログの更新時刻(3 秒ヒューリスティック) | dsh のエージェント状態で正確に判定 | 同左 |
| 承認(ツール実行) | headless は承認なしで実行 | dsh の承認ポリシー(`approvals` で選ぶ) | 同左 |
| モデル一覧 | `cordis.patch.yml` を読み取る | `modelCatalog()`(設定ファイルに触れない) | 同左 |
| 対象 | `dsh headless` が動く環境 | `web` / `desktop` プロファイル(`sessionController` が必要) | 同左 |

**同じ `--name`(`name`)でデーモンとプラグインを同時に動かさないでください。** サーバーは (ユーザー, name) ごとに 1 接続で、新しい接続が古い接続を置き換えます。デーモンは止めるか、別の name にしてください。`desktop` と `web` の両方に入れる場合も name は別にします。

## インストール(別の PC でも同じ手順)

前提: その PC に dsh(DeepSeek Harness)がインストール済みで、`dsh` コマンド(例: `C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`)が使えること。

### 1. パッケージを作る(開発 PC)

```bash
cd dsh-plugin
npm install      # テスト用の devDependency(ws)のみ。実行時依存はなし
npm test         # 任意: ユニットテスト
npm pack         # -> omnichat-dsh-bridge-0.5.0.tgz
```

できた `.tgz` を対象 PC にコピーします(npm への公開は不要)。

### 2. プロファイルに入れる

**絶対パス**で指定します(相対パスは不可)。

```powershell
# desktop プロファイル(dsh デスクトップアプリ)— GUI を完全に終了してから実行
dsh plugin --profile desktop add C:\path\to\omnichat-dsh-bridge-0.5.0.tgz

# web プロファイル(ブラウザ UI。常駐運用向き)
dsh plugin --profile web add C:\path\to\omnichat-dsh-bridge-0.5.0.tgz
```

- `desktop` は一度 GUI を起動して初期化済みで、かつ **GUI(トレイ常駐も含む)を完全終了**している必要があります。
- パッケージが `dsh.bundle.patch` を宣言しているため、`dsh.profile.bundles` への追加と既定設定の挿入は自動で行われます。
- `@deepseek-ai/dsh*` の peer 依存は宣言していません。dsh のバージョンゲートで黙ってスキップされることはありません(代わりに、内部 API が変わると起動時に `[omnichat] disabled: ... lacks ...` と 1 回警告してプラグインは何もしません)。
- 更新: 新しい `.tgz` で `dsh plugin --profile <name> remove @omnichat/dsh-bridge` のあと `add` し直します。
- 削除: `dsh plugin --profile <name> remove @omnichat/dsh-bridge`。

### 3. 設定する

### ローカルモード(既定)

環境変数は**不要**です。`OMNICHAT_SERVER_URL` を設定しないでください(設定すると remote になります)。ペアリングは §「ペアリング」を参照してください。

設定を変える場合は、プロファイルの `cordis.patch.yml`(`%USERPROFILE%\.dsh\profiles\<name>\cordis.patch.yml`。バンドル既定とマージされます)に書きます。

```yaml
- id: omnichat-bridge
  config:
    name: my-pc
    listenPort: 19401     # 既定のまま。変えるなら環境変数 OMNICHAT_LOCAL_PORT でも可
    mirror: true          # GUI の会話を OmniChat に反映(既定 true)
    mirrorScope: all      # all | cwd
    approvals: gui        # remote | gui | deny(同梱の既定は gui)
```

### リモートモード

環境変数(推奨。トークンを YAML に書かないため)。`OMNICHAT_SERVER_URL` が設定されていると remote になります(`OMNICHAT_MODE=remote` でも可)。

| 変数 | 意味 |
|---|---|
| `OMNICHAT_SERVER_URL` | OmniChat サーバー。`http://host:8787` / `https://chat.example.com`(`ws(s)://` に自動変換)。必須 |
| `OMNICHAT_TOKEN` | OmniChat のログイントークン(アプリと同じ)。または下の 2 つ |
| `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` | `POST /auth/login` でログイン(失敗時は再試行) |
| `OMNICHAT_NAME` | ブリッジ名(既定: ホスト名)。アプリのプロバイダーの `baseUrl` と一致させる |
| `OMNICHAT_CWD` | プラグインが新規作成するセッションの作業フォルダ(既定: dsh の既定ワークスペース) |

プロファイルの設定の上書き:

```yaml
- id: omnichat-bridge
  config:
    mode: remote
    name: my-pc
    mirror: true
    mirrorScope: all
    approvals: remote     # remote | gui | deny
    approvalTimeoutMs: 600000
```

### 設定項目

| キー | 既定 | 環境変数 | 意味 |
|---|---|---|---|
| `mode` | `local` | `OMNICHAT_MODE` | `local` または `remote`。`OMNICHAT_MODE` も `OMNICHAT_SERVER_URL` も無ければ local(同梱の patch の場合) |
| `listenPort` | `19401` | `OMNICHAT_LOCAL_PORT` | ローカルモード: `127.0.0.1` と `::1` で待ち受けるポート |
| `allowedOrigins` | 空 | — | ローカルモード: 追加で許可するブラウザの Origin(通常は初回ペアリングで自動追加) |
| `pairingFile` | `<DSH_HOME>/omnichat-bridge.json` | — | ローカルモード: ペアリング情報の保存先 |
| `serverUrl` | — | `OMNICHAT_SERVER_URL` | リモートモード: 必須 |
| `token` または `username` + `password` | — | `OMNICHAT_TOKEN` / `OMNICHAT_USERNAME` + `OMNICHAT_PASSWORD` | リモートモード: 認証 |
| `name` | ホスト名 | `OMNICHAT_NAME` | ブリッジ名 |
| `cwd` | dsh の既定 | `OMNICHAT_CWD` | 新規セッションの作業フォルダ |
| `mirror` / `mirrorScope` | `true` / `all` | — | GUI の会話の反映。`all` または `cwd` |
| `approvals` / `approvalTimeoutMs` | コードの既定 `remote` / `600000` | — | 承認の扱い(同梱の cordis.patch.yml の既定は `gui`) |
| `allowAnyCwd` | `false` | — | OmniChat が新しいチャットで指定した作業フォルダを、知っているフォルダ(`cwd`・GUI のセッション・過去の実行)以外にも許す。既定は許さない。相対パス・`..`・制御文字は、設定に関わらず拒否 |
| `previewFs` | `false` | `OMNICHAT_BRIDGE_PREVIEW_FS` | リモートモードのみ: Code のプレビュー用に、作業フォルダのファイルの読み取りを許可する。下の「プレビュー用のファイル読み取り」を参照 |

ローカルモードでは `serverUrl` / `token` / `username` / `password` は使われず、設定されていると警告が出ます。不明なキーは警告のうえ無視されます。設定が不正な場合は理由を `[omnichat] disabled: invalid configuration: ...` と 1 行ログに出し、プラグインは何もしません(dsh は落ちません)。ログは dsh ホストの標準エラー(`dsh web` を起動した端末 / デスクトップのホストログ)に `[omnichat]` 付きで出ます。

## ペアリング(ローカルモード)

### A. dsh で承認する(0.4.0 以降、推奨)

1. OmniChat の設定 → プラグイン → DeepSeek Harness で **Connect** を押します(コード入力は不要)。
2. dsh の GUI の プラグイン → OmniChat のページ上部に「OmniChat (origin) wants to connect」のバナーが出ます。**Allow** で接続、**Deny** で拒否です。リクエストは 120 秒で期限切れになります。
3. 許可すると、そのアプリの Origin が `allowedOrigins` に保存され、ペアリングコードが**承認された接続にだけ**届きます。アプリはそれを保存し、新しいソケットで通常の `hello` を送ります。次回からは承認なしで再接続します。

ワイヤーフォーマット(JSON テキストフレーム):

- アプリ → プラグイン(最初のフレーム): `{type:"hello", client:"omnichat-app", version, pairRequest:true, clientName}`(`pairing` なし)
- プラグイン → アプリ: `{type:"pair-pending", requestId, expiresInSec}`。待機中はソケットを開いたままにします。
- 承認: `{type:"pair-approved", pairing}` を送って 1000 で切断します。同じソケットは認証済みにならず、アプリは**新しいソケット**で通常の `hello` を送ります。
- 拒否・期限切れ・コード再生成による無効化: `{type:"pair-denied", reason:"denied"|"expired"|"invalidated"}` を送って **4002** で切断します。
- 保留が多すぎる(同じ Origin に 1 件、全体で 3 件まで)場合は 4003、Origin が不正な場合は 4403 で切断します。
- 申請できる Origin は `http(s)://localhost` / `127.0.0.1` / `[::1]`(任意のポート)と Tauri の Origin だけです。Origin が無い、またはその他の場合は 4403。LAN / Tailscale のホスト名から開いたページは、下の手動のコードを使います。
- 拒否と期限切れは失敗として数え、5 回で 60 秒の 4429 ロックアウトになります。待機中にアプリが切断すると、リクエストは取り消されます。コードを再生成すると、保留中のリクエストはすべて無効になります。
- 設定ページの Remote `omnichatbridge`: `getState()` に `pending:[{id,origin,clientName,createdAt,expiresAt,expiresInSec}]` が加わり、`approve(id)` / `deny(id)` が追加されました(未知の id はエラー `omnichatbridge/unknown-request`)。

### B. コードを手入力する(手動のフォールバック)

1. 初回の起動で、32 バイト(base64url)のペアリングコードを作り、`<DSH_HOME>/omnichat-bridge.json` に保存します。`DSH_HOME` 未設定なら `~/.dsh` です。ファイルの権限は 600(対応している OS)です。
2. まだペアリングされていない間は、起動のたびにログに `OmniChat pairing code: <コード>` と出ます。
3. コードを確認するには、dsh のログを見るか、次のコマンドを使います(`--json` は機械向けの出力です)。

   ```bash
   node dist/pair.js [--home <dir>] [--file <path>] [--json]
   ```

   `dist/pair.js` は tgz に入っています(外部依存なし)。コード、`ws://127.0.0.1:<port>/omnichat-bridge`、ファイルのパスを表示します。
4. アプリにコードを貼ります(設定 → プラグイン → DeepSeek Harness のカード。詳細は `docs/DSH.md` §4.9)。
5. 初回の接続で、アプリは `pair: true` を付けて `hello` を送ります。正しいコードであれば、ブラウザの Origin が `allowedOrigins` に保存されます。

コードは**秘密情報**です。コードを持っていて、その PC で動いている人は dsh を操作できます。ペアリングファイルを削除したり壊したりすると、次の起動で新しいコードが作られ、以前のペアリングは無効になります。

## 起動と確認

### ローカルモード

```powershell
dsh web --no-open --port 8123
```

起動ログに `[omnichat] plugin loaded (local mode, 127.0.0.1:19401, name 'my-pc', ...)` と `listening for OmniChat on 127.0.0.1:19401` が出ます。アプリで接続すると `OmniChat app authenticated` が出ます。アプリで dsh プロバイダー(`baseUrl` = `my-pc`)の会話にメッセージを送ってください。

### リモートモード

```powershell
$env:OMNICHAT_SERVER_URL = 'http://192.168.1.10:8787'
$env:OMNICHAT_TOKEN = '<token>'
$env:OMNICHAT_NAME = 'my-pc'
dsh web --no-open --port 8123
```

起動ログに `[omnichat] connected as 'my-pc'` が出て、サーバーの `GET /bridges` に `online:true` で現れれば成功です。

動作確認用スクリプト(アプリ役として REST/WS で送信、継続、Stop、モデル選択、ツール表示を確認。サーバー経由の接続で使います): `SERVER=... TOKEN=... BRIDGE=my-pc node scripts/live-check.mjs [chat,continue,stop,model,tool,wait-mirror]`。

## 動作

### ローカルモード

- **ペアリング(hello)**: 最初のフレームは `{type:"hello", pairing, client, version}` です(§セキュリティ)。認証に成功すると、プラグインは `ready` を返します。`ready` には `mode: "local"`、`version`、`instance`、`seq` が付きます。
- **切断とバッファ**: アプリが切れても run は続きます。プラグインは 60 秒・2 MB までフレームを保持し、次の認証の後に送り直します。`resume`(`instance` と `sinceSeq`)が有効ならその続きから送ります。無効なら最後に届けた位置から送ります(ベストエフォート)。`ready` / `models` / `sessions` は保持せず、接続のたびに作り直します。
- **中継**: アプリは PC 側とサーバー側の接続を、指数バックオフ(1〜30 秒)で再接続します。サーバー側が切れたら、PC 側のローカル接続も切って、プラグインに `ready` を送り直させます。

### リモートモード

- **接続**: `ws(s)://<server>/bridge?token=…&name=…` に外向き接続。指数バックオフ(1〜30 秒)で再接続し、再接続のたびに `ready`(cwd・dsh バージョン・モデル一覧・既定モデル)と、GUI 会話の `full:true` スナップショットを送ります。

### 共通

- **run**: `sessionId` が null なら新規セッションを作成(`cwd` 設定の場所)。`model`(`provider::id`)があればそのターンのモデルを選択します(dsh の `selectModel` は GUI の既定モデルも上書きするため、直後に元の既定へ戻します)。続けて `sessionController.prompt()` で投入し、dsh のイベントを従来の NDJSON 互換イベント(`session` / `status` / `text` / `thinking` / `tool_call` / `tool_result` / `final`)と 1 回の `done` に変換して送ります。
- **キャンセル**: `cancel` → `sessionController.cancel()`、`done ok:false error:'cancelled'`。
- **排他**: そのセッションが GUI などで実行中なら `done ok:false error:'session busy in dsh'`。
- **GUI 同期**: 自分の run に属さない全イベント(GUI で入力したユーザー発言、アシスタントのストリーミング、ツール呼び出し、ターン終了)を `sessions` フレーム(`full:false` の差分。キー `u:<turn>:<k>` / `a:<turn>`、ステータス streaming/done/error/stopped)で送ります。接続時は直近 30 セッション(各 300 メッセージまで)を `full:true` で送ります。
- **モデル一覧**: 変更時と 30 秒ごとに再送します。

## セキュリティ

- **プラグインは dsh と同じプロセスで、ユーザーの OS 権限のまま動きます**(dsh のプラグインに権限制御やサンドボックスはありません)。信頼できるパッケージだけを入れてください。このパッケージは依存ゼロで、ソースは `dist/` の数ファイルだけです。
- **OmniChat のアカウントを持つ人は、この dsh を操作できます**(シェル・ファイル操作を含むエージェントの実行)。強いパスワード、HTTPS(リバースプロキシ)、専用の作業フォルダ(`cwd`)を使い、サーバー/トークンの管理を厳重にしてください。

### ローカルモード

- **待ち受けは `127.0.0.1` と `::1` だけ**です(`0.0.0.0` には bind しません)。
- **Host ヘッダー**は、ループバックのアドレスと待ち受けポートの組み(`127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`)だけを受け付けます(DNS リバインディングの対策)。
- **Origin の許可リスト**: 既定で `tauri://localhost`、`http://tauri.localhost`、`https://tauri.localhost`。それ以外のブラウザの Origin は、初回のペアリング(`pair: true` とコード)で追加されたものだけが通ります。Origin が無いクライアントは、コードが必須です。
- **ペアリングコード**: 最初のフレームで照合します。ミスマッチ時は 2 秒後に 4401 で切断し、失敗を数えます。5 回失敗すると 60 秒間、新しい接続を 4429 で拒否します。
- **接続の拒否**: 最初のフレームが `hello` でない、または 10 秒 `hello` が来ない場合は拒否(失敗として数える)。Origin が許可されておらず `pair: true` も無い場合は、即座に 4403 で切断します(失敗には数えません)。
- **同時に 1 クライアントだけ**: 新しく認証されたクライアントが古いものを置き換え、古い方は 4000 で切断されます。

### 共通

- **承認** (`approvals`): 既定の `remote` は、OmniChat から始めた run の承認要求(`approval/request`)を `{type:"approval", requestId, approvalId, tool, command?, path?, reason?}` としてサーバーへ転送し、`approval_reply`(`allowed-once` / `rejected`)で答えます。`command` / `path` は同じツール呼び出しの引数から取ります。サーバーが答えない場合は `approvalTimeoutMs`(既定 10 分)で拒否、接続が切れたときも拒否です。OmniChat から始めていないセッション(dsh の GUI で始めたもの)の承認は `next()` で dsh/GUI に渡します。`gui` は何もしない(従来どおり dsh のポリシーと GUI に任せる)、`deny` は OmniChat の run の承認要求を常に拒否します。同梱の `cordis.patch.yml` は `gui` を既定にしています。
- トークンは YAML に書かず環境変数で渡してください。プラグインはトークン・パスワード・ペアリングコード・プロンプトの内容をログに出しません。
- 内部 API(rc 版)に依存します。dsh のアップデート後は `[omnichat]` ログを確認してください。

## トラブルシューティング

| 症状 | 確認 |
|---|---|
| `[omnichat]` のログが何も出ない | `dsh plugin` が成功しているか。`<profile>/package.json` の `dsh.profile.bundles` に `@omnichat/dsh-bridge` があるか。起動時の `dsh: warning: N entries did not activate` の下に理由が出ます(例: `waiting for service: sessionController` = そのプロファイルに無い) |
| `disabled: invalid configuration` | メッセージのとおり設定を直す(環境変数が dsh のプロセスに渡っているか。desktop は GUI を再起動)。ローカルモードで `serverUrl` 等を書いていると警告だけが出ます |
| ローカルモード: `pairing rejected`(4401) | ペアリングコードが違います。`node dist/pair.js` で確認し、アプリに貼り直してください。dsh を起動したときにペアリングファイルが作り直されていないかも確認します |
| ローカルモード: `locked`(4429) | 失敗が 5 回たまりました。60 秒待ってから再試行してください |
| ローカルモード: `origin not allowed`(4403) | ブラウザの Origin が許可されていません。初回のペアリング(`pair: true`)をやり直すか、`allowedOrigins` に追加してください |
| ローカルモード: `replaced`(4000) | 別の OmniChat アプリが接続しました。同時に使うのは 1 つにしてください |
| ローカルモード: 接続できない(https のページ) | 混在コンテンツで `ws://127.0.0.1` がブロックされることがあります。デスクトップ版を使うか、`http` のオリジンで開いてください |
| `socket error (server unreachable or connection rejected)` を繰り返す(リモートモード) | サーバー URL・ファイアウォール・トークンの有効性(トークン方式では 401 でも同じ表示)。`username`/`password` 方式なら毎回ログインし直します |
| アプリで `Bridge '<name>' is offline` | `GET /bridges` に出ているか。`name` とプロバイダーの `baseUrl` が一致しているか。デーモンと同名で動かしていないか |
| `session busy in dsh` | そのセッションを dsh 側で実行中。終わってから送るか、別の会話にする |
| GUI の会話が反映されない | `mirror: true` か、`mirrorScope: cwd` で cwd が違っていないか、`mirror is off` の警告が出ていないか(履歴 API が無い場合は自動でオフ) |
| `[omnichat] disabled: ... lacks sessionController.xxx` | dsh のバージョンが内部 API を変えた。プラグインを更新するか、dsh のバージョンを合わせる |
| 承認待ちで止まる / 自動拒否される | 上記セキュリティの項のとおり dsh のポリシーです。GUI で承認するか、`approvals` を見直してください |
| デスクトップのウィンドウを閉じると切れる | ホストプロセスが終了するため。常時接続したい場合は `web` プロファイル(`dsh web --no-open`)を常駐させる |

## 開発

```bash
npm install
npm test        # node:test。偽の ctx と偽の WS サーバーで run/cancel/busy/モデル/ミラー/再接続/設定検証/ローカルモードの認証・バッファ/ペアリング/ログを検証
```

ファイル: `dist/index.js`(エントリ・設定検証・ログ)、`dist/config.js`(設定の検証。ローカル/リモート)、`dist/host.js`(dsh 内部 API の防御的アダプタ)、`dist/bridge.js`(WS・run・モデル・ミラー)、`dist/local.js`(ローカルモードの待ち受け・認証・バッファ)、`dist/pairing.js`(ペアリングファイル)、`dist/pair.js`(コード表示のコマンド)、`dist/wsserver.js`(依存なしの WebSocket サーバー)、`dist/mirror.js`(セッションモデル)、`dist/wire.js`。

アプリ側の中継: `app/src/dshRelay.ts`(純粋な中継ロジック。テストは `app/src/__tests__/dshRelay.test.ts`、`npm run test:relay` で実行)。

## モデル連携(0.5.0)

- **Code タブ**: ブリッジの `ready` / `models` フレームの `models[]` に、プロバイダーの表示名 `providerName` と、取り込み済みの印 `imported` を付けて報告します。OmniChat の Code タブの選択欄は、この PC の dsh のモデルだけを出します。
- **OmniChat のモデルを dsh に取り込む**: 設定ページ(プラグイン → OmniChat)の「Models from OmniChat」。サーバーに `omni_models_request` / `omni_key_request` を送り、dsh の `settings` サービスで `llm-pi-ai` にプロバイダー `omnichat` を、`credentials` サービスで API キー `OMNICHAT_API_KEY` を登録します(再起動不要)。取り込み済みの記録は `<DSH_HOME>/omnichat-imported-models.json`(秘密情報なし)。設定ページ用のメソッドは `omnichatbridge` の `omniModels` / `omniImport` / `omniSync` / `omniRemove`(引数は `args` という名前の JSON 1 つ)。仕様: [../docs/PROTOCOL-v7-dshmodels.md](../docs/PROTOCOL-v7-dshmodels.md)。

## Code 操作 (OmniChat v4)

デーモン型(`bridge/README.md` の同名の節)と同じフレームを送ります: `checkpoint`(run 開始前、`event` より前)、`changes`(終了時、`done` の前。パッチを切り詰めたときは `truncated:true`)、`rewind` → `rewound`、`approval` ↔ `approval_reply`、`agents`。
- 作業フォルダは run のセッションの cwd(新規セッションは `cwd` 設定)。`rewind` は `cwd` 設定または今まで実行した run の cwd だけ受け付けます。
- **サブエージェント**: 子は別セッション(`header.origin === 'subagent'`, `header.parentSession`)として `session/event` に流れるので、状態(running/done/error)、要約、ログ(最大 64 KB)、役割(親の `subagent/catalog` のラベル)を逐次更新して `agents` を送ります。親のターンが終わっても子が動いていれば、最長 15 分、完了まで追跡して `agents` を送り続けます。cordis イベント `subagent/start` / `subagent/end` も使います。

## プレビュー用のファイル読み取り(0.7.0)

既定では無効です。リモートモードで設定 `previewFs: true`(または環境変数 `OMNICHAT_BRIDGE_PREVIEW_FS=1`)を指定したときだけ、サーバーが作業フォルダ(`cwd`)のファイルを読めるようになります。ローカルモードでは使われません。

- **サーバーの管理者が、作業フォルダのファイルを読めるようになります**。この dsh の作業フォルダを、そのサーバーに見せてよいときだけ有効にしてください。
- 読めるもの: 作業フォルダの中の、許可された種類のファイル(html、css、js、json、txt、md、画像、フォント、音声・動画の一部)。1 回 3 MB まで。一覧は 2000 件まで。
- 読めないもの: `.` で始まる名前(`.git`、`.env`)、`node_modules`、`*.pem`・`*.key`・`*.p12`・`*.pfx`・`*.keystore`・`id_rsa*`・`id_ed25519*`、名前に `credential` / `secret` を含むもの、作業フォルダの外へ出るシンボリックリンク・ジャンクション、許可されていない種類のファイル。
- 書き込み・削除・実行はできません。dsh が実行中でも読めます(読み取りだけ)。
- 有効かどうかは、ブリッジが `ready` で `capabilities.fs` を送るかどうかで決まります。仕様は `BRIDGE-v2.md` の「C. Preview file access (fs)」を参照してください。

## 検証の状況

| 項目 | 状況 |
|---|---|
| プラグイン(リモートモード)0.1.0: dsh 0.2.0-rc.2 の `web` プロファイルへの導入と、接続・実行・停止・モデル選択・ツール表示 | 記録に基づき確認済み(0.1.0 パッケージ時点の記録) |
| 0.2.0 の自動テスト: plugin の `npm test`(158 件)、アプリの中継 `npm run test:relay`(19 件) | このドキュメントの作成時に実行し、合格 |
| ローカルモード: 偽の dsh ホストを使ったエンドツーエンド | 確認済み(実サーバー + 偽の dsh ホスト + 中継。実 dsh は使っていない) |
| ローカルモード: 実 dsh の `web` プロファイルでの接続と実行 | **未検証** |
| `desktop` プロファイルへの導入(ローカルモードを含む) | **未検証** |
| アプリの設定画面からのペアリングと接続 | 確認済み(Web 版を実ブラウザで。デスクトップ版は未検証) |
| 実際の dsh GUI(ユーザー自身の画面)での入力と同期 | **未検証** |

Windows 以外の dsh については、このリポジトリでは確認していません。

## 更新(0.6.0)

プラグインは新しいバージョンを自分では置き換えません。設定ページの「プラグインの更新」で確認と準備だけを行い、インストールは dsh を終了してから手動で行います。

1. **更新を確認**: GitHub(`remuno3751/omnichat`)のリリースから、最新の安定版 `omnichat-dsh-bridge-<ver>.tgz` を探します。自動の確認は最大 6 時間に 1 回で、設定ページを開いたときは前回の結果を使います。
2. **更新**: パッケージを `<DSH_HOME>/omnichat-update/` に取得し、リリースの `SHA256SUMS`(または `<asset>.sha256`)と SHA-256 を照合します。チェックサムが無い場合・一致しない場合は保存しません。
3. **コマンドをコピー**: 表示されるコマンドを、dsh を完全に終了してからターミナルで実行します。

```
dsh plugin --profile desktop remove @omnichat/dsh-bridge; dsh plugin --profile desktop add "<準備されたパッケージ>"
```

- プロファイル名は環境変数 `DSH_PROFILE` で指定できます(既定は `desktop`)。
- 非公開リポジトリや GitHub の API 制限の対策として、GitHub トークンを設定ファイルの `updateToken`、または環境変数 `OMNICHAT_UPDATE_TOKEN` で渡せます。トークンは API 呼び出しの `Authorization` としてだけ使い、ログやエラーメッセージには出しません。
- 確認先は環境変数 `OMNICHAT_UPDATE_REPO` と `OMNICHAT_UPDATE_API_BASE` で変えられます(既定はこのリポジトリと api.github.com。https のみ、ローカルの http は除く)。
