# OmniChat サーバー AI インストールマニュアル

この文書は **AI コーディングエージェント**が OmniChat サーバーを自律的に導入し、各ステップを検証するための手順書です。人間向けの手順は [INSTALL.md](INSTALL.md) を参照してください。

コマンド、パス、環境変数、既定値は、リポジトリ内のコードとスクリプトを基に記載しています。コードに無いものは書いていません。確認できていない項目には **未検証** と明記しています。検証状況の全体は末尾の「検証状況」を参照してください。

## 実行の約束(必ず守る)

1. 各ステップの「確認」を実行し、期待結果と一致したら次へ進みます。一致しなければ「再試行ルール」に従います。
2. 再試行は同じステップにつき**最大 2 回**です。それでも失敗したら「トラブルシューティング」へ進みます。同じコマンドを繰り返し続けないでください。
3. パスワード、API キー、端末トークンを、コマンドライン引数、URL、チャット欄、ログ、このリポジトリのファイルに**書かないでください**。パスワードは環境変数(一般ユーザーは `OMNICHAT_PASSWORD`、管理者の作成は `OMNICHAT_ADMIN_PASSWORD`)でユーザーに設定してもらいます。`Read-Host` は非対話環境では使えません。
4. 次の操作は**ユーザーの明示的な許可を得てから**行います。ルーターのポート開放、ファイアウォールの公開範囲の変更、プロセスの強制終了、8787 番などを使用中の他プロセスの停止、データの削除(`--purge`、`REMOVEDATA=1`)、GitHub への push、コンテナレジストリへの login。
5. 管理者権限が必要な操作(Windows インストーラー、Windows サービス登録、systemd、launchd の system インストール)は、管理者の PowerShell または `sudo` で実行します。権限が無い場合はユーザーに依頼します。
6. 作業ツリーに未コミットの変更がある可能性があります。最初に `git status` で確認してください。`git reset` や `git checkout --` は実行しないでください。
7. リポジトリのファイル(特にソースと `packaging/`)は編集しないでください。設定は環境変数または `config.env` で行います。

---

## 1. 概要と前提条件

OmniChat サーバーは Node.js 24 上で動く Fastify サーバーです(`server/`)。SQLite を `node:sqlite` で使うため、Node.js 24 以上が必要です(`server/package.json` の `engines` は `>=24`)。Web クライアントは任意で、`WEB_DIR` が指す静的ファイルとして配信されます。Web クライアントが無くても API は動きます。

### 1.1 前提条件

| 項目 | 要件 | 確認コマンド | 根拠 |
|---|---|---|---|
| Node.js | 24 以上 | `node -v`(Windows / sh 共通) | `server/package.json` |
| npm | Node.js に同梱のもの | `npm -v` | `server/package.json` の `npm ci` に必要 |
| git | ソースから導入する場合のみ | `git --version` | - |
| ポート | 既定 `8787/TCP` が空いていること(変更可) | 下記 | `server/src/config.ts` |
| OS | Windows 10/11 x64(PowerShell 5.1 以上)、Linux(systemd)、macOS(arm64 / x64) | `$PSVersionTable.PSVersion` / `uname -sm` | `packaging/` |
| 権限 | サービス登録とインストーラーは管理者 / root。ソース起動と CLI は通常ユーザーで可 | - | `packaging/` |
| 任意 | Web 検索(SearXNG は任意。空でもキー不要の内蔵検索で使える)、LM Studio / Ollama などのローカル LLM、dsh(DeepSeek Harness) | - | `docs/SEARCH.md`、`docs/DSH.md` |

ポートの確認:

#### Windows PowerShell
```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
```

#### Linux/macOS (sh)
```sh
ss -ltn 'sport = :8787'                  # Linux
lsof -nP -iTCP:8787 -sTCP:LISTEN         # macOS(何も出ないと終了コード 1)
```

### 1.2 方法の選び方

| 方法 | 手順 | 使う場面 | 検証状況 |
|---|---|---|---|
| A. ソースから起動 | 2-c | 試す、開発、検証。常駐化はしない | tsx 経由の起動と API 確認は開発 PC で記録あり(`docs/HANDOFF.md` §2)。`npm run build` と `node dist/index.js` での起動は**未検証** |
| B. install-server スクリプト | 2-d | 常駐化(Windows / Linux / macOS)。推奨 | **未検証**。`packaging/install-server.sh`(bash 専用)と `packaging/windows/install-server.ps1` がリポジトリにあります。実行前に存在を確認してください |
| C. Docker Compose | 2-e | Docker を使う環境 | **未検証**(イメージのビルドも取得も) |
| D. 配布物 | 2-d の代わりに手動で | 配布版を使う | **未検証**(Inno Setup、WinSW、tarball、`install.sh` / `uninstall.sh` の実行記録なし) |

選び方の規則:

- ユーザーが Docker を指定した場合は C。
- ユーザーが配布版(インストーラーや tarball)を指定した場合は D。
- 常駐化が必要で方法の指定が無い場合は、B のスクリプトが存在すれば B(必ず `--dry-run` を先に実行)。存在しなければユーザーに方法を確認します。
- A は常駐化しません。PC の再起動後は止まります。

---

## 2. 手順

各ステップは、目的、実行(Windows PowerShell と Linux/macOS sh の 2 つ)、確認、再試行ルールの順に書いています。

### 2-a. 前提を確認する

**目的**: Node.js、npm、git、ポートを確認します。

#### Windows PowerShell
```powershell
node -v
npm -v
git --version
$PSVersionTable.PSVersion
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
```

#### Linux/macOS (sh)
```sh
node -v
npm -v
git --version
uname -sm
ss -ltn 'sport = :8787'                  # Linux
lsof -nP -iTCP:8787 -sTCP:LISTEN         # macOS
```

**確認**
- `node -v` の出力が `v24.` で始まる。
- `npm -v` と `git --version` が版番号を出す(`git version 2.` で始まる)。
- ポートの確認で、リスナーが一覧に**無い**(Windows は何も出ない。Linux の `ss` は見出し行だけ)。

**再試行ルール**
- Node.js が 24 未満の場合: 導入方法はユーザーに確認し、ユーザーの許可を得てから入れます。自動では入れません。
- ポート 8787 が使用中の場合: 使用しているプロセスを確認し、停止はユーザーに確認します。許可が出ない場合は、以降の手順の `8787` を別の空きポート(例: `8790`)に読み替えます。

---

### 2-b. コードを取得する

**目的**: リポジトリをローカルに用意します。

**リポジトリ URL はユーザーに確認してください。** このリポジトリの `origin` は `https://github.com/remuno3751/omnichat.git` ですが、GitHub 上の所有者は `remuno3751` です。リポジトリの公開範囲(非公開 / 公開)はユーザーの判断です。ローカルにすでにコードがある場合は clone せず、そのパスを使います。

#### Windows PowerShell
```powershell
git clone <ユーザーに確認した URL> C:\omnichat
cd C:\omnichat
git status
git log -1 --oneline
```

#### Linux/macOS (sh)
```sh
git clone <ユーザーに確認した URL> ~/omnichat
cd ~/omnichat
git status
git log -1 --oneline
```

**確認**
- `git log -1 --oneline` が `<7 桁以上のハッシュ> <コミット件名>` の形で出る。
- Windows: `Test-Path .\server\package.json` が `True`。sh: `test -f server/package.json && echo ok` が `ok` を出す。
- `git status` の内容をユーザーに報告する(未コミットの変更がある場合は、その扱いをユーザーに確認する)。

