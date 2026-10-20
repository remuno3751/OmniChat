# DeepSeek Harness(dsh)連携

OmniChat から、自分の PC で動いている **DeepSeek Harness(dsh)** を操作する仕組みです。接続の仕方は 3 通りあります。

- **プラグイン型・ローカルモード(既定)**(`dsh-plugin/`): dsh のプラグインは PC の中(127.0.0.1)だけで待ち受け、OmniChat のアプリ(Web タブまたはデスクトップ版)が中継してサーバーへ接続する
- **プラグイン型・リモートモード**(`dsh-plugin/`、`mode: remote`): dsh のプラグインが PC からサーバーへ直接接続する。ヘッドレス PC 向け
- **デーモン型**(`bridge/`): 別プロセスで動き、必要なときに `dsh headless` を起動する

リモートモードとデーモン型は、PC からサーバーへ**外向き**に WebSocket で接続します。PC 側でポートを開ける必要はありません。ローカルモードは PC の中(`127.0.0.1` / `::1`)だけで待ち受け、外部からは届きません。サーバーへの接続はアプリが行います。

関連: [README.md](../README.md) の「DeepSeek Harness(dsh)の遠隔操作」、[bridge/README.md](../bridge/README.md)、[dsh-plugin/README.md](../dsh-plugin/README.md)、[BRIDGE.md](../BRIDGE.md) / [BRIDGE-v2.md](../BRIDGE-v2.md)(ワイヤプロトコル)、[DSH-PLUGIN-RESEARCH.md](../DSH-PLUGIN-RESEARCH.md)(プラグイン化の調査メモ)、[PROTOCOL-v6.md](../PROTOCOL-v6.md) の第 2 節(ローカルモードの設計)。

> **警告**: dsh のヘッドレス実行は**承認なしで**シェルやファイル操作のツールを実行します。OmniChat のアカウントを持つ人は、このブリッジが動く PC を操作できます。強いパスワード、HTTPS、専用の作業フォルダ(`--cwd` / `cwd`)を使ってください。

## 1. 3 つの方式の比較

| 項目 | デーモン型(`bridge/`) | プラグイン型・ローカルモード(既定) | プラグイン型・リモートモード |
|---|---|---|---|
| 実行形態 | 別プロセス。メッセージごとに `dsh headless` を起動 | dsh プロセス内。起動しない | dsh プロセス内。起動しない |
| 接続の向き | PC → サーバー(外向き) | アプリ → PC(127.0.0.1 のみ)、アプリ → サーバー | PC → サーバー(外向き) |
| 認証 | `--token` / `--username` / `--password` | ペアリングコード(PC で表示、アプリに貼る) | `OMNICHAT_SERVER_URL` と端末トークン |
| 対象の dsh プロファイル | `headless` | `web` または `desktop`(`sessionController` が必要) | `web` または `desktop`(`sessionController` が必要) |
| GUI で入力した発言の反映 | セッションログ(zstd)を 1.5 秒ごとに監視 | `session/event` を購読(リアルタイム) | `session/event` を購読(リアルタイム) |
| 実行中の判定 | ログの更新時刻(3 秒のヒューリスティック) | dsh のエージェント状態 | dsh のエージェント状態 |
| 承認(ツール) | **承認なし**で実行 | dsh の承認ポリシーに従う(`approvals`) | dsh の承認ポリシーに従う(`approvals`) |
| モデル一覧 | `cordis.patch.yml` の `llm-pi-ai` から、id と名前だけを読む | dsh の `modelCatalog()` | dsh の `modelCatalog()` |
| 依存 | Node.js(`npm install`) | 実行時依存なし。`npm pack` の `.tgz` を dsh に入れる | 同左 |
| 検証状況 | 44.0.0(開発者の PC、記録に基づく) | 0.2.0 の自動テストと、偽の dsh ホストでのエンドツーエンド確認。**実 dsh では未検証**(§10) | 0.1.0 パッケージ、dsh 0.2.0-rc.2(`web`、記録に基づく) |

**同じ名前(`--name` / `name` / アプリのブリッジ名)でこれらを同時に動かさないでください。** サーバーは (ユーザー, 名前) ごとに 1 接続で、後から来た接続が古い接続を置き換えます。

## 2. 共通の設定(OmniChat アプリ側)

1. Settings → Providers → **+ Add provider**
2. プリセット **DeepSeek Harness (PC bridge)** を選ぶ(種類は `dsh-bridge`、モデルは `dsh`)
3. **baseUrl** の欄に、ブリッジの名前を入れる。例: `my-pc`

