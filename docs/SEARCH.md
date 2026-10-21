# Web 検索の設定と使い方

OmniChat の Web 検索は、次の 3 つの方式から選べます。OmniChat は検索結果をモデルに渡し、`[n]` の出典付きで回答させます。

1. **SearXNG(おすすめ)**: 自分で動かしている検索サーバー(SearXNG)を使います。このファイルの §1〜§2 は、この方式の手順です。
2. **内蔵(キー不要)**: Bing RSS / Wikipedia / DuckDuckGo を直接使います。SearXNG は不要です。
3. **API キー式**: Brave Search API / Tavily を使います。各サービスの API キーが必要です。

この手順は、サーバー PC の Docker で既存の SearXNG が動いている前提です(SearXNG 方式の場合)。SearXNG 自体の導入は扱いません。

関連: [INSTALL.md](INSTALL.md)(環境変数の書き方)、[FEATURES.md](FEATURES.md)(検索モードの画面操作)、[PLUGINS.md](PLUGINS.md)(別のネットワーク系ツール)、[SERVER-APP.md](SERVER-APP.md)(サーバーアプリの設定画面)。

## Web 検索の方式を選ぶ

### 選び方

- **クライアント**: 設定 > プラグイン > **Web 検索** カードで、3 つの方式から 1 つを選びます。各方式の状態(設定済みか、使えているか)が表示されます。変更できるのは管理者だけで、利用者は同じ内容を閲覧できます。
- **サーバーアプリ**: 設定 > **Web 検索** で同じ内容を設定します(`docs/SERVER-APP.md`)。
- 変更は**再起動なしで即反映**されます。

### 自動フォールバック

「自動フォールバック」(既定でオン)を有効にすると、選んだ方式が失敗したとき、または結果が 0 件だったときに、ほかの使える方式を **SearXNG → 内蔵 → API キー式** の順に試します。使えるのは URL かキーが設定されている方式だけです。

どの方式が実際に答えたかは `usedBackend` として返り、画面にも表示されます。オフにすると、選んだ方式だけを使います。

### API キーの扱い

- API キー(Brave / Tavily)は、サーバーのデータベースに暗号化(`enc1:` 形式、AES-256-GCM)して保存されます。
- 画面にも API にも、キーの値は返りません。設定済みかどうか(`keySet`)だけが表示されます。
- 暗号化の鍵を失うと保存済みのキーは復号できず、再入力が必要になります(`OMNICHAT_SECRET_KEY` は `docs/AI-INSTALL.md` を参照)。

### 既定値(env / config.env)

`SEARXNG_URL` などの環境変数や `config.env` の値は**既定値**です。データベースに設定があれば、そちらが優先されます。画面で一度でも保存または削除した項目は、データベースの値が使われ、環境変数の値は無視されます。

| 変数 | 意味 |
|---|---|
| `SEARCH_BACKEND` | 既定の方式。`searxng` / `builtin` / `api`。未設定なら、`SEARXNG_URL` があれば `searxng`、なければ `builtin` |
| `SEARXNG_URL` | SearXNG の URL |
| `SEARCH_ENGINES` | 有効にするエンジン ID のカンマ区切り(内蔵と API の両方のエンジンを書けます) |
| `BRAVE_API_KEY` | Brave Search API のキー |
| `TAVILY_API_KEY` | Tavily のキー |
| `SEARCH_FALLBACK` | `0` で自動フォールバックを無効にする(既定は有効) |

各変数の詳しい説明は、後ろの「関連する環境変数」の表を見てください。

## 内蔵エンジン(キー不要)

内蔵の方式は、次の 3 つのエンジンを組み合わせます。どれもキーは要りません。

| エンジン ID | 中身 |
|---|---|
| `wikipedia` | Wikipedia の公式 API(MediaWiki)で記事を検索します。`SEARCH_LANG` の言語版を先に調べ、結果が少ないときだけ英語版も調べます。 |
| `bing-rss` | Bing の検索結果を RSS 形式で読みます。 |
| `duckduckgo` | DuckDuckGo の HTML 版を読みます。 |