**再試行ルール**: 認証エラーでの clone 失敗は、認証方法をユーザーに確認します(再試行は 1 回まで)。URL が無い場合は作業を止め、ユーザーに URL を求めます。

---

### 2-c. ソースからサーバーを起動する(方法 A)

**目的**: `server/` を直接ビルドして起動します。Web クライアントは任意です。

#### Windows PowerShell
```powershell
cd C:\omnichat\server
npm ci
npm run build
Test-Path .\dist\index.js
```

起動(専用のターミナルで実行し、止めずに置いておきます):
```powershell
$env:PORT = "8787"
$env:HOST = "127.0.0.1"
$env:DATA_DIR = "C:\omnichat-data"
node dist\index.js
```

- `HOST` を `127.0.0.1` にすると、この PC からだけアクセスできます。他の端末から使う場合は、ユーザーに確認したうえで `0.0.0.0`(既定値)にします。
- `DATA_DIR` は無ければ自動で作られます(`server/src/db.ts`)。
- 停止は `Ctrl+C`。環境変数を消すには `Remove-Item Env:PORT, Env:HOST, Env:DATA_DIR` を実行します。

#### Linux/macOS (sh)
```sh
cd ~/omnichat/server
npm ci && npm run build
test -f dist/index.js && echo built
PORT=8787 HOST=127.0.0.1 DATA_DIR="$HOME/omnichat-data" node dist/index.js
```

**Web クライアント(任意、通常は必要)**: `WEB_DIR` が存在しないと、API のみが動きます。`packaging/build-release.mjs` と同じ方法で書き出します。

#### Windows PowerShell
```powershell
cd C:\omnichat\app
npm ci
npx expo export --platform web --output-dir C:\omnichat-web
Test-Path C:\omnichat-web\index.html
$env:WEB_DIR = "C:\omnichat-web"     # サーバーを再起動すると反映される
```

#### Linux/macOS (sh)
```sh
cd ~/omnichat/app
npm ci
npx expo export --platform web --output-dir "$HOME/omnichat-web"
test -f "$HOME/omnichat-web/index.html" && echo web-ok
WEB_DIR="$HOME/omnichat-web"         # サーバーを再起動すると反映される
```

書き出し先に `index.html` が無い場合は失敗です(`build-release.mjs` も同じ条件で失敗します)。

**確認**(起動したサーバーとは別のターミナルで実行します)

#### Windows PowerShell
```powershell
curl.exe -s http://localhost:8787/healthz
curl.exe -s http://localhost:8787/version
```

#### Linux/macOS (sh)
```sh
curl -s http://localhost:8787/healthz
curl -s http://localhost:8787/version
```

- 起動ターミナルに `OmniChat server listening on :8787` が出ている。
- `/healthz` の出力が `ok`。
- `/version` の出力が次のとおり(`WEB_DIR` 未設定の場合):
  ```
  {"name":"omnichat-server","version":"0.1.0","webUi":false,"searxng":false}
  ```
  `WEB_DIR` を設定して再起動した後は `"webUi":true` になります。`version` は `server/package.json` の値と一致します。

**再試行ルール**
- `npm ci` が失敗: `node -v` を確認し、ネットワークを確認して 1 回再試行します。
- `npm run build` が失敗: TypeScript のエラー全文を記録して作業を止め、報告します。コードは勝手に直さないでください。
- `listen EADDRINUSE`(ポート使用中): `PORT` を別の値にするか、2-a の再試行ルールに従います。
- `/healthz` が応答しない: 起動ターミナルに `OmniChat server listening on :8787` が出ているか確認します。出ていなければ、表示されたエラーを読みます。

---

### 2-d. install-server スクリプトで導入する(方法 B、未検証)

**目的**: 依存関係の確認、設定ファイルの作成、サービス登録、`omnichat doctor` の実行を一括で行います。

**注意**: 次で存在を確認してください。存在しなければ、このステップを飛ばして 2-c、2-e、または配布版(方法 D)を選びます。

#### Windows PowerShell
```powershell
Test-Path C:\omnichat\packaging\windows\install-server.ps1
```

#### Linux/macOS (sh)
```sh
test -f ~/omnichat/packaging/install-server.sh && echo exists
```

**必ず先に `--dry-run` を実行してください。** 本番実行はユーザーの許可を得てから行います。

Windows(管理者の PowerShell):
```powershell
cd C:\omnichat
.\packaging\windows\install-server.ps1 -DryRun
# 本番(許可後)。-Yes で確認を省略。ポート、SearXNG、登録の方針、bridge 名を指定
.\packaging\windows\install-server.ps1 -Yes -Port 8787 -BridgeName my-pc
# 任意の追加指定: -AllowRegistration / -SearxngUrl "http://localhost:8888" / -BindHost / -InstallDir / -DataRoot / -SkipFirewall
```

Linux/macOS(root):
```sh
cd ~/omnichat
bash packaging/install-server.sh --dry-run
sudo bash packaging/install-server.sh --yes --port 8787 --bridge-name my-pc
# 任意の追加指定: --allow-registration | --no-registration / --searxng-url URL / --host ADDR / --data-dir DIR
```

- 方法 D(配布物)を選んだ場合の導入は、[INSTALL.md](INSTALL.md) の B / C / D 節に従います。こちらも未検証です。
- 既定値(ポート、登録の可否など)はスクリプトの定義を確認してください。このマニュアルでは検証していません。
- 両スクリプトは、仕様上は最後に `omnichat doctor` を実行します(作成中の仕様です)。
- 作成者の報告では、Windows で `--dry-run` のみ確認されています。本番実行、Linux、macOS は**未検証**です。

**確認**
- `--dry-run` の終了コードが `0`(PowerShell は `$LASTEXITCODE`、sh は `echo $?`)。出力の内容は作成中の仕様に依存し、未確認です。出力に、実行される操作(ファイルのコピー、サービス登録、ファイアウォール)がすべて列挙されていることを確認してください。
- 本番実行の後、2-c の `/healthz` と `/version` の確認を行います。`curl.exe -s http://localhost:8787/healthz` が `ok` を返します。
- Windows のサービス状態: `sc.exe query OmniChat` の `STATE` 行に `RUNNING`(一般的な出力形式。未確認)。

**再試行ルール**: 終了コードが非 0 の場合、出力の最初の `FAIL` 行を読み、トラブルシューティングの表で対処します。スクリプトは編集しないでください。再試行は 1 回までです。

---

### 2-e. Docker Compose で起動する(方法 C、未検証)

**目的**: コンテナで起動します。**イメージのビルドも取得も未検証です。**

このリポジトリのルートで、ローカルでビルドしたイメージを使います(compose ファイルは編集しません)。

#### Windows PowerShell
```powershell
cd C:\omnichat
docker build -t omnichat:local .
$env:OMNICHAT_IMAGE = "omnichat:local"
$env:ALLOW_REGISTRATION = "0"
docker compose up -d
docker compose ps
```

#### Linux/macOS (sh)
```sh
cd ~/omnichat
docker build -t omnichat:local .
export OMNICHAT_IMAGE=omnichat:local ALLOW_REGISTRATION=0
docker compose up -d
docker compose ps
```