名前が一致しないと、アプリでは「Bridge 'my-pc' is offline」と表示されます。接続中のブリッジは `GET /bridges` で確認できます(`{bridges: [{name, cwd, online: true}]}`)。ローカルモードでは、サーバーに登録される名前はアプリ側のブリッジ名(端末設定の `dsh.bridgeName`)で決まります。プラグインの `name` と同じ値にしてください。

## 3. デーモン型ブリッジ(`bridge/`)のインストールと起動

前提: 対象の PC に dsh と Node.js(`bridge/` の `npm install` が通るバージョン。サーバーと同じ Node 24 を推奨)があること。

```powershell
cd C:\vibecording\omnichat\bridge
npm install
$env:OMNICHAT_PASSWORD = '<パスワード>'     # コマンドラインに書かず環境変数で渡す
npm start -- --server https://chat.example.com --username alice --cwd C:\work\agent --name my-pc
```

主なオプション:

| オプション | 既定 | 意味 |
|---|---|---|
| `--server` | (必須) | OmniChat サーバーの URL(http / https) |
| `--token` / `--username` / `--password` | — | 認証。環境変数 `OMNICHAT_TOKEN` / `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` も可 |
| `--cwd` | (必須) | dsh の作業フォルダ(存在するフォルダ) |
| `--name` | ホスト名 | ブリッジ名。プロバイダーの baseUrl と一致させる |
| `--dsh-app` | `%LOCALAPPDATA%\Programs\DeepSeek Harness` | dsh のインストール先 |
| `--dsh-patch` | `bridge/dsh-overlay.yml` | 設定のオーバーレイ。`none` で無効 |
| `--profile` | `headless` | dsh のプロファイル |
| `--dsh-home` | `~/.dsh` | dsh のホーム(モデル検出とミラーに使う) |
| `--no-mirror` / `--mirror-all` | ミラー有効・同じ `--cwd` のみ | GUI の会話の反映を止める / 全フォルダの会話を反映 |

### モデル

- ブリッジは起動中のプロファイルの `llm-pi-ai` から、**プロバイダー名・モデル ID・モデル名だけ**を読みます。API キーと baseURL は読みません(ログにも送信にも含めません)。`~/.dsh/.credentials.yaml` は読みません。
- 既定モデルは `--dsh-patch` のオーバーレイ(`agent-default-model`)から取ります。
- アプリでモデルを選ぶと、そのターンだけ一時的なオーバーレイ(OS の一時フォルダ)を追加して実行し、終わったら削除します。
- 上流(例: LM Studio の前段のプロキシ)が**今配信しているモデルだけ**を報告します。10 秒ごとに上流の `GET {baseURL}/models` を確認します。上流が応答しないときは宣言済みの一覧に戻ります。
- 上流への要求は、baseURL のホストが localhost か RFC1918 のプライベート IP の場合だけ許可され、リダイレクトは追いません。

> **デスクトップ版からの承認(プラグイン 0.8.0 以降)**: デスクトップ版は、サーバーが配信する画面を開くため、ページの Origin はサーバーの URL になり、プラグインは直接の承認申請を受けません。そこで、アプリ自身の Origin(`tauri.localhost`)の隠しフレーム(`desktop/launcher/dsh-bridge-frame.js`)が、「このサーバーの画面のために承認してほしい」と申請します(`hello.forOrigin`。ブラウザが報告するページの Origin だけを使い、Tauri の Origin の接続からだけ受け付けます)。DSH の承認ダイアログにそのサーバーの URL が出て、「許可」を押すと、その URL が許可されます。実 dsh(0.8.0、Windows)で、承認ダイアログの表示と、許可後の接続を確認しました。

## 4. プラグイン型・ローカルモード(既定)

### 4.1 構成

```
dsh(プラグイン。127.0.0.1:19401 で待ち受け)
   ⇅  ローカル WebSocket /omnichat-bridge(ペアリングコードで認証)
OmniChat アプリ(Web タブ または デスクトップ版。中継: app/src/dshRelay.ts)
   ⇅  WebSocket /bridge(ユーザー自身のログイン)
OmniChat サーバー(変更なし)
```

- アプリは、PC のプラグインとサーバーの間でフレームをそのまま両方向へ転送します。フレームの形式は従来のブリッジのプロトコルと同じです。
- サーバーは従来どおり、(ユーザー, 名前) ごとに 1 つのブリッジ接続として見ます。
- PC に外から入ってくるポートはありません。サーバー用のトークンを環境変数や YAML に置く必要もありません。サーバーへの認証は、アプリにログインしているユーザーのものを使います。

