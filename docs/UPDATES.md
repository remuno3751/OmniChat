# 自動更新

OmniChat サーバーの更新の仕組みと、クライアント(Web / デスクトップ / Android / DSH プラグイン)の更新の仕方をまとめています。インストーラーで入れ直す方法は [INSTALL.md](INSTALL.md) と [SERVER-APP.md](SERVER-APP.md) を参照してください。

## 1. 利用者がすること

**管理者が行うのは、ほぼ「今すぐ更新」を押すことだけです。**

- 新しい版が出ると、管理者の画面に更新ポップアップが出ます。「今すぐ更新」を押すと、サーバーが自分で取得・検証・入れ替え・再起動を行います。再起動の間、接続が一時的に切れます。
- 「この版をスキップ」を押すと、その版はそれ以上知らせません(次の版は別に知らせます)。「あとで」を押すと 24 時間後にもう一度出ます。
- 更新に失敗して自動で元の版に戻ったときは、次に管理者がログインした時に失敗のポップアップが出ます。内容を確認して閉じると、その記録は確認済みになります。

| 項目 | 自動 | 人が行う |
|---|---|---|
| 新しい版の確認 | する(既定は 12 時間ごと。起動の 60 秒後に最初の確認) | 「確認」ボタンで今すぐ確認もできる |
| 新版の適用 | **しない**(管理者が承認したときだけ) | 「今すぐ更新」を押す |
| 取得・チェックサム検証・展開 | する | - |
| 更新前のバックアップ | する | - |
| 入れ替えと再起動 | する | - |
| 起動後の健全性確認と失敗時の巻き戻し | する | 失敗の通知を確認する |
| Docker 版 | 確認と通知だけ(入れ替えはしない) | ホストでコマンドを実行する |
| DSH プラグイン | 確認と取得・検証まで(入れ替えはしない) | 表示されたコマンドを DSH を閉じて実行する |

## 2. 流れ

1. サーバーが GitHub Releases を確認し、新しい版を見つけると、管理者の画面に表示します。
2. 管理者が「今すぐ更新」を押すと、サーバーは次を行います。
   1. サーバーのバンドル(`omnichat-server-bundle-<版>.zip`)とチェックサムを取得する。
   2. チェックサムを先に取得し、zip の SHA-256 を検証する。一致しなければ zip を消して何も変えずに終わる。
   3. zip を `<DATA_DIR>/updates/bundles/<版>` に展開し、中身を検査する。
   4. 更新前バックアップを `<DATA_DIR>/backups/pre-update-<旧版>-<日時>/` に作る。
   5. `<DATA_DIR>/updates/state.json` に「新版を検証中」と書く。ここまでは元に戻せる段階で、この書き込みが入れ替えの始まりです。
   6. 約 0.8 秒後にプロセスを再起動する(終了コードや再起動方法は後述の 3.6)。
3. 次の起動で `boot.js` が状態ファイルを読み、新版の `dist/index.js` を起動します。
4. 新版は 60 秒以内に健全性確認(後述 3.5)に合格すると「確認済み」になります。
5. 不合格(起動しない、タイムアウト、DB の検査に失敗など)なら、旧版と更新前バックアップの DB に戻します。その版は「失敗済み」になり、自動では二度と試しません。

## 3. 仕組み

### 3.1 版の確認

- GitHub Releases API を使います。リポジトリは既定で `remuno3751/omnichat` です(`OMNICHAT_UPDATE_REPO` で変えられます)。
- 前回の応答の ETag を付けて問い合わせるため、変わりがなければ軽く済みます。結果(最終確認時刻、エラー、ETag、一覧)は DB の `server_settings`(キー `update_state`)に保存されます。
- 下書き(draft)のリリースは無視します。タグを semver として読めないものも無視します。
- チャンネル:
  - `stable`(既定): プレリリースを除いた最新。
  - `prerelease`: プレリリースを含めた最新(安定版より新しいプレリリースがあればそれ)。
- 確認が失敗した場合は、そのエラー(種類と短い説明。トークンは伏せる)が状態に出ます。確認の失敗だけでは、動いているサーバーには影響しません。

### 3.2 バンドル

サーバーの更新は、プラットフォーム共通の zip(`omnichat-server-bundle-<版>.zip`)で行います。Node 本体は含みません。zip の直下には次が入ります。

`dist/`(`boot.js` を含む)、`web/`、`node_modules/`、`package.json`、`package-lock.json`、`VERSION`、`bundle.json`、ライセンス類、`config.env.example`

