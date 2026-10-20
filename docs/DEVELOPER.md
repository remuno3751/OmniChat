# 開発者向け機能と開発の手順

この文書は 2 つの内容を扱います。

1. **開発者モード**: モデルに実際に送られたプロンプト、生の応答、サンプリングパラメーターなどを確認する機能(フェーズ 1〜3 から使えます)
2. **フェーズ 4 の機能**: 構造化出力、トークン表示、モデル比較、ベンチマーク、設定ファイル、CLI

仕様は [PROTOCOL-v3-phase4.md](../PROTOCOL-v3-phase4.md) です。API は [API.md](API.md)、サンプリングの画面操作は [FEATURES.md](FEATURES.md) を参照してください。

## 1. 状態一覧

このリポジトリのコードを確認した時点の状況です。「実装あり」はコードが存在して配線されていることを指し、**実機やリアルなモデルでの検証はまだ行っていません**。

| 機能 | サーバー | アプリの画面 | CLI | 状態 |
|---|---|---|---|---|
| 最終プロンプト・生 JSON・速度の表示 | 実装済み | 実装済み(メッセージの開発者向け表示) | — | フェーズ 1〜3 で確認済み(記録に基づく) |
| サンプリングパラメーター(温度など) | 実装済み | 実装済み(モデル・会話・プロジェクト・全体の各設定) | — | 同上 |
| 構造化出力(JSON モード / JSON スキーマ) | 実装あり(`structured.ts`) | 実装あり(応答形式エディター、JSON 検証バッジ) | — | 検証済み(一部コンパイル確認のみ) |
| logprobs / grammar / extraBody | 実装あり(`sampling.ts`、`structured.ts`) | 実装あり(パラメーター欄、ログ確率の表示) | — | 検証済み(一部コンパイル確認のみ) |
| トークン表示 | 実装あり(`tokenize.ts`、`POST /tokenize`) | 実装あり(トークン表示) | — | 検証済み(一部コンパイル確認のみ) |
| モデル比較 | 実装あり(`compare.ts`、WebSocket の `compare`) | 実装あり(比較画面) | — | 検証済み(一部コンパイル確認のみ) |
| ベンチマーク | 実装あり(`bench.ts`、`/bench/*`) | 実装あり(ベンチ画面、問題セット、結果) | — | 検証済み(一部コンパイル確認のみ) |
| 設定ファイルの入出力(JSON / YAML) | 実装あり(`configfile.ts`、`/config/*`) | 実装あり(データ画面の設定ファイル) | — | 検証済み(一部コンパイル確認のみ) |
| CLI(`omnichat`) | — | — | 実装あり(`cli/`) | `cli/README.md` を参照 |
| チャットテンプレートの編集 | 対象外 | 対象外 | 対象外 | 対象外(下記) |

**チャットテンプレートの編集は対象外です。** 安全で移植性のある仕組みを提供するバックエンドがないためです。代わりに、最終的にモデルへ送られたプロンプトを開発者モードで確認できます。

## 2. 開発者モードの有効化

1. Settings → **Developer** → **Developer mode** をオンにする
2. 設定はサーバーに保存され、すべての端末で同じになります(`settings.devMode`)

オンにすると次が表示されます。

- **メッセージの開発者向け表示**(DebugSheet): タブ **Final prompt**(最終プロンプト)、**Raw JSON**(生の応答)、**Speed**(計測がある場合)、**Logprobs**(ログ確率がある場合)
- 入力欄の下の小さなチップ(次の 1 通だけ JSON 形式を指定する、など)
- 全体・プロジェクト・チャットの各設定で **Sampling parameters** の欄
- Settings → Developer の **API keys & OpenAI-compatible endpoint**(API キーの作成と管理)

開発者モードは表示だけを切り替えます。サーバーの `GET /messages/:id/debug` は本人なら常に使えます。

### 最終プロンプトと生 JSON

`GET /messages/:id/debug` は、そのメッセージの送信時の記録を返します。

- `model`、`providerKind`
- `final`: 実際に送った `messages`(役割と内容)、`params`(統合後のサンプリング)、`effort`(要求された値・解決された値・送った形)、ツールと検索の情報
- `response`: バックエンドの HTTP ステータス、`finishReason`、`usage`、`raw`(生の応答。ストリームでは最後の SSE データ)、`timings`
- 記録は 256 KB で打ち切られます(先に `raw` を、次に本文を切ります)