### 4.2 インストール

前提: dsh(DeepSeek Harness)が入っていて、`dsh` コマンドが使えること。

```powershell
cd dsh-plugin
npm install      # テスト用の devDependency(ws)のみ
npm pack         # → omnichat-dsh-bridge-0.2.0.tgz
```

`.tgz` は**絶対パス**で指定します。ローカルモードでは `OMNICHAT_SERVER_URL` などの環境変数は要りません。

```powershell
# desktop プロファイル(GUI を完全に終了してから実行)
dsh plugin --profile desktop add C:\path\to\omnichat-dsh-bridge-0.2.0.tgz

# web プロファイル(ブラウザ UI。常駐向き)
dsh plugin --profile web add C:\path\to\omnichat-dsh-bridge-0.2.0.tgz
```

更新は、設定画面の「更新」で新しい版を取得すると表示される 1 行のコマンドを実行します(取得したファイルはチェックサムを検証してから保存されます)。DSH の GUI を閉じてから実行してください。

```powershell
dsh plugin --profile <名前> remove @omnichat/dsh-bridge; dsh plugin --profile <名前> add "<保存された tgz の絶対パス>"
```

DSH を開いたまま入れ替えることはしません。詳しくは [UPDATES.md](UPDATES.md) の 9 を参照してください。削除も同じ `remove` です。

### 4.3 モードの選び方

`mode`(設定)または環境変数 `OMNICHAT_MODE`(`local` / `remote`)で選びます。

- 同梱の `cordis.patch.yml` では、`OMNICHAT_MODE` も `OMNICHAT_SERVER_URL` も未設定なら **local** です。
- `OMNICHAT_SERVER_URL` が設定されていれば **remote** になります(従来の環境変数設定が、そのまま動き続けるようにするため)。
- `OMNICHAT_MODE` を明示すれば、それが優先されます。

### 4.4 設定項目(local)

| キー | 既定 | 環境変数 | 意味 |
|---|---|---|---|
| `mode` | `local` | `OMNICHAT_MODE` | `local` または `remote` |
| `listenPort` | `19401` | `OMNICHAT_LOCAL_PORT` | `127.0.0.1` と `::1` で待ち受けるポート(1〜65535) |
| `allowedOrigins` | 空 | — | 追加で許可するブラウザの Origin(`https://chat.example.com` の形)。通常は初回ペアリングで自動追加される |
| `pairingFile` | `<DSH_HOME>/omnichat-bridge.json` | — | ペアリング情報の保存先 |
| `name` | ホスト名 | `OMNICHAT_NAME` | プラグインの名前。サーバー上の名前は、アプリのブリッジ名で決まる |
| `cwd` | dsh の既定ワークスペース | `OMNICHAT_CWD` | プラグインが新規作成するセッションの作業フォルダ |
| `mirror` | `true` | — | GUI の会話を OmniChat に反映する |
| `mirrorScope` | `all` | — | `all`(全セッション)または `cwd`(`cwd` のセッションだけ) |
| `approvals` | コードの既定は `remote`。同梱の `cordis.patch.yml` は `gui` | — | 承認の扱い(§7) |
| `approvalTimeoutMs` | `600000`(10 分) | — | `remote` のときの承認の待ち時間。過ぎると拒否 |

`DSH_HOME` は環境変数で、未設定なら `~/.dsh` です。ローカルモードでは `serverUrl` / `token` / `username` / `password` は使われず、設定されていると警告が出ます。

プロファイルの設定の上書き(`%USERPROFILE%\.dsh\profiles\<名前>\cordis.patch.yml`。バンドル既定とマージされます):

```yaml
- id: omnichat-bridge
  config:
    name: my-pc
    listenPort: 19401     # 既定のままなら省略可
    mirror: true
    mirrorScope: all
    approvals: gui
```

設定が不正な場合は `[omnichat] disabled: invalid configuration: …` と 1 行出して、プラグインは何もしません(dsh は落ちません)。

### 4.5 ペアリング

- 初回の起動時に、32 バイトの乱数(base64url)のペアリングコードを作り、`<DSH_HOME>/omnichat-bridge.json` に保存します。
- まだペアリングされていない間は、起動のたびに dsh のログへ `OmniChat pairing code: <コード>` と出ます。ペアリング済みのときは `already paired` と出るだけで、コードは出ません。
- コードを確認する手段は 2 つです。
  - dsh のログの `OmniChat pairing code:` の行
  - `node dist/pair.js [--home <dir>] [--file <path>] [--json]`(`dist/pair.js` は tgz に入っています。コードと接続先 `ws://127.0.0.1:<port>/omnichat-bridge` を表示します。`--json` は機械向けの出力)