- 公開イメージを使う場合は `OMNICHAT_IMAGE=ghcr.io/<所有者>/omnichat:<版>` を指定します。所有者はユーザーに確認してください。`docs/RELEASING.md` の既定値は `remuno3751` です。非公開パッケージの場合は `docker login ghcr.io` が必要です(ユーザーが行う)。
- `docker-compose.yml` は `ports: "127.0.0.1:${OMNICHAT_PORT:-8787}:8787"` で、この PC のループバックだけに公開されます(既定)。他の端末から使う場合は、ユーザーに確認してから `127.0.0.1` を `0.0.0.0` に変えるか、リバースプロキシ経由にしてください。`0.0.0.0` にする前に、最初のアカウント(管理者)の登録を済ませておきます。
- データは名前付きボリューム `omnichat-data`(コンテナ内 `/data`)に保存されます。

**確認**
- `docker compose ps` の STATUS 列が `(healthy)` になる(起動後、Dockerfile の HEALTHCHECK の `start-period` 15 秒、間隔 30 秒。未検証)。
- `curl.exe -s http://localhost:8787/healthz`(sh は `curl -s`)が `ok` を返す。

**再試行ルール**: `unhealthy` の場合は `docker compose logs --tail 100 omnichat` を読みます。`docker build` の失敗は 1 回だけ再試行し、エラー全文を報告して止まります。

---

### 2-f. 最初のアカウント(管理者)を作る

**目的**: 管理者を 1 人作ります。管理者は HTTP(`/auth/register`)からは作れません。管理者がいないときの `/auth/register` は 403 `No administrator exists yet` を返します。管理者は、サーバーを動かしている機械で管理者 CLI(`omnichat-admin`、Docker や開発用では `node dist/admin-cli.js`)で作ります。

**事前条件**: ユーザーに、ユーザー名(3〜32 文字)とパスワード(8 文字以上)を決めてもらいます。パスワードは**コマンドライン引数、URL、ファイル、このリポジトリに書かず**、次のどちらかで渡します。
- 環境変数 `OMNICHAT_ADMIN_PASSWORD`(ユーザーが自分のシェルで設定する)
- 対話入力(端末でコマンドを実行し、ユーザーがパスワードを入力する)

エージェントの実行環境に端末がない場合は、下のコマンドをユーザーに渡して自分で実行してもらいます。

#### Linux(systemd、`sudo` が必要)
```sh
# ユーザーが設定済みの前提: $OMNICHAT_ADMIN_PASSWORD(sudo で渡すため --preserve-env を付ける)
sudo --preserve-env=OMNICHAT_ADMIN_PASSWORD omnichat-admin create <ユーザー名>
```
対話入力の場合は `sudo omnichat-admin create <ユーザー名>` です。

#### macOS(sudo は付けない)
```sh
# system インストール
omnichat-admin create <ユーザー名>
# ユーザー単位のインストール
"$HOME/Library/Application Support/OmniChat/app/omnichat-admin" create <ユーザー名>
```

#### Windows(管理者として開いた PowerShell / コマンドプロンプト)
```bat
"C:\Program Files\OmniChat\omnichat-admin.cmd" create <ユーザー名>
```
(`omnichat-admin.cmd` は未検証です。動かなければ、パスワードを対話入力する方法を試し、結果をユーザーに報告してください。)

#### Docker
```sh
# ユーザーが設定済みの前提: $OMNICHAT_ADMIN_PASSWORD(-e に値を付けないと、この環境変数がコンテナに渡る)
docker exec -e OMNICHAT_ADMIN_PASSWORD omnichat node dist/admin-cli.js create <ユーザー名>
```

#### ソースから起動(開発)
```sh
# サーバーと同じ DATA_DIR を指定する(違うと、起動中のサーバーの DB に入りません)
cd ~/omnichat/server && DATA_DIR=<サーバーと同じ DATA_DIR> node dist/admin-cli.js create <ユーザー名>
```
`dist/` が無い場合は先に `npm ci && npm run build` を実行します。

**確認**: 管理者 CLI の一覧で、そのユーザーの role が `admin` になっている(`omnichat-admin list` / `docker exec omnichat node dist/admin-cli.js list`)。続けて、同じ資格情報で `POST /auth/login` を呼び、応答の `isAdmin` が `true` であることを確かめます。

#### Windows PowerShell
```powershell
# ユーザーが設定済みの前提: $env:OMNICHAT_ADMIN_PASSWORD
$body = @{ username = '<ユーザー名>'; password = $env:OMNICHAT_ADMIN_PASSWORD; deviceName = 'ai-installer'; platform = 'cli' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/auth/login' -ContentType 'application/json' -Body $body
$login.isAdmin
```

#### Linux/macOS (sh)
```sh
# ユーザーが設定済みの前提: $OMNICHAT_ADMIN_PASSWORD
curl -s -X POST http://localhost:8787/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"<ユーザー名>\",\"password\":\"$OMNICHAT_ADMIN_PASSWORD\",\"deviceName\":\"ai-installer\",\"platform\":\"cli\"}"
```

期待結果: `True`(PowerShell)、または応答に `"isAdmin":true` を含む JSON(sh)。端末トークンは画面やログに出さないでください。

**再試行ルール**
- `403` と `No administrator exists yet`: HTTP からは管理者を作れません。上の管理者 CLI を使います。
- `create` が `Username already taken`(409): 同名のユーザーが既にいます。作り直さず、ログインを使います。パスワードを変える場合は、ユーザーの許可を得て `set-password <名前>` を実行してもらいます。
- `403` と `registration is disabled`: 管理者はいますが、自己登録が無効です。一般ユーザーは `omnichat-admin create <名前> --role user` で作ります。`ALLOW_REGISTRATION=1` は、ユーザーの許可を得たときだけ一時的に設定し、登録後に必ず `0` に戻して再起動します。
- `400` と `Username must be 3-32 characters` / `Password must be at least 8 characters`: 入力を直します。パスワードはユーザーに確認し直してください。
- ログインが `429` を返す場合は、同じ IP とユーザー名で 5 分間に 10 回失敗しています。5 分待ちます。

---

### 2-g. CLI で接続を確認する

**目的**: `cli/`(`omnichat` コマンド)でサーバーにログインし、モデル一覧を取得します。CLI は Node.js 22 以上で動きます(`cli/package.json`)。

#### Windows PowerShell
```powershell
cd C:\omnichat
$env:OMNICHAT_PASSWORD = '<ユーザーが設定したパスワード>'   # 非対話では、標準入力の 1 行目か環境変数から読まれる
node cli\bin\omnichat.mjs login --server http://localhost:8787 --username <ユーザー名>
node cli\bin\omnichat.mjs whoami
node cli\bin\omnichat.mjs models
```

#### Linux/macOS (sh)
```sh
cd ~/omnichat
export OMNICHAT_PASSWORD='<ユーザーが設定したパスワード>'
node cli/bin/omnichat.mjs login --server http://localhost:8787 --username <ユーザー名>
node cli/bin/omnichat.mjs whoami
node cli/bin/omnichat.mjs models
```

トークンは CLI の設定ファイルに保存されます。Windows は `%APPDATA%\omnichat\config.json`、macOS と Linux は `$XDG_CONFIG_HOME/omnichat/config.json`(未設定なら `~/.config/omnichat/config.json`)です。権限は 0600 です(Windows では設定されません)。

**確認**
- `whoami` の終了コードが `0`(PowerShell は `$LASTEXITCODE`)で、ユーザー名と接続先が表示される。
- `models` の終了コードが `0`。モデルが 0 件の場合は、2-h でプロバイダーを登録してから再実行します。
- 出力の体裁は未確認です。モデル名は `<プロバイダー名>/<モデル ID>` の形式です(`cli/README.md`)。

