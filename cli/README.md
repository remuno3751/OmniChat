# omnichat — OmniChat コマンドラインクライアント

OmniChat サーバーを端末から使うための CLI です。ランタイム依存はゼロで、Node.js 22 以上（グローバル `fetch` と組み込みの `WebSocket` を使用）で動きます。

主な機能: ログイン、モデル一覧、ストリーミングでのチャット（ツール承認・Web 検索の出典付き）、履歴の一覧・表示・全文検索・エクスポート、ベンチマーク実行、設定のエクスポート／インポート。

## インストール

リポジトリ内で直接実行する場合:

```sh
node cli/bin/omnichat.mjs help
```

`omnichat` コマンドとして使う場合（npm link）:

```sh
cd cli
npm link          # グローバルに omnichat コマンドを登録
omnichat help
```

パスを指定して実行する場合は、`node /path/to/omnichat/cli/bin/omnichat.mjs <command>` と書けば同じです。

## クイックスタート

```sh
# 1. サーバーにログイン（パスワードは非表示で入力されます）
omnichat login --server http://localhost:8787 --username alice

# 2. 利用できるモデルを確認（<プロバイダー名>/<モデルID> の形式）
omnichat models

# 3. チャット（応答はストリーミングで表示されます）
omnichat chat "3 語で挨拶して" --model "LM Studio/google/gemma-4-e4b"

# 4. 続きの会話・プロジェクト指定・思考過程の表示
omnichat chat "もう一度" --conv 3f2a1b9c
omnichat chat "要約して" --project 研究 --thinking

# 5. 履歴
omnichat history --limit 10
omnichat show 3f2a1b9c            # 会話の内容（現在の枝）
omnichat search "ゼブラ"          # 全文検索
omnichat export 3f2a1b9c -o chat.md
omnichat export 3f2a1b9c --format json -o chat.json
```

標準入力からメッセージを渡すこともできます。

```sh
cat notes.txt | omnichat chat - "次の文章を要約して"  # 標準入力と引数を空行で連結
cat notes.txt | omnichat chat                          # 標準入力だけを使う（引数なし）
omnichat chat --json "1+1は？" | jq .message.content  # JSON で受け取る
```

## コマンド一覧

| コマンド | 内容 |
| --- | --- |
| `login --server URL [--username U] [--register]` | ログインして接続先とトークンを保存します。パスワードは端末では非表示入力、それ以外は標準入力の 1 行目、または `OMNICHAT_PASSWORD` から読みます。 |
| `logout` | サーバー側でこの端末のデバイスを失効させ、保存したトークンを削除します。 |
| `whoami [--json]` | 接続先、ユーザー名、現在のデバイスを表示します。 |
| `models [--provider 名前] [--all] [--json]` | モデル一覧を表示します。 |
| `chat "<メッセージ>" [オプション]` | メッセージを送信し、応答をストリーミング表示します。 |
| `history [--limit N] [--project 名前] [--json]` | 最近の会話を一覧します（既定 20 件）。 |
| `show <会話ID> [--thinking] [--json]` | 会話の現在の枝を表示します。ID は先頭数文字でも指定できます。 |
| `search "<語句>" [--limit N] [--offset N] [--project 名前] [--json]` | 履歴を全文検索します。一致箇所は `«…»` で囲まれます（色が使える端末では太字）。 |
| `export <会話ID> [--format md\|json] [-o ファイル\|-] [--reasoning] [--all-branches]` | 会話をエクスポートします。`-o` の拡張子が `.json` なら JSON になります。 |
| `bench run <セット名\|ID> --targets "A/モデル,B/モデル" [--repeats N] [--max-tokens N] [--no-warmup] [--json]` | ベンチマークを実行し、結果の表（TTFT、prefill / decode の tok/s など）を表示します。Ctrl+C でサーバー側の実行を取り消します。 |
| `config export [FILE] [--format json\|yaml]` | 設定を書き出します（FILE を省略すると標準出力）。 |
| `config import [FILE\|-] [--mode merge\|replace]` | 設定を読み込みます。拡張子が `.yaml` / `.yml` なら YAML として送ります。 |
| `doctor [--server URL] [--data-dir DIR]` | 端末の設定、接続先への到達性、サーバーの診断（`/admin/diagnostics`）を確認します。ログインしていなくても実行できます。 |