ツールを使った応答では、`final.messages` は**最後のリクエスト**(ツールの結果を含む)を指します。

## 3. サンプリングパラメーター

| キー | 意味 |
|---|---|
| `temperature`、`topP`、`topK`、`minP`、`repeatPenalty`、`seed`、`maxTokens` | 数値。空欄は「継承」 |
| `stop` | 停止文字列の配列(最大 16 件) |
| `logprobs` | 0〜20 の整数。下の「logprobs・grammar・extraBody」を参照 |
| `grammar` | llama.cpp の GBNF 文法 |
| `extraBody` | バックエンドのリクエストに追加する JSON オブジェクト |

**統合の順序**(キーごとに、最初に値がある層を使う):

1. その 1 回の送信(one-shot)
2. チャットの設定
3. プロジェクトの設定
4. 全体の「モデルごとの生成パラメーター」(`modelParams["<プロバイダー ID>::<モデル>"]`)
5. 全体の設定

`maxTokens` を指定しても、バックエンドによっては無視されることがあります。dsh プロバイダーにはサンプリングを送りません(`final.params` は `{}`)。

## 4. 構造化出力(JSON モード)

モデルに JSON を返させる設定です。

- `json_object`: 有効な JSON であることを要求する
- `json_schema`: 指定した JSON スキーマに沿うことを要求する(`{type:"json_schema", schema:{…}}`)

**指定の場所**(一回限り > 会話 > プロジェクトの順):

- 入力欄のチップ(次の 1 通だけ。表示は「JSON: off」「JSON object (next)」「JSON schema (next)」)
- チャットの設定
- プロジェクトの設定(「Ask the model for JSON in every conversation of this project」)

**確認**: 応答の後、サーバーは内容を `JSON.parse` し、スキーマについては型・必須項目・プロパティの型・enum だけを簡易に検査します。結果は計測の `jsonValid`(と失敗時の `jsonError`)に入り、アプリでは JSON 検証バッジで表示されます。

注意:

- 検査は簡易です。完全な JSON Schema の検証器ではありません(外部の検証ライブラリは入れていません)。
- 失敗しても自動では再生成しません。
- 対応していないバックエンドやモデルでは、JSON を守らないことがあります。

## 5. logprobs・grammar・extraBody

- **logprobs**: 0〜20 を指定すると、バックエンドには `logprobs: true` と `top_logprobs: N` を送ります。返ってきた確率は、デバッグの記録の `response.logprobs` に保存されます(256 KB まで)。**メッセージ本文には入りません。** 表示は開発者モードのデバッグ画面の Logprobs タブです。
- **grammar**: 文字列をそのままリクエストの `grammar` に入れます。llama.cpp の機能で、対応していないバックエンドでは無視されるか、エラーになります。
- **extraBody**: 追加の JSON です。**次のキーは無視されます**: `model`、`messages`、`stream`、`tools`、`stream_options`、`response_format`。サーバーの値を壊さないためです。それ以外のキーは、そのままバックエンドに送られます(名前が間違っていても検査しません)。

## 6. トークン表示

`POST /tokenize`:

```bash
curl -s -X POST "$BASE/tokenize" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"providerId":"<プロバイダー ID>","model":"<モデル>","text":"こんにちは、世界"}'
```

応答は `{tokens: [{id?, text}], count, exact, source}` です。

- **llama.cpp**: サーバーの `/tokenize` を使うので `exact: true`、`source: "llama.cpp"`
- **それ以外**: 推定のトークン分割。`exact: false`、`source: "estimate"`。CJK(日本語など)と ASCII で別の係数を使います(`tokens.ts` と同じ推定)

テキストは 20,000 文字までが対象で、超えた分は切り捨てて計算します(エラーにはなりません)。推定のトークン数は、実際のモデルのトークン数と一致しません。モデルの文脈長の判断には、コンテキストバーの値(バックエンドの値を優先し、分からないときだけ推定)を使ってください。

## 7. モデル比較

Settings → Developer → **Compare models**。同じプロンプトを最大 4 つのターゲット(プロバイダーとモデルの組)に送り、結果を並べます。