**再試行ルール**: 終了コード `1` で `cannot reach server` の場合は、URL とサーバーの起動を確認します。終了コード `2` は使い方の誤りです。`cli/README.md` のコマンド一覧で書式を確認します。

---

### 2-h. プロバイダー(LLM の接続先)を追加する

**目的**: OpenAI 互換の API(LM Studio、Ollama など)を登録します。画面の手順は [FEATURES.md](FEATURES.md) §3 を参照してください。ここでは API で登録する例を示します。

- `kind` は `openai-compatible` か `dsh-bridge` です(`GET /provider-kinds` で確認できます)。
- 登録する LLM サーバーは、OmniChat サーバーと同じ PC、またはアクセス可能な場所で起動している必要があります。
- LM Studio の既定 URL は `http://localhost:1234/v1` です。サーバーは、LM Studio、Ollama(11434)、llama.cpp(8080)、vLLM(8000)を自動検出します(`server/src/local-servers.ts`)。
- API キーが必要なプロバイダーの場合は、ユーザーに値をもらい、`apiKey` フィールドに入れます。チャットには書かないでください。API キーはサーバーの DB に平文で保存されます。

#### Windows PowerShell
```powershell
$providerId = [guid]::NewGuid().ToString()
$p = @{ name = 'LM Studio'; kind = 'openai-compatible'; baseUrl = 'http://localhost:1234/v1'; model = '<モデル ID>' } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "http://localhost:8787/providers/$providerId" -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $p
Invoke-RestMethod -Uri "http://localhost:8787/providers/$providerId/models" -Headers @{ Authorization = "Bearer $token" }
```

#### Linux/macOS (sh)
```sh
PROVIDER_ID=$(uuidgen | tr 'A-Z' 'a-z')     # uuidgen が無い場合は任意の UUID 文字列
curl -s -X PUT "http://localhost:8787/providers/$PROVIDER_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"LM Studio","kind":"openai-compatible","baseUrl":"http://localhost:1234/v1","model":"<モデル ID>"}'
curl -s "http://localhost:8787/providers/$PROVIDER_ID/models" -H "Authorization: Bearer $TOKEN"
```

- `<モデル ID>` は LM Studio で読み込んだモデルの ID に置き換えます。
- プロバイダー ID は、クライアントが生成する任意の一意な文字列です。

**確認**
- `PUT` の応答に `name` と `baseUrl` が含まれ、API キーは含まれない。
- `GET /providers/<ID>/models` が HTTP 200 で JSON を返す。
- `omnichat models`(2-g)に `LM Studio/<モデル ID>` の行が出る。

**再試行ルール**
- `400` と `name, kind, baseUrl and model are required`: 4 つのフィールドのどれかが無い。
- `GET .../models` が `502` または `504`: LLM サーバーが起動していないか、URL が違う。`curl http://localhost:1234/v1/models` で直接確認します。
- 2 回で直らない場合は、トラブルシューティングへ進みます。

---

### 2-i. SearXNG で Web 検索を有効にする(任意)

**目的**: 自前の SearXNG を使って Web 検索を有効にします。SearXNG 自体の導入は扱いません。

**前提**: SearXNG の `settings.yml` で JSON 出力を有効にします(`docs/SEARCH.md` §1)。JSON が無効だと 403 になります。

```yaml
search:
  formats:
    - html
    - json
```

確認(SearXNG がホストの 8888 番で動いている例):
```sh
curl "http://localhost:8888/search?q=test&format=json"
```
応答が JSON(先頭が `{`)であること。HTML が返る場合は設定を直します。

OmniChat の設定: `SEARXNG_URL=http://localhost:8888` を設定して OmniChat を再起動します。
- Windows サービス版: `%ProgramData%\OmniChat\config.env` に `SEARXNG_URL=http://localhost:8888` を書きます(引用符は付けない)。再起動は `net stop OmniChat` の後に `net start OmniChat`。
- ソースから起動: 起動前に `$env:SEARXNG_URL = "http://localhost:8888"`(sh は `SEARXNG_URL=...`)を設定します。
- Linux: `/etc/omnichat/config.env` に書いて `sudo systemctl restart omnichat`。
- Docker: `docker-compose.yml` の `SEARXNG_URL` の行(コメントを外す)。同じネットワークに参加する場合の注意は `docs/SEARCH.md` §2 を参照。

**確認**

#### Windows PowerShell
```powershell
curl.exe -s http://localhost:8787/version
curl.exe -s -H "Authorization: Bearer $token" http://localhost:8787/search/status
```

#### Linux/macOS (sh)
```sh
curl -s http://localhost:8787/version
curl -s http://localhost:8787/search/status -H "Authorization: Bearer $TOKEN"
```

- `/version` が `"searxng":true` を含む。
- `/search/status` の応答に `"reachable":true` があり、`"error"` が無い。
- 管理者として `POST /search/test` に `{"query":"test"}` を送ると、`results` を含む応答が返る。

新規アカウントには `web_search` の承認が事前に付与されます(`OMNICHAT_DEFAULT_SEARCH_GRANT=0` で無効)。

**再試行ルール**: エラーは `docs/SEARCH.md` §5 の表で対処します。再試行は 1 回までです。

---

### 2-j. バックアップを確認する(任意)

**目的**: 自動バックアップが有効であることと、手動バックアップが作れることを確認します。詳細は [BACKUP.md](BACKUP.md)。

- 既定: `BACKUP_INTERVAL_HOURS=24`(24 時間ごと)、`BACKUP_KEEP=7`(7 個保持)。最初の判定は起動の約 5 分後です(`BACKUP_FIRST_DELAY_MS` 既定 `300000`)。
- 保存先は `$DATA_DIR/backups/`(`omnichat-YYYYMMDD-HHMMSS.db`)です。
- バックアップには API キーが平文で含まれます。保管場所はユーザーに確認してください。

手動バックアップ(管理者のトークンが必要):

#### Windows PowerShell
```powershell
$b = Invoke-RestMethod -Method Post -Uri 'http://localhost:8787/admin/backup' -Headers @{ Authorization = "Bearer $token" }
$b.name
Test-Path "C:\omnichat-data\backups\$($b.name)"
```

#### Linux/macOS (sh)
```sh
curl -s -X POST http://localhost:8787/admin/backup -H "Authorization: Bearer $TOKEN"
ls "$HOME/omnichat-data/backups/"
```

**確認**: 応答に `name`、`size`、`createdAt` があり、ファイルが存在する。

**再試行ルール**: `403` と `Admin only` は、管理者ではないアカウントです。管理者でログインし直します。復元は、ユーザーの明示的な指示があるまで行わないでください(手順は BACKUP.md)。

---

### 2-k. dsh(DeepSeek Harness)を接続する(任意、Windows で確認済み)

**目的**: この PC の dsh を OmniChat から操作できるようにします。対象は dsh がインストールされた PC だけです。

**セキュリティ警告**: OmniChat アカウントを持つ人は、このブリッジが動く PC のシェルやファイルを操作できます。デーモン型は承認なしで実行します。強いパスワードを使い、`--cwd` には専用の低リスクなフォルダを指定してください(`docs/DSH.md` §6)。

**方式は 1 つだけ選びます。同じ名前(`--name` / `name`)でデーモン型とプラグイン型を同時に動かしてはいけません。**