`bundle.json` の例: `{"version":"1.2.3","minNode":"24.0.0","minHostEpoch":1}`

- `minNode` より古い Node で動いているサーバーには適用しません。
- `minHostEpoch` は、インストーラー側の互換性の番号です(今の値は 1)。バンドルがこの番号より新しい前提を持つ場合は、「フルインストーラーが必要」として拒否されます。Node の大きな版の変更や、ネイティブ依存の変更がこれにあたります。その場合はインストーラーで入れ直します。
- 展開時の安全策: 絶対パス・`..`・シンボリックリンクを拒否し、展開後の合計は 1.5 GiB まで、エントリは 20 万件までです。

### 3.3 状態ファイル `updates/state.json`

場所: `<DATA_DIR>/updates/state.json`(権限 0600、書き込みは一時ファイルを作ってから置き換えます)。

| キー | 意味 |
|---|---|
| `active` | 動かす版(`version`, `dir`)。`null` はインストール済みの版 |
| `previous` | 巻き戻し先の版。`null` はインストール済みの版 |
| `status` | `idle` または `verifying`(新版の確認待ち) |
| `attempts` | 確認が終わらないまま起動された回数 |
| `backupDir` | 巻き戻しに使う更新前バックアップのフォルダ |
| `restoreOnBoot` | 次の起動で、バックアップを DB より先に戻すかどうか |
| `verifyDeadline` | 健全性確認の期限(時刻) |
| `failed` | 失敗した版の一覧(自動では再試行しない) |
| `lastResult` | 直近の結果(`ok` / `failed`、巻き戻したか、確認済みか) |

このファイルは DB を開く前に読まれるため、DB に依存するコードは入りません。

### 3.4 `boot.js`

すべての launcher(Windows サービス、Tauri のサーバー用アプリ、systemd、launchd、tarball の起動スクリプト)は `dist/index.js` ではなく `dist/boot.js` を起動します。`boot.js` は次を決めてから本体を読み込みます。

1. 状態ファイルを読み、動かす版を決める。
   - 保存されている版が、インストール済みの版より新しく、フォルダがあり、失敗済みでなければ、その版を動かす。
   - それ以外(インストーラーでより新しい版が入った場合を含む)は、インストール済みの版を動かす。
   - 確認されないまま 3 回起動されたら、巻き戻しの扱いにする。
2. 巻き戻しの指示がある場合は、DB を開く前にバックアップを戻す。戻せなければ起動せず、終了コード 1 で止まります(半端なデータで起動しないため)。
3. 新版を動かすときは、確認が終わるまで 60 秒の見張り(ウォッチドッグ)を置く。確認されないまま期限が過ぎたら、巻き戻して再起動する。
4. 新版の読み込みで例外が出たら、その版を失敗済みにして巻き戻す。

ウェブ画面は、新版の `web/` を使うように `WEB_DIR` を切り替えます(`WEB_DIR` が未設定か、インストール済みの `web/` を指している場合のみ)。

### 3.5 健全性確認と巻き戻し

新版が起動すると、サーバーは 60 秒以内に次をすべて満たすか確認します(1 秒ごとに再試行)。

1. `http://127.0.0.1:<ポート>/healthz` が `ok` を返す。
2. `/version` の版が、取り込んだ版と一致する。
3. DB の `PRAGMA quick_check` が `ok`。

すべて満たせば、`status` を `idle` にし、`lastResult` を「成功」にします。古いバンドルは「現在」と「1 つ前」だけ残して消えます。この時点で `backupDir` は参照されなくなりますが、バックアップのフォルダ自体は次のルールで残ります(3.8)。

失敗したとき(期限切れ、起動の失敗、確認の失敗、3 回起動されても確認されない):

- その版を `failed` に加える(自動では再試行しない)。
- `active` を `previous`(旧版)に戻す。
- バックアップがあれば `restoreOnBoot` を立てる。次の起動で、DB より先に `omnichat.db`、`secret.key`、`local-admin.token`、`effort-map.json`、`plugins/`、必要なら `config.env` を戻してから起動する。
- 再起動して旧版で起動し、管理者にはログイン時に失敗のポップアップが出ます。

### 3.6 再起動と終了コード 75

サーバーは、launcher が監督しているとき(`OMNICHAT_SUPERVISED=1`)は終了コード **75** で終わり、監督者に再起動を任せます。監督されていない場合(手動で `node dist/boot.js` を実行した場合など)は、自分の複製を切り離して起動してから終了コード 0 で終わります。