> **警告: 利用規約について**
>
> - `bing-rss` と `duckduckgo`(HTML 版)は、各社が公式に提供している API ではありません。非公式な利用になり、各社の利用規約に反する可能性があります。
> - CAPTCHA や遮断によって、ある日突然使えなくなることがあります。
> - 確実に使いたい場合は、Brave Search API / Tavily の API キーか、SearXNG を使うことをおすすめします。
> - 内蔵エンジンは個人利用の範囲にとどめてください。利用した結果の責任は利用者が負います。

### 動きと制限

- **言語**: `SEARCH_LANG`(既定 `ja`)で、Wikipedia などの言語を決めます。
- **タイムアウト**: 1 エンジンの上限は `SEARCH_ENGINE_TIMEOUT_MS`(既定 `6000` ms)です。
- **休止**: 同じエンジンが 3 回連続で失敗すると、10 分休止します。以後も失敗が続くと休止時間は倍になり、最大 1 時間までです。成功すると元に戻ります。休止中は `/search/status` の状態が `cooldown` になります。
- **キャッシュ**: 同じ検索語は 60 秒間キャッシュします(一部でも失敗した結果は保存しません)。
- **送信の回数**: 1 回の検索で、1 エンジンにつき 1 リクエストだけ送ります。
- **通信の作法**: 固定の User-Agent(`OmniChat/<version> (+https://github.com/remuno3751/omnichat)`)を使います。Cookie は送らず、リダイレクトは追いません。
- **サイズ**: 応答は 1 MB まで読みます。検索語は 200 文字までです。
- **接続先**: 各エンジン自身の https ホストだけに接続します。
- **遮断の扱い**: 403・429・503 の応答や、CAPTCHA のページは、遮断として失敗扱いにします。

## API キー式(Brave Search API / Tavily)

| エンジン ID | 中身 |
|---|---|
| `brave` | Brave Search API(公式の API)。キーは Brave の公式サイトで取得します。 |
| `tavily` | Tavily の API(公式の API)。キーは Tavily の公式サイトで取得します。 |

- キーを設定したエンジンだけが使われます。キーが無いエンジンは `API key not set` として扱われます。
- キーは、画面の入力欄(保存後は「設定済み」と表示されます)か、環境変数 `BRAVE_API_KEY` / `TAVILY_API_KEY` で設定します。
- 料金や無料枠は各サービスの条件を確認してください。

## 1. SearXNG で JSON を有効にする

以下の §1〜§2 は、SearXNG 方式の手順です。

OmniChat は `format=json` で問い合わせます。SearXNG の既定は HTML のみなので、設定を変える必要があります。

`settings.yml` に次を書きます。

```yaml
search:
  formats:
    - html
    - json
```

Docker 版 SearXNG では、設定ファイルは通常 `/etc/searxng/settings.yml` にあります(ホスト側のボリューム位置は導入方法で異なります)。変更後は SearXNG のコンテナを再起動します。

確認(ホストに公開したポートが 8888 の例):

```bash
curl "http://localhost:8888/search?q=test&format=json"
```