### chat のオプション

- `--model <プロバイダー名>/<モデルID>`: モデルを指定します。プロバイダー名にはスペースを含められます（例: `"LM Studio/google/gemma-4-e4b"`）。短い指定（モデル ID だけ、プロバイダーの slug など）も受け付けますが、複数に一致した場合は候補を表示してエラーになります。
- `--project 名前` と `--create-project`: プロジェクトに入れます。存在しない名前は `--create-project` を付けない限りエラーです。
- `--conv <ID>` / `--new`: 既存の会話を続けるか、新しい会話を始めます（同時指定はできません）。
- `--effort low|medium|high|max`、`--search off|smart|always`(`auto` は `smart` の別名)、`--system "<文章>"`
- `--thinking`: 思考過程を標準エラー出力に表示します（既定では表示しません）。
- `--approve once|always|deny`: ツール承認への回答を指定します。詳しくは下記。
- `--json`: `{conversationId, status, message, metrics}` を 1 つの JSON として標準出力に出します。
- `--stats`: 応答の ttft・decode 速度・トークン数を標準エラー出力に出します。
- `--no-sources`: 出典一覧を表示しません。
- `--idle-timeout 秒`: サーバーからのデータが途絶えてから諦めるまでの時間（既定 300 秒）。

### ツール承認

ツールが通信や端末の操作を必要とする場合、サーバーは承認を求めます。

- 端末で実行しているとき: `Allow tool ... ? [y]es once / [a]lways / [N]o` と聞かれます。既定は拒否です。
- 端末以外（パイプや CI）のとき: 既定は**拒否**です。`--approve once`（今回だけ許可）または `--approve always`（常に許可）を指定すると、その回答を返します。

### 出典

Web 検索の結果を使った応答の後には、次の形式で出典が表示されます。

```
[1] タイトル — https://example.com/a
[2] 別のタイトル — https://example.org/b
```

## doctor（診断）

`omnichat doctor` は、CLI がサーバーに接続できない原因を切り分けるための確認コマンドです。ログインしていなくても実行でき、サーバーに接続できない場合もローカルの確認は行います。

ローカルの確認（`## Local checks`）は次のとおりです。

| 名前 | 内容 |
| --- | --- |
| `node` | Node.js のバージョン。22 未満は FAIL、22 または 23 は WARN（サーバーをソースから動かすには Node 24 以上が必要）です。 |
| `config file` | 設定ファイルの有無。ない場合、`--server` か `OMNICHAT_SERVER` があれば WARN、なければ FAIL（`omnichat login` の案内）です。 |
| `port` | 接続先の host:port への TCP 接続（3 秒でタイムアウト）。 |
| `healthz` | `GET /healthz` の応答が `ok` か。port が閉じている場合は省略されます。 |
| `token` | トークンがあるか。ない場合は FAIL で、サーバー側の診断は行いません。 |
| `server diagnostics` | `GET /admin/diagnostics` を呼びます。管理者のトークンが必要で、一般ユーザーの場合は「管理者アカウントが必要」と表示されます。 |
| `data dir` | `--data-dir DIR` を指定したときだけ確認します。存在するディレクトリで、書き込めることを確認します（確認用のファイルを作って消します）。 |

結果は Markdown で表示されます。各行は `- [OK] 名前: 詳細`、`- [WARN] …`、`- [FAIL] …` の形式です。続く `## Server diagnostics` の部分には、サーバーが返した診断の Markdown をそのまま表示します。サーバーに接続できない場合は `server unreachable or request failed: …` と表示されます。

- 接続先は `--server`、`OMNICHAT_SERVER`、保存された設定の順に決まります。どれもなければ `http://localhost:8787` を使います。保存されたトークンは、保存されたサーバーと同じ接続先に対してだけ送られます。
- 終了コードは、確認に FAIL がなければ 0、FAIL が 1 つでもあれば 1 です。WARN は終了コードに影響しません。
- トークンは表示されません。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | エラー（接続失敗、認証失敗、応答の失敗、コンテキスト超過など） |
| 2 | 使い方の誤り（不明なオプション、必須の引数がない、値が不正） |
| 130 | 中断（Ctrl+C）。チャットではサーバーに停止を依頼してから終了します。 |