先に、OmniChat で dsh プロバイダーを作ります。`PUT /providers/<ID>` で `kind` を `dsh-bridge`、`baseUrl` をブリッジ名(例: `my-pc`)、`model` を `dsh` にします。または画面の「DeepSeek Harness (PC bridge)」プリセットを使います。

#### k-1. デーモン型(`bridge/`)

Windows PowerShell:
```powershell
New-Item -ItemType Directory -Force C:\work\agent | Out-Null   # 専用の作業フォルダ
cd C:\omnichat\bridge
npm install
$env:OMNICHAT_PASSWORD = '<ユーザーが設定したパスワード>'
npm start -- --server http://localhost:8787 --username <ユーザー名> --cwd C:\work\agent --name my-pc
```

Linux/macOS (sh): dsh の Windows 向けの既定パスは使えないため、対応は未検証です。ユーザーに確認してください。

**確認**: 起動ログに `connected as 'my-pc'` が出る。サーバーの `GET /bridges` で `"online":true` が表示される。

```powershell
curl.exe -s -H "Authorization: Bearer $token" http://localhost:8787/bridges
```
期待結果の形: `{"bridges":[{"name":"my-pc","cwd":"C:\\work\\agent","online":true}]}`

#### k-2. プラグイン型(`dsh-plugin/`、`web` プロファイル)

Windows PowerShell:
```powershell
cd C:\omnichat\dsh-plugin
npm install
npm pack                       # 出力: omnichat-dsh-bridge-0.1.0.tgz
dsh plugin --profile web add C:\omnichat\dsh-plugin\omnichat-dsh-bridge-0.1.0.tgz
$env:OMNICHAT_SERVER_URL = 'http://localhost:8787'
$env:OMNICHAT_TOKEN = $token
$env:OMNICHAT_NAME = 'my-pc'
dsh web --no-open --port 8123
```

- `.tgz` は**絶対パス**で指定します。`dsh` コマンドが無い場合は、dsh のインストール先をユーザーに確認します。
- 更新は `dsh plugin --profile web remove @omnichat/dsh-bridge` の後に `add` し直します。
- `desktop` プロファイルへの導入は**未検証**です。

**確認**: 起動ログに `[omnichat] connected as 'my-pc'` が出る。`GET /bridges` で `"online":true` が表示される(k-1 と同じ)。

**再試行ルール**
- `disabled: invalid configuration`: 環境変数の値を確認します(`OMNICHAT_SERVER_URL` が必須)。
- `Bridge 'my-pc' is offline`: ブリッジが起動していない、名前が違う、またはデーモンとプラグインが同名で競合しています。
- `session busy in dsh`: 同じセッションを dsh 側で実行中です。終わるまで待つか、別の会話にします。
- 2 回で直らない場合は、トラブルシューティングへ進みます。

---

## 3. 設定

### 3.1 設定の仕組み

- サーバーは**設定ファイルを読みません**。環境変数だけを読みます(`server/src/config.ts` ほか)。
- `server/src/configfile.ts` は、アプリの設定(プロジェクト、プリセット、設定値)のインポートとエクスポートの機能です。サーバーの環境変数ファイルではありません。
- `config.env` は `KEY=VALUE` 形式のファイルで、サービスのラッパーが読み込んで環境変数にします。`#` で始まる行はコメントです。

| 導入方法 | `config.env` の場所 | 読み込む仕組み |
|---|---|---|
| Windows サービス(インストーラー、B) | `%ProgramData%\OmniChat\config.env` | `run-service.cmd`(WinSW から起動)。行の形式は `KEY=VALUE`。`=` の前後に空白を入れず、**引用符を付けない** |
| Linux(systemd、D) | `/etc/omnichat/config.env` | systemd の `EnvironmentFile=`(`packaging/linux/omnichat.service`) |
| macOS(launchd、D) | system: `/usr/local/omnichat-data/config.env` / user: `~/Library/Application Support/OmniChat/config.env` | `run.sh` が `KEY=VALUE` の行として読み込みます(`source` しません)。`=` の最初の1つより後ろがそのまま値です。空白を含む値(既定の `DATA_DIR` など)も引用符なしで書きます |
| Docker(C) | `docker-compose.yml` の `environment:` | Compose が環境変数として渡します |
| ソースから起動(A) | なし | シェルの環境変数で指定します |

変更後は必ずサービスを再起動します。

### 3.2 サーバーの環境変数(すべて)

既定値は、コードの `process.env` の読み取り箇所に基づきます。真偽値の解釈は変数ごとに違います。`ALLOW_REGISTRATION` と `TRUST_PROXY` は `1` または `true` のときだけ有効です。`AUTO_TITLE_DEFAULT`、`OMNICHAT_QUOTES`、`OMNICHAT_INJECT_DATE`、`OMNICHAT_DEFAULT_SEARCH_GRANT`、`OMNICHAT_MODEL_LOGOS` は `0` のときだけ無効になり、それ以外の値では有効のままです。

