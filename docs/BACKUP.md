# バックアップ・復元・エクスポート・インポート

OmniChat には 3 種類の保存の仕組みがあります。

| 種類 | 中身 | 誰が | 用途 |
|---|---|---|---|
| **バックアップ**(DB のスナップショット) | SQLite の DB 全体(API キーは暗号化された状態) | 管理者 | サーバーごとまるごと戻す |
| **会話のエクスポート** | 1 会話を Markdown か JSON で | 各ユーザー | 読む、保存する、共有する |
| **全データのエクスポート / インポート** | 自分のプロジェクト・会話などを JSON で | 各ユーザー | 別のサーバーへ移す、部分的に戻す |

**重要**: プロバイダーの API キーは暗号化(AES-256-GCM)して保存され、バックアップの DB にも**暗号化された値だけ**が入ります。鍵は環境変数 `OMNICHAT_SECRET_KEY`、または、データフォルダの `secret.key` です。バックアップのファイルに鍵は入らないので、`secret.key`(または `OMNICHAT_SECRET_KEY` の値)を、バックアップとは別の安全な場所に保管してください。鍵がないサーバーへ復元すると、保存したキーは使えません(設定でキーを入れ直します)。エクスポートの JSON には API キーは含まれません。

関連: [INSTALL.md](INSTALL.md)(インストール先の場所)。仕様の根拠は [PROTOCOL-v3-phase3.md](../PROTOCOL-v3-phase3.md) の「4. Backup and export」と「6. Server B implementation notes」です。

## 1. バックアップ(DB のスナップショット)

### 仕組み

- 保存先: `$DATA_DIR/backups/`(`DATA_DIR` ではなく、**DB_PATH の場所ではなく DATA_DIR** の下です)
- ファイル名: `omnichat-YYYYMMDD-HHMMSS.db`(同じ秒に作られた場合は `-2`、`-3` …が付く)
- 作り方: SQLite の `VACUUM INTO` で作るため、サーバーを動かしたままでも整合したコピーになります(作成中は短時間イベントループが止まります)
- 保持数: `BACKUP_KEEP`(既定 7)。手動でも自動でも、作るたびに古いものから削除されます(最小 1)
- 自動: `BACKUP_INTERVAL_HOURS`(既定 24)ごと。起動から 5 分後に最初のチェックが行われ、直近のバックアップがその間隔より新しければ作りません。`0` で自動を止めます。

### 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `BACKUP_INTERVAL_HOURS` | 24 | 自動バックアップの間隔(時間)。0 で無効 |
| `BACKUP_KEEP` | 7 | 残す数 |

### API(管理者)

```bash
# 作る
curl -s -X POST "$BASE/admin/backup" -H "Authorization: Bearer $ADMIN_TOKEN"

# 一覧(新しい順)
curl -s "$BASE/admin/backups" -H "Authorization: Bearer $ADMIN_TOKEN"

# ダウンロード
curl -s -o omnichat-backup.db "$BASE/admin/backups/omnichat-20261016-031500.db" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 削除
curl -s -X DELETE "$BASE/admin/backups/omnichat-20261016-031500.db" -H "Authorization: Bearer $ADMIN_TOKEN"
```

画面では Settings → History and data → **Backup (admin)**(管理者にだけ表示)から、作成・一覧・ダウンロード・削除ができます。

API からの**復元はできません**。復元は次のオフライン手順で行います。

## 2. 停止してコピーする(一番確実な方法)

サーバーを止めてから、データのフォルダを丸ごとコピーします。コピーに含めるもの:

- DB: `omnichat.db`(稼働中なら `omnichat.db-wal` と `omnichat.db-shm` も。止めてからコピーすれば不要)
- 設定: `config.env`(インストール方法ごとの場所は下)
- `effort-map.json`(あれば)
- `backups/`(自動バックアップも一緒に残せます)

### Windows(サービス版)