- コードは**秘密情報**です。コードを持っていて、その PC で動いている人は dsh を操作できます。ファイルの権限は 600(対応している OS)で作られます。ペアリングファイルを削除したり壊したりすると、次の起動で新しいコードが作られ、以前のペアリングは無効になります。

### 4.5b dsh で承認するペアリング(0.4.0 以降)

アプリの **Connect** ボタン(コード不要)は、`{type:"hello", client:"omnichat-app", version, pairRequest:true, clientName}` を送ります。プラグインは Origin を確認し(`http(s)://localhost|127.0.0.1|[::1]` の任意のポートと Tauri の Origin のみ。それ以外は 4403)、保留リクエスト(120 秒で期限切れ、同じ Origin に 1 件、全体で 3 件まで。超えると 4003)を作って `{type:"pair-pending", requestId, expiresInSec}` を返し、ソケットを開いたままにします。dsh の GUI の プラグイン → OmniChat ページ上部のバナーで **Allow** / **Deny** を押します。

- Allow: Origin を `allowedOrigins` に追加し、`{type:"pair-approved", pairing}` を**そのソケットにだけ**送って 1000 で切断します。アプリは `pairing` を端末設定に保存し、新しいソケットで通常の `hello`(コード付き)を送ります。以後は承認なしで再接続します。
- Deny / 期限切れ / コードの再生成: `{type:"pair-denied", reason:"denied"|"expired"|"invalidated"}` を送って **4002** で切断します。拒否と期限切れは失敗として数え、5 回で 4429 のロックアウトになります。
- 待機中のソケットが切れたら、リクエストは取り消されます。待機中のソケットが送るフレームは無視されます。
- 設定ページの Remote: `getState()` に `pending` が入り、`approve(id)` / `deny(id)` が使えます(未知の id はエラー)。
- コード入力(§4.5・§4.6)は「Enter code manually」として残っています。LAN / Tailscale のホスト名から開いたアプリは承認方式を使えず(4403)、コード入力を使います。

### 4.6 接続の流れと拒否の条件

1. アプリが `ws://127.0.0.1:<port>/omnichat-bridge` に接続し、最初のフレームとして `{type:"hello", pairing, client:"omnichat-app", version}` を送ります。初回のペアリングでは `pair: true` を付け、再接続のときは `resume: {instance, sinceSeq}` を付けます。
2. プラグインは `ready` を返します。`ready` には `mode`、`version`、`instance`、`seq` が付きます。
3. アプリはサーバーの `/bridge` に接続して `ready` を送り、以後のフレームを両方向に転送します。

| 条件 | 結果 |
|---|---|
| 最初のフレームが `hello` でない、または 10 秒 `hello` が来ない | 拒否(失敗として数える)。2 秒後に切断 |
| ペアリングコードが違う | 2 秒後に 4401 で切断。失敗として数える |
| 失敗が 5 回たまる | 60 秒間、新しい接続を 4429 で拒否 |
| Origin が許可リストになく、`pair: true` もない | 即座に 4403 で切断(失敗には数えない) |
| Origin が許可リストになく、`pair: true` とコードが正しい | Origin を `allowedOrigins` に追加して接続 |
| Origin がない(ブラウザ以外のクライアント) | コードが正しい場合だけ接続 |
| 別のクライアントが接続した | 新しい方が勝ち、古い方は 4000 で切断 |

### 4.7 切断・再接続・バッファ

- アプリが切断されても、実行中の run は続きます。プラグインはフレームを**最大 60 秒・2 MB** まで保持し、次に接続して `ready` を送った後に送り直します。`resume`(`instance` と `sinceSeq`)が有効なら、その続きから送ります。有効でなければ、最後に届けた位置から送り直します(ベストエフォート)。
- `ready` / `models` / `sessions` は保持せず、接続のたびに作り直します。GUI 会話のミラーのスナップショットも、接続のたびに再生成されます。
- 中継(アプリ側)は、PC 側とサーバー側の両方の接続を指数バックオフ(1〜30 秒、ジッタ付き)で再接続します。サーバー側の接続が切れたときは、PC 側のローカル接続も切ります。プラグインは新しい接続で `ready` を送り直します。

### 4.8 制限