| 起動方法 | 再起動の仕組み |
|---|---|
| Tauri のサーバー用アプリ(Windows / Linux) | アプリが終了コード 75 のときだけ起動し直す。2 分間に 5 回までで止める(暴走防止) |
| Windows サービス(WinSW) | 失敗時の再起動(10 秒、30 秒、60 秒の間隔。1 時間で失敗回数をリセット)。75 も失敗として扱われる |
| Linux サービス(systemd) | `Restart=always`、`RestartSec=5` |
| macOS(launchd) | `KeepAlive` を true に設定 |
| Docker | 再起動しない。更新は `docker compose pull && docker compose up -d` をホストで実行する(通知だけ) |
| ソースから起動(`tsx src/...`) | 自己更新は無効 |

### 3.7 インストーラー版との関係

- インストーラー(Windows の Inno / Tauri の NSIS、tarball)は、今も使えます。Node の大きな版の変更、ネイティブ依存の変更などは、インストーラーでの入れ直しが必要です。
- インストーラーの版が自動更新の版より新しければ、`boot.js` は保存されているバンドルを無視し、インストーラーの版を動かします。

### 3.8 バックアップの中身と保存数

フォルダ: `<DATA_DIR>/backups/pre-update-<旧版>-<YYYYMMDD-HHMMSS>/`

| 中身 | 備考 |
|---|---|
| `omnichat.db` | `VACUUM INTO` で取った一貫したコピー(WAL は含まない) |
| `secret.key` | 暗号化された設定値(API キーなど)の鍵。**無いとバックアップ自体を作りません** |
| `local-admin.token` | ローカル管理 API のトークン |
| `effort-map.json` などのトップレベルのファイル | DB のファイル(`*.db`、`*.db-wal`、`*.db-shm`)以外すべて |
| `plugins/` | あれば |
| `config.env` | データフォルダの親にあれば |
| `manifest.json` | 旧版、作成時刻、ファイル一覧 |

- **このフォルダには鍵とトークンが入っています。** データフォルダと同じ扱いにしてください。
- 新しい順に **3 個まで** 残し、それより古いものは次のバックアップ作成時に消えます。
- バックアップの作成に失敗した場合は、そのまま更新を中止します(入れ替えはしません)。

### 3.9 インストーラーとデータ

- **Windows の Inno インストーラー**(`OmniChat-Server-Setup-<版>.exe`): データフォルダ(`%ProgramData%\OmniChat` の `config.env`、`data`、`logs`)はアンインストールでも消しません。消すのは `/REMOVEDATA=1`(サイレント)を付けた場合、または対話画面で「はい」を選んだ場合だけです。
- **Tauri の NSIS インストーラー**(サーバー用アプリ、クライアント用ランチャー): 未検証です。アンインストーラーにはアプリのデータを消すかどうかのチェックボックスがあるため、消さないように**チェックを外したまま**にしてください。

## 4. 設定

### 4.1 画面の設定(管理者)

| 名前 | 内容 | 既定 |
|---|---|---|
| `updateCheckHours`(確認の間隔) | 0 から 720 の整数(時間)。0 は自動確認を止める(手動の「確認」は使える) | 12 |
| `updateChannel` | `stable` または `prerelease` | `stable` |
| `updateGithubToken` | 非公開リポジトリ用のトークン。入力のみで、画面にも API の応答にも出ません | 未設定 |
| `updateSkipped` | スキップした版の一覧(「この版をスキップ」「スキップ解除」で変わる) | 空 |

### 4.2 環境変数

DB に設定が無い場合にだけ使われます(DB の値が優先)。

| 変数 | 内容 | 既定 |
|---|---|---|
| `OMNICHAT_UPDATE_CHECK_HOURS` | 確認の間隔(時間)。`updateCheckHours` の既定値 | 12 |
| `OMNICHAT_UPDATE_CHANNEL` | チャンネルの既定値 | `stable` |
| `OMNICHAT_UPDATE_TOKEN` | GitHub トークン(DB の値より後に使う) | 未設定 |
| `OMNICHAT_UPDATE_REPO` | リポジトリ(`owner/name`) | `remuno3751/omnichat` |
| `OMNICHAT_UPDATE_API_BASE` | GitHub API の基底 URL(プライベートなミラー用) | `https://api.github.com` |
| `OMNICHAT_UPDATE_ALLOW_HTTP` | `1` にすると http を許可する。**試験専用。接続先が 127.0.0.1 / localhost / [::1] のときだけ有効** | 無効 |
| `OMNICHAT_UPDATE_FIRST_DELAY_MS` | 起動後の最初の確認までの時間(試験用) | 60000 |