| 変数 | 既定 | 意味 | 読む場所 |
|---|---|---|---|
| `PORT` | `8787` | 待ち受けポート | `config.ts` |
| `HOST` | `0.0.0.0` | 待ち受けアドレス。同じ PC だけなら `127.0.0.1` | `config.ts` |
| `DATA_DIR` | `./data`(カレントディレクトリ基準) | DB、バックアップ、effort-map、plugins の親フォルダ | `config.ts`、`effort.ts`、`backup.ts` |
| `DB_PATH` | `$DATA_DIR/omnichat.db` | SQLite の DB ファイル。親フォルダは自動作成 | `config.ts`、`db.ts` |
| `WEB_DIR` | `./web`(カレントディレクトリ基準) | Web クライアントの配置先。無ければ API のみ(`/version` の `webUi` が `false`) | `config.ts`、`static.ts` |
| `ALLOW_REGISTRATION` | `0` | `1` または `true` で、管理者の作成後に一般ユーザーの自己登録を許可。それ以外は禁止。管理者は HTTP からは作れず、`omnichat-admin create` / `admin-cli.js create` で作る | `config.ts`、`auth.ts` |
| `OMNICHAT_OPEN_FIRST_REGISTRATION` | `0` | **テスト専用。製品では使わない。** `1` にすると管理者がいない間は `/auth/register` で最初のアカウントが管理者になる旧仕様に戻る | `config.ts`、`auth.ts` |
| `EFFORT_MAP` | `$DATA_DIR/effort-map.json` | 推論エフォートの対応表。無ければ既定値で作る | `config.ts`、`effort.ts` |
| `CORS_ORIGIN` | 空(全オリジン許可) | 許可するオリジンのカンマ区切り | `config.ts`、`index.ts` |
| `TRUST_PROXY` | `0` | `1` または `true` で、リバースプロキシの背後にあると見なす。WebSocket の接続経路(route)判定に `X-Forwarded-For` を使い、ログイン試行制限もプロキシ越しの本来のクライアント IP 単位になる | `config.ts`、`index.ts` |
| `OMNICHAT_SECRET_KEY` | 未設定 | 16 文字以上の文字列。プロバイダー API キーを暗号化(AES-256-GCM)する鍵の元にする。未設定なら `DATA_DIR/secret.key`(ランダム 32 バイト、権限 0600)を自動作成して使う。**この鍵を失うと保存済みの API キーは復号できない**(再入力が必要)。バックアップの保管先に `secret.key` を一緒に置かないこと | `secret.ts` |
| `PLUGINS_DIR` | `$DATA_DIR/plugins` | ツール用プラグインの置き場所 | `tools/registry.ts` |
| `BACKUP_INTERVAL_HOURS` | `24` | 自動バックアップの間隔(時間)。`0` で無効。不正な値は既定値 | `backup.ts` |
| `BACKUP_KEEP` | `7` | 保持するバックアップ数(最小 1) | `backup.ts` |
| `BACKUP_FIRST_DELAY_MS` | `300000` | 最初の自動判定までの遅延(テスト用。通常は変更しない) | `backup.ts` |
| `SEARXNG_URL` | 空 | SearXNG の URL。SearXNG は任意になった。空でも内蔵検索(キー不要)で `web_search` は使える。空のときは SearXNG 方式だけが使えず、`/version` の `searxng` が `false` | `search/searxng.ts`、`search/config.ts` |
| `SEARXNG_ENGINES` | 空 | SearXNG の `engines` パラメーターにそのまま渡す文字列(例: `bing news,yandex`) | `search/searxng.ts` |
| `SEARXNG_TIMEOUT_MS` | `8000` | SearXNG への要求の上限(ms) | `search/searxng.ts` |
| `SEARCH_MAX_RESULTS` | `5` | 1 回の検索の件数。正の整数でなければ 5、上限は 20 | `search/index.ts` |
| `SEARCH_BACKEND` | 未設定なら `SEARXNG_URL` があれば `searxng`、なければ `builtin` | Web 検索の既定の方式(`searxng` / `builtin` / `api`)。画面の設定があればそちらが優先 | `search/config.ts` |
| `SEARCH_ENGINES` | `bing-rss,wikipedia,duckduckgo` | 有効にするエンジン ID のカンマ区切り(内蔵と API の両方を書ける。API 側は `brave`、`tavily`) | `search/config.ts` |
| `SEARCH_FALLBACK` | `1` | `0` で、選んだ方式が失敗したときほかの方式を試す自動フォールバックを止める | `search/config.ts` |
| `SEARCH_LANG` | `ja` | 内蔵エンジン(Wikipedia など)の言語 | `search/builtin/util.ts` |
| `SEARCH_ENGINE_TIMEOUT_MS` | `6000` | 内蔵・API のエンジン 1 件の上限(ms) | `search/builtin/http.ts` |
| `BRAVE_API_KEY` | 空 | Brave Search API のキー。ログや API には出ない。DB の設定が優先 | `search/config.ts`、`search/builtin/brave.ts` |
| `TAVILY_API_KEY` | 空 | Tavily のキー。ログや API には出ない。DB の設定が優先 | `search/config.ts`、`search/builtin/tavily.ts` |
| `OMNICHAT_SEARCH_BASE_<ENGINE>` | 各エンジンの公式 https | エンジンの接続先の上書き(テスト用。ループバックの http(s) のみ)。例: `OMNICHAT_SEARCH_BASE_BING_RSS` | `search/builtin/http.ts` |
| `OMNICHAT_SEARCH_COOLDOWN_MS` | `600000` | 3 回連続失敗後の休止時間の基準(ms)。以後は倍になり、最大 1 時間 | `search/builtin/aggregator.ts` |
| `OMNICHAT_SEARCH_CACHE_TTL_MS` | `60000` | 同じ検索語の結果キャッシュ(ms)。`0` で無効 | `search/builtin/aggregator.ts` |
| `TOOL_TIMEOUT_MS` | `30000` | ツール 1 回の実行上限(ms) | `tools/registry.ts` |
| `TOOL_APPROVAL_TIMEOUT_MS` | `120000` | ツール承認を待つ上限(ms)。超えた場合の扱いは INSTALL.md の記載どおり(拒否扱い) | `tools/approvals.ts` |
| `AUTO_TITLE_DEFAULT` | `1` | `0` で、ユーザーが未設定のとき自動タイトルの既定をオフ | `projects.ts` |
| `OMNICHAT_TZ` | システムのタイムゾーン | 現在日時の挿入と相場の日付の基準 | `prompts.ts`、`quotes.ts` |
| `OMNICHAT_INJECT_DATE` | 有効 | `0` で現在日時のシステムプロンプトへの挿入を止める(テストで使用) | `prompts.ts` |
| `OMNICHAT_QUOTES` | 有効 | `0` で株価・為替・暗号資産の相場取得を止める | `chat.ts` |
| `OMNICHAT_DEFAULT_SEARCH_GRANT` | 有効 | `0` で、新規アカウントへの `web_search` の事前許可を止める | `tools/approvals.ts`、`migrate-tools.ts` |
| `OMNICHAT_MODEL_ACTION_TIMEOUT_MS` | `120000` | モデルのロード・アンロードのタイムアウト(ms) | `adapters/index.ts` |
| `OMNICHAT_ADAPTER_TIMEOUT_MS` | `1500` | アダプターの HTTP 取得のタイムアウト(ms) | `adapters/index.ts` |
| `OMNICHAT_PROBE_TIMEOUT_MS` | `800` | ローカルサーバー検出の 1 件あたりのタイムアウト(ms) | `local-servers.ts` |
| `OMNICHAT_LOCAL_PROBES` | 内蔵 4 件 | 検出先を JSON 配列 `[{"name":"…","baseUrl":"…"}]` で上書き | `local-servers.ts` |
| `OMNICHAT_MODELS_TTL_MS` | `5000` | モデル一覧のキャッシュ時間(ms) | `models.ts`、`model-admin.ts` |
| `OMNICHAT_MODEL_POLL_MS` | `15000` | モデル一覧の定期更新間隔(ms) | `models.ts` |
| `OMNICHAT_CONTEXT_TTL_MS` | `3000` | コンテキスト上限の取得キャッシュ(ms) | `context.ts` |
| `OMNICHAT_SUMMARY_TIMEOUT_MS` | `90000` | 要約(コンテキスト圧縮)のタイムアウト(ms) | `context.ts` |
| `OMNICHAT_TITLE_TIMEOUT_MS` | `60000` | 自動タイトルのタイムアウト(ms) | `chat.ts` |
| `OMNICHAT_TOKENIZE_TIMEOUT_MS` | `5000` | トークン数計算のタイムアウト(ms) | `tokenize.ts` |
| `OMNICHAT_SEARCH_STATUS_TTL_MS` | `5000` | `/search/status` の結果のキャッシュ(ms) | `routes-tools.ts` |
| `OMNICHAT_MODEL_LOGOS` | 有効 | `0` でモデルのロゴ画像の取得を止める | `model-logos.ts` |
| `OMNICHAT_HF_BASE` | `https://huggingface.co` | ロゴ画像の取得元のベース URL(末尾の `/` は除かれる) | `model-logos.ts` |
| `OMNICHAT_HF_CDN_ALLOW` | 空 | ロゴ画像の取得を許可する追加のホスト(カンマ区切り、`host[:port]`)。テスト用 | `model-logos.ts` |

- `NODE_ENV` は、ラッパー(`run-service.cmd`、`run.sh`、systemd、Dockerfile)が `production` を設定します。サーバーのコードは読みません。
- `OMNICHAT_*` の多くは、テストやチューニング用です。通常は変更しません。テストの固定値は `server/test.env` にあります。

**インストーラーが書き出す項目**: Windows は `PORT`、`HOST`、`DATA_DIR`、`ALLOW_REGISTRATION`、(指定時のみ)`SEARXNG_URL`。Linux と macOS は `config.env.example`(`PORT`、`HOST`、`ALLOW_REGISTRATION`、`#SEARXNG_URL`)と、末尾に追記される `DATA_DIR`。

