# OmniChat API リファレンス

サーバーの REST / WebSocket / OpenAI 互換 (`/v1`) の一覧です。仕様の一次資料は [PROTOCOL.md](../PROTOCOL.md)、[PROTOCOL-v3.md](../PROTOCOL-v3.md)、[PROTOCOL-v3-phase2.md](../PROTOCOL-v3-phase2.md)、[PROTOCOL-v3-phase3.md](../PROTOCOL-v3-phase3.md)、[PROTOCOL-v3-phase4.md](../PROTOCOL-v3-phase4.md) です。このページは実装されている経路(`server/src/` の `app.get` / `app.post` 等)を基に要約しています。食い違う場合はコードが正です。

表記:

- `{...}` は JSON ボディ、`?a=b` はクエリです。
- 「認証」列の **端末** は `Authorization: Bearer <端末トークン>`、**API キー** は `Authorization: Bearer ocsk-…`、**管理者** は端末トークンかつ管理者アカウント、**なし** は認証不要です。
- 時刻はエポックミリ秒、ID はクライアントが生成する UUID です。

## 目次

- [共通仕様](#共通仕様)
- [認証と端末](#認証と端末)
- [API キー](#api-キー)
- [同期](#同期)
- [会話・メッセージ](#会話メッセージ)
- [プロジェクト・プリセット・設定](#プロジェクトプリセット設定)
- [チャットフォルダー](#チャットフォルダー)
- [プロバイダーとモデル](#プロバイダーとモデル)
- [モデルのロゴ](#モデルのロゴ)
- [ツール・Web 検索](#ツールweb-検索)
- [履歴検索](#履歴検索)
- [バックアップ・エクスポート・インポート](#バックアップエクスポートインポート)
- [統計](#統計)
- [開発者向け(フェーズ 4)](#開発者向けフェーズ-4)
- [WebSocket](#websocket)
- [OpenAI 互換 API (`/v1`)](#openai-互換-api-v1)
- [curl の例](#curl-の例)

---

## 共通仕様

### エラー形式

通常の REST(`/v1` 以外)のエラーは次の形です。

```json
{ "error": "Unauthorized" }
```

ステータスは内容に応じて 400(入力不正)、401(認証なし・トークン無効)、403(権限なし、登録無効)、404(存在しない / 他人のデータ)、409(重複)、429(ログインの失敗回数超過)、502 / 504(外部への接続失敗・タイムアウト)などです。

`/v1/*` のエラーは OpenAI 形式です。

```json
{ "error": { "message": "Invalid API key", "type": "authentication_error", "code": "invalid_api_key" } }
```

### 認証の使い分け

| 経路 | 受け付ける認証 |
|---|---|
| `/v1/*` | API キー(`ocsk-…`)のみ。端末トークンは不可 |
| それ以外の REST と `/ws` | 端末トークンのみ。API キーは不可 |
| `/ping`、`/version`、`/healthz`、`/auth/register`、`/auth/login` | 認証なし |

### 同期の仕組み

会話・メッセージ・プロジェクト・プリセット・プロバイダー・設定はすべて `seq`(サーバー全体で単調増加)を持ち、削除は `deleted: true` の論理削除です。変更は WebSocket の `upsert` で全端末に配られ、再接続時は `GET /sync?since=<seq>` で差分を取ります。

---

## 認証と端末

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `POST /auth/register` | なし | `{username, password, deviceName?, platform?}`。ユーザー名は 3〜32 文字、パスワードは 8 文字以上。管理者(最初のアカウント)はこの API では作れず、ユーザーが 0 人のとき 403 `No administrator exists yet` を返す(サーバーで `omnichat-admin create` を使う)。管理者がいれば `ALLOW_REGISTRATION=1` のときだけ登録でき、一般ユーザーになる(無いと 403 `registration is disabled`)。`409` は名前の重複 |
| `POST /auth/login` | なし | `{username, password, deviceName?, platform?}`。成功すると端末を 1 つ作り `{userId, username, token, deviceId, isAdmin}` を返す。同じ IP とユーザー名で 5 分間に 10 回失敗すると 429 |
| `POST /auth/logout` | 端末 | 今使っている端末を失効させる |
| `GET /devices` | 端末 | `{devices: [{id, name, platform, createdAt, lastSeenAt, current}]}` |
| `DELETE /devices/:id` | 端末 | その端末を失効させる。トークンは即座に無効になり、開いている WebSocket は close code `4001` で閉じられる |

端末トークンはサーバーに平文では保存されず、ハッシュのみ保存されます。紛失した端末は `DELETE /devices/:id` で失効させてください。

---

## API キー

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `POST /apikeys` | 端末 | `{name?}` → `{id, name, key, prefix, createdAt}`。`key`(`ocsk-…`)は**この応答でしか表示されない** |
| `GET /apikeys` | 端末 | `{keys: [{id, name, prefix, createdAt, lastUsedAt}]}`(キー本体は返らない) |
| `DELETE /apikeys/:id` | 端末 | 失効。`{ok: true}` |

API キーは `/v1/*` 専用です。ハッシュのみ保存されます。

---

## 同期

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /sync?since=N` | 端末 | `seq > N` の変更を返す。`{seq, conversations, messages, providers, projects, presets, folders, settings?}`。`settings` は変更があったときだけ入る |
| `GET /ping` | なし | `{t}`(サーバーの時刻。WebSocket が使えないときの RTT 計測用) |
| `GET /version` | なし | `{name: "omnichat-server", version, webUi, searxng}`。`searxng` は `SEARXNG_URL` が設定されているかの真偽値 |
| `GET /healthz` | なし | 本文 `ok` |

---

## 会話・メッセージ

会話の作成・メッセージの送信は REST ではなく WebSocket の `send` / `regenerate` で行います([WebSocket](#websocket))。REST では会話の属性を作成・更新します。

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `PUT /conversations/:id` | 端末 | 作成または更新。受け付けるフィールド: `title`, `providerId`, `model`, `projectId`, `systemPrompt`, `systemMode` (`append`/`replace`), `effort` (`off`(推論なし)/`low`/`medium`/`high`/`max`/`null`(モデル標準)), `params`(サンプリング), `tools`(文字列配列または `null`), `searchMode` (`off`/`smart`/`always`/`null`。`auto` は `smart` として読まれる), `responseFormat`, `headId`。`headId` だけの更新は `updatedAt` を変えない。不正な値は 400 |
| `DELETE /conversations/:id` | 端末 | 論理削除。`conversation` を返す |

フェーズ 5: `PUT /conversations/:id` は `pinned`(真偽値)も受け付けます。`true` で `pinnedAt` を記録し(既にピン留め済みなら時刻は変えない)、`false` で `pinnedAt` を消します。`updatedAt` は変わりません。
| `GET /conversations/:id/context` | 端末 | 文脈の使用量(`ContextUsage`)。`limit`、`used`(system / history / attachments / tools / input)、`total`、`reserve`、`fits`、`estimated` などを返す |
| `POST /conversations/:id/context` | 端末 | `{draft?, providerId?, model?, effort?}` を含めて計算。入力中の下書きを数えるためのもので、モデルは呼ばない |
| `GET /conversations/:id/export?format=md\|json&branches=current\|all&reasoning=1` | 端末 | 1 会話を書き出す。既定は `md` と `current`。`reasoning=1` で思考過程も含める |
| `GET /messages/:id/debug` | 端末 | 送信時の最終プロンプト・パラメーター・生の応答(`{model, providerKind, final, response, createdAt}`)。本人のみ。無ければ 404 |

`GET /conversations/:id/export` の `format=json` は再インポート可能な形式です([BACKUP.md](BACKUP.md))。

---

## プロジェクト・プリセット・設定

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `PUT /projects/:id` | 端末 | 作成または更新。`name`, `systemPrompt`, `systemMode`, `defaultProviderId`, `defaultModel`, `effort`, `params`, `tools`, `searchMode` (`off`/`smart`/`always`。`auto` は `smart` の別名)。`Project` を返す |
| `DELETE /projects/:id` | 端末 | 論理削除。所属する会話は「未分類」(`projectId: null`)に移る |
| `PUT /presets/:id` | 端末 | システムプロンプトのプリセット。`{name?, text?}` |
| `DELETE /presets/:id` | 端末 | 論理削除 |
| `GET /settings` | 端末 | 全体設定 |
| `PUT /settings` | 端末 | 部分更新。`systemPrompt`, `effort`, `params`, `devMode`, `tools`, `searchMode` (`off`/`smart`/`always`。`auto` は `smart` の別名), `search` (Web 検索の詳細設定 `searchModel`、`maxSites`、`maxSearches`、`allowDomains`、`denyDomains`、`readPages`、`readImages`、`maxImages`、`visionModel`、`guard` (`off`/`standard`/`strict`)、`allowPrivateUrls`。部分更新。詳しくは [SEARCH.md](SEARCH.md)。`searchMode` の `auto` は `smart` として読まれる), `autoTitle`, `titleModel` (`"<providerId>::<model>"`), `modelParams`(キーは `"<providerId>::<model>"`), `contextOverflow` (`truncate`/`summarize`/`stop`), `contextLimits`、フェーズ 5 の `contextCompressAt` (50〜95、`null` で自動圧縮オフ、既定 80)、`contextCompressTarget` (20〜80、既定 50)、`defaultContextLength` (256〜10000000、`null` で未設定。モデル読み込み時の既定値と、バックエンドが上限を返さないときの想定上限) |

---

## チャットフォルダー

チャットを分類するフォルダーです。プロジェクトとは別で、システムプロンプトや既定の設定は持ちません。

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `PUT /folders/:id` | 端末 | 作成または更新。`{name?, mode?}`。`name` は前後の空白を除いて 100 文字まで(既定 `"New folder"`)。`mode` (`chat`/`code`) は作成時だけ指定できる。`ChatFolder` を返す。他の人のフォルダーは 403 |
| `DELETE /folders/:id` | 端末 | 論理削除。所属する会話は「未分類」(`folderId: null`)に移る。会話は削除されない。`ChatFolder` を返す |

- 会話は `PUT /conversations/:id` の `folderId` (フォルダー ID または `null`)で移動します。存在しない・削除済み・他の人のフォルダーは 400 (`Unknown folder`)。エフェメラル会話は必ず `null` です。
- 会話の `conversation` には `folderId` が入ります。
- 変更は WebSocket の `upsert` で `folders`(と影響した `conversations`)として届きます。同期では `GET /sync` の `folders` に入ります。`ChatFolder` は `{id, name, mode, createdAt, updatedAt, deleted, seq}` です。

---

## プロバイダーとモデル

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /provider-kinds` | 端末 | 登録されているプロバイダーの種類(`openai-compatible`、`dsh-bridge`) |
| `PUT /providers/:id` | 端末 | `{name, kind, baseUrl, model, apiKey?}`。`apiKey` を省略すると既存の値を保持。API キーはレスポンスに含まれない |
| `DELETE /providers/:id` | 端末 | 論理削除 |
| `GET /providers/:id/models?refresh=1&all=1` | 端末 | そのプロバイダーのモデル一覧。`refresh` でキャッシュを無視、`all` で埋め込み・音声などの除外を解除 |
| `GET /models?refresh=1&all=1` | 端末 | 全プロバイダーのモデルを `{groups: [...]}` で返す |
| `POST /providers/:id/models/load` | 端末 | `{model}`。LM Studio / Ollama のみ。成功で `{ok: true}`。対応外は 501 `{error: "unsupported"}` |
| `POST /providers/:id/models/unload` | 端末 | `{model}`。同上 |
| `GET /local-servers` | 端末 | サーバー PC 上で検出されたローカル推論サーバー(LM Studio 1234、Ollama 11434、llama.cpp 8080、vLLM 8000 の既定ポート) |
| `GET /bridges` | 端末 | 接続中の dsh ブリッジ `{bridges: [{name, cwd, online}]}` |
| `POST /bridges/token` | 端末 | dsh プラグイン用の端末トークンを新しい端末として発行する。body は `{name?}`(JSON。空でも `{}` を送る。名前は制御文字を除き 40 文字まで、既定 `PC`)。応答は `{token, deviceId, name}` で、**トークンはこの 1 回だけ**返る(保存はハッシュのみ)。端末名は `DSH plugin (<name>)`。ユーザーごとに 1 時間 10 回まで(超えると 429)。`DELETE /devices/:id` で失効でき、接続中のブリッジは close code `4001` で切れる |

モデル一覧の各項目には、分かる場合だけ `state`(読み込み状態・VRAM・量子化・コンテキスト長)と `effort`(`supported` / `unsupported` / `unknown`)が付きます。LM Studio では `state.publisher`(モデルの発行元、例: `lmstudio-community`)も入ります。

---

## モデルのロゴ

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /model-logo?model=&publisher=` | 端末 | モデルを出している組織(Hugging Face の組織)のアバター画像のバイト列。`model` は必須(300 文字以内)、`publisher` は任意(100 文字以内)。見つからなければ 404 `{error: "not found"}`。成功時は `Cache-Control: private, max-age=604800`(7 日)。Content-Type は取得元の画像形式(png / jpeg / webp / svg / gif) |

組織の決め方は次の順です。

1. モデル名の系統表(例: `gemma` / `gemini` は google、`qwen` は Qwen、`llama` は meta-llama)に当たれば、その組織。
2. `publisher`(LM Studio の発行元)があり、再配布者(下記)でなければ、その組織。
3. モデル ID の `組織/` 接頭辞があり、再配布者でなければ、その組織。
4. どれも決まらなければ Hugging Face を検索し、該当リポジトリの `cardData.base_model`(元モデル)の組織、なければリポジトリの作者を使う。

再配布者(`lmstudio-community`、`mradermacher`、`unsloth`、`bartowski`、`TheBloke`、`mlx-community`、`ggml-org`、`ollama` など、量子化や変換だけをしている組織)は組織として使いません。

取得したアバターは `DATA_DIR/cache/model-logos/` に保存されます(`<組織>.<拡張子>` と `index.json`)。成功は 30 日、失敗(アバターなし)は 24 時間キャッシュされ、組織の解決結果もメモリに 24 時間残ります。アバターは `huggingface.co` / `hf.co` のホストからだけ、2 MB 以下の画像を取得します。

**プライバシー:** 画像を取るためにモデル名・組織名が huggingface.co に送信されます(サーバーから Hugging Face への通信)。送らないようにするには、サーバーの環境変数 `OMNICHAT_MODEL_LOGOS=0` を設定します。この場合は外部への通信を一切せず、既にキャッシュ済みの画像だけを返します。

---

## ツール・Web 検索

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /tools` | 端末 | `{tools: ToolInfo[]}`。組み込みの `web_search` とプラグインのツール。読み込みエラーは `available: false` と `error` 付きで出る |
| `POST /tools/reload` | 管理者 | プラグインフォルダを再スキャンして `{tools}` を返す |
| `GET /tool-grants` | 端末 | 「常に許可」にした承認: `{grants: [{tool, grantedAt}]}` |
| `DELETE /tool-grants/:tool` | 端末 | 承認を取り消す(`{ok: true}`、存在しなくても成功) |
| `GET /search/status` | 端末 | `{configured, backend, host, reachable, error?}`。結果は 5 秒キャッシュ。`host` は host:port のみ |
| `POST /search/test` | 管理者 | `{query}` → `{results: [{title, url, snippet?}]}`。未設定は 400、検索失敗は 502 |

ツールの型 `ToolInfo` は `{name, description, parameters, permissions, source, pluginId, available, error?, needsApproval}` です。詳しい仕様は [PLUGINS.md](PLUGINS.md)、[SEARCH.md](SEARCH.md) を参照してください。

---

## 履歴検索

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /history/search?q=…&projectId=…&limit=20&offset=0` | 端末 | 全会話のメッセージ本文と会話タイトルを検索。`{results: [{messageId, conversationId, conversationTitle, projectId, role, snippet, createdAt}], total}`。`snippet` の一致箇所は `\u0001…\u0002` で囲まれる。`limit` は 1〜100 |

3 文字以上の語は FTS5(trigram)で検索し、短い語は `LIKE` で部分一致します。空白区切りの語は AND 検索で、最大 8 語です。タイトル一致は `messageId: null` で返ります。

---

## 文書の変換(フェーズ 5)

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `POST /artifacts/convert` | 端末 | `{type: "docx"\|"pptx", title?, markdown}` を Word / PowerPoint のバイナリにする(本文 1 MB 以下)。`Content-Type` は各形式、`Content-Disposition: attachment; filename*=UTF-8''<title>.<ext>`。`pptx` は `#`/`##` 見出しごとにスライド。不正な形式・本文は 400 |

## バックアップ・エクスポート・インポート

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `POST /admin/backup` | 管理者 | 手動バックアップを作る(`{name, size, createdAt}`) |
| `GET /admin/backups` | 管理者 | 一覧(新しい順) |
| `GET /admin/backups/:name` | 管理者 | ダウンロード(`application/octet-stream`) |
| `DELETE /admin/backups/:name` | 管理者 | 削除 |
| `GET /export` | 端末 | 自分のデータを JSON で全部出力(プロジェクト、プリセット、設定、会話)。API キーとプロバイダーのキーは含まない |
| `POST /import` | 端末 | `GET /export` の JSON を取り込む。上限 50 MB。常に新しい ID で作り、既存データは上書きしない。設定は取り込まない |

手順は [BACKUP.md](BACKUP.md) を参照してください。

---

## 統計

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /stats?since=<ms>&recent=20` | 端末 | 全体・直近・モデル別の平均(TTFT、prefill / decode tok/s、トークン数)と時系列。`source: "estimated"` の割合も返す |
| `GET /stats/export` | 端末 | 計測の CSV(`omnichat-metrics.csv`) |

---

## 開発者向け(フェーズ 4)

[PROTOCOL-v3-phase4.md](../PROTOCOL-v3-phase4.md) の仕様で、`server/src/routes-dev.ts` に経路があります。**状態: 実装済みだが実機での検証は未実施**です(詳細は [DEVELOPER.md](DEVELOPER.md))。

| メソッド・パス | 内容 |
|---|---|
| `POST /tokenize` | `{providerId?, model?, text}` → `{tokens, count, exact, source}`。llama.cpp は実トークン、それ以外は推定 |
| `GET /comparisons`、`GET /comparisons/:id`、`DELETE /comparisons/:id` | 比較の保存結果(チャット履歴とは別) |
| `GET /bench/sets`、`PUT /bench/sets/:id`、`DELETE /bench/sets/:id` | ベンチマークの問題セット |
| `POST /bench/runs`、`GET /bench/runs`、`GET /bench/runs/:id`、`GET /bench/runs/:id/export`、`POST /bench/runs/:id/cancel`、`DELETE /bench/runs/:id` | ベンチマーク実行(同時に 1 件まで) |
| `GET /config/export?format=json\|yaml` | 設定・プロジェクト・プリセットを移植用に出力(キーは含まない) |
| `POST /config/import` | `{format, content, mode?}` を取り込む。既定は merge |

WebSocket の `compare` / `compare_stop` も同じ仕様です([WebSocket](#websocket))。

---

## v4: Chat/Code 分離・承認ルール・通知・テンプレート・ペット

[PROTOCOL-v4.md](../PROTOCOL-v4.md) の仕様(サーバー側は M1)。**状態: 実装済み。サーバーのテストは `server/src/v4.test.ts`**。

| メソッド・パス | 内容 |
|---|---|
| `PUT /conversations/:id`、`PUT /projects/:id` | `mode: "chat"|"code"` を受け付ける。dsh-bridge の会話は既定で `code`。会話には `codeStatus`(`idle`/`running`/`awaiting_approval`/`done`/`error`)が付く |
| `GET /code/sessions` | Code モードの会話一覧(`conversationId,title,projectId,cwd,bridge,codeStatus,updatedAt,pendingApprovals`) |
| `GET /messages/:id/changes` | Code 実行の変更ファイル一覧(`patch` 全文つき。同期されるメッセージは 20 KB 超の `patch` を省く) |
| `GET /code/checkpoints?conversationId=`、`POST /code/checkpoints/:id/rewind` | チェックポイント一覧と巻き戻し(`{removeNew?}`。実行中は 409) |
| `GET /approval-rules?projectId=`、`PUT /approval-rules/:id`、`DELETE /approval-rules/:id` | 承認ルール(`kind`: tool/command/path、`action`: allow/deny/ask、`pattern` は 300 文字まで、ユーザーあたり 500 件まで)。プロジェクトのルールがグローバルに優先し、deny > allow > ask、一致なしは ask |
| `PUT /settings` | `notify: {done,approval,error}`、`notifyUrl`(ntfy 互換の http(s) URL。`GET /settings` は `notifyUrlSet` だけ返し URL は返さない)、`activePetId` |
| `POST /notify/test` | 設定済みの `notifyUrl` にテスト通知を送る |
| `GET /templates?projectId=`、`PUT /templates/:id`、`DELETE /templates/:id` | テンプレート(名前は 60 文字まで・スコープ内で一意、本文は 20 000 文字まで)。`GET /sync` と WS `upsert` の `templates` で同期 |
| `POST /pets`、`GET /pets`、`GET /pets/:id/sheet`、`DELETE /pets/:id` | Codex ペットの保存(PNG/WebP のヘッダーで 1536x2288(v2)/1536x1872(v1)を検査、8 MB まで) |
| `GET /admin/diagnostics` | 管理者のみ。Markdown の診断レポート(秘密情報は `***`)。直近 40 行のログつき |

WebSocket サーバー → クライアントの追加: `phase`(`thinking/searching/tool/subagent/answering` の開始・終了。メッセージの `phases` にも保存)、`notify`、`checkpoint`、`checkpoint_unavailable`。ブリッジ → サーバーの追加フレーム: `changes`、`agents`、`checkpoint`、`approval`、`rewound`。サーバー → ブリッジ: `approval_reply`、`rewind`。

---

## VS Code ブリッジ(vscode-bridge)

[VSCODE.md](VSCODE.md) と [design/VSCODE-BRIDGE.md](design/VSCODE-BRIDGE.md)。**状態: サーバー実装済み**(テスト: `server/src/code-agent.test.ts`、`code-approval-mode.test.ts`、`vscode-bridge*.test.ts`、`vscode-policy.test.ts`)。

| メソッド・パス | 内容 |
|---|---|
| `PUT /providers/:id` | `kind: "vscode-bridge"`: `baseUrl` は端末名(URL ではない)、API キーなし。使うモデルは会話の `model` に `"<providerId>::<modelId>"` で持つ |
| `POST /bridges/token` | `{name, kind:"vscode"}` で VS Code 拡張用の端末トークンを作る(端末名は `VS Code (<name>)`) |
| `GET /bridges` | `kind:"vscode"` の要素に `version` `protocol` `tools` `trusted` `busy` `compat:{ok,minVersion}` `instances` が付く。同名の VS Code ウィンドウは 1 件にまとまり、`workspaces` は和集合 |
| `PUT /conversations/:id` | `approvalMode: "manual"|"auto"|"full"`(Code 会話のみ。既定 `manual`。`full` は `confirmFull: true` が必要で、無いと 400 `{code:"confirm_required"}`)。サーバーが自動で戻すことはない。会話に `approvalMode` が付き、`/sync` と WS `upsert` で同期 |
| `POST /code/checkpoints/:id/rewind` | vscode-bridge の会話では、そのフォルダを開いているウィンドウが実行。実行中は 409、未保存エディタがあれば 409 `{code:"dirty_editors"}` |

- ツール呼び出しは既存の WS `tool`(`messages.toolCalls`)で見え、`decidedBy` は `rule:<id>` / `mode:<mode>` / `user` / `timeout` / `abort`。承認は既存の WS `tool_approval`(vscode では保護項目に `protected:true` と `reasons` が付き、「常に許可」は無効)と `tool_approval_reply`。
- 環境変数: `OMNICHAT_CODE_MAX_ROUNDS`(1 送信あたりの最大ラウンド。既定 50、最大 200)、`TOOL_APPROVAL_TIMEOUT_MS`(承認待ち。既定 120000)。
- 拡張 ⇄ サーバーのフレーム(`/bridge?kind=vscode&instance=<uuid>`)。拡張 → サーバー: `ready` `workspaces` `run_ack` `checkpoint` `event`(`tool_progress`)`tool_result` `approval` `approval_decision` `changes` `done` `rewound`。サーバー → 拡張: `welcome` `run` `tool_call`(`approval:{by,protectedOk,outsideOk?}` 付き。`outsideOk` はフルアクセス、または範囲外アクセスをユーザーが承認したときだけ `true`)`cancel` `approval_reply` `approval_pending` `approval_settled` `run_end` `rewind`。
- VS Code 内チャット(0.5.4 以降、`ready.capabilities.chat` と `transcript` が true のとき): 拡張 → サーバー `prompt`(`searchMode`、`interrupt` 付き可、`replaceLast: true` で最後のユーザーメッセージとその後を会話から消してから送る。実行中は `busy`、`conversationId` 必須)`models_request` `conversations_request` `conversation_request` `set_approval_mode` `stop` `context_request` `devices_request` `compact_request` `conversation_settings_request` `conversation_settings_set` `history_search_request` `checkpoints_request {requestId, conversationId}`(0.5.6 以降)`checkpoint_restore {requestId, conversationId, checkpointId, removeNew?}`(0.5.6 以降)、サーバー → 拡張 `prompt_ack` `models`(項目に `contextLength`・`vision` が付く場合あり)`conversations`(`searchMode` 付き)`transcript` `approval_mode` `context`(`used`・`reasoning`・`last?` 付き)`devices`(`{name, kind: vscode|dsh, online, self, workspaces}` の配列。このユーザーのオンライン端末のみ、`self` は問い合わせ元)`compacted`(`ok:true` は `before` `after` トークン数。`compacted` `ok:false` `reason:"too_short"` は圧縮対象なし)`conversation_settings`(`systemPrompt` `systemMode` `effort` `title`)`conversation_settings_ack`(`ok`。失敗時は `error`(`invalid_frame` `not_found`)と `message`。成功時は `settings` `title`)`history_search`(`results` は最大 30 件。この端末の Code 会話の一致だけ)と `error {code:"rate_limited"}`(毎秒 30 フレームまで)。 0.5.6 以降のサーバー → 拡張: `checkpoints {requestId, conversationId, items}`(新しい順、最大 50。項目は `{id, createdAt, dirty, restorable, prompt, files, messageId}`。`prompt` は直前のユーザー依頼の 1 行(120 文字まで)、`files` は変更ファイル数、`restorable` は Git の時点として戻せるか)`checkpoint_restored {requestId, conversationId, checkpointId, ok, error?, message?}`(`error` は `busy` `unavailable` `not_found` `dirty_editors` `failed`。戻す前の状態は `refs/omnichat/checkpoints/pre-rewind-<時刻>` に残る)。`transcript` の assistant 項目は、最終フレームと `conversation_request` の履歴に `sources?: [{title, url, host}]`(最大 8。http/https のみ、ユーザー情報とフラグメントは除く)を持つことがある。`ready.capabilities.transcriptDelta` が true のときは、実行中の `assistant` が `from` 付きの差分で届き、`tool` 項目には `diff` が付く(0.5.5 以降)。詳細は [VSCODE.md](VSCODE.md)。

---

## 音声通話(`/voice/*`、Aria)

サーバーが Aria(別プロジェクトの AI-VTuber)との間を中継し、通話を履歴に残します。設計は [design/ARIA-HOST.md](design/ARIA-HOST.md) と [design/ARIA-HOST-ADDENDUM.md](design/ARIA-HOST-ADDENDUM.md)(食い違うときは追補が優先)。認証は他の REST と同じ(`Authorization: Bearer <端末トークン>`、WS は `?token=`)。`mode` が `off` のとき、Aria が要る API は `409 {code:"voice_off"}`、Aria に届かないときは `502 {code:"aria_unreachable"}`。Aria のトークンは、どの応答にも出ません。通話に使う LLM は、ユーザー一律(管理者が役割 `fast` / `deep` のモデルを指定)です。

| メソッド・パス | 誰が | 内容 |
|---|---|---|
| `GET /voice/status` | ログイン済み | `{ mode, ready, ttsModes, me, canAdmin }`(`ready` = Aria の `/health` と `/voice/placement` が 200) |
| `GET` / `PUT /voice/me` | 本人 | 話し方の設定(`voice`, `ttsMode`, `speed`, `pauseScale`, `responseDelayMs`, `endOfTurnMs`, `bargeIn`, `bargeInDb`)。範囲は丸める。`speed` の既定は balanced で 1.3、fast で 1.0 |
| `GET /voice/voices` | ログイン済み | 声モデルの一覧(`kind`: `aivmx` / `piper`、`ownerUserId`、`mine` 付き) |
| `POST /voice/voices/models?name=&kind=aivmx\|piper&file=zip\|model\|config` | ログイン済み | 声モデルのアップロード(本文は生のバイト列、上限 300 MB)。`kind` 省略時は拡張子から(`.aivmx` = 標準、`.onnx` / `.zip` / `.json` = Fast の piper)。Aria が弾いた形式は `422`、知らない拡張子は `415`(どちらも `{code:"unsupported_format"}`) |
| `DELETE /voice/voices/models/:uuid` | 持ち主 / 管理者 | 削除(`kind` に応じた Aria の API を呼ぶ) |
| `POST /voice/preview` | ログイン済み | `{ text?, voice?, ttsMode? }` → `audio/wav`。Aria に試聴の API が無いときは `501 {code:"not_supported_yet"}` |
| `GET /voice/diagnose` | ログイン済み | `[{ id, ok, message, hint }]`(Aria に届く、健康状態、音声認識、`tts_modes`、LLM の役割) |
| `GET /voice/usage` | 本人 | 今日と直近 30 日の通話時間・ターン数・返事の文字数、本人に当たる 1日の上限(分)(本人の上書き、なければ共通の値)、超過しているか |
| `GET` / `PUT /voice/admin/config` | 管理者 | `{ mode: off\|hosted\|external, baseUrl, dailyLimitMinutes }`。トークン(`chatToken`, `adminToken`)は書き込み専用で、読み出しは `chatTokenSet` / `adminTokenSet` だけ。`dailyLimitMinutes` = ユーザーごと・1日あたりの通話時間の上限(0 = 無制限) |
| `PUT /voice/admin/quota` | 管理者 | `{ userId?, dailyMinutes }`。`dailyMinutes` は 0〜1440 の整数か `null`。`userId` なしは共通の `dailyLimitMinutes` を設定(`null` は無制限、つまり 0)。`userId` ありは、そのユーザーの上書きを設定(0 = 無制限、`null` = 上書きを外して共通の値に戻す)。存在しない `userId` は `404`。`/local-admin/voice/quota` にも同じ |
| `GET /voice/admin/llm`、`PUT /voice/admin/llm/roles` | 管理者 | 役割 `fast`(通話の返事)/ `deep`(背景思考)のモデルの取得と指定(`{role, endpoint?, model}`) |
| `GET /voice/admin/users` | 管理者 | ユーザーと設定、今日の使用量 |
| `GET /voice/admin/usage?days=7\|30` | 管理者 | ユーザー別の使用量。既定は 30 日。`{ days, defaultDailyMinutes, dailyLimitMinutes, users: [{ id, username, isAdmin, callMinutes(期間の通話時間・分、小数 1 桁), turns, replyChars, dailyMinutes(本人の上書き、なければ null), today, last30 }] }`。`last30` は常に直近 30 日 |
| `GET /voice/admin/placement`、`PUT /voice/admin/placement/stt` | 管理者 | Whisper の置き場所 |
| `GET /voice/admin/models` | 管理者 | 声モデル(持ち主付き)。各要素に `kind`、`ready`(Fast は Aria の `ready`、なければ `.onnx` と config がそろっているか。標準は常に `true`)、`builtin`(持ち主のない Aria の声。例: Fast の `tsukuyomi`)。Aria の Fast の一覧にあって行の無い声も、`builtin` で並ぶ。Aria が答えないときは行だけ(Fast は `ready: false`) |
| `/local-admin/voice/*` | Server アプリ | `/voice/admin/*` と同じ内容(ループバック + local-admin トークン)。ほかに `status`、`diagnose`、`usage`(`?days=` も渡る)、`quota`(PUT)、`DELETE models/:uuid` |

### `WS /voice/ws?token=&conversationId=&private=1`
Aria の `/live/ws` へ JSON とバイナリをそのまま中継します。`conversationId` が無ければ新しい会話を作り(`ready` に `conversationId` を足して返す)、ある場合は本人の会話に追記します。`private=1` のときは、会話の作成も保存もしません(Aria にも `private=1` を伝え、`ready.private` をそのまま返す)。接続の直後(Aria の `ready` のあと)に、サーバーが保存した話し方の設定を、`{type:"settings", values, persist:false}` で Aria に送ります。

閉じるコード: `4409` = `voice_off`、`4429` = `busy`(1ユーザー 1 通話)または `quota`(1日の上限)、`4404` = 会話が無い、`4502` = Aria に届かない、`1011` = `aria_restarting`(Aria が止まった / 再起動した。クライアントが再接続する)。

サーバーが履歴に記録します(クライアントの実装に依存しません): 確定した文字起こし(`final:true`)は `role:'user'`、Aria の `text` は `role:'assistant'` のメッセージで、どちらも `via:'voice'`。取り消し(`transcript_retract`)は `utterance_id` で対応します。`/ws` の `upsert` で、ほかの端末にもリアルタイムに届きます。会話の JSON の `kinds`(`'chat'` / `'voice'` の配列)は、メッセージの `via` から導かれます。通話が終わると、仮のタイトル(「通話 …」)を、既存のタイトル生成で付けます(使えるプロバイダーがあるとき)。

中継は、ターンごとに `{type:"omni_stats", latencyMs}` をクライアントに流します(Aria の `turn_end.stats.first_audio_ms` があればそれ、なければ中継が測った値)。通話時間とターン数は `voice_usage` に集計します。

## WebSocket

### 接続

```
ws(s)://<サーバー>/ws?token=<端末トークン>
```

認証は URL のクエリで渡します。リバースプロキシのアクセスログに残る可能性があるため、ログの扱いに注意してください([INSTALL.md](INSTALL.md))。トークンが無効なら HTTP 401 で接続を拒否します。端末が失効すると close code `4001` で切断されます。

接続直後にサーバーは次を送ります。

1. `hello`: `{"type":"hello","seq":123,"serverTime":1760000000000,"route":"lan"}`。`route` は `loopback` / `lan` / `vpn` / `external`。`TRUST_PROXY=1` のときは `X-Forwarded-For` の先頭を使う
2. `snapshot`: 生成中のメッセージの途中経過(再接続時に続きを表示するため)

### クライアント → サーバー

| `type` | 内容 |
|---|---|
| `send` | メッセージを送る。`{conversationId, content, userMessageId, assistantMessageId, parentId?, effort?, params?, responseFormat?}`。`parentId` を省略すると会話の `headId` の下に入る。編集して再送は元のメッセージの親を `parentId` にする |
| `regenerate` | 応答を作り直す。`{conversationId, messageId, assistantMessageId, effort?, params?, responseFormat?}`。`messageId` は作り直す**アシスタント**メッセージ |
| `stop` | 生成を止める。`{messageId}` |
| `tool_approval_reply` | ツール承認の回答。`{approvalId, decision}`。`decision` は `once` / `always` / `deny` |
| `ping` | `{t}`。サーバーは即座に `pong` で返す |
| `compare` | 比較の実行(フェーズ 4)。`{compareId, prompt, systemPrompt?, targets: [{providerId, model, effort?, params?, responseFormat?}], sequential?}` |
| `compare_stop` | 比較の停止。`{compareId}` |

`send` の `effort` や `params` は 1 回限りの指定です(会話の設定より優先)。

### サーバー → クライアント

| `type` | 内容と例 |
|---|---|
| `hello` | 上記 |
| `snapshot` | `{"type":"snapshot","messages":[{"id":"…","conversationId":"…","content":"…","reasoning":null,"status":"streaming","toolCalls":null,"sources":null,"guardBlocked":null}]}`。受け取った側は内容を置き換える。`guardBlocked` は、検索の安全装置(`search.guard`)が取り除いた本文の一覧(無ければ `null`) |
| `upsert` | `{"type":"upsert","messages":[…]}` ほか `conversations` / `projects` / `presets` / `folders` / `providers` / `settings`。完了したメッセージの `status` は `done` / `stopped` / `error` |
| `delta` | `{"type":"delta","messageId":"…","conversationId":"…","text":"こん"}`。`"kind":"reasoning"` が付けば思考過程、付かなければ本文 |
| `tool` | ツール呼び出しの状態変化。`{"type":"tool","messageId":"…","conversationId":"…","call":{id,name,arguments,status,result?,error?,durationMs?}}` |
| `tool_approval` | 承認要求。`{"type":"tool_approval","approvalId":"…","messageId":"…","conversationId":"…","tool":"fetch_url","arguments":{…},"permissions":["network"]}`。120 秒以内に回答がなければ拒否扱い |
| `error` | `{"type":"error","code":"context_overflow","message":"…","messageId":"…"}`。`code` は省略されることもある。`messageId` は省略されることもある |
| `models_changed` | `{"type":"models_changed","providerIds":["…"]}` |
| `pong` | `{"type":"pong","t":…}` |
| `compare_delta` / `compare_done` / `compare_complete` | 比較の進行(フェーズ 4) |

クライアントは未知の `type` を無視する必要があります(後方互換のため)。

---

## OpenAI 互換 API (`/v1`)

API キーで認証します。チャット履歴には保存されません(ステートレス)。dsh ブリッジのプロバイダーは公開されません。

### `GET /v1/models`

モデル ID は **`<プロバイダー名のスラッグ>/<モデル ID>`** です。スラッグは小文字化し、空白をハイフンにしたものです(例: `LM Studio` → `lm-studio`)。

```json
{ "object": "list", "data": [ { "id": "lm-studio/lfm2.5-24b-a2b", "object": "model", "created": 1760000000, "owned_by": "lm-studio" } ] }
```

### `POST /v1/chat/completions`

- `model`: `<スラッグ>/<モデル ID>`。スラッグが無い場合は、そのモデル ID を一覧に持つ最初のプロバイダーを使う
- `messages`、`stream`、およびサンプリング(`temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `seed`, `stop`, `max_tokens`, `reasoning_effort`, `response_format` など)は、そのまま上流のプロバイダーに渡される
- `stream: true` のときは `text/event-stream` で返す。クライアントが切断すると上流への要求も中止する
- 上流が失敗したときは上流のステータスと本文を返す。接続失敗は 502 `api_connection_error`

存在しないモデルは 404 `model_not_found` です。

---

## curl の例

以下の `BASE` はサーバーの URL、`ALICE_PASS` は各自のパスワードに置き換えてください。

### 1. 端末トークンを得る

```bash
BASE=http://localhost:8787
TOKEN=$(curl -s -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"'"$ALICE_PASS"'","deviceName":"curl"}' | jq -r .token)

curl -s "$BASE/models" -H "Authorization: Bearer $TOKEN"
```

### 2. API キーを作る(端末トークンが必要)

```bash
KEY=$(curl -s -X POST "$BASE/apikeys" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"script"}' | jq -r .key)
```

`key` は一度しか表示されないので、すぐ保存してください。UI からも作れます(Settings → Developer mode → API keys & OpenAI-compatible endpoint)。

### 3. 非ストリーミングで呼ぶ

```bash
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "model": "lm-studio/lfm2.5-24b-a2b",
    "messages": [{"role": "user", "content": "こんにちは"}],
    "temperature": 0.7
  }'
```

### 4. ストリーミングで呼ぶ

```bash
curl -N "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"lm-studio/lfm2.5-24b-a2b","stream":true,"messages":[{"role":"user","content":"短く自己紹介して"}]}'
```

応答は `data: {...}` の行が続き、最後は `data: [DONE]` です。

### 5. OpenAI SDK から使う

Python:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="ocsk-…")
resp = client.chat.completions.create(
    model="lm-studio/lfm2.5-24b-a2b",
    messages=[{"role": "user", "content": "こんにちは"}],
)
print(resp.choices[0].message.content)
```

Node.js:

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "ocsk-…" });
const stream = await client.chat.completions.create({
  model: "lm-studio/lfm2.5-24b-a2b",
  stream: true,
  messages: [{ role: "user", content: "こんにちは" }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

HTTPS のリバースプロキシの後ろに置く場合は `base_url` をその URL にします。

### 6. 端末トークンを失効させる

```bash
curl -s -X POST "$BASE/auth/logout" -H "Authorization: Bearer $TOKEN"
```
