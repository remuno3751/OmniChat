# OmniChat クイックスタート

サーバーを立てて、最初のチャットを送るまでの最短ルートです。細かい設定や環境変数の一覧は [INSTALL.md](INSTALL.md) にあります。

> 「未検証」と付いた手順は、このリポジトリでは実際に動かして確認していません(基準は [HANDOFF.md](HANDOFF.md) の 8 節)。試すときは、表示やログを見ながら進めてください。

## 1. サーバーを起動する

| 方法 | 向いている環境 | 状態 |
|---|---|---|
| A. 自分の PC でソースから | Node.js 24 以上を入れている PC | 確認済み(開発時の記録) |
| B. インストーラー / install.sh | 常駐させたい Windows・Linux・macOS | 未検証 |
| C. Docker Compose | Docker を使っている PC | 未検証 |

### A. ソースから起動

リポジトリのルートで実行します(PowerShell でも sh でも同じ書き方で動きます)。

```
cd server
npm ci
npm run build
node dist/index.js
```

- Node.js 24 以上が必要です(`node:sqlite` を使うため)。
- ソースのままだと `/` の Web 画面は出ません(`server/web` が無いため、`/version` の `webUi` が `false` になります)。ブラウザで使うなら、`node packaging/build-release.mjs --out <作業フォルダ>` が作る `<作業フォルダ>/server/` で `node dist/index.js` を実行します(未検証)。
- 止めるときは `Ctrl+C` です。

### B. インストーラー / install.sh(未検証)

- **Windows**: Releases の `OmniChat-Server-Setup-<版>.exe` を管理者として実行します。ポートなどを選ぶと、Windows サービス `OmniChat` として自動起動します。署名がないので、SmartScreen が出たら「詳細情報 → 実行」を選びます。
- **Linux(systemd)**: tarball を展開して `install.sh` を実行します。

  ```
  tar xzf omnichat-server-<版>-linux-x64.tar.gz
  cd omnichat-server-<版>-linux-x64
  sudo ./install.sh
  ```

- **macOS**: `macos-arm64` か `macos-x64` の tarball を展開し、`./install.sh`(システム全体に入れるなら `sudo ./install.sh`)を実行します。

### C. Docker Compose(未検証)

`docker-compose.yml` のあるフォルダで実行します。

```
docker compose up -d
docker compose ps
```

- 既定のイメージは `ghcr.io/remuno3751/omnichat:latest` です(`OMNICHAT_IMAGE` で変更できます)。パッケージが非公開なら `docker login ghcr.io` が必要です。
- ソースからビルドするなら、compose の `image:` 行を `build: .` に替えて `docker compose up -d --build` を実行します。
- `docker compose ps` で `healthy` になれば起動できています。
- 既定ではこの PC からだけ開けます(`ports` が `127.0.0.1` 指定)。別の PC から開くには docs/INSTALL.md の A. Docker Compose の「アクセス範囲」を参照してください。

## 2. 最初のアカウントを作る

1. **管理者を 1 人作ります**(ブラウザからは作れません)。サーバーの PC で次を実行し、パスワードを対話入力します(8 文字以上。強いものを使ってください)。
   - Linux: `sudo omnichat-admin create <ユーザー名>`
   - macOS(システム全体): `omnichat-admin create <ユーザー名>`(sudo は付けない)
   - Windows(管理者として開いたコマンドプロンプト): `"C:\Program Files\OmniChat\omnichat-admin.cmd" create <ユーザー名>`(未検証)
   - Docker: `docker exec -it omnichat node dist/admin-cli.js create <ユーザー名>`
   - 「OmniChat Server」アプリ(Windows / Linux)なら、画面で作れます([SERVER-APP.md](SERVER-APP.md))。
2. ブラウザで `http://localhost:8787/` を開き(別の PC からは `http://<サーバーのIP>:8787/`)、1 で作った管理者でログインします。
3. 他の人を追加する: `omnichat-admin create <名前> --role user` で一般ユーザーを作れます(`--role` を省略すると管理者になるので注意してください)。本人に登録してもらうなら、`ALLOW_REGISTRATION=1` にして再起動し、登録が済んだら `0` へ戻します。Docker なら `ALLOW_REGISTRATION=1 docker compose up -d`、ソース起動なら PowerShell で `$env:ALLOW_REGISTRATION = '1'` を設定してから起動します。
4. 動作確認: `http://localhost:8787/healthz` が `ok` を返し、`/version` が JSON を返せば正常です。