- **1 回限り**: チャットの履歴にも文脈にも入りません。統計(`/stats`)にも入りません。
- **順番に実行**: 既定では 1 件ずつ実行します。同じ GPU で並列に動かすと速度の計測が歪むためです。`sequential: false` で並列にもできます。
- **保存**: 結果は `comparisons` に別に保存され、`GET /comparisons` で一覧、`DELETE /comparisons/:id` で削除できます。
- dsh のターゲットは拒否されます(`error`)。
- 中止: `compare_stop`(WebSocket)で全件を止めます。

## 8. ベンチマーク

Settings → Developer → **Benchmarks**。問題セットを作り、ターゲットに対して実行して、速度を比べます。

- **問題セット**: 1〜50 件の問題(1 件 8,000 文字まで)とシステムプロンプト(任意)
- **実行**: ターゲットは 1〜6 件、繰り返しは 1〜5 回(既定 1)、ウォームアップは既定で有効、最大トークン数は既定 256(1〜32,768)
- **同時に 1 件まで**。実行中にもう 1 件を始めると 409 になります
- 実行はサーバーで行われ、クライアントが切断しても続きます。サーバーを再起動すると、実行中のものは `error` になります
- 進捗は WebSocket の `bench_progress` / `bench_done` で届きます
- 結果: 各回の TTFT、prefill・decode の tok/s、トークン数、推論トークン数、実行方法(`source`)。回答の内容は先頭 500 文字だけ保存します
- 集計: ターゲットごとに、平均・中央値・最小・最大、エラー数、`estimatedShare`(推定値の割合)。量子化と文脈長が分かる場合は表示します
- CSV: `GET /bench/runs/:id/export`

### 計測の注意(方法論)

ベンチマークの数値を比べるときは、次を守ってください。

1. **同じ条件で比べる**: 同じモデル、同じ量子化、同じ文脈長、同じ温度・最大トークン数。条件が違う結果は別の表にする(集計はこの組み合わせごとにまとめます)
2. **ウォームアップを使う**: 既定のウォームアップは、モデルの読み込みを計測から外すための短い要求です。結果には含まれません。ウォームアップを切ると、最初の回の値が読み込みの時間で歪みます
3. **繰り返す**: 1 回の値は揺れます。2〜5 回で平均と幅を見てください
4. **順番に、一つずつ**: 同時に別の推論や重い処理を動かさない。GPU を共有しているとデコード速度が落ちます
5. **推定と実測を混ぜない**: `source` が `estimated`(サーバーが推定した値)のものと、バックエンドが報告した値(`backend`)は性質が違います。`estimatedShare` が 0 でない結果は、そのまま比較しないでください
6. **TTFT・prefill・decode を分けて見る**: TTFT は最初のトークンまでの時間(待ち時間)、decode は生成の速さです。合計の時間だけで比べると、どちらが効いたか分かりません
7. **思考モデルの扱い**: 推論トークンが回答に含まれるかで、tok/s の意味が変わります。`reasoningTokens` を見て、同じ基準で比べてください
8. **品質は別**: ベンチマークは速度の計測です。回答の正しさは保存された先頭 500 文字では判定できません

## 9. 設定ファイル(移植用)

Settings の **Data**(データ画面)の「設定ファイル」から、または API で、設定を JSON か YAML のファイルとして出し入れします。

```bash
curl -s "$BASE/config/export?format=yaml" -H "Authorization: Bearer $TOKEN" -o omnichat-config.yaml
curl -s -X POST "$BASE/config/import" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile c omnichat-config.yaml '{format:"yaml", content:$c, mode:"merge"}')"
```

- **含むもの**: 全体の設定(システムプロンプト、エフォート、パラメーター、モデルごとの設定、ツール、検索モード、自動タイトル、文脈の溢れ時の動作と上限)、プロジェクト、プリセット、問題セット
- **含まないもの**: 会話、API キーなどの秘密情報
- **プロバイダーは名前で参照します**(ID ではない)。モデルは `"<プロバイダー名>::<モデル>"` の形です
- **上限**: 1 MB
- **取り込みの方法**: `mode` は `merge`(既定)か `replace`。
  - `merge`: 同じ名前のものは更新、無いものは作成。ファイルの空欄は手元の値を残す
  - `replace`: ファイルに無いプロジェクト、プリセット、問題セットを**削除します**。ファイルに含まれているセクションだけが対象です。取り込む前に必ずエクスポートを取ってください