- 中継は、**アプリが開いていて、ログインしているときだけ**動きます(Web タブまたはデスクトップ版)。デスクトップ版のウィンドウを隠してトレイに入れた場合は、webview が生きている間だけ中継を続けます。
- 中継は Web 版(デスクトップ版は Web の画面を webview で表示したもの)だけです。スマートフォン版のアプリでは動きません。
- ブラウザの制限: `https` のページから `ws://127.0.0.1` へ接続すると、混在コンテンツとしてブロックされることがあります。Safari は接続できません。Chrome と Firefox は 127.0.0.1 を安全な接続として扱います。新しい Chrome では、ローカルネットワークへのアクセスの許可を求められることがあります。接続できない場合は、デスクトップ版を使うか、`http` のオリジンで開いてください。
- Web アプリの Origin は許可リストに入っている必要があります。初回のペアリング(`pair: true`)で追加されます。

### 4.9 アプリの設定画面(現状)

設定 → Plugins → **DeepSeek Harness** のカードで、次の手順で行う想定です。

1. プラグインを入れる(`dsh plugin --profile desktop add ...tgz`。GUI を閉じた状態で実行)
2. **Connect** を押し、dsh の GUI の プラグイン → OmniChat で **Allow** を押す(手動の場合は、ログの `OmniChat pairing code:` または `node dist/pair.js` のコードを「Enter code manually」に貼る)
3. 状態が local / server で表示される
4. dsh のプロバイダーを追加する
5. 試す

折りたたみの「リモートモード(PC からサーバーへ直接)」に、従来のトークン手順(`POST /bridges/token`)を残しています。

手順 3 の入力は端末設定 `dsh`(有効化・ポート・ペアリングコード・ブリッジ名)に保存され、アプリがログインしている間、`DshRelayHost` が中継を動かします(Web のみ)。状態は 10 秒ごとのサーバーの `/bridges` と、中継自身の状態(この PC / サーバー)の両方がカードに出ます。

## 5. プラグイン型・リモートモード(従来方式)

`mode: remote`(または `OMNICHAT_SERVER_URL` の設定)のときの手順です。プラグインが PC からサーバーへ直接、外向きに接続します。アプリを開いていなくても接続できます。ヘッドレスの PC に向きます。

### 5.1 パッケージを作る(開発 PC)

```bash
cd dsh-plugin
npm install      # テスト用の devDependency(ws)のみ
npm test         # 任意
npm pack         # → omnichat-dsh-bridge-0.2.0.tgz
```

### 5.2 dsh のプロファイルに入れる

`.tgz` は**絶対パス**で指定します。

```powershell
# web プロファイル(ブラウザ UI。常駐向き)
dsh plugin --profile web add C:\path\to\omnichat-dsh-bridge-0.2.0.tgz

# desktop プロファイル(GUI を完全に終了してから実行)
dsh plugin --profile desktop add C:\path\to\omnichat-dsh-bridge-0.2.0.tgz
```

更新は、設定画面の「更新」で新しい版を取得すると表示される 1 行のコマンドを実行します(取得したファイルはチェックサムを検証してから保存されます)。DSH の GUI を閉じてから実行してください。

```powershell
dsh plugin --profile <名前> remove @omnichat/dsh-bridge; dsh plugin --profile <名前> add "<保存された tgz の絶対パス>"
```

DSH を開いたまま入れ替えることはしません。詳しくは [UPDATES.md](UPDATES.md) の 9 を参照してください。削除も同じ `remove` です。

### 5.3 設定する

トークンは、アプリの **Settings → Plugins → 連携 → DeepSeek Harness** にある「プラグイン用のアクセストークンを作成」ボタン(`POST /bridges/token`)で作れます。トークンは**一度だけ**表示され、`setx OMNICHAT_SERVER_URL` / `setx OMNICHAT_TOKEN` のコマンドもそのまま表示されます。作られた端末は Devices 画面に `DSH plugin (<名前>)` として出るので、そこで失効できます。`setx` で設定した環境変数は、dsh(デスクトップアプリ)を再起動しないと反映されません。

環境変数(推奨。トークンを YAML に書かないため):

| 変数 | 意味 |
|---|---|
| `OMNICHAT_SERVER_URL` | サーバーの URL(必須)。`http://` は `ws://` に、`https://` は `wss://` に自動変換。設定されていると remote になる |
| `OMNICHAT_MODE` | `remote` と書けば明示できる(省略可) |
| `OMNICHAT_TOKEN` | 端末トークン。または次の 2 つ |
| `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` | ログインして端末トークンを得る |
| `OMNICHAT_NAME` | ブリッジ名(既定はホスト名)。プロバイダーの baseUrl と一致させる |
| `OMNICHAT_CWD` | 新規セッションの作業フォルダ(既定は dsh の既定ワークスペース) |