**Docker の既定**: イメージの `ENV` は `NODE_ENV=production`、`PORT=8787`、`HOST=0.0.0.0`、`DATA_DIR=/data`、`WEB_DIR=/app/web`、`ALLOW_REGISTRATION=0`。Compose は次のシェル変数を使います: `OMNICHAT_IMAGE`(既定 `ghcr.io/remuno3751/omnichat:latest`)、`OMNICHAT_PORT`(既定 `8787`)、`ALLOW_REGISTRATION`(既定 `0`)。

### 3.3 関連ツールの環境変数

**デーモン型ブリッジ(`bridge/`)**

| 変数 / オプション | 既定 | 意味 |
|---|---|---|
| `OMNICHAT_TOKEN` / `--token` | - | 端末トークン(どちらか一方の認証が必要) |
| `OMNICHAT_USERNAME` / `--username` | - | ログインするユーザー名 |
| `OMNICHAT_PASSWORD` / `--password` | - | パスワード(環境変数での指定を推奨) |
| `--server` | 必須 | サーバーの URL(http / https) |
| `--cwd` | 必須 | dsh の作業フォルダ(存在するフォルダ) |
| `--name` | ホスト名 | ブリッジ名。プロバイダーの `baseUrl` と一致させる |
| `--dsh-app` | `%LOCALAPPDATA%\Programs\DeepSeek Harness` | dsh のインストール先(`LOCALAPPDATA` を参照) |
| `--dsh-patch` | `bridge/dsh-overlay.yml` | 設定のオーバーレイ(`none` で無効) |
| `--profile` | `headless` | dsh のプロファイル |
| `--dsh-home` | `~/.dsh` | dsh のホーム |
| `--no-mirror` / `--mirror-all` | ミラー有効、同じ `--cwd` のみ | GUI の会話の反映を止める / 全フォルダを反映 |

**プラグイン型(`dsh-plugin/`)**

| 変数 | 意味 |
|---|---|
| `OMNICHAT_SERVER_URL` | サーバーの URL(必須)。`http://` は `ws://`、`https://` は `wss://` に変換される |
| `OMNICHAT_TOKEN` | 端末トークン。または次の 2 つ |
| `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` | ログインして端末トークンを得る |
| `OMNICHAT_NAME` | ブリッジ名(既定はホスト名)。プロバイダーの `baseUrl` と一致させる |
| `OMNICHAT_CWD` | 新規セッションの作業フォルダ(既定は dsh の既定ワークスペース) |

**CLI(`cli/`)**

| 変数 | 意味 |
|---|---|
| `OMNICHAT_SERVER` | 接続先の URL(保存された設定より優先) |
| `OMNICHAT_TOKEN` | 認証トークン(保存された設定より優先) |
| `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` | `login` のユーザー名とパスワード |
| `OMNICHAT_CONFIG` | CLI の設定ファイルのパス |
| `OMNICHAT_BENCH_POLL_MS` | ベンチマークのポーリング間隔(既定 1000 ms) |
| `NO_COLOR` | 色を無効にする |

---

## 4. 運用

### 4.1 起動、停止、再起動、ログ

| 導入方法 | 起動 | 停止 | 再起動 | ログ / 状態 |
|---|---|---|---|---|
| Windows サービス(管理者) | `net start OmniChat` | `net stop OmniChat` | 停止してから起動 | ログ: `%ProgramData%\OmniChat\logs`。状態: `sc.exe query OmniChat` |
| Linux systemd | `sudo systemctl start omnichat` | `sudo systemctl stop omnichat` | `sudo systemctl restart omnichat` | `journalctl -u omnichat -f`。状態: `systemctl is-active omnichat`(`active`) |
| macOS system | `sudo launchctl bootstrap system /Library/LaunchDaemons/com.omnichat.server.plist` | `sudo launchctl bootout system /Library/LaunchDaemons/com.omnichat.server.plist` | `sudo launchctl kickstart -k system/com.omnichat.server` | `/usr/local/omnichat-data/logs/omnichat.out.log` と `omnichat.err.log` |
| macOS user | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omnichat.server.plist` | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.omnichat.server.plist` | `launchctl kickstart -k gui/$(id -u)/com.omnichat.server` | `~/Library/Application Support/OmniChat/logs/` |
| Docker | `docker compose up -d` | `docker compose stop` | `docker compose restart omnichat` | `docker compose logs -f omnichat`、`docker compose ps` |
| ソースから起動 | `node dist/index.js` | `Ctrl+C` | 起動し直す | 起動したターミナルの標準出力 |

- Windows のサービスは、インストール時に自動起動(`Automatic`)に設定されます(`packaging/windows/omnichat-service.xml`)。
- macOS の system インストールは起動時、user インストールはログイン時に開始されます。

### 4.2 更新

- Windows インストーラー: 新しい `OmniChat-Server-Setup-<版>.exe` を実行します。サービスを止めて上書きし、設定とデータは保持されます(未検証)。
- Linux: 新しい tarball を展開し、`sudo ./install.sh` を再実行します。設定とデータは保持されます(未検証)。
- macOS: 新しい tarball を展開し、`install.sh` を再実行します(未検証)。
- Docker(公開イメージ): `docker compose pull && docker compose up -d`(未検証)。ボリュームは保持されます。
- Docker(ローカルビルド): `docker build -t omnichat:local .` の後に `docker compose up -d`(未検証)。
- ソース: `git pull` の後に `npm ci` と `npm run build` を行い、サーバーを再起動します。ローカル変更とのコンフリクトに注意してください。

### 4.3 アンインストール

- Windows: 「設定 → アプリ」から削除します(データと設定を削除するかの確認で、既定は残す)。サイレントの場合は `"C:\Program Files\OmniChat\unins000.exe" /VERYSILENT /REMOVEDATA=1`(`REMOVEDATA=1` を付けなければデータは残る)。
- Linux: `sudo ./uninstall.sh`(設定とデータは残る)。全削除は `sudo ./uninstall.sh --purge`。
- macOS: `./uninstall.sh`(user)または `sudo ./uninstall.sh`(system)。全削除は `--purge`。
- Docker: `docker compose down`(ボリュームは残る)。ボリュームも削除する場合はユーザーの許可を得てから `docker compose down -v`。

いずれも、データの削除は**ユーザーの許可を得てから**行います。

### 4.4 バックアップ

[BACKUP.md](BACKUP.md) を参照してください。要点は次のとおりです。自動バックアップは `$DATA_DIR/backups/` に作られます。稼働中に `omnichat.db` だけをコピーしないでください(`-wal` が欠けるため)。停止してからデータフォルダごとコピーするのが確実です。

---

## 5. トラブルシューティング

### 5.1 最初に実行する: `omnichat doctor`

```sh
node cli/bin/omnichat.mjs doctor --server http://localhost:8787 [--data-dir <DATA_DIR>]
```

