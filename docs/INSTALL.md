# OmniChat サーバー インストールガイド

サーバーを常時稼働させる PC(自宅 PC など)に入れる手順です。方法は 4 つあります。環境に合うものを 1 つ選んでください。

| 方法 | 向いている環境 | Node.js のインストール |
|---|---|---|
| [A. Docker Compose](#a-docker-compose) | すでに Docker を使っている(推奨) | 不要 |
| [B. Windows インストーラー](#b-windows-インストーラー) | Windows、Docker なし | 不要(同梱) |
| [C. Linux](#c-linux-systemd) | systemd の Linux | 不要(同梱) |
| [D. macOS](#d-macos) | Apple Silicon / Intel Mac | 不要(同梱) |

配布物はすべて GitHub の [Releases](../../../releases) にあります(`OmniChat-Server-Setup-<版>.exe`、`omnichat-server-<版>-linux-x64.tar.gz` など。`SHA256SUMS` でハッシュ確認できます)。Docker イメージは `ghcr.io/<GitHubのユーザー名またはOrg名>/omnichat` です。

## 初回の使い方(共通)

1. **先に管理者を 1 人作ります。** 最初のアカウント(管理者)は HTTP(ブラウザ)からは作れません。サーバーを動かしている PC で次を実行します。パスワードは対話入力です(8 文字以上。強いものにしてください)。

   | 環境 | コマンド |
   |---|---|
   | Linux(systemd) | `sudo omnichat-admin create <ユーザー名>` |
   | macOS(システム全体にインストール) | `omnichat-admin create <ユーザー名>`(sudo は付けない) |
   | macOS(ユーザー単位にインストール) | `"$HOME/Library/Application Support/OmniChat/app/omnichat-admin" create <ユーザー名>` |
   | Windows(サービス) | 管理者として開いたコマンドプロンプトで `"C:\Program Files\OmniChat\omnichat-admin.cmd" create <ユーザー名>`(未検証) |
   | Docker | `docker exec -it omnichat node dist/admin-cli.js create <ユーザー名>` |

   - 管理者は `--role` を省略すると admin になります。一般ユーザーを作るときは `--role user` を付けてください。
   - パスワードは環境変数 `OMNICHAT_ADMIN_PASSWORD` でも渡せます(sudo では `sudo --preserve-env=OMNICHAT_ADMIN_PASSWORD omnichat-admin create <名前>`)。コマンド行に直接書かないでください。
   - 「OmniChat Server」アプリ(GUI、Windows / Linux)なら、画面で管理者と一般ユーザーを作れます([SERVER-APP.md](SERVER-APP.md))。
2. ブラウザで `http://<サーバーのIP>:8787/` を開き(サーバー PC 自身なら `http://localhost:8787/`)、1 で作った管理者でログインします。
3. 設定画面でプロバイダー(OpenAI 互換 API、Ollama、LM Studio、dsh ブリッジなど)を追加します。API キーはサーバーにだけ保存されます。
4. スマホアプリやデスクトップ版は、ログイン画面のサーバー URL に同じアドレスを入れます。

### 他のユーザーを追加する

- サーバーで作る: `omnichat-admin create <名前> --role user`(Docker は `docker exec -it omnichat node dist/admin-cli.js create <名前> --role user`)。新規登録の設定は不要です。
- 本人に登録してもらう: `ALLOW_REGISTRATION=1` にして再起動します。管理者ができた後は、誰でも一般ユーザーとして登録できます。登録が済んだら `0` へ戻してください。

### アカウントの管理(サーバー上の CLI)

```
omnichat-admin list                      # ユーザー一覧
omnichat-admin set-password <名前>       # パスワードの変更(そのユーザーは全端末からサインアウト)
omnichat-admin role <名前> admin|user    # 管理者 / 一般ユーザーの切り替え
omnichat-admin disable <名前>            # 無効化(enable で戻す)
```

Docker では `docker exec -it omnichat node dist/admin-cli.js <同じ引数>` で実行します。

動作確認用: `http://<サーバー>:8787/healthz` が `ok`、`/version` がバージョン JSON(`name`, `version`, `webUi`, `searxng`)を返します。

使い方は [FEATURES.md](FEATURES.md)、クライアントの入手は [CLIENTS.md](CLIENTS.md) を参照してください。

## 設定項目(環境変数)

| 変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | 8787 | 待ち受けポート |
| `HOST` | 0.0.0.0 | 待ち受けアドレス。同じ PC のリバースプロキシだけから使うなら `127.0.0.1` |
| `DATA_DIR` | `./data`(Docker は `/data`) | SQLite などの保存先 |
| `DB_PATH` | `$DATA_DIR/omnichat.db` | DB ファイルを別の場所にしたいとき |
| `WEB_DIR` | `./web` | 同梱の Web クライアントの場所(通常は変更不要) |
| `ALLOW_REGISTRATION` | 0 | 1 で、管理者を作成した後に誰でも一般ユーザーとして登録できるようにする(管理者の作成は CLI で行う) |
| `OMNICHAT_OPEN_FIRST_REGISTRATION` | 0 | **テスト専用。製品では使わないでください。** 1 にすると、管理者がいない間は HTTP の `/auth/register` で最初に届いたアカウントが管理者になる旧仕様に戻ります |
| `SEARXNG_URL` | なし | Web 検索に使う SearXNG の URL([SearXNG 連携](#searxng-連携)、詳細は [SEARCH.md](SEARCH.md)) |
| `EFFORT_MAP` | `$DATA_DIR/effort-map.json` | 推論エフォートの対応表(無ければ既定値で作成。mtime が変わると再読込) |
| `CORS_ORIGIN` | 空(全オリジン許可) | 許可するオリジンをカンマ区切りで指定。空のままだと全オリジンを許可 |
| `TRUST_PROXY` | 0 | 1 でリバースプロキシの `X-Forwarded-For` の先頭を接続経路(loopback / lan / vpn / external)の判定に使う |
| `BACKUP_INTERVAL_HOURS` | 24 | 自動バックアップの間隔(時間)。0 で無効([BACKUP.md](BACKUP.md)) |
| `BACKUP_KEEP` | 7 | 自動・手動を合わせて残すバックアップ数(古いものから削除。最小 1) |
| `PLUGINS_DIR` | `$DATA_DIR/plugins` | ツール用プラグインの置き場所([PLUGINS.md](PLUGINS.md)) |
| `TOOL_TIMEOUT_MS` | 30000 | ツール 1 回の実行時間の上限 |
| `TOOL_APPROVAL_TIMEOUT_MS` | 120000 | ツール実行の承認を待つ時間。超えると拒否扱い |
| `SEARXNG_TIMEOUT_MS` | 8000 | SearXNG へのリクエストのタイムアウト |
| `SEARCH_MAX_RESULTS` | 5 | 1 回の検索で使う結果数(最大 20) |
| `AUTO_TITLE_DEFAULT` | 1 | `0` にすると、ユーザーが設定していない場合の自動タイトルの既定をオフにする |
| `OMNICHAT_MODEL_ACTION_TIMEOUT_MS` | 120000 | モデルのロード/アンロード操作のタイムアウト |

上の表にない `OMNICHAT_*` 系の変数(キャッシュ時間やタイムアウトの調整、ローカルサーバー検出の上書き)は主にテスト用です。

設定の書き方はインストール方法によって違います。Docker は `docker-compose.yml` の `environment:`、Windows は `%ProgramData%\OmniChat\config.env`(`KEY=VALUE`、引用符なし)、Linux は `/etc/omnichat/config.env`、macOS は `config.env`(launchd のラッパーが `. config.env` で読み込むので、空白を含む値は引用符で囲みます)。変更後はサービスを再起動します。

---

## A. Docker Compose

```bash
curl -O https://raw.githubusercontent.com/remuno3751/omnichat/main/docker-compose.yml
# または git clone して OMNICHAT_IMAGE を指定
OMNICHAT_IMAGE=ghcr.io/remuno3751/omnichat:latest docker compose up -d
```

- イメージ名は `ghcr.io/remuno3751/omnichat` です。別の場所に置く場合は環境変数 `OMNICHAT_IMAGE` で指定します。
- パッケージが private の場合は先に `docker login ghcr.io`(PAT: `read:packages`)が必要です。公開にしておくと不要です。
- データは名前付きボリューム `omnichat-data`(コンテナ内 `/data`)に保存されます。
- ソースからビルドする場合: リポジトリを clone して compose の `image:` 行を `build: .` に差し替え、`docker compose up -d --build`。
- 状態確認: `docker compose ps`(HEALTHCHECK が `healthy` になる)、ログは `docker compose logs -f omnichat`。
- **アクセス範囲**: 既定の `docker-compose.yml` は `ports: "127.0.0.1:${OMNICHAT_PORT:-8787}:8787"` で、この PC からだけ `http://localhost:8787/` で開けます。他の端末から使う場合は、ports の `127.0.0.1` を `0.0.0.0` に変えて `docker compose up -d` し直すか、リバースプロキシ経由にしてください(下の「外出先から使う」を参照)。`0.0.0.0` にする前に、管理者を作成しておいてください(`docker exec -it omnichat node dist/admin-cli.js create <名前>`)。
- Docker の既定 `ALLOW_REGISTRATION=0` のままにしてください。

### SearXNG 連携
下の「[SearXNG 連携](#searxng-連携)」を参照してください(Docker の場合は compose のネットワーク参加が一番簡単です)。

### 更新
```bash
docker compose pull && docker compose up -d
```
ボリュームは保持されるのでデータは消えません。

---

## B. Windows インストーラー

1. Releases から `OmniChat-Server-Setup-<版>.exe` をダウンロードして実行します(管理者権限が必要)。
   署名していないため SmartScreen が警告します。「詳細情報」→「実行」を選びます。
2. ウィザードで **ポート** と(任意で)**SearXNG の URL**、追加登録を許可するかを指定します。
3. 追加タスク:
   - **ファイアウォール**: 指定ポートの受信を「プライベートネットワークのみ」で許可
   - **スタートメニュー**: 「Open OmniChat」「データフォルダ」「設定を編集」「ログ」
4. 完了すると Windows サービス `OmniChat` が自動起動(PC 起動時に自動開始)します。ブラウザで `http://localhost:<ポート>/` を開きます。

保存場所:

| 内容 | 場所 |
|---|---|
| プログラム | `C:\Program Files\OmniChat`(Node.js 同梱) |
| 設定 | `%ProgramData%\OmniChat\config.env` |
| データ(SQLite) | `%ProgramData%\OmniChat\data` |
| ログ | `%ProgramData%\OmniChat\logs` |

設定変更は `config.env` を編集し、管理者のコマンドで `net stop OmniChat` → `net start OmniChat`(または「サービス」アプリから再起動)。

- **更新**: 新しいインストーラーをそのまま実行すれば上書き更新されます(サービス停止→置換→再開。設定とデータは保持)。
- **アンインストール**: 「設定 → アプリ」から。データと設定を削除するか尋ねられ、既定は残します。
- **サイレントインストール**:
  ```
  OmniChat-Server-Setup-1.2.3.exe /VERYSILENT /SUPPRESSMSGBOXES /PORT=8787 /ALLOWREG=0 /SEARXNG=http://localhost:8888 /TASKS="firewall,startmenu"
  "C:\Program Files\OmniChat\unins000.exe" /VERYSILENT /REMOVEDATA=1   (REMOVEDATA を付けなければデータは残る)
  ```
  タスクは `/TASKS="firewall,startmenu"` で指定します(省略すると両方とも既定で有効)。

---

## C. Linux (systemd)

```bash
tar xzf omnichat-server-<版>-linux-x64.tar.gz      # arm64 の機種は linux-arm64
cd omnichat-server-<版>-linux-x64
sudo ./install.sh
```

`omnichat` ユーザーを作り、次の配置で systemd サービスを `enable --now` します。

| 内容 | 場所 |
|---|---|
| プログラム | `/opt/omnichat` |
| 設定 | `/etc/omnichat/config.env` |
| データ | `/var/lib/omnichat` |
| ログ | `journalctl -u omnichat -f` |

- 設定変更後: `sudo systemctl restart omnichat`
- **更新**: 新しい tarball を展開して `sudo ./install.sh` をもう一度実行(設定・データは保持)。
- **削除**: `sudo ./uninstall.sh`(設定とデータは残す)/ `sudo ./uninstall.sh --purge`(全削除)。
- ファイアウォール(ufw 例): `sudo ufw allow 8787/tcp`。インターネット側には開けないでください。

---

## D. macOS

Apple Silicon は `macos-arm64`、Intel は `macos-x64` の tarball を使います。

```bash
tar xzf omnichat-server-<版>-macos-arm64.tar.gz
cd omnichat-server-<版>-macos-arm64
sudo ./install.sh      # システム全体: /usr/local/omnichat, LaunchDaemon(起動時に自動開始)
# または
./install.sh           # 自分だけ: ~/Library/Application Support/OmniChat, LaunchAgent(ログイン時に開始)
```

| 内容 | システムインストール | ユーザーインストール |
|---|---|---|
| プログラム | `/usr/local/omnichat` | `~/Library/Application Support/OmniChat/app` |
| 設定・データ・ログ | `/usr/local/omnichat-data/` | `~/Library/Application Support/OmniChat/` |
| launchd | `/Library/LaunchDaemons/com.omnichat.server.plist` | `~/Library/LaunchAgents/com.omnichat.server.plist` |

- sudo で実行した場合、データは `sudo` を実行したユーザーの権限で動かします。
- **Gatekeeper**: ブラウザでダウンロードした tarball の中身には隔離属性が付きます。`install.sh` が `xattr -dr com.apple.quarantine` で外しますが、「開発元を確認できない」と出る場合は `xattr -dr com.apple.quarantine <展開したフォルダ>` を手動で実行してください(システム設定 → プライバシーとセキュリティ の「このまま許可」でも可)。署名・公証はしていません。
- **ファイアウォール**: 初回起動時に「node へのネットワーク受信接続を許可しますか?」と出たら「許可」を選びます(スマホなど他の端末から使うために必要)。
- 設定変更後の再起動: システム `sudo launchctl kickstart -k system/com.omnichat.server` / ユーザー `launchctl kickstart -k gui/$(id -u)/com.omnichat.server`
- ログ: 上の「設定・データ・ログ」配下の `logs/`。
- **更新**: 新しい tarball で `install.sh` を再実行。**削除**: `./uninstall.sh`(`--purge` でデータも削除)。
- **代替**: Docker Desktop for Mac が入っているなら、[A. Docker Compose](#a-docker-compose) が一番手軽です(ホストの SearXNG へは `host.docker.internal` で到達できます)。
- Mac がスリープするとサーバーも止まります。常時稼働させるなら「システム設定 → バッテリー/省エネルギー」でスリープを防ぎます。

---

## SearXNG 連携

すでに Docker 上で SearXNG が動いている場合、OmniChat の `SEARXNG_URL` にその URL を設定します。検索モードや承認の流れ、エラーの対処は [SEARCH.md](SEARCH.md) にまとめています。

**重要**: SearXNG の `settings.yml` で JSON 出力を有効にしてください(無効だと 403 になります)。

```yaml
search:
  formats:
    - html
    - json
```
変更後に SearXNG を再起動します。確認: `curl "http://localhost:8888/search?q=test&format=json"`。

| OmniChat の動かし方 | SearXNG の場所 | `SEARXNG_URL` |
|---|---|---|
| Docker(同じ compose ネットワークに参加) | 別 compose のコンテナ名 `searxng` | `http://searxng:8080` |
| Docker | ホストに公開したポート(例 8888) | `http://host.docker.internal:8888` |
| Windows サービス / Linux / macOS | ホストに公開したポート | `http://localhost:8888` |

同じネットワークへの参加方法(Docker): `docker network ls` で SearXNG 側のネットワーク名(例 `searxng_default`)を調べ、`docker-compose.yml` の `networks:` 関連のコメントを外して名前を合わせます。Linux ホストで `host.docker.internal` を使うための `extra_hosts` は compose に含めてあります。

Windows サービスの場合は `%ProgramData%\OmniChat\config.env`、Linux は `/etc/omnichat/config.env` の `SEARXNG_URL=` に書いて再起動します。

---

## バックアップと復元

保存対象は `DATA_DIR`(`omnichat.db`、`-wal`、`-shm` と `effort-map.json`)と `config.env` です。自動バックアップの仕組み、API、エクスポート / インポート、プラットフォームごとの正確なコマンドは [BACKUP.md](BACKUP.md) にあります。以下は要点です。

**停止してコピーするのが一番確実**です。

- Docker: `docker compose stop` → `docker run --rm -v omnichat_omnichat-data:/data -v "$PWD":/backup alpine tar czf /backup/omnichat-data.tgz -C /data .` → `docker compose start`
  (ボリューム名は `docker volume ls` で確認。compose のプロジェクト名が前に付きます)
- Windows: `net stop OmniChat` → `%ProgramData%\OmniChat` をコピー → `net start OmniChat`
- Linux: `sudo systemctl stop omnichat` → `/var/lib/omnichat` と `/etc/omnichat` をコピー → `start`

停止できない場合は SQLite のオンラインバックアップを使います(sqlite3 コマンドがある環境):
```bash
sqlite3 /var/lib/omnichat/omnichat.db ".backup '/backup/omnichat-$(date +%F).db'"
```
`.db` だけを稼働中にコピーすると `-wal` が欠けて壊れた状態になり得るので避けてください。

**復元**: サービスを止め、`DATA_DIR` を空にしてバックアップの内容(`omnichat.db`)を置き、所有者を合わせて(Linux なら `chown -R omnichat:omnichat`)起動します。

---

## 外出先から使う(リモートアクセス)

**平文の HTTP をインターネットに公開しないでください。** パスワードとトークンが平文で流れます。次のどちらかを使います。

### 1. Tailscale(推奨: ポート開放不要)
サーバー PC とスマホの両方に Tailscale を入れ、同じアカウントでログインします。アプリのサーバー URL は `http://<サーバーのtailnet名またはIP>:8787` で動きます(WireGuard で暗号化済み)。macOS の Tailscale も同様です。

HTTPS にしたい場合(ブラウザのマイクや PWA 等で必要になることがあります):
```bash
# Tailscale 管理画面で MagicDNS と HTTPS Certificates を有効化したうえで
tailscale serve --bg 8787
```
※ `tailscale serve` の書式はバージョンで異なります(古い版は `tailscale serve https / http://127.0.0.1:8787`)。お使いの版で `tailscale serve --help` を確認してください。表示された `https://<マシン名>.<tailnet>.ts.net/` をサーバー URL に使います。インターネットに公開する `tailscale funnel` は、友人に使ってもらう目的がある場合だけ、下の「友人へ公開する(Tailscale Funnel)」の注意を守って使ってください。

### 2. Caddy(リバースプロキシ + 自動 TLS)
独自ドメインがあり、80/443 をサーバーに転送できる場合。`Caddyfile`:
```
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```
`caddy run` で証明書(Let's Encrypt)が自動取得されます。この場合 OmniChat は `HOST=127.0.0.1` にして、8787 を外に出さないことを推奨します(Docker なら既定の `ports: "127.0.0.1:8787:8787"` のままにします)。WebSocket(`/ws` など)も `reverse_proxy` が自動で通します。公開するなら `ALLOW_REGISTRATION=0` を維持してください。

### 3. 友人へ公開する(Tailscale Funnel)

Tailscale Funnel は、サーバー PC の `http://127.0.0.1:8787` を、インターネット上の公開 URL(`https://<マシン名>.<tailnet>.ts.net`)として公開する機能です。**URL を知っていれば誰でも届く**ため、tailnet に入れない友人にも使ってもらえる反面、攻撃者にも届きます。必ず下のチェックリストを守ってください。

**Funnel が提供するもの**: HTTPS(証明書は Tailscale が自動取得・終端)と公開 URL。OmniChat には、サーバー PC のループバック(127.0.0.1)から `X-Forwarded-*` などの転送ヘッダー付きで届きます。

**コマンド**(書式は版で異なります。`tailscale funnel --help` で確認してください):
```bash
# 管理画面で MagicDNS / HTTPS Certificates を有効化し、ACL で funnel を許可しておく
tailscale funnel --bg 8787     # 公開開始
tailscale funnel status        # 公開 URL と状態の確認
tailscale funnel --bg 8787 off # 公開停止(版によっては `tailscale funnel reset`)
```

**設定**(`config.env` など):
```
HOST=127.0.0.1          # Funnel 経由だけを入口にする(LAN から直接届かせない)
TRUST_PROXY=1           # 友人ごとにログイン試行制限を分ける。転送ヘッダーを読む
ALLOW_REGISTRATION=0    # 勝手な新規登録を防ぐ
```

**チェックリスト**
- [ ] アカウントは**管理者だけ**が作る(サーバーアプリまたは `/local-admin`。友人にはユーザー名と初期パスワードを別経路で渡す)。`ALLOW_REGISTRATION=0`。
- [ ] `TRUST_PROXY=1`。未設定だと、全員が 127.0.0.1 からの接続に見え、ログイン試行制限を全員で共有します。
- [ ] パスワードは長く固有のものにする(サーバー側の最小は 8 文字のみで、複雑性の検査はありません)。
- [ ] 共有プロバイダーを使うなら、**クォータとモデルの許可(grant)**を友人ごとに設定する(`docs/PROTOCOL-v7-quotas.md`、`docs/PROTOCOL-v7-shared-providers.md`)。既定のアクセスは「なし」にしておく。
- [ ] **dsh ブリッジ(自分の PC を操作できる接続)は共有しない**。友人には管理者権限を与えない。ブリッジを接続しているアカウントでログインできる人は、その PC を操作できます。
- [ ] プラグインは管理者専用です。友人に管理者権限を渡さなければ、友人はプラグインを入れられません。
- [ ] `omnichat doctor` を実行し、「Exposure warnings」が空であることを確認する(Funnel 経由のリクエストを一度受けた後に見ると、転送ヘッダー関連の警告も出ます)。
- [ ] 管理操作(`/local-admin/*`)は、転送ヘッダー付きのリクエストを拒否するため Funnel 経由では使えません。サーバー PC 上で直接行います。

**確認できていない点(不明)**
- Funnel が付ける転送ヘッダーの正確な一覧と、`X-Forwarded-For` を上書きするのか追記するのか: **不明**(実機未検証。サーバーは右端の未信頼アドレスを使うため、どちらでも偽装には耐える設計ですが、実機では未確認)。
- Funnel の帯域・接続数・タイムアウトの制限、WebSocket(`/ws`、`/bridge`)が長時間つながり続けるか: **不明**。
- Funnel 経由でのストリーミング応答(SSE 等)の挙動: **不明**。
- Funnel を使うために必要な ACL / 管理画面の設定の最新手順: **不明**(Tailscale の公式ドキュメントを参照)。
- 公開 URL への総当たり・スキャンを Tailscale 側が制限するか: **不明**。OmniChat 側のログイン試行制限(同一クライアント・ユーザー名で 5 分に 10 回)に頼ります。

---

## ファイアウォールとセキュリティの注意

- LAN 内だけで使うなら、ルーターのポート開放(ポートフォワード)は **しない** でください。
- Windows インストーラーの既定は「プライベートネットワークのみ」許可です。公共 Wi-Fi のプロファイルでは開きません。
- インターネットから使うときは必ず HTTPS(上記)にし、`ALLOW_REGISTRATION=0` のまま、強いパスワードを使います。
- dsh ブリッジを接続しているアカウントは、そのブリッジの PC を操作できます(README の注意参照)。アカウント管理は厳重に。
- バックアップには会話内容と API キーが含まれます。保管場所に注意してください。
- 設定ファイル(`config.env`)には秘密情報を直接書かない前提です(API キーは UI から登録しサーバーの DB に保存されます)。

## トラブルシューティング

- 画面が開かない: `/healthz` を直接確認 → ポート衝突(`PORT` を変更)、ファイアウォール、サービス起動状態を確認。
- `No administrator exists yet`(403): 管理者がまだいません。上の「初回の使い方」1 の `omnichat-admin create` を実行してください。
- `registration is disabled`(403): 管理者はいるが自己登録が無効です。`ALLOW_REGISTRATION=1` で再起動するか、`omnichat-admin create <名前> --role user` で作ってください。
- 検索が使えない: `/version` の `searxng` が `true` か、SearXNG の JSON 出力設定を確認。
- Node のバージョンエラー(自前で動かす場合): `node:sqlite` が必要なので Node 24 以上。