プロファイルの `cordis.patch.yml` で上書きする場合:

```yaml
- id: omnichat-bridge
  config:
    mode: remote
    name: my-pc
    mirror: true          # GUI の会話を OmniChat に反映
    mirrorScope: all      # all | cwd
    approvals: gui        # gui | deny | remote
```

設定が不正な場合は `[omnichat] disabled: invalid configuration: …` と 1 行出して、プラグインは何もしません(dsh は落ちません)。

### 5.4 起動と確認

```powershell
$env:OMNICHAT_SERVER_URL = 'http://192.168.1.10:8787'
$env:OMNICHAT_TOKEN = '<端末トークン>'
$env:OMNICHAT_NAME = 'my-pc'
dsh web --no-open --port 8123
```

起動ログに `[omnichat] connected as 'my-pc'` が出て、`GET /bridges` に `online: true` で現れれば成功です。ログは dsh を起動した端末の標準エラーに出ます。

## 6. モデルの選択

- すべての方式で、アプリのモデル一覧に dsh のモデルが出ます。
- デーモン型: 上の「モデル」の通り(配信中のモデルだけ)。
- プラグイン型(ローカル・リモートとも): dsh の `modelCatalog()` の一覧。変更時と 30 秒ごとに再送されます。
- アプリで選んだモデルは `<プロバイダー>::<ID>` の形で渡されます。ID に `::` が無い場合は、その ID を持つプロバイダーとして扱われます。
- **Code タブ(0.5.0 以降)**: モデルの選択欄には、接続している PC の dsh のモデルだけが出ます(OmniChat 自身のモデルは出ません)。dsh のプロバイダーごとにまとまり、GUI で選択中のモデルに「DSH で選択中」、OmniChat から取り込んだモデルに「OmniChat」の印が付きます。選んだモデルは次の run で `selectModel`(セッション単位。GUI の既定は run のあとで元に戻します)として dsh のセッションに適用されます。ブリッジがモデルを報告しない場合(古いプラグイン、dsh に届かない)は、従来の全モデル一覧に戻り、注意書きが出ます。チャットタブの選択欄は変わりません。フレームの詳細は [PROTOCOL-v7-dshmodels.md](PROTOCOL-v7-dshmodels.md) の第 1 節。

### 6.1 OmniChat のモデルを dsh に取り込む(0.5.0 以降)

dsh の GUI の プラグイン → OmniChat ページに「Models from OmniChat」の節があります。

1. OmniChat のアプリを開いて、このブリッジに接続しておきます(ローカルモード。リモートモードはサーバーへ直接つながっていれば可)。
2. **Refresh** で、ペアリング済みの OmniChat サーバーが提供するモデル(`openai-compatible` のプロバイダーのチャットモデル)を一覧します。
3. 取り込むモデルにチェックを入れて **Import**。初回はサーバーが端末用の API キー(`DSH import (<ブリッジ名>)`)を発行します。キーは設定 → API キーにも出るので、そこで失効できます。
4. **Sync** は、名前などの更新、サーバーから消えたモデルの削除、新しいモデルの追加を行います。**Remove all imported models** は取り込んだものをすべて外し、キーを失効させます。

**登録の仕組み(決定事項)**: dsh は OpenAI 互換のルートを `llm-pi-ai` の `providers` に持ちます(dsh の GUI の Models ページと同じ設定)。プラグインは dsh の `settings` サービスで、プロバイダー `omnichat`(表示名 `OmniChat`、`api: openai-completions`、`baseURL` = サーバーの `/v1`、モデル名は `[OmniChat] <モデル名>`)を実行時に書き込みます。設定は dsh 自身がプロファイルの `cordis.patch.yml` に永続化し、**再起動は不要**です。API キーは `credentials` サービスの `OMNICHAT_API_KEY` として dsh の認証情報ストア(`<DSH_HOME>/.credentials.yaml`)に入り、パッチファイル・プラグインの状態・ログには出ません。`settings` が使えない場合は取り込みを失敗させ、`cordis.patch.yml` に貼るための YAML(キーなし)を表示します。dsh のモデル一覧では、プロバイダー「OmniChat」のグループと `[OmniChat] ` の名前で見分けられます。

記録ファイル `<DSH_HOME>/omnichat-imported-models.json` に取り込み済みモデルの一覧(秘密情報なし)を保存し、設定ページの「取り込み済み」表示と再同期に使います。フレーム・メソッドの詳細は [PROTOCOL-v7-dshmodels.md](PROTOCOL-v7-dshmodels.md) の第 2 節。