- 結果は `{created, updated, removed?, skipped}` で、スキップした理由が入ります

## 10. CLI(`omnichat`)

`cli/` にあります。外部依存はなく、Node 22 以上で動きます(`cli/package.json` の `bin`)。詳細は `cli/README.md` を参照してください。

```bash
cd cli
node bin/omnichat.mjs --help      # 直接実行
npm test                          # node --test test/*.test.mjs
```

主なコマンド(`omnichat --help` の一覧より):

| コマンド | 内容 |
|---|---|
| `login --server URL [--username U] [--register]` | ログインして保存する(パスワードは入力、標準入力、または `OMNICHAT_PASSWORD`) |
| `logout` / `whoami` | 端末の失効・保存済みの確認 |
| `models [--provider NAME] [--all] [--json]` | `<プロバイダー名>/<モデル ID>` の一覧 |
| `chat "<メッセージ>" [--model …] [--project …] [--conv ID \| --new] [--effort …] [--search off\|auto\|always] [--approve once\|always\|deny]` | 送信して応答を流す(標準入力からも読める) |
| `history`、`show <会話ID>`、`search "<語>"` | 一覧、枝の表示、全文検索 |
| `export <会話ID> [--format md\|json] [-o FILE]` | 会話の書き出し |
| `bench run <セット> --targets "A/B,C/D"` | ベンチマークの実行 |
| `config export\|import` | 設定ファイルの入出力 |

設定ファイルは `~/.config/omnichat/config.json`(`OMNICHAT_CONFIG` で変更可)に、サーバーの URL と端末トークンを、ファイルの権限を絞って保存します。終了コードは 0(成功)、1(エラー)、2(使い方の誤り)、130(Ctrl+C)です。

## 11. 開発の手順

### 必要なもの

- Node.js 24(サーバー)。CI は Node 24 で `tsc --noEmit` とテストを実行します
- Expo 用の環境(アプリの Web 版を書き出す場合)
- Rust(デスクトップ版をビルドする場合)

### コマンド

| 対象 | 型検査・テスト | 補足 |
|---|---|---|
| `server/` | `npm run typecheck`、`npm test` | テストは `node:test`(`tsx --test`) |
| `server/` | `npm run build` | `tsconfig.build.json` で `dist/` を作る |
| `bridge/` | `npm run typecheck`、`npm test` | dsh デーモン型 |
| `dsh-plugin/` | `npm test`、`npm pack` | dsh プラグイン |
| `cli/` | `npm test` | 外部依存なし |
| `app/` | `npm run web`(開発サーバー) | Expo(react-native-web) |
| リリース相当の成果物 | `node packaging/build-release.mjs --out .release/stage` | Web の書き出し、サーバーのビルド、本番用の依存。`--node <実行ファイル>` で Node を同梱 |

CI(`.github/workflows/ci.yml`)は、サーバー、ブリッジ、dsh プラグインの型検査とテストを実行します。リリースの手順は [RELEASING.md](RELEASING.md) です。

### テストの注意

- サーバーのテストは、モデルの自動タイトル要求を避けるために `AUTO_TITLE_DEFAULT=0` を使うテストサーバーで動きます
- 検索のテストは偽の SearXNG だけを使います。**実際の SearXNG とは接続していません**
- 実際の LM Studio や dsh を使う確認は、テストには含まれていません(記録は [README.md](../README.md) の検証範囲を参照)

### 設計の要点

- **同期**: 行はすべて `seq` を持ち、変更は `upsert` で配られる。論理削除
- **プロバイダー**: `server/src/providers/index.ts` の `registerProvider(kind, factory)` で種類を追加できる
- **モデルの適応**: LM Studio / Ollama / llama.cpp / vLLM の検出と読み込み・アンロードは `adapters/` と `model-admin.ts`
- **ツール**: `server/src/tools/`(登録、承認、実行)。プラグインは [PLUGINS.md](PLUGINS.md)
- **検索**: `server/src/search/`(バックエンドの型と SearXNG)。[SEARCH.md](SEARCH.md)
- **マイグレーション**: `migrate-*.ts` がスキーマを上げる。既存の DB に対して起動時に実行される
