# 引き継ぎメモ(ローカル LLM で開発を続けるための手順書)

対象リポジトリ: `<リポジトリのルート>`(Git 管理済み、Windows 11、シェルは Git Bash か PowerShell)。
このメモは、小さめのローカルモデルでも迷わないように、**やること・やり方・落とし穴**を具体的に書いています。迷ったら、まずこの順で読んでください: 1 → 3 → 4 → 5。

## 1. このプロジェクトは何か

OmniChat は、スマホ・PC・Web・Mac から同じ会話を続けられる AI チャットアプリです。

| フォルダ | 中身 |
|---|---|
| `server/` | Node 24 + TypeScript、Fastify 5、`ws`、`node:sqlite`。API と WebSocket と DB |
| `app/` | Expo SDK 57(React Native + Web)。画面遷移は状態ベース(ルーターなし) |
| `bridge/` | PC 常駐のデーモン。`dsh headless` を起動して DeepSeek Harness(dsh)を遠隔操作 |
| `dsh-plugin/` | dsh の中で動くプラグイン(`@omnichat/dsh-bridge`) |
| `desktop/` | Tauri 2 のデスクトップ用ランチャー |
| `cli/` | `omnichat` コマンド(外部依存なし) |
| `packaging/` | Docker、Windows インストーラー、systemd、launchd |
| `docs/` | 利用者向けドキュメント(`FEATURES.md`、`API.md`、`SEARCH.md` など) |

契約(プロトコル)文書はリポジトリ直下: `PROTOCOL.md`、`PROTOCOL-v3.md`、`PROTOCOL-v3-phase2/3/4.md`、`BRIDGE.md`、`BRIDGE-v2.md`、`NEXT-VERSION.md`(次期仕様書)。**新機能は、まずサーバー側の契約(型・API)を文書に書いてから実装します。**

## 2. これまでに完了していること

実サーバーと実 LM Studio で動作確認済みのもの:

- 認証・端末管理、プロジェクト、3 階層のシステムプロンプト、エフォート、生成パラメーター
- 会話の枝分かれ(編集して再送、再生成)、ストリーミング、思考表示
- OpenAI 互換 `/v1` と API キー、モデルのロード/アンロード、**ロード時のコンテキスト長指定(LM Studio / Ollama)**
- コンテキスト使用量バー、速度メトリクス、統計
- ツールとプラグイン、承認フロー、検索(SearXNG)、全文検索、バックアップ、エクスポート/インポート
- 構造化出力、トークン表示、モデル比較、ベンチマーク、設定ファイル、CLI
- **現在日時のシステムプロンプトへの自動挿入**(「今日」「昨日」の解釈、今日を未来と誤認しない)
- **smart 検索モード(既定)**: 最新情報が要りそうな質問だけ先に Web 検索。株価・為替・暗号資産は Yahoo Finance から現在値を取得(`server/src/freshness.ts`、`server/src/quotes.ts`)
- **検索の承認は既定で許可済み**(新規アカウントと、既存アカウントは一度だけ。取り消しは維持される)

直近のコミット: `f7acf77`(検索の既定許可)。サーバーのテストは 178 件すべて通っています。

## 3. これからやること(優先順)

ユーザーの依頼です。**UI の磨き込みは、機能追加がすべて終わってから**行います。