## 7. 承認とセキュリティ

| 方式 | ツールの承認 |
|---|---|
| デーモン型 | **承認なし**。`dsh headless` が `--cwd` の中でシェル・ファイル操作を実行する |
| プラグイン型(`approvals: remote`、コードの既定) | OmniChat から始めた run の承認要求を、サーバーへ転送し、アプリで 1 回許可 / 拒否する。答えが無ければ `approvalTimeoutMs`(既定 10 分)で拒否。OmniChat 以外から始めたセッションは dsh/GUI に任せる |
| プラグイン型(`approvals: gui`、同梱の `cordis.patch.yml` の既定) | dsh のポリシー(`ask`)に従う。承認が必要な操作は、接続している GUI に承認ダイアログが出る。GUI が無ければ自動的に拒否される |
| プラグイン型(`approvals: deny`) | OmniChat から始まった実行の承認要求は**すべて拒否**する。読み取り系だけ使わせたい場合に使う |

- 遠隔承認はプラグイン型(`approvals: remote`)だけです。デーモン型の `dsh headless` は承認の仕組みを通らないので、承認を出せません。
- ローカルモードでも承認の扱いは同じです。承認要求と回答は、アプリが中継するフレームとして流れます。
- トークン・パスワード・ペアリングコード・プロンプトの内容はログに出しません。
- プラグイン型は dsh と同じプロセスで、ユーザーの OS 権限のまま動きます。信頼できるパッケージだけを入れてください。

### 7.1 ローカルモードの防御

ウェブページを開いているブラウザからも、`ws://127.0.0.1:<port>` には接続を試みられます。そのため、次の防御を入れています。

1. **待ち受けは `127.0.0.1` と `::1` だけ**です。`0.0.0.0` には bind しません。
2. **Host ヘッダー**は、ループバックのアドレスと待ち受けポートの組み(`127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`)だけを受け付けます(DNS リバインディングの対策)。
3. **Origin の許可リスト**。既定で `tauri://localhost`、`http://tauri.localhost`、`https://tauri.localhost` を許可します。それ以外のブラウザの Origin は、初回のペアリング(`pair: true` とコード)で追加されたものだけが通ります。
4. **ペアリングコード**(32 バイト)。Origin が無いクライアントも、コードが無ければ接続できません。失敗が続くと 60 秒のロックアウトになります。
5. **同時に 1 クライアントだけ**。新しく認証されたクライアントが古いものを置き換えます。
6. ペアリングファイルの権限は 600(対応している OS)です。

承認の設定(`approvals`)は、ローカルモードでも従来のとおりです。

## 7.2 Code 操作 (v4): チェックポイント・変更一覧・巻き戻し

両方式とも、run の前に作業フォルダの git スナップショット(`refs/omnichat/checkpoints/<id>`、ユーザーのブランチ・インデックスには触れない)を取り、終了時に差分(`changes`)を送り、サーバーからの `rewind` で復元します。git でないフォルダでは警告(`done.warning`)だけです。サブエージェントは `agents` フレームで送ります(デーモン型は終了時の推定まで、プラグイン型は進行も)。詳細は各 README と `DSH-PLUGIN-RESEARCH.md` の追補。

## 8. 双方向同期(GUI とアプリの会話)

dsh の GUI で入力した発言と応答は、OmniChat に**同じ会話として**現れます。アプリで入力した内容も GUI に現れます。

- デーモン型: dsh のセッションログを 1.5 秒ごとに監視して増分を送ります。既定は `--cwd` と同じ作業フォルダのセッションだけです(`--mirror-all` で全フォルダ)。
- プラグイン型(ローカル・リモートとも): dsh の `session/event` を購読するので、ログの解析はありません。`mirrorScope: cwd` で作業フォルダを絞れます。
- **同期を効かせるには、ブリッジの `--cwd`(プラグインの場合は `cwd` 設定)を dsh GUI の作業フォルダに合わせてください。**

### 注意

- **アプリと dsh GUI で、同じセッションを同時に実行しないでください。** デーモン型は、ログが直近 3 秒以内に更新されていて自分の実行が無い場合、`session busy in dsh` で断ります。プラグイン型は dsh の状態から判定して同じエラーを返します。
- デーモン型のログ形式(dsh 内部の v4 形式)が変わると、ミラーは stderr に警告を 1 回出して自動停止します。ブリッジ経由のチャット自体は動き続けます。
- ミラーが止まった場合は、dsh のバージョンとブリッジのバージョンが合っているか確認してください。
- プラグイン型は dsh の**内部 API**(`sessionController` など、rc 版)に依存します。dsh を更新したら、`[omnichat] disabled: … lacks sessionController.xxx` が出ないか確認してください。