DSH プラグインは `OMNICHAT_UPDATE_TOKEN`、`OMNICHAT_UPDATE_REPO`、`OMNICHAT_UPDATE_API_BASE` を使います(設定ファイルの `updateToken` でも指定できます)。

## 5. 非公開リポジトリとトークン

- リポジトリが非公開の場合は、読み取り権限のあるトークンが必要です。画面の `updateGithubToken` か、環境変数 `OMNICHAT_UPDATE_TOKEN` で設定します。
- 画面から入れたトークンは、サーバーの鍵(`secret.key`)で暗号化して DB に保存します。
- トークンは API の応答(`GET /update/status`)に含まれません。応答に出るのは「設定済みかどうか」(`tokenSet`)だけです。
- エラーの文章からもトークンは取り除きます(`[redacted]`)。ログには書きません。
- 空の値(`null` または空文字)を送ると、トークンを消します。トークンの形式は 8〜300 文字の印字可能な ASCII です。

## 6. エンドポイント

すべて JSON で、`Authorization: Bearer` が必要です。「管理者」は `users.is_admin` が true の人です。

| メソッド・パス | 権限 | 内容 |
|---|---|---|
| `GET /update/status` | ログイン済みの全員 | 現在の状態(`UpdateStatus`)。トークンは `tokenSet` のみ |
| `POST /update/check` | 管理者 | 今すぐ確認。本文 `{ "channel"?: "stable" \| "prerelease" }` |
| `POST /update/apply` | 管理者 | 更新を開始。本文 `{ "version"?: "1.2.3" }`。`202 { ok, phase }` を返し、進みは `GET /update/status` で見る |
| `POST /update/skip` | 管理者 | 本文 `{ "version" }` をスキップ |
| `POST /update/unskip` | 管理者 | スキップを解除 |
| `PUT /update/config` | 管理者 | 本文 `{ "channel"?, "checkHours"?(0〜720), "githubToken"?(文字列または null) }` |
| `POST /update/ack` | 管理者 | 直近の結果(失敗・巻き戻し)を確認済みにする |
| `GET /local-admin/update/status` | 127.0.0.1 からのみ | `/update/status` と同じ(ローカル管理 API) |
| `POST /local-admin/update/check` | 127.0.0.1 からのみ | `/update/check` と同じ |
| `POST /local-admin/update/apply` | 127.0.0.1 からのみ | `/update/apply` と同じ |

- 更新のエラーは `{ "error": "...", "code": "..." }` で返します。`busy` と `unsupported` は 409、`not-found` は 404、GitHub や通信の問題(`network`、`rate-limited`、`unauthorized`、`forbidden`、`download` など)は 502、その他は 400 です。
- `GET /version` の応答には `installType` と `selfUpdate` が入ります。
- `/update` の経路は、サーバーの API の一覧(`API_PREFIXES`)に入っています。`/admin` の下には出していません。

## 7. 整合性の確認

- 通信は HTTPS だけです。リダイレクトの各段階も HTTPS でなければ拒否します(試験用の http は 4.2 の `OMNICHAT_UPDATE_ALLOW_HTTP` の条件を満たすときだけ)。
- 接続先は許可リストに限ります: GitHub API のホスト、`github.com`、`api.github.com`、`*.githubusercontent.com`。リダイレクトは最大 5 回です。
- 認証のヘッダーは、最初の接続先(GitHub API のホスト)にだけ付けます。
- チェックサムは、リリースの `SHA256SUMS`(`<hex>  <ファイル名>` の形式、`*` の付いた形式も可)か、バンドルごとの `<ファイル名>.sha256` を使います。どちらも無ければ、ダウンロードしないで拒否します(`checksum-missing`)。
- 一致しなければ、ダウンロードしたファイルを消して拒否します(`checksum-mismatch`)。この場合、インストール済みのものも状態も変わりません。
- ダウンロードの上限は 600 MiB です(リリースに書かれたサイズとも比べます)。

## 8. データの安全性