- ローカルの確認(Node のバージョン、設定ファイル、ポート、`/healthz`、トークン、データフォルダ)は、ログインしていなくても行われます(`cli/src/commands/doctor.mjs`)。
- 終了コードは、FAIL が 1 つも無ければ `0`、あれば `1` です。WARN は影響しません。
- **サーバー側の診断(`GET /admin/diagnostics`)は実装済みです**(`server/src/diagnostics.ts` を `server/src/routes-v4.ts` が登録)。管理者のトークンが必要で、一般ユーザーは `403`(`Admin only`)になります。`omnichat doctor` は、トークンがあるときにこのエンドポイントを呼びます。
- 出力は Markdown で、バージョン、稼働時間、ポート、データフォルダのサイズ、プロバイダーの到達性、検索の状態、ブリッジ、設定の概要、ログの末尾 40 行を含みます。秘密情報は `***` で伏せられます。ログは `server/src/logring.ts` が起動時に有効化するリングバッファ(直近 200 行)から取ります。仕様は `PROTOCOL-v4.md`(リポジトリのルート)の §7 です。

### 5.2 症状、原因、対処

| 症状 | 原因 | 対処 |
|---|---|---|
| `listen EADDRINUSE` | ポート使用中 | `PORT` を変える。他プロセスの停止はユーザーに確認 |
| `/healthz` が接続できない | サービス未起動、`HOST` の指定、ファイアウォール | 起動状態を確認(4.1)。`HOST` を確認。ファイアウォールはユーザーに確認 |
| `No administrator exists yet`(403) | 管理者が未作成 | 2-f の管理者 CLI(`omnichat-admin create`)で作る |
| `registration is disabled`(403) | 自己登録が無効 | 一般ユーザーは `omnichat-admin create <名前> --role user` で作る。`ALLOW_REGISTRATION=1` は許可を得て一時的に設定(後で `0` に戻す) |
| `Username already taken`(409) | 同名のユーザーが存在 | ログインを使うか、別の名前をユーザーに確認 |
| `401 Unauthorized` | トークンが無効、または端末が失効 | `POST /auth/login` で再ログイン |
| `429`(ログイン) | 5 分間に 10 回の失敗 | 5 分待つ。パスワードをユーザーに確認 |
| `node:sqlite` の読み込みエラー | Node.js が 24 未満 | Node.js 24 以上を使う(文言は Node の版で異なり、未確認) |
| `SearXNG returned HTML: enable search.formats: [html, json]` | SearXNG で JSON 無効 | `docs/SEARCH.md` §1 の設定を入れて SearXNG を再起動 |
| `SearXNG refused the request (HTTP 403)` | JSON の要求が拒否された | `formats` に `json` を入れる。それでも 403 なら SearXNG の bot 対策の設定を確認(`docs/SEARCH.md` §5) |
| `SearXNG timed out after 8000 ms` | 応答が遅い | `SEARXNG_TIMEOUT_MS` を延ばす |
| `SearXNG unreachable ... ECONNREFUSED` | URL・ポートの誤り、Docker 内から `localhost` を指定 | `SEARXNG_URL` を見直す(`docs/SEARCH.md` §2 の表) |
| `no search backend configured (set a SearXNG URL, enable a built-in engine or add an API key in the web search settings)` | Web 検索の 3 方式のどれも使えない(SearXNG の URL、内蔵エンジン、API キーがいずれも無い) | `docs/SEARCH.md` の「Web 検索の方式を選ぶ」を見て、いずれか 1 つを設定する |
| `Bridge '<名前>' is offline` | ブリッジ未起動、名前の不一致、同名の競合 | `GET /bridges` を確認。プロバイダーの `baseUrl` と `--name` / `OMNICHAT_NAME` を一致させる |
| `session busy in dsh` | 同じセッションを dsh 側で実行中 | 終わってから送る。別の会話にする |
| `[omnichat] disabled: invalid configuration` | プラグインの環境変数の誤り | 変数名と値を確認(3.3)。dsh を再起動 |
| `[omnichat] disabled: ... lacks sessionController.xxx` | dsh の内部 API が変わった | dsh とプラグインのバージョンを合わせる |
| Windows サービスが起動しない | `config.env` の形式誤り、または `runtime\node.exe` が無い | `Test-Path "C:\Program Files\OmniChat\runtime\node.exe"` を確認。`config.env` は `KEY=VALUE`、引用符なし、`=` の前後に空白なし。ログを確認 |
| Web 画面が出ない(`/` が `{"error":"Not found"}`) | `WEB_DIR` が無い、または `index.html` が無い | `/version` の `webUi` を確認。`WEB_DIR` を設定(2-c) |
| macOS: 「開発元を確認できない」 | 隔離属性(quarantine) | `xattr -dr com.apple.quarantine <展開したフォルダ>`(ユーザーの許可を得て実行) |
| macOS: 「node の受信接続を許可」の表示 | ファイアウォールの確認 | ユーザーが「許可」を選ぶ |
| Windows: SmartScreen の警告 | インストーラーに署名が無い | 「詳細情報」→「実行」(ユーザーが操作) |
| Docker: `unhealthy` | サーバーの起動失敗 | `docker compose logs --tail 100 omnichat` を読む |

---

## 6. 検証状況

| 項目 | 状況 | 根拠 |
|---|---|---|
| サーバーの API、認証、同期、バックアップ、検索 | 自動テストあり(サーバーのテスト 178 件が通過と記録) | `docs/HANDOFF.md` §2 |
| 実サーバーと実 LM Studio での動作 | 開発 PC で記録あり(tsx 経由) | `docs/HANDOFF.md` §2 |
| `npm run build` と `node dist/index.js` での起動 | コンパイルは CI の定義に含む。起動は**未検証** | `.github/workflows/ci.yml` |
| Web クライアントの書き出し(`expo export`)と `WEB_DIR` での配信 | コマンドは `docs/HANDOFF.md` §5 と `packaging/build-release.mjs` に記載。一連の確認記録は見当たらないため、未検証扱い | `docs/HANDOFF.md` §5 |
| install-server スクリプト(B) | **未検証**。作成者の報告では Windows で `--dry-run` のみ | 本マニュアル 2-d |
| Windows インストーラー(Inno Setup、WinSW) | **未検証** | `docs/HANDOFF.md` §8 |
| Linux(systemd)と macOS(launchd)の scripts | **未検証** | `docs/HANDOFF.md` §8 |
| Docker イメージのビルドと Compose | **未検証** | `docs/HANDOFF.md` §8 |
| GitHub Actions(CI、リリース) | **未検証**(ワークフローは存在するが実行記録なし) | `docs/HANDOFF.md` §8、`docs/RELEASING.md` |
| `omnichat doctor` のサーバー側の診断 | **実装あり**(`/admin/diagnostics`)。実行の記録は見当たらない | `server/src/diagnostics.ts`、`server/src/routes-v4.ts` |
| ログのリングバッファ | **実装あり**(`installLogRing`)。実行の記録は見当たらない | `server/src/logring.ts` |
| CLI | 偽のサーバーに対する自動テストのみ | `cli/README.md` |
| dsh デーモン型(`bridge/`) | dsh 44.0.0 で記録あり。他の PC と他の dsh は未検証 | `docs/DSH.md` §9 |
| dsh プラグイン型(`web` プロファイル) | dsh 0.2.0-rc.2 で記録あり | `docs/DSH.md` §9 |
| dsh プラグイン型(`desktop` プロファイル) | **未検証** | `docs/DSH.md` §9 |
| Linux と macOS での dsh | **未検証** | `docs/DSH.md` §9 |
| 外出先からの接続(Tailscale、Caddy) | 手順のみ。確認記録なし | `docs/INSTALL.md` |

**注記**: 本マニュアルの各コマンドは、コードの記述と照合して書きました。実行して確認したものではありません。実行した結果は、その時点の確認として別に記録してください。