1. **メッセージ本文の Markdown 表示**(現在はプレーンテキスト。`app/src/components/MessageView.tsx`)。コードブロック、表、リスト、リンク、見出し。コードのコピーボタン。
2. **グラフ・表の表示**。モデルが出力した表(Markdown)、グラフ(JSON か ```chart のコードブロックなど、形式を先に決める)を描画。`app/src/components/LineChart.tsx` が既にあります。
3. **コンテキストの自動圧縮**。設定 `contextOverflow` に `truncate` / `summarize` / `stop` がすでにあります(`server/src/projects.ts`、`server/src/context.ts`)。`summarize` の実装状況を確認し、足りなければ「上限の何 % で古い部分を要約に置き換える」自動処理にする。
4. **既定コンテキストの設定変更**。モデルごとの既定コンテキスト長を、アプリの設定画面で変更できるようにする(`settings.contextLimits` が土台。ロード時の指定は `POST /providers/:id/models/load` の `contextLength`)。
5. **右側パネル(Claude のアーティファクト風)**。Markdown、Word(.docx)、PowerPoint(.pptx)を右側に表示・編集・ダウンロード。まずは Markdown の表示と保存、次に docx/pptx の生成(サーバー側で生成するのが安全)。
6. **メッセージ操作のワンクリック化**。コピー、再実行(再生成)、分岐(編集して再送)を、メニューではなくメッセージ横のボタンにする。現状は `MessageView.tsx` のメニュー(`Copy` / `Regenerate` / `Edit & resend`)。
7. **チャットのピン止め**。会話にピン状態を持たせ(DB 列、同期、API)、サイドバーの最上部に表示。
8. **アイコンの置き換え**。Google Fonts(Material Symbols など)または Icooon-mono のアイコンへ。絵文字や文字の記号(`⟳`、`🔍`)を置き換える。

その後に、UI のブラッシュアップをします。

## 4. 作業のやり方(必ず守る)

1. **契約を先に**: サーバー側の API・型・DB 変更を文書(`PROTOCOL-v3-phase5.md` を新規作成)に書く。
2. **サーバーを先に実装 → テスト → アプリ**の順。アプリは `app/src/protocol.ts` に型を足す。
3. **検証は自分で行う**: 型チェック、テスト、実サーバー + 実 LM Studio + ブラウザ。「動くはず」で終わらせない。
4. 1 つのまとまりごとにコミット。コミットメッセージの最後に次の 1 行を入れる:
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`(使うモデルが変わった場合も、ユーザーの指示がない限りこの行のままにする)
5. **ライセンスは AGPL-3.0-only に決定済み**(`LICENSE`、`NOTICE`)。改変・追加するファイルはこのライセンスで公開される前提。GPL 非互換のライセンスの依存を足さない(足す前に確認する)。
6. 日本語で報告する。未確認のことは「未確認」と書く。

## 5. コマンドと落とし穴

### よく使うコマンド

```bash
# サーバー: 型チェック → テスト(全 178 件、約 1〜2 分)
cd <リポジトリのルート>/server && npx tsc --noEmit && npm test

# アプリ: 型チェック → Web 書き出し
cd <リポジトリのルート>/app && npx tsc --noEmit
npx expo export --platform web --output-dir <出力先>

# 検証用サーバーの起動(別ポートとデータ置き場を使う。本番データを触らない)
cd <リポジトリのルート>/server
PORT=8790 DATA_DIR=<空のフォルダ> WEB_DIR=<書き出し先> ALLOW_REGISTRATION=1 \
  SEARXNG_URL=http://192.168.0.10:8080 npx tsx src/index.ts
```

- LM Studio は `http://localhost:1234/v1`。確認に使うモデルは `google/gemma-4-e4b` と `lfm2.5-24b-a2b`。
- 管理者は HTTP からは作れません。検証用のサーバーでは `node dist/admin-cli.js create <名前>` で作ります(パスワードは対話入力か `OMNICHAT_ADMIN_PASSWORD`)。検証用にはユーザーを新しく作る。
- 一時ファイルは、リポジトリの外(スクラッチ用フォルダ)に置く。

### 落とし穴

- **テストは `server/test.env` を読み込みます**(`npm test` が `--env-file=test.env` を付ける)。中身は `OMNICHAT_INJECT_DATE=0`(日時挿入を止める)、`OMNICHAT_QUOTES=0`(相場取得を止める)、`OMNICHAT_DEFAULT_SEARCH_GRANT=0`(検索の既定許可を止める)。既存テストが送信内容を厳密に比べるためです。新しい環境変数で挙動が変わるなら、ここに足します。
- **スクリプトでファイルを書き換えるとき、`\` と `` ` `` の扱いで壊れやすい**。正規表現やテンプレート文字列を含む編集は、Node の文字列置換より**エディタ系の編集ツール**を使い、直後に `npx tsc --noEmit` で確認する。壊れたまま `npm test` を走らせるとテストが固まります。
- Windows では `pkill` が無い。プロセスを止めるときは PowerShell で `Get-NetTCPConnection -LocalPort <ポート> -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`。
- テストの並列数は `--test-concurrency=2`。上げると時間依存のテストが落ちます。
- アプリの画面はブラウザの幅を合わせて確認する(デスクトップと 375px の両方)。スクリーンショットの座標と実際の座標は、拡大率の違いでずれることがある。
- Expo の API は変更が多い。`app/AGENTS.md` の注意に従い、使う前に公式ドキュメント(バージョンは `app/package.json` の `expo`)を確認する。
- 検索(SearXNG)は、ユーザーの環境で既定のエンジンが制限されています。使えるエンジンは `SEARXNG_ENGINES="bing news,yandex"` で指定します(`docs/SEARCH.md`)。

## 6. DSH(DeepSeek Harness)連携の現状

詳細は `docs/DSH.md`。

- デーモン型ブリッジ(`bridge/`): dsh 44.0.0 で会話の送受信を確認済み。
- dsh プラグイン(`dsh-plugin/`): `web` プロファイルで確認済み。PC からサーバーへ外向きに接続するので、別の PC でも使える。
- **未確認**: dsh のデスクトップ画面で入力した内容がアプリに反映されること、デスクトップ用プロファイルへのプラグイン導入。
- デーモン型は**承認なし**でシェルやファイルを操作します。

## 7. ユーザーの判断待ち(勝手に決めない)

- Apple の署名、Android のキーストア、バンドル ID(今は仮の `dev.omnichat.app`)
- GitHub(所有者 `remuno3751`、リポジトリ名 `omnichat`)の作成と push。**外部への公開にあたるので、許可なしにしない**。非公開での作成を推奨。

## 8. 未確認のこと

Docker のビルド、Inno Setup/WinSW のインストーラー、Linux/macOS のスクリプト、GitHub Actions、Android APK の署名、実機のスマホ、ライトモード、いくつかの画面の 375px 表示、フェーズ 4 のアプリ画面のうち JSON スキーマ編集・ログ確率タブ・ベンチの中止/CSV 出力(コンパイル確認のみ)、ロード時コンテキスト指定のアプリ画面(型チェックのみ)、smart モードの選択肢のアプリ画面(型チェックのみ)。