`chat` で `context_overflow`（コンテキストウィンドウを超過）が返った場合は、読みやすいメッセージを表示して終了コード 1 になります。`--new` で新しい会話にするか、メッセージを短くするか、OmniChat の設定でコンテキスト超過時の動作を変えてください。

## グローバルオプション

- `--server URL`: 接続先（既定は保存された設定、または `OMNICHAT_SERVER`）。
- `--timeout 秒`: リクエストのタイムアウト（既定 30 秒）。
- `--debug`: リクエストの概要を標準エラー出力に出します。トークンやパスワードは伏せ字になります。
- `--no-color` / `NO_COLOR=1`: 色を使いません。標準出力や標準エラーが端末でない場合、色は自動的に無効です。
- `-q, --quiet`: 補足メッセージ（`conversation: …` など）を出しません。
- `-h, --help` / `-v, --version`

## 環境変数

| 変数 | 内容 |
| --- | --- |
| `OMNICHAT_SERVER` | 接続先の URL（設定ファイルより優先） |
| `OMNICHAT_TOKEN` | 認証トークン（設定ファイルより優先）。CI などで便利です。 |
| `OMNICHAT_PASSWORD` | `login` のパスワード。CI で使うときは秘密情報として扱ってください。 |
| `OMNICHAT_USERNAME` | `login` のユーザー名 |
| `OMNICHAT_CONFIG` | 設定ファイルのパスを変更します。 |
| `NO_COLOR` | 色を無効にします。 |

接続先やトークンを `--server` / `OMNICHAT_SERVER` で保存されたものとは別の値にした場合、保存済みのトークンは**送られません**（別サーバーへトークンを漏らさないため）。その場合は `OMNICHAT_TOKEN` を指定するか、`omnichat login --server ...` を実行してください。

## 設定ファイル

- Windows: `%APPDATA%\omnichat\config.json`
- macOS / Linux: `$XDG_CONFIG_HOME/omnichat/config.json`（未設定なら `~/.config/omnichat/config.json`）

内容は `{ "server": "...", "token": "...", "deviceId": "...", "username": "..." }` です。ファイルは書き換え時に一時ファイル経由で置き換えられ、権限は 0600 になります（Windows では権限の設定は行われません）。`logout` でトークンは削除されます。トークンは機密情報なので、このファイルを共有しないでください。

`login` はこの端末用のデバイス「CLI (ホスト名)」を作成します。`logout` でそのデバイスは失効します。

## CI での利用

CI ではブラウザを使わず、トークンを環境変数で渡します。

```yaml
env:
  OMNICHAT_SERVER: https://omnichat.example.com
  OMNICHAT_TOKEN: ${{ secrets.OMNICHAT_TOKEN }}
steps:
  - run: node cli/bin/omnichat.mjs bench run smoke --targets "LM Studio/google/gemma-4-e4b" --json > bench.json
  - run: node cli/bin/omnichat.mjs chat --approve deny --json - "変更点を要約して" < CHANGES.md > summary.json
```

- 標準入力からの読み取り: `login` はパスワードを標準入力の 1 行目から読みます（`OMNICHAT_PASSWORD` が未設定のとき）。`chat` はメッセージが `-` または引数なしのときだけ標準入力を読みます。
- ツール承認は既定で拒否されるので、CI が意図せずツールを実行することはありません。
- 終了コードで成否を判定できます（0 / 1 / 2 / 130）。

## テスト

```sh
cd cli
npm test
```

テストは `node:test` で書かれており、ランダムなポートで立ち上げるフェイクの OmniChat サーバー（REST と WebSocket）に対して、すべてのコマンド、ツール承認、標準入力、終了コード、設定ファイルの権限と往復、トークンの伏せ字化を確認します。

既知の制限: Windows では `SIGINT` を子プロセスに届けられないため、Ctrl+C の経路はテストで `SIGINT` ハンドラを直接呼び出して確認しています。端末上のパスワード入力（非表示入力）も自動テストの対象外で、手動での確認が必要です。

## 関連ドキュメント

API の契約は `PROTOCOL.md`、`PROTOCOL-v3.md`、`PROTOCOL-v3-phase2.md` から `PROTOCOL-v3-phase4.md` の第 6 節（CLI）を参照してください。