場所: 設定 `%ProgramData%\OmniChat\config.env`、データ `%ProgramData%\OmniChat\data`(その中の `omnichat.db` と `backups\`)。サービス名は `OmniChat`(インストーラーの `omnichat.iss` と `omnichat-service.xml` で定義)。

管理者のコマンドプロンプトで:

```bat
net stop OmniChat
xcopy "%ProgramData%\OmniChat" "D:\backup\OmniChat-%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%\" /E /I /Y
net start OmniChat
```

(`%DATE%` の書式は地域設定で変わります。日付はご自分の環境に合わせてください)

復元: `net stop OmniChat` → `%ProgramData%\OmniChat` の中身をバックアップから戻す → `net start OmniChat`。

### Linux(systemd)

場所: 設定 `/etc/omnichat/config.env`、データ `/var/lib/omnichat`(`omnichat.db` と `backups/`)。ユニット名は `omnichat`。

```bash
sudo systemctl stop omnichat
sudo tar czf omnichat-$(date +%F).tgz /etc/omnichat /var/lib/omnichat
sudo systemctl start omnichat
```

復元:

```bash
sudo systemctl stop omnichat
sudo tar xzf omnichat-2026-10-16.tgz -C /
sudo chown -R omnichat:omnichat /var/lib/omnichat
sudo systemctl start omnichat
```

ログは `journalctl -u omnichat -f` で確認できます。

### macOS(launchd)

場所は導入方法で違います。

| 導入方法 | 設定・データ | 停止 | 起動 |
|---|---|---|---|
| システム(`sudo ./install.sh`) | `/usr/local/omnichat-data/`(`config.env`、`data/`、`logs/`) | `sudo launchctl bootout system /Library/LaunchDaemons/com.omnichat.server.plist` | `sudo launchctl bootstrap system /Library/LaunchDaemons/com.omnichat.server.plist` |
| ユーザー(`./install.sh`) | `~/Library/Application Support/OmniChat/`(同じ構成) | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.omnichat.server.plist` | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omnichat.server.plist` |

例(システム導入):

```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.omnichat.server.plist
sudo tar czf ~/omnichat-$(date +%F).tgz -C /usr/local omnichat-data
sudo launchctl bootstrap system /Library/LaunchDaemons/com.omnichat.server.plist
```

復元は、停止したあと `/usr/local/omnichat-data` の中身をバックアップで置き換えて、起動します。

### Docker Compose

データは名前付きボリューム `omnichat-data`(コンテナ内 `/data`)です。Compose のプロジェクト名が前に付くので、実際のボリューム名は `docker volume ls` で確認します(プロジェクトのフォルダ名が `omnichat` なら `omnichat_omnichat-data`)。

```bash
docker compose stop
docker run --rm -v omnichat_omnichat-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/omnichat-data-$(date +%F).tgz -C /data .
docker compose start
```

復元: `docker compose stop` → 同じボリュームへ `tar xzf` で展開(`-C /data`)→ `docker compose start`。

## 3. 稼働中にコピーしない

`omnichat.db` だけを稼働中にコピーすると、`-wal` が欠けて壊れた状態になることがあります。止められない場合は、`sqlite3` コマンドのオンラインバックアップを使います。

```bash
sqlite3 /var/lib/omnichat/omnichat.db ".backup '/backup/omnichat-$(date +%F).db'"
```

(この方法でも `config.env` は別途コピーしてください)

## 4. 会話のエクスポート

1 会話を書き出します。会話の操作メニューの **Export as Markdown** または **Export as JSON** を選ぶと、次の項目を選べるダイアログが開きます(ダイアログの Export ボタンで実行)。

| 項目 | 選択肢 | 既定 |
|---|---|---|
| Format | Markdown / JSON | 選んだ形式 |
| Branches | Current branch(今見ている枝)/ All branches(全部の枝) | Current branch |
| Include thinking | 思考過程を含める | オフ |

API:

```bash
curl -s -o chat.md "$BASE/conversations/$CONV_ID/export?format=md&branches=current" \
  -H "Authorization: Bearer $TOKEN"
curl -s -o chat.json "$BASE/conversations/$CONV_ID/export?format=json&branches=all&reasoning=1" \
  -H "Authorization: Bearer $TOKEN"
```

Markdown の枝の表示: `branches=all` では兄弟の枝に `*[Branch i/n]*` が付き、別の枝は `>` で字下げされます。JSON の 1 会話は `GET /export` と同じ形なので、そのまま取り込めます。

## 5. 全データのエクスポート / インポート

### エクスポート

`GET /export` は自分のすべてのデータを JSON で返します(画面: Settings → History and data → **Data: export / import**)。

含まれるもの: プロジェクト、プリセット、全体の設定、会話(メッセージ、思考過程、出典を含む)、プロバイダーの**名前・種類・URL・モデル**。

含まれないもの: 端末トークン、API キー、**プロバイダーの API キー**、ツール承認の記録、計測データ(メッセージの速度情報)、ツール呼び出しの記録。

```bash
curl -s -o omnichat-export.json "$BASE/export" -H "Authorization: Bearer $TOKEN"
```

### インポート

`POST /import`(JSON 本体、上限 50 MB)。画面: Settings → History and data → Data: export / import(Web / デスクトップ版のみ)。

- **すべて新しい ID で作ります**。既存のデータは上書きしません。同じファイルを 2 回取り込むと 2 回分になります。
- 取り込みは 1 つのトランザクションで行われ、構造に問題があれば 400 で何も書き込まれません。
- 親子関係(枝)、プロジェクトへの所属は、取り込まれた範囲で付け替えます。
- プロバイダーは、**同じユーザーが持つものだけ**を紐づけます。他人のプロバイダー ID は外れます。
- **全体の設定は取り込まれません**(エクスポートには含まれていても、インポートでは無視されます)。
- 計測データとツール呼び出しの記録は取り込まれません。出典(sources)は取り込まれます。
- 取り込んだ会話は `streaming` の状態が `done` に直されます。

### 別のサーバーへ移すときの手順

1. 移行元で `GET /export` を保存する
2. 移行先で管理者を `omnichat-admin create <名前>`(Docker は `docker exec -it omnichat node dist/admin-cli.js create <名前>`)で作り、ユーザーも必要なら作ってログインする
3. 移行先の画面で **プロバイダーの API キーを再入力する**(エクスポートには含まれないため)
4. 移行先で `POST /import` する

## 6. 復元の確認

- 起動後に `GET /healthz` が `ok` を返すか
- ログインし、会話一覧に期待する会話が出るか
- `GET /admin/backups` で、バックアップの一覧が見えるか
- 設定画面の「Providers」で、API キーの入力が必要な状態になっているか(エクスポートから戻した場合)