JSON が返れば成功です。HTML が返る、または 403 になる場合は [トラブルシューティング](#5-トラブルシューティング) を見てください。

## 2. OmniChat から接続する(SEARXNG_URL)

環境変数 `SEARXNG_URL` に SearXNG の URL を入れて、OmniChat を再起動します。どの URL になるかは、OmniChat をどう動かしているかで決まります。

| OmniChat の動かし方 | SearXNG の場所 | `SEARXNG_URL` の例 |
|---|---|---|
| Docker(同じ compose ネットワークに参加) | SearXNG のコンテナ名 `searxng`(ポート 8080) | `http://searxng:8080` |
| Docker(別の compose) | SearXNG をホストに公開(例 8888) | `http://host.docker.internal:8888` |
| Windows サービス / Linux / macOS | SearXNG をホストに公開(例 8888) | `http://localhost:8888` |

設定の場所:

- **Docker**: `docker-compose.yml` の `environment:` の `SEARXNG_URL`。同じネットワークに参加する場合は、compose の `networks:` のコメントを外し、SearXNG 側のネットワーク名(`docker network ls` で確認)に合わせます。`host.docker.internal` は compose に `extra_hosts` が入っているので Linux でも使えます。
- **Windows サービス版**: `%ProgramData%\OmniChat\config.env` の `SEARXNG_URL=`。インストーラーのウィザードでも指定できます。
- **Linux**: `/etc/omnichat/config.env` の `SEARXNG_URL=`。
- **macOS**: インストール先の `config.env` の `SEARXNG_URL=`。

変更後はサービスを再起動します(`net stop OmniChat` / `net start OmniChat`、`sudo systemctl restart omnichat`、macOS は `sudo launchctl kickstart -k system/com.omnichat.server`、Docker は `docker compose up -d`)。

接続の状態は `GET /search/status`(画面では Settings → Tools, plugins & search)で確認できます。`reachable: true` かつ `error` が無ければ、SearXNG は JSON で応答しています。`host` には host:port だけが表示され、パスや認証情報は含まれません。

関連する環境変数(全方式):

| 変数 | 既定 | 意味 |
|---|---|---|
| `SEARXNG_URL` | なし | SearXNG の URL。未設定でも内蔵とAPI キー式は使える。SearXNG 方式だけが使えなくなる |
| `SEARXNG_TIMEOUT_MS` | 8000 | SearXNG への要求の上限 |
| `SEARCH_MAX_RESULTS` | 使われない | 廃止。1 回の回答で使うサイト数は、全体の設定 `search.maxSites`(既定 10、1〜30)で指定します |
| `SEARCH_BACKEND` | 下の説明 | 既定の方式。`searxng` / `builtin` / `api`。未設定なら、`SEARXNG_URL` があれば `searxng`、なければ `builtin` |
| `SEARCH_ENGINES` | `bing-rss,wikipedia,duckduckgo` | 有効にするエンジン ID のカンマ区切り。API 側のエンジン(`brave`、`tavily`)も書ける |
| `SEARCH_FALLBACK` | `1` | `0` で自動フォールバックを無効にする |
| `SEARCH_LANG` | `ja` | 内蔵エンジン(Wikipedia など)の言語 |
| `SEARCH_ENGINE_TIMEOUT_MS` | 6000 | 内蔵・API のエンジン 1 件の上限(ms) |
| `BRAVE_API_KEY` | なし | Brave Search API のキー(DB の設定が優先) |
| `TAVILY_API_KEY` | なし | Tavily のキー(DB の設定が優先) |

## 3. 検索モード

検索の使い方は 3 つのモードから選びます。

| モード | 動き | 向いている場合 |
|---|---|---|
| `off` | 検索しない | 通常のチャット |
| `smart`(既定) | モデルが検索が必要かを判断し、必要なら **検索クエリを自分で書いて** `web_search` を呼び出す | ツール呼び出しに対応したモデル |
| `always` | 送信のたびに検索する。検索クエリは補助モデル(または応答モデル)が書く。書けないとき(計画の呼び出しが失敗したとき)は、ユーザーの発言そのものを検索語にする | 必ず検索させたい場合 |

`auto` は古い名前で、保存されていても、送信されても `smart` として扱われます(API の `searchMode`、CLI の `--search` も同じ)。以前の `smart` にあった「最新情報らしい語が含まれたら検索する」という語句判定は廃止しました。今は、モデルの判断が使われます。計画の呼び出しが失敗したときだけ、語句判定が予備として使われます。

解決の順序は **チャット → プロジェクト → 全体** で、どこかに値があればそれを使います(画面の表示は「Inherit」)。既定は `off` です。

### 承認

`web_search` は「ネットワーク」の権限を持ちますが、**新しいアカウントでは最初から許可済み**です(既存のアカウントにも、一度だけ許可を付けました)。許可を取り消すと、そのまま取り消された状態になり、以後は `smart` ではモデルの要求ごと、`always` では送信ごとに確認が出ます。

- **Allow once**: この 1 回だけ検索する
- **Always allow**: 以後の検索を承認なしで行う(取り消しは Settings → Tools, plugins & search の承認一覧)
- **Deny**: 検索せず、回答は自分の知識だけで行われる

承認が無い、または失敗した場合、`always` のモデルには「検索できなかった。出典を書いてはいけない」という指示が入ります。モデルが勝手に `[n]` を作らないようにするためです。

### 検索の結果と出典

検索結果は番号付き(`[1] タイトル — URL — 概要`)でモデルに渡され、回答には `[n]` の形で出典が付きます。メッセージの下に **Sources** として一覧が表示され、番号をクリックすると出典の URL を開けます。

同じ会話の中で同じ URL は同じ番号になります。出典の情報はメッセージの `sources` として保存されます。

### 検索の詳細設定(`search`)

全体の設定の `search` オブジェクトで、検索の細かい動きを決めます。`GET /settings` で読み、`PUT /settings` で一部だけ更新できます(残りは保たれます)。

| 項目 | 既定 | 意味 |
|---|---|---|
| `searchModel` | `null` | `"<providerId>::<model>"`。検索の計画・ページの要約に使う、別の小さく速いモデル。`null` なら応答モデルを使います。応答モデルとは別の GPU に置き、同時に読み込んでおくのがおすすめです |
| `maxSites` | 5(1〜30) | 1 回の回答で使うサイト数。検索結果とページの両方を数えます |
| `maxSearches` | 3(1〜10) | 1 回の回答での検索回数の上限 |
| `allowDomains` | `[]` | 空なら全サイトを許可。並べると、そのドメインだけを使います |
| `denyDomains` | `[]` | 拒否するドメイン。**拒否が許可より優先**されます |
| `readPages` | `true` | 上位の結果のページをサーバーが取得し、本文を抜き出してモデルに渡します |
| `allowPrivateUrls` | `false` | `false` の間は、プライベート・LAN・Tailscale・ループバックのアドレスへの取得を拒否します(SSRF 対策) |
| `readImages` | `false` | `true` で、ページ内の画像を画像認識モデルで説明文にして渡します |
| `maxImages` | 3(1〜10) | 読む画像の上限 |
| `visionModel` | `"answer"` | 画像の説明に使うモデル。`"answer"`(応答モデル)か `"search"`(`searchModel`) |
| `guard` | `"standard"` | 検索結果の安全装置。下の説明を参照 |

`guard` の動き:

- `off`: 何もしません。
- `standard`(既定): 検索結果の本文は、ユーザーのメッセージの中の区切られた「信頼できない内容」のブロックに入れられます。本文は無害化され、AI に向けた指示のような文は検出されて取り除かれます。取り除いた箇所は、回答の下に通知として表示され、メッセージの `guardBlocked` に保存されます。
- `strict`: `standard` に加えて、検出があった結果は丸ごと捨てられます。さらに、回答に含まれる、データを外へ運ぶ疑いのあるリンクは取り除かれます。

**注意**: プロンプトインジェクション(検索結果の中の悪意のある指示が、モデルの動きを変えること)は、この仕組みでも完全には防げません。検出は語句や形式のパターンで行うため、すり抜けることがあります。出典は必ず自分で確かめてください。重要な判断に検索結果を使うときは、特に注意してください。

## 4. 検索の確認と HTTP API(管理者)

管理者は `POST /search/test` で検索結果を直接確かめられます。画面では Settings → Tools, plugins & search の「Test search (administrator)」です。

```bash
curl -s -X POST "$BASE/search/test" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"weather tokyo"}'
```

### エンドポイント

| メソッド・パス | 権限 | 内容 |
|---|---|---|
| `GET /search/status` | ログイン済み | 3 方式の状態。`options`(各方式の `id`、`configured`、`reachable`、`state`、`lastError`、`engines`)、`active`(今使われる方式)、`mode`(選んだ方式)、`fallback`、`lastUsed`(最後に答えた方式 `usedBackend` と時刻) |
| `GET /search/config` | ログイン済み | 設定。`mode`、`fallback`、`searxngHost`(host だけ)、`engines`({`builtin`, `api`})、`keySet`({`brave`, `tavily`}) |
| `PUT /search/config` | 管理者のみ | 設定の変更。返り値は `GET /search/config` と同じ |
| `POST /search/test` | 管理者のみ | 検索を 1 回試す。`{query, mode?}` |

#### GET /search/status

```bash
curl -s "$BASE/search/status" -H "Authorization: Bearer $TOKEN"
```

#### GET /search/config

```bash
curl -s "$BASE/search/config" -H "Authorization: Bearer $TOKEN"
```

キーの値は返りません。`keySet` で設定済みかどうかだけを確認できます。

#### PUT /search/config

管理者だけが使えます。送った項目だけを変えます。

```bash
curl -s -X PUT "$BASE/search/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"api","fallback":true,"engines":{"api":["brave","tavily"]},"braveApiKey":"<Brave の API キー>","tavilyApiKey":null}'
```

- `braveApiKey` / `tavilyApiKey` は、文字列で設定します。`null`(または空文字)でキーを削除します。
- `searxngUrl` は `http(s)://` で始まる URL、`null` で削除します。
- 不正な値があると 400 を返し、何も変わりません。

#### POST /search/test

`mode`(`searxng` / `builtin` / `api`)を付けると、その方式だけを試します(フォールバックはしません)。省略すると、設定された方式で、フォールバックを含めて試します。

```bash
curl -s -X POST "$BASE/search/test" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"weather tokyo","mode":"builtin"}'
```

- 成功(200): `results`(検索結果)、`usedBackend`(答えた方式)、`tried`(試した方式と結果の一覧)、`status`(`/search/status` と同じ内容)を返します。
- 失敗(502): `error`(理由。キーの値は `***` に置き換えられます)と `status` を返します。

### サーバーアプリ・同じ PC からの管理(/local-admin)

サーバーアプリや、サーバーの PC 上の管理ツールは、`/local-admin` を使います。ループバック(`127.0.0.1`)からの要求だけを受け付け、`x-local-admin` ヘッダーに、サーバーが起動時に作るローカル管理用のトークンが要ります(サーバーアプリのデータフォルダ内の `data/local-admin.token`。`docs/SERVER-APP.md` を参照)。

```bash
curl -s "http://127.0.0.1:8787/local-admin/search/config" -H "x-local-admin: $LOCAL_ADMIN_TOKEN"

curl -s -X POST "http://127.0.0.1:8787/local-admin/search/test" \
  -H "x-local-admin: $LOCAL_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"weather tokyo"}'
```

| メソッド・パス | 内容 |
|---|---|
| `GET /local-admin/search/config` | `GET /search/config` と同じ内容に、`searxngUrl`(全体の URL)と `status` を加えたもの |
| `PUT /local-admin/search/config` | `PUT /search/config` と同じ。返り値は GET と同じ形式 |
| `POST /local-admin/search/test` | `POST /search/test` と同じ |

## 5. トラブルシューティング

| 表示されるエラー | 原因 | 対処 |
|---|---|---|
| `SearXNG returned HTML: enable search.formats: [html, json] in its settings.yml` | JSON が無効で、HTML のページが返った | 上の 1 の `settings.yml` を設定して SearXNG を再起動 |
| `SearXNG refused the request (HTTP 403)…` | SearXNG が JSON 形式の要求を拒否した | 同じく `formats` に `json` を入れる。それでも 403 のときは SearXNG の botdetection / limiter(bot 対策)が JSON 要求を止めていることがある。ローカルだけで使うなら SearXNG 側の該当設定を見直す(設定名は SearXNG のバージョンで異なるため、その版の公式ドキュメントで確認) |
| `SearXNG timed out after 8000 ms` | 応答が遅い、または上流の検索エンジンが遅い | `SEARXNG_TIMEOUT_MS` を延ばす。SearXNG 側の上流エンジンの状態を確認 |
| `SearXNG unreachable (host:port): ECONNREFUSED` など | URL・ポートの間違い、コンテナが同じネットワークにない | `SEARXNG_URL` を見直す(表の 3 通り)。Docker 内からホストの `localhost` は見えない |
| `SearXNG URL not set` | SearXNG 方式を選んでいるが、URL が空 | `SEARXNG_URL` を設定するか、内蔵または API キー式に切り替える |
| `Web search failed (builtin: …)` など(括弧の中に各エンジンの理由) | 使える内蔵・API のエンジンが、すべて失敗した(`bing-rss: …; wikipedia: …` のように理由が並ぶ) | 理由を見る。タイムアウトなら `SEARCH_ENGINE_TIMEOUT_MS` を延ばす。時間をおいて再試行する |
| `… blocked or rate-limited the request (HTTP 429)` / `… (HTTP 403)` / `… (HTTP 503)`、`duckduckgo blocked the request (CAPTCHA or anomaly page)` | 上流が遮断・制限した(CAPTCHA を含む) | そのエンジンは失敗として数えられ、3 回連続で 10 分休止する。時間をおく、または別のエンジン・方式に切り替える。繰り返すときは API キー式か SearXNG を使う |
| `… cooling down after repeated errors, retry in N s` | そのエンジンは休止中 | N 秒後に自動で戻る。待つか、別の方式を使う |
| `no API key set` / `API key not set` | API キー式を選んでいるが、キーが未設定 | Brave / Tavily のキーを入力する。キーを使わないなら、内蔵か SearXNG に切り替える |
| `no built-in engine enabled` | 内蔵のエンジンが 1 つも有効になっていない | `SEARCH_ENGINES` や画面のエンジン設定で、1 つ以上有効にする |
| `no search backend configured (set a SearXNG URL, enable a built-in engine or add an API key in the web search settings)` | 3 方式のどれも使えない | SearXNG の URL を入れる、内蔵エンジンを有効にする、API キーを入れる。いずれか 1 つで使えるようになる |
| `/search/status` の `reachable` が `false` | 上の接続エラーと同じ | `error` の文言を見る |
| 検索結果が無い(`No results.`) | 検索語に対してエンジンが何も返さなかった | 検索語を変える。SearXNG の画面で同じ語を試す |

確認の順序は次のとおりです。(1) 選んだ方式が「使える」になっているか(`GET /search/status` の `options`)。(2) `POST /search/test` で `mode` を付けて、方式ごとに結果が返るか。(3) 最後に OmniChat のモードを `smart` / `always` にします。SearXNG 方式の場合は、先に `curl` で `format=json` が JSON を返すかも確かめてください。

## 6. 注意

- 検索語(会話の一部)は、検索サービスとその先の検索エンジンに送られます。機密性の高い内容を検索に含めないでください。
- `always` と `smart` は、モデルが書いた検索語を外部に送ります。`always` では計画が失敗したとき、ユーザーの発言がそのまま検索語になるため、入力内容が外部に出ます。
- `readPages` が有効なときは、サーバーが検索結果のページを直接取得します。`allowPrivateUrls` は、社内や LAN のページを読ませる場合にだけ有効にしてください。
- `searchModel` を使うと、検索計画と要約の内容が、その別モデルに送られます(同じ PC や同じサーバー内で動かしてください)。
- SearXNG 自体は公開しないでください。OmniChat からしか使わないなら、ホストのポートは `127.0.0.1` だけに公開するか、Docker の同じネットワーク内だけで通信させます。
- 検索で得た本文はモデルに渡されるため、悪意のあるページがモデルの指示を書き換えようとする可能性があります(プロンプトインジェクション)。`guard`(既定 `standard`、より厳しい `strict`)で防ぎますが、**完全に防ぐことはできません**。出典は必ず自分で確かめてください。
- 内蔵エンジンの利用規約については、「内蔵エンジン」の警告を読んでください。

## スマート検索(既定)と最新情報

- 検索モードの既定は **smart** です。モデルが検索の要否を判断し、必要なときだけ自分で検索語を書いて `web_search` を呼びます。語句(「最新」「今日」など)による判定は、計画の呼び出しが失敗したときの予備にだけ使われます。
- 株価・為替・暗号資産の質問では、検索に加えて Yahoo Finance の相場(キー不要、最大 20 分程度の遅れあり)を取得してモデルに渡します(`server/src/quotes.ts`)。`OMNICHAT_QUOTES=0` で無効にできます。
- すべてのリクエストに現在の日時が自動で付きます(`OMNICHAT_TZ` でタイムゾーン、`OMNICHAT_INJECT_DATE=0` で無効)。
- SearXNG の既定エンジンが CAPTCHA や制限で 0 件になる場合は、ニュースカテゴリに自動でフォールバックします。使えるエンジンが分かっているときは `SEARXNG_ENGINES="bing news,yandex"` のようにカンマ区切りで指定してください。