## 3. プロバイダー(接続先)を追加する

**Settings → Providers → + Add provider** を開きます。

- プリセット(OpenAI / DeepSeek / Ollama / LM Studio / DeepSeek Harness)から選ぶと、種類と URL が入ります。
- サーバー PC で LM Studio(1234 番)や Ollama(11434 番)が動いていれば、「Auto-detected on the server」に出るので **Add** を押すだけです。
- Docker で動かしている場合、コンテナの `localhost` はホストを指さないため、自動検出に出ないことがあります(未検証)。その場合は Base URL を手で入力します。
- API キーはサーバーの DB に保存され、クライアントには返りません。ただし DB には**平文で**入り、バックアップにも含まれます。

追加したら、チャット画面上部のモデルボタンでモデルを選び、メッセージを送ります。

## 4. クライアントを用意する

- ブラウザなら、サーバーの URL を開くだけです。
- スマホやデスクトップ版は、ログイン画面の「サーバー URL」に同じアドレスを入力します。Windows / macOS / Linux / Android / iPhone の入手方法は [CLIENTS.md](CLIENTS.md) にあります。

## 5. 家の外から使う

**平文の HTTP をインターネットに公開しないでください**(パスワードとトークンが平文で流れます)。おすすめは **Tailscale** です。サーバーと手元の端末に入れて同じアカウントでログインすれば、ルーターのポート開放なしで使えます。手順は [INSTALL.md の「外出先から使う」](INSTALL.md#外出先から使うリモートアクセス) を参照してください。

## 6. 任意の機能

- **Web 検索(SearXNG)**: `SEARXNG_URL` に SearXNG の URL を設定します。SearXNG の `settings.yml` で JSON 出力を有効にしてください(無効だと 403 になります)。設定の詳細は [INSTALL.md の SearXNG 連携](INSTALL.md#searxng-連携) と [SEARCH.md](SEARCH.md) にあります。
- **dsh(DeepSeek Harness)**: PC 上の dsh を OmniChat から操作できます。PC 側からは外向きの接続だけを使います。`bridge` フォルダで、次の 2 行でブリッジを起動します(パスワードは `OMNICHAT_PASSWORD` 環境変数で渡します)。

  ```
  npm install
  npm start -- --server http://<サーバー>:8787 --username <ユーザー名> --cwd <作業フォルダ> --name my-pc
  ```

  **ブリッジは承認なしでシェルやファイル操作を実行します。** 専用の作業フォルダ(`--cwd`)を使い、アカウントは厳重に管理してください。詳細は [DSH.md](DSH.md) を参照してください。

## 7. 困ったとき

まず診断を実行します(CLI は Node.js 22 以上で動き、外部パッケージは不要です)。

```
node cli/bin/omnichat.mjs login --server http://localhost:8787 --username <管理者>
node cli/bin/omnichat.mjs doctor --server http://localhost:8787
```

- `doctor` はログインなしでも、ローカルの確認(Node、設定ファイル、ポート、`/healthz`)を行います。サーバー側の診断には管理者としてのログインが必要です。
- 終了コードは、失敗がなければ `0`、失敗があれば `1` です。
- サーバー側の診断は `GET /admin/diagnostics` を使います(管理者のみ。実装済みです)。

よくある症状の確認先は次のとおりです。

| 症状 | 確認すること |
|---|---|
| 画面が開かない | `/healthz` が `ok` か。ポート、ファイアウォール、サービスの起動状態 |
| `No administrator exists yet`(403) | 管理者が未作成。`omnichat-admin create` で作る |
| `registration is disabled` | 自己登録が無効。`ALLOW_REGISTRATION` の設定、または `omnichat-admin create --role user` |
| 検索が使えない | `/version` の `searxng` が `true` か。SearXNG の JSON 出力の設定 |
| Node のバージョンエラー | ソースから動かす場合は Node.js 24 以上が必要 |

詳しい手順と設定の一覧は [INSTALL.md](INSTALL.md) の「トラブルシューティング」を参照してください。AI エージェントに設定を任せる場合は [AI-INSTALL.md](AI-INSTALL.md) を参照してください。
