# 次期バージョン 実装方針(仕様書との突き合わせ)

仕様書 = 2026-10-15 版「ローカルLLMチャットアプリ 次期バージョン仕様書」。本書は、現行 OmniChat(server / app / bridge / dsh-plugin)に対する現状・方針・分担案・未決事項への推奨をまとめたもの。

## 1. 未決事項への推奨(これで進めてよいかの確認が必要)

| 未決事項 | 推奨 | 根拠 |
|---|---|---|
| 推論バックエンド | **OpenAI互換API(LM Studio / Ollama / llama.cpp / vLLM)を共通口にし、速度は各バックエンド固有のフィールドから取る** | 既に `openai-compatible` で LM Studio を実機確認済み。LM Studio は応答の `stats`(tokens_per_second, time_to_first_token)、llama.cpp は `timings`(prompt_per_second, predicted_per_second)、Ollama は `eval_count` / `eval_duration` / `prompt_eval_duration` を返す。**アダプターで正規化**し、取れない場合は自前計測(TTFT・総時間・出力トークン概算)で代替し「推定」と表示 |
| クライアント | **Expo(現行)を継続**。Android は EAS Build か `expo prebuild` + Gradle の署名付きAPK、Windows は Web 書き出しを **Tauri で包む** | 既にスマホ/Web 同一コード。Android SDK が未導入なので、APK ビルドは EAS(クラウド)か SDK 導入が前提 |
| 外部接続 | **Tailscale(VPN)を推奨、TLS は Tailscale の `serve`(HTTPS)または Caddy** | このPCは既に Tailscale のアドレス(100.x)を持つ。ポート開放・独自証明書が不要 |
| 検索バックエンド | **SearXNG を自前**(Docker。Docker Desktop は導入済み)。バックエンドは差し替え可能なインターフェース | 仕様どおり1つ目を実装。外部APIは後から追加 |
| ツール呼び出し非対応モデル | **「常に検索して文脈に入れる」簡易モードのみ対応**。それ以上(自作プロンプト型ツール呼び出し)はやらない | 仕様の「最小実装から」に合わせる |

## 2. 機能ごとの現状と方針

凡例: ✅実装済み / 🟡一部 / ⬜未着手

| 仕様 | 現状 | 方針 |
|---|---|---|
| 認証と安全な接続 | 🟡 ログイン時に1トークン(失効なし)、HTTP | 端末ごとのトークン(`devices` テーブル)、端末一覧と失効、API キー(別系統)。TLS はデプロイ側(Tailscale/Caddy)+ README。HTTP で非ループバックなら警告 |
| プロジェクト | ⬜ | `projects` テーブル + 会話の `projectId`。同期の対象(既存の seq 方式でそのまま流れる) |
| システムプロンプト(3階層/プリセット/最終プロンプト確認) | ⬜ | global(ユーザー設定)→ project → conversation。モード `append`/`replace`。`prompt_presets`。**組み立ては1か所**(`buildContext()`)に集約し、最終プロンプトをメッセージ単位で保存(開発者モードで表示) |
| 生成の停止・再生成・編集して再送 | 🟡 停止のみ | 再生成=同じ親からの新しい応答。**編集して分岐**のため、メッセージに `parentId` と `branch` を持たせる(木構造)。表示は現在の枝 |
| ストリーミング再接続 | 🟡 生成はサーバー側で継続し、再接続時に最終結果は同期される | 生成中の途中経過の再送(再接続時に、そのメッセージの現在の全文を `snapshot` で返す) |
| モデル管理 | 🟡 一覧・自動認識・切替まで | ロード/アンロードとVRAMは**バックエンド固有**。LM Studio は `lms` CLI / API、Ollama は `/api/ps`・`keep_alive`。アダプター方式で、対応できるものだけ表示 |
| エフォート設定 | ⬜ | 設定階層(global→project→chat→次の1通)。変換表は YAML。openai-compatible は `reasoning_effort`、dsh はモデルの `reasoningEfforts`。非対応モデルは無効表示 |
| コンテキスト表示 | ⬜ | サーバーで内訳(system/履歴/添付/ツール結果/入力)をトークン数に換算して返す。トークナイザーが無いバックエンドは概算(文字数/補正係数)で「概算」表示、可能なら `/tokenize` 等を使う |
| 速度メトリクス | ⬜ | 応答ごとに `metrics` テーブル(モデル・量子化・ctx長付き)。統計画面は集計クエリ |
| レイテンシ表示 | ⬜ | 既存 WebSocket 上の ping/pong を5秒間隔で計測、直近平均、LAN/外部の判定(接続先のアドレス種別) |
| クライアント配布 | ⬜ | フェーズ3 |
| ウェブ検索 | ⬜ | フェーズ3(ツール基盤の上に載せる) |
| プラグイン基盤 | ⬜ | フェーズ3。**dsh プラグインとは別物**(こちらはハーネスのツール登録)。dsh プラグインは既に別途進行中 |
| 開発者モード(高のみ) | ⬜ | 最終プロンプト/生JSON、OpenAI互換API(+APIキー)、サンプリング全設定、実行ログ・トレース |

## 3. フェーズ1の分担案(ファイルの衝突を避ける)

契約を先に固める: `PROTOCOL.md` に v3(devices/auth、projects、prompts、effort、branching、sampling、dev API)を追記。そのあと次の順で進める。

1. **S1(サーバー: 認証・端末・APIキー・OpenAI互換API)** — `auth.ts`、新規 `devices.ts` / `apikeys.ts` / `openai-api.ts`
2. **S2(サーバー: 会話モデルの拡張)** — `db.ts`(マイグレーション)、`chat.ts`、新規 `projects.ts` / `prompts.ts` / `context.ts`。プロジェクト、3階層プロンプト、effort、サンプリング、再生成/編集分岐、最終プロンプト保存
3. **A1(アプリ)** — S1/S2 の契約を満たす UI(端末一覧、プロジェクト、プロンプト編集、effort、再生成/編集、開発者モード)

S1 と S2 は別ファイル中心だが `index.ts` への登録は **S2 の完了後に私がまとめて配線**する(同時編集を避ける)。

## 4. リスク

- 速度メトリクス・VRAM・ロード/アンロードは、バックエンドごとに取れる情報が違う。**「取れるものだけ表示・取れないものは推定と明記」**で割り切る。
- 会話の枝分かれ(木構造)は、既存の同期(`seq` 方式)・mirror(dsh 同期)・UI の並び順に影響する。**先に仕様を固めてから実装**する。
- 端末ごとトークンへの移行で、既存の単一トークン(ログイン時)を壊さない移行が必要。
- Android APK は SDK 未導入のため、環境準備(EAS か SDK)が先に要る(フェーズ3)。