- 更新は DB とデータフォルダを上書きしません。新しい版は `updates/` の下に置かれ、データは更新の前に `backups/` へコピーされてから、そのまま使われます。
- 巻き戻すと、バックアップを作った時点の DB に戻ります。**その後に作られたデータ(新しく入った会話やユーザーなど)は失われます。**
- 更新が確認済みになった後も、バックアップは 3 個までは残ります。手で必要なものは別の場所に保存してください。
- 通常のバックアップ(`backups/omnichat-*.db`、[BACKUP.md](BACKUP.md))とは別のフォルダです。

## 9. クライアントの更新

- **Web クライアント**: サーバーが配信しているので、サーバーを更新すれば Web の画面も新しくなります。画面は 60 秒ごとに `/version` を見て、版が変わったら「再読み込み」のバナーを出します。
- **デスクトップ(クライアント用ランチャー)**: 起動して少しした後に GitHub を確認します。Windows では「今すぐ更新」でインストーラーを取得し、SHA-256 を検証してから、サイレント(`/S`)で実行して再起動します。macOS と Linux では、リリースのページを開きます。
  - 設定は `<app_data_dir>/update.json` に保存されます(スキップ、あとで、チャンネル、トークン)。
- **Android**: アプリ内での置き換えはしません。APK のリンクを表示するだけです(`OmniChat-<版>.apk`)。
- **DSH プラグイン**(`omnichat-dsh-bridge-<版>.tgz`): プラグインの版は、サーバーの版とは別に番号が付きます。
  - GitHub の確認は最大 6 時間に 1 回です(それ以外は前回の結果を使います)。
  - 取得の操作を行うと、tgz を取得してチェックサムを検証し、`<dshHome>/omnichat-update/omnichat-dsh-bridge-<版>.tgz` に保存します。
  - 設定画面に、次の 1 行のコマンドが出ます(コピーできます)。**DSH の GUI を完全に閉じてから**実行してください。
    ```
    dsh plugin --profile <名前> remove @omnichat/dsh-bridge; dsh plugin --profile <名前> add "<保存した tgz の絶対パス>"
    ```
  - DSH を開いたまま入れ替えることはしません(`dsh plugin add` は GUI を閉じている必要があります)。

## 10. 手動で元に戻す

自動の巻き戻しが動かなかった場合や、失敗が確認済みになった後に戻したい場合の手順です。**この手順は実機で試していません。**

1. サーバーを止めます(Windows サービス、systemd、launchd、またはアプリの「停止」)。
2. `<DATA_DIR>/backups/pre-update-<旧版>-<日時>/` の中身を、`<DATA_DIR>` に戻します。
   - `omnichat.db` を `<DATA_DIR>/omnichat.db` にコピーします。その前に `omnichat.db-wal` と `omnichat.db-shm` があれば消します。
   - `secret.key`、`local-admin.token`、`effort-map.json`、`plugins/` も戻します(鍵が違うと、暗号化された設定が読めません)。
   - `config.env` があれば、`<DATA_DIR>` の親フォルダに戻します。
3. `<DATA_DIR>/updates/state.json` を次のように書き換えます。
   ```json
   { "v": 1, "active": null, "previous": null, "status": "idle", "attempts": 0, "backupDir": null, "restoreOnBoot": false, "verifyDeadline": null, "failed": ["<戻したい新しい版>"], "lastResult": null }
   ```
   `active` が `null` のときは、インストール済みの版が動きます。
4. サーバーを起動し、版と DB を確認します。

## 11. 初回の注意(自動更新が効く前の版)

自動更新の仕組みより前に入れた版は、launcher が `dist/index.js` を直接起動しています(`OMNICHAT_BOOT` が設定されていない)。このため、その版では「今すぐ更新」は使えず、画面に「launcher predates the update system; install the new installer once」と出ます。

**一度だけ新しいインストーラーで入れ直してください。** データは残ります(3.9 を参照)。入れ直した後は、自動更新が使えます。

## 12. 未検証

この文書を書いた時点で、次は確認していません。

- 実際の GitHub リリースでの取得(試験は偽の GitHub サーバー `fake-github` を使っています)。
- Windows の実機での NSIS インストーラーのサイレント更新(`/S`)。
- DSH プラグインの、DSH を閉じた状態でのコマンド実行による入れ替え(コマンドの生成までです)。
- Docker での動作(通知のみの仕様)。
- macOS の launchd での再起動。
- Linux の Tauri サーバー用アプリの GUI での再起動。
- Windows サービス(WinSW)、systemd での終了コード 75 による再起動の実機確認。
- 本文 10 の手動の巻き戻し手順。