## 8b. Code タブ: フォルダ別のグループ・デバイス・作業フォルダの選択(プラグイン 0.9.0 以降)

設計は [design/CODE-WORKSPACES.md](design/CODE-WORKSPACES.md)、通信は [BRIDGE-v2.md](../BRIDGE-v2.md) の D。

- **フォルダ別のグループ**: Code の一覧は、作業フォルダごとにまとまります(見出しはフォルダ名、フルパスはホバー / 長押し)。最近動いたフォルダが上、フォルダ不明の会話は「その他」。見出しをタップで折りたため、状態は端末ごとに保存されます。プラグインが古い間に作られた会話も、そのセッションが次に同期されたときにフォルダが入ります。
- **デバイス**: PC(ブリッジ)が 2 台以上あるときだけ、行にデバイス名とオンライン状態のバッジが付き、会話のヘッダーにも出ます。一覧の「デバイス別にまとめる」で、デバイス → フォルダの 2 段にできます。1 台だけのときは何も増えません。
- **新しいチャットのフォルダ**: 最初のメッセージの前に、デバイス(複数のとき)とフォルダを選べます。選択肢は、そのブリッジが知っているフォルダ(設定の `cwd`、GUI のセッションのフォルダ、過去の実行のフォルダ)です。「ブリッジの既定」は、これまでどおり DSH GUI で最後に使ったフォルダ(設定の `cwd` があればそれ)です。
- **セキュリティ**: プラグインは、知っているフォルダ以外を受け付けません(相対パス・`..`・制御文字は常に拒否)。任意のフォルダを許すのは設定 `allowAnyCwd: true`(既定 `false`)だけです。
- 古いプラグイン(0.8.x 以前)では、フォルダ選択は出ず、会話は GUI セッションのフォルダがあれば分類されます。

## 9. dsh プロバイダーの制限

OmniChat の機能のうち、dsh プロバイダーでは次が使えません。

- **分岐なし**: 再生成と「編集して再送」は拒否されます(会話は直線です)。
- **OmniChat のツール・Web 検索は対象外**: dsh は自分のツールを使います。
- **自動タイトルは対象外**。
- **構造化出力(JSON モード)は無視**されます。
- 思考過程は表示されます(折りたたみ)。
- 推論の強さ(エフォート)は転送されますが、ブリッジ側で無視されることがあります。

## 10. 検証の状況

| 項目 | 状況 |
|---|---|
| デーモン型: 開発者の PC の dsh 44.0.0 での起動、チャット、GUI との同期 | 記録に基づき確認済み(コミット時点の記録。このドキュメントの作成時には再実行していません) |
| プラグイン型(リモートモード): 0.1.0 パッケージを dsh 0.2.0-rc.2 の `web` プロファイルへ導入し、接続・実行・停止・モデル選択・ツール表示 | 記録に基づき確認済み(同上) |
| プラグイン型(0.2.0)の自動テスト: dsh-plugin の `npm test`(158 件)、アプリの中継のテスト(`npm run test:relay`、19 件) | このドキュメントの作成時に実行し、すべて合格 |
| プラグイン型・ローカルモード: 偽の dsh ホストを使ったエンドツーエンド(プラグイン → 中継 → サーバー → dsh プロバイダーでのチャット) | 確認済み(2026-10-17、実サーバー + 偽の dsh ホスト + Node 上の中継、およびアプリの Web 版を実ブラウザで接続)。**実 dsh は使っていない** |
| プラグイン型・ローカルモード: 実 dsh の `web` プロファイルでの接続と実行 | **未検証** |
| プラグイン型: `desktop` プロファイルへの導入(ローカルモードを含む) | **未検証** |
| 実際の dsh GUI(ユーザー自身の画面)での入力と同期 | **未検証** |
| アプリの設定画面からのペアリングと接続(ローカルモード) | 確認済み(Web 版を実ブラウザで操作: 接続・自動再接続・状態表示)。デスクトップ(Tauri)版は未検証 |
| 0.5.0: Code タブのモデル選択(dsh モデル)と OmniChat モデルの取り込み: 自動テストと偽の dsh ホスト(`settings` / `credentials` の偽物)で確認 | **実 dsh の GUI での取り込み・モデル一覧への反映は未検証** |
| 他の PC・他の dsh バージョン | 未検証 |

Windows 以外の dsh については、このリポジトリでは確認していません。
