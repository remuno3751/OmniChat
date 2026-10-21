# OmniChat

[English](README.md) | **日本語**

自分のサーバー(自宅 PC など)で動かすセルフホスト型の AI チャットアプリです。会話・プロジェクト・設定はサーバーの SQLite に保存され、ブラウザ・スマホ・デスクトップのどの端末からでも同じ内容が見え、別の端末から続きを送れます。バックエンドは OpenAI 互換 API(OpenAI / DeepSeek / Ollama / LM Studio / llama.cpp / vLLM など)で、PC 上の DeepSeek Harness(dsh)を遠隔操作する経路もあります。

- 対象は「自分と家族程度の少人数」で使う個人用途です。大規模なマルチテナント運用は想定していません。
- ライセンスは AGPL-3.0 です([ライセンス](#ライセンス)を参照)。
- **利用は自己責任です。** 無保証で提供し、利用によって生じた損害や不利益について、作者は責任を負いません([免責事項](#免責事項))。

## ダウンロード

最新版は **[Releases の最新リリース](https://github.com/remuno3751/omnichat/releases/latest)** の「Assets」からダウンロードします(ボタンはすべて最新リリースのページへ移動します)。

### OmniChat アプリ(クライアント)

スマホ・PC から自分のサーバーに接続してチャットするアプリです。

[![Windows 版クライアントをダウンロード](https://img.shields.io/badge/Windows-.exe_%2F_.msi-0078D6?style=for-the-badge)](https://github.com/remuno3751/omnichat/releases/latest/download/OmniChat-Desktop-Windows-x64-Setup.exe) [![macOS 版クライアントをダウンロード](https://img.shields.io/badge/macOS-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest/download/OmniChat-Desktop-macOS-universal.dmg) [![Android 版(APK)をダウンロード](https://img.shields.io/badge/Android-.apk-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest/download/OmniChat.apk) [![Web 版の使い方](https://img.shields.io/badge/Web-browser-555555?style=for-the-badge&logo=googlechrome&logoColor=white)](docs/DOWNLOAD.md#web-版)

文字リンク: [Windows](https://github.com/remuno3751/omnichat/releases/latest) / [macOS](https://github.com/remuno3751/omnichat/releases/latest) / [Android](https://github.com/remuno3751/omnichat/releases/latest) / [Web 版](docs/DOWNLOAD.md#web-版)(Linux の PC は、[Web 版](docs/DOWNLOAD.md#web-版)を使うか、ソースからビルドしてください)

### OmniChat Server(サーバー)

会話を保存して各端末をつなぐ本体です。自分の PC・NAS・VPS で動かします。

[![Windows 版サーバーをダウンロード](https://img.shields.io/badge/Windows-Setup.exe-0078D6?style=for-the-badge)](https://github.com/remuno3751/omnichat/releases/latest/download/OmniChat-Server-App-Windows-x64-Setup.exe) ![Docker は近日公開予定](https://img.shields.io/badge/Docker-%E8%BF%91%E6%97%A5%E5%85%AC%E9%96%8B%E4%BA%88%E5%AE%9A-lightgrey?style=for-the-badge&logo=docker&logoColor=white)

文字リンク: [Windows](https://github.com/remuno3751/omnichat/releases/latest) / Docker(近日公開予定) / macOS・Linux は [docs/INSTALL.md](docs/INSTALL.md) の手順(ソースから)

[すべてのリリース](https://github.com/remuno3751/omnichat/releases) ・ どれを入れるか迷ったら **[docs/DOWNLOAD.md](docs/DOWNLOAD.md)**(選び方・インストール手順・チェックサムの確認)をご覧ください。

### OmniChat VS(VS Code 拡張機能)

VS Code で開いているフォルダを、自分のサーバー経由で AI に操作させる拡張です(チャット、モデルの選択、承認)。

[![OmniChat VS 拡張機能(.vsix)をダウンロード](https://img.shields.io/badge/VS_Code-.vsix-FFD400?style=for-the-badge&logo=visualstudiocode&logoColor=black&labelColor=111111)](https://github.com/remuno3751/omnichat/releases/latest/download/OmniChat-VS.vsix)

インストール: `code --install-extension OmniChat-VS.vsix --force` を実行して、VS Code で「Reload Window」を実行します。設定と使い方は [docs/VSCODE.md](docs/VSCODE.md) を見てください。

> **v0.5.0 は、一般公開の最初のバージョンです。** 0.x なので、仕様が変わることがあります。動作確認が十分でない部分もあります(下の「[状態と検証範囲](#状態と検証範囲)」)。大切なデータは、定期的にバックアップしてください。他の OS・.msi などは [Releases](https://github.com/remuno3751/omnichat/releases/latest) の表から選べます。

> **注意**: インストーラーは署名していないため、初回に OS の警告が出ます(手順は [docs/DOWNLOAD.md](docs/DOWNLOAD.md#os-ごとのインストール手順))。

## 画面

| デスクトップ(ライト) | デスクトップ(ダーク) |
|---|---|
| ![チャット画面(ライト)](docs/images/chat-light.png) | ![チャット画面(ダーク)](docs/images/chat-dark.png) |

| スマホ | 設定 → モデル(コンテキスト超過時の動作) | 設定 → 外観(テーマとアプリアイコン) |
|---|---|---|
| ![スマホのチャット画面](docs/images/mobile-chat.png) | ![設定のモデルのページ](docs/images/settings-models.png) | ![設定の外観のページ](docs/images/settings-appearance.png) |

<sub>画面は、デモ用のアカウントと、擬似の LLM で撮影したものです。</sub>

## 目次

- [ダウンロード](#ダウンロード)
- [できること](#できること)
- [クイックスタート](#クイックスタート)
- [インストール(サーバー)](#インストールサーバー)
- [対応プラットフォーム](#対応プラットフォーム)
- [リポジトリ構成](#リポジトリ構成)
- [モデルの選択](#モデルの選択)
- [DeepSeek Harness(dsh)の遠隔操作](#deepseek-harnessdshの遠隔操作)
- [ドキュメント一覧](#ドキュメント一覧)
- [開発用の起動](#開発用の起動)
- [状態と検証範囲](#状態と検証範囲)
- [セキュリティの要約](#セキュリティの要約)
- [免責事項](#免責事項)
- [ライセンス](#ライセンス)

## できること

操作手順と既定値は [docs/FEATURES.md](docs/FEATURES.md) にまとめています。

| 領域 | 内容 |
|---|---|
| チャット | ストリーミング応答、停止、全端末への同期(WebSocket)、生成中に再接続したときの途中経過の復元(`snapshot`)、サイドバーの会話一覧 |
| プロジェクト | 会話をプロジェクトにまとめ、プロジェクトごとにシステムプロンプト・既定モデル・エフォート・ツール・検索モードを持たせる。削除時、会話は「未分類」へ移動 |
| システムプロンプト | 全体 → プロジェクト → チャットの 3 階層。各階層は「追記」か「置換」を選べる。プリセットの保存・再利用 |
| 推論エフォート | low / medium / high / max。次の 1 通だけ、チャット固定、プロジェクト、全体の順に解決。モデルごとの対応表は `effort-map.json`(編集可) |
| 分岐 | 再生成と「編集して再送」でメッセージが木構造になり、`‹ 2/3 ›` で版を切り替える |
| モデル | プロバイダーごとのモデル一覧の自動取得、ローカルサーバー(LM Studio / Ollama / llama.cpp / vLLM)の自動検出、LM Studio / Ollama ではロード状態・VRAM・量子化の表示とロード/アンロード |
| 思考(thinking) | 推論モデルの思考過程を回答と別レーンで保存。既定は折りたたみ(トークン数・所要時間つき) |
| コンテキスト表示 | 入力欄の上に「使用トークン / 上限」。内訳(システム・履歴・入力など)、80 % 警告、溢れたときの動作(古い順に削除 / 要約 / 停止) |
| 速度メトリクス・統計 | 返信ごとの TTFT・prefill/decode tok/s・トークン数。バックエンド報告値か推定値かを `est.` で区別。統計画面と CSV 出力 |
| レイテンシ | ヘッダーに ping の平均値と経路(loopback / LAN / VPN / 外部)。切断時は自動再接続、下書きは保持 |
| ツール・Web 検索 | モデルが呼べるツール(組み込みの `web_search` と、サーバーに置くプラグイン)。権限付きツールは初回に承認(1 回のみ / 常に許可 / 拒否)。検索は SearXNG(自前)を使い、出典は `[n]` 引用で表示([docs/SEARCH.md](docs/SEARCH.md)、[docs/PLUGINS.md](docs/PLUGINS.md)) |
| 履歴検索 | 全会話の全文検索(日本語の部分一致可)。`Ctrl/Cmd+K` |
| バックアップ・エクスポート | 管理者向けの定期バックアップ、会話の Markdown / JSON 出力、全データの JSON 出力と取り込み |
| API キー・OpenAI 互換エンドポイント | `/v1/chat/completions` と `/v1/models`。OpenAI SDK の `base_url` を向けて使える(履歴には保存しない) |
| 開発者モード | 最終プロンプトと生 JSON の確認、サンプリングパラメーター、API キー。モデル比較・ベンチマーク・構造化出力・トークン表示・設定ファイル入出力・CLI は[フェーズ 4](#状態と検証範囲)の範囲([docs/DEVELOPER.md](docs/DEVELOPER.md)) |
| dsh の遠隔操作 | PC 上の DeepSeek Harness を OmniChat から操作(外向き接続のみ)。dsh の GUI の会話も同期 |
| VS Code 連携 | VS Code で開いているフォルダを AI に操作させる(拡張 `vscode-ext/`・`.vsix`)。エージェントのループはサーバー側(ツール対応の任意のモデル)、拡張がツール(ファイルの読み書き・コマンド・Git)を実行。承認は手動 / 自動 / フルアクセスの 3 段、保護項目は常に確認、チェックポイントと巻き戻し付き。安全網でありサンドボックスではない。[docs/VSCODE.md](docs/VSCODE.md) |
| 端末管理 | 端末ごとのトークン、端末一覧と失効、ログアウト |

## クイックスタート

1. サーバーを入れる(下の[インストール](#インストールサーバー)。手元で試すだけなら[開発用の起動](#開発用の起動))。
2. **管理者を 1 人作ります。** 最初の管理者は HTTP からは作れず、サーバーの PC で `sudo omnichat-admin create <ユーザー名>`(Docker は `docker exec -it omnichat node dist/admin-cli.js create <ユーザー名>`)を実行します。パスワードは対話入力で、8 文字以上です。次にブラウザで `http://<サーバー>:8787/` を開いてその管理者でログインします。他の人の登録は `ALLOW_REGISTRATION=1` にすると、管理者の作成後に一般ユーザーとして受け付けます。詳しくは [docs/INSTALL.md](docs/INSTALL.md) を参照してください。（Windows の「OmniChat Server」アプリでは、画面の中からも作成できます。）
3. サイドバー下部の **Settings** → **Providers** → **+ Add provider** で接続先を追加します。プリセット(OpenAI / DeepSeek / Ollama / LM Studio / DeepSeek Harness)から選ぶと URL が入ります。サーバー PC 上で LM Studio や Ollama が動いていれば「Auto-detected on the server」に出るので **Add** で追加できます。API キーはサーバー側にのみ保存され、クライアントには返りません。
4. チャット画面上部のモデルボタンでモデルを選び、メッセージを送ります。

スマホ・デスクトップ版は、ログイン画面のサーバー URL に同じアドレスを入力します([docs/CLIENTS.md](docs/CLIENTS.md))。

## インストール(サーバー)

サーバーを動かす PC に入れる方法は 4 つです。詳細は **[docs/INSTALL.md](docs/INSTALL.md)**。配布物は GitHub の Releases にあります。

| 方法 | 手順の要点 |
|---|---|
| Docker Compose | **近日公開予定**(イメージ `ghcr.io/remuno3751/omnichat` を公開したあと、`docker compose up -d` で使えます。データはボリューム `/data`) |
| Windows | `OmniChat-Server-Setup-<版>.exe` を実行(Node.js 不要、Windows サービスとして常駐) |
| Linux | tarball を展開して `sudo ./install.sh`(systemd) |
| macOS | tarball を展開して `./install.sh`(launchd、Apple Silicon / Intel) |

更新・バックアップ・Tailscale/HTTPS・SearXNG 連携も [docs/INSTALL.md](docs/INSTALL.md) にあります。リリース作業は [docs/RELEASING.md](docs/RELEASING.md)。

## 対応プラットフォーム

### サーバー

| 環境 | 提供形態 | 常駐の仕組み |
|---|---|---|
| Windows(x64) | インストーラー `.exe`(Node 24 同梱) | Windows サービス `OmniChat`(WinSW) |
| Linux(x64 / arm64) | tarball + `install.sh`(Node 24 同梱) | systemd(ユニット名 `omnichat`) |
| macOS(Apple Silicon / Intel) | tarball + `install.sh`(Node 24 同梱) | launchd(`com.omnichat.server`) |
| Docker(amd64 / arm64)※近日公開予定 | `ghcr.io/remuno3751/omnichat` | Docker の `restart: unless-stopped` |

### クライアント

| 端末 | クライアント | 備考 |
|---|---|---|
| ブラウザ(Chrome / Edge / Firefox / Safari) | サーバーの URL を開く(PWA としてインストール可) | Service Worker は HTTPS または localhost のときだけ有効 |
| Windows | デスクトップランチャー(NSIS `.exe` / `.msi`) | サーバー URL を入れて Web UI を開く薄いシェル。未署名 |
| macOS | デスクトップランチャー(`.dmg`、universal) | 未署名・未公証(初回に Gatekeeper の手動許可が必要) |
| Linux | デスクトップランチャー(AppImage / `.deb`) | WebKitGTK 4.1 が必要 |
| Windows / Linux | **OmniChat Server**(サーバー用アプリ、NSIS `.exe` / AppImage / `.deb`) | サーバーを同梱して起動・管理。最初の管理者もここで作る([docs/SERVER-APP.md](docs/SERVER-APP.md)) |
| Android | APK(サイドロード) | CI で作成。署名用キーが無い場合はデバッグ署名 |
| iPhone / iPad | Safari の「ホーム画面に追加」(PWA) | ネイティブアプリ(IPA)は提供しない。プッシュ通知なし |

クライアントの入手方法と制限は [docs/CLIENTS.md](docs/CLIENTS.md)。

## リポジトリ構成

| パス | 内容 |
|---|---|
| `server/` | Node 24 + TypeScript(Fastify, ws, `node:sqlite`)。認証・同期・ストリーミング・プロバイダー・ツール/プラグイン・検索・バックアップ。`server/plugins-examples/` にプラグインの例 |
| `app/` | Expo(React Native + Web)のクライアント。Web 書き出しをサーバーが配信し、Android APK の元にもなる |
| `desktop/` | Tauri 2 のデスクトップランチャー(クライアント用。Windows / macOS / Linux) |
| `server-app/` | OmniChat Server: サーバーを動かして管理する Tauri 2 アプリ(Windows / Linux)。[docs/SERVER-APP.md](docs/SERVER-APP.md) |
| `bridge/` | PC で動かす常駐プログラム。dsh を遠隔操作するデーモン型ブリッジ |
| `dsh-plugin/` | 同じ役割を dsh のプラグインとして dsh プロセス内で行う版(`@omnichat/dsh-bridge`) |
| `packaging/` | 配布物のビルド(リリース用ビルドスクリプト、Windows インストーラー、Linux/macOS スクリプト、tarball 生成) |
| `cli/` | コマンドラインクライアント `omnichat`(外部依存なし) |
| `docs/` | ユーザー/開発者向けドキュメント |
| `.github/workflows/` | CI、リリース、デスクトップ、Android のワークフロー |
| `Dockerfile` / `docker-compose.yml` | Docker イメージと Compose 定義 |
| `PROTOCOL*.md` | アプリ↔サーバーの通信仕様(`PROTOCOL.md`、`PROTOCOL-v3.md`、`-phase2/3/4`) |
| `BRIDGE.md` / `BRIDGE-v2.md` | サーバー↔ブリッジの通信仕様 |
| `DSH-PLUGIN-RESEARCH.md` | dsh プラグイン化の調査メモ |
| `NEXT-VERSION.md` | v3 の実装方針メモ |

## モデルの選択

チャット上部のボタンから、プロバイダーごとのモデル一覧を開いて選べます(会話ごとに保存、新しいチャットは前回の選択から開始。プロジェクトに既定モデルがあればそれが優先)。

- OpenAI互換API(OpenAI / DeepSeek / Ollama / LM Studio など): `{baseUrl}/models` から自動取得。embedding / rerank / whisper / tts / moderation を含む id は一覧から除外
- dshブリッジ: dshの設定にあるモデル(id と名前のみ)をブリッジが報告
- 一覧に無いモデルは「Custom model id…」で直接入力できます
- LM Studio / Ollama では、一覧にロード状態・VRAM・量子化が出て、ロード/アンロードもできます

## DeepSeek Harness(dsh)の遠隔操作

```
アプリ ⇄ OmniChatサーバー ⇐(PCから外向き接続)= ブリッジ → dsh headless
```

PC側のポートは開けません。使い方は [bridge/README.md](bridge/README.md)。設定画面のプリセット「DeepSeek Harness (PC bridge)」でプロバイダーを作り、ブリッジ名(`--name`)を入れます。デーモン型とプラグイン型の比較、インストール、検証範囲は **[docs/DSH.md](docs/DSH.md)** にまとめています。

- **双方向同期**: dshのGUIで入力した発言・応答も、このアプリで入力したものも、同じ会話として両方に見えます(dshのセッションログをブリッジが約1.5秒ごとに監視)。
- 同期を効かせるには、ブリッジの `--cwd` を dsh GUI の作業フォルダに合わせてください。
- dsh GUI とアプリで、同じセッションの同じ瞬間に会話を進めることはできません(ブリッジが検知して断ります)。
- ログ形式はdsh内部仕様です。変わると同期は止まります(チャットは動き続けます)。

### dshプラグイン版(`dsh-plugin/`)

`dsh plugin --profile <desktop|web> add <.tgz の絶対パス>` で dsh に直接組み込み、dshプロセス内から OmniChat サーバーへ外向き接続します。`dsh headless` の起動やログ監視が不要で、GUIで入力した内容もリアルタイムに反映されます。使い方は [dsh-plugin/README.md](dsh-plugin/README.md)。デーモン型ブリッジと同じ `--name`/`name` で同時に動かさないでください。

dsh プロバイダーの会話は直線です。再生成・編集再送(分岐)は拒否され、OmniChat 側のツール・Web 検索・自動タイトルは対象外です(思考は表示されます)。詳細は [docs/DSH.md](docs/DSH.md)。

## ドキュメント一覧

| 文書 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | サーバーのインストール(Docker / Windows / Linux / macOS)、環境変数、更新、HTTPS、トラブルシューティング |
| [docs/CLIENTS.md](docs/CLIENTS.md) | デスクトップ版・Android・iOS(PWA)・ブラウザ |
| [docs/FEATURES.md](docs/FEATURES.md) | 機能ごとの使い方と既定値 |
| [docs/PLUGINS.md](docs/PLUGINS.md) | ツール/プラグインの作り方と信頼モデル |
| [docs/SEARCH.md](docs/SEARCH.md) | Web 検索(SearXNG)の設定 |
| [docs/API.md](docs/API.md) | REST / WebSocket / `/v1` のリファレンス |
| [docs/BACKUP.md](docs/BACKUP.md) | バックアップ・復元・エクスポート・インポート |
| [docs/DEVELOPER.md](docs/DEVELOPER.md) | 開発者モード、計測の注意、設定ファイル、CLI |
| [docs/DSH.md](docs/DSH.md) | DeepSeek Harness 連携 |
| [docs/RELEASING.md](docs/RELEASING.md) | リリース手順 |
| [docs/BUILD-ALL.md](docs/BUILD-ALL.md) | 全 OS のビルド手順(手元 / Actions の担当表) |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 |
| [PROTOCOL.md](PROTOCOL.md), [PROTOCOL-v3.md](PROTOCOL-v3.md), [PROTOCOL-v3-phase2.md](PROTOCOL-v3-phase2.md), [PROTOCOL-v3-phase3.md](PROTOCOL-v3-phase3.md), [PROTOCOL-v3-phase4.md](PROTOCOL-v3-phase4.md) | 通信仕様(一次資料) |
| [BRIDGE.md](BRIDGE.md), [BRIDGE-v2.md](BRIDGE-v2.md) | ブリッジの通信仕様 |
| [bridge/README.md](bridge/README.md), [dsh-plugin/README.md](dsh-plugin/README.md) | ブリッジ/プラグインの使い方 |

ドキュメントとコードが食い違う場合はコードが正です。

## 開発用の起動

```bash
cd server && npm install && npm start     # http://0.0.0.0:8787(tsx で TypeScript を直接実行。Node 24 以上)
cd app && npm install && npm run web      # ブラウザ
cd app && npx expo start                  # 実機は Expo Go でQRを読む
```

- テスト/型検査: `cd server && npm test`、`cd server && npm run typecheck`(`bridge/` は同名のスクリプト、`dsh-plugin/` は `npm test`)。
- リリース相当の成果物をローカルで作る: `node packaging/build-release.mjs --out .release/stage`(Web 書き出し + サーバーのビルド + 本番依存。`--node <node実行ファイル>` で Node を同梱)。
- 実機から使う場合は、ログイン画面のサーバーURLをPCのLAN IP(例 `http://192.168.1.10:8787`)に変更します。
- 開発者向けの詳細は [docs/DEVELOPER.md](docs/DEVELOPER.md)。

## 状態と検証範囲

バージョンは 0.5.0 です(DSH 連携プラグインは 1.0.0)。実装は 4 フェーズ(基盤 / 可視化 / ツール・検索・履歴 / 開発者機能)で、詳細は [CHANGELOG.md](CHANGELOG.md)。フェーズ 4 の各機能は、まだ実機で検証していない項目があります([docs/DEVELOPER.md](docs/DEVELOPER.md) の状態一覧)。

以下の「確認したもの」は、各フェーズの開発時に行った確認の記録です。このドキュメントを書いた時点で再実行したものではありません。

**実機・ローカルで確認したもの**(開発時の記録に基づく)

- サーバーの自動テスト(`node:test`、`cd server && npm test`)、アプリのテスト、プラグインのテスト、型検査。
- 実サーバー + 実 LM Studio での確認(チャット、思考レーン、メトリクス、コンテキスト、ロード/アンロード、ツール呼び出し)。LM Studio の画像入力(Gemma 4 E4B)。
- llama.cpp(Strata と Bonsai の 2 モデル)の実機: モデル一覧、コンテキスト上限、画像対応の判定。
- 実物の SearXNG での Web 検索。
- アプリの UI をブラウザ(デスクトップ幅。フェーズ 1 はスマホ幅も)で実サーバーに対して確認。PWA(Service Worker・インストール可能判定・オフライン再読込)は Edge で実測。
- Windows: デスクトップ(NSIS / MSI)とサーバーアプリ(NSIS)を実際にビルドし、インストールして確認。macOS: デスクトップクライアントを実機で広く確認(サーバーは軽微な確認のみ)。Android: リリース APK のビルドと、実機でのアプリの更新。
- 自動更新を実際のリリースで確認: サーバー(0.4.0-beta.4 から 0.5.0)、DSH プラグイン(取得とチェックサム)、デスクトップの更新のお知らせ。
- dsh デーモン型ブリッジ(dsh 44.0.0)、dsh プラグイン(dsh 0.2.0-rc.2、実際の dsh とのペアリング、GUI セッションのミラー、モデルの取り込み)。

**未確認のもの**

- Docker イメージのビルドと Compose の起動、Linux / macOS の `install.sh`、Linux のデスクトップ / サーバーアプリのビルド。**Linux は一度も動かしていません。動かした方は、結果を教えてください**(Issue で歓迎します)。
- macOS のサーバーは、軽微な確認だけです。
- iOS(Safari / PWA)の実機と、Firefox の実際の動作。
- Ollama と vLLM の実機(LM Studio と llama.cpp は確認済み)。
- Windows のデスクトップクライアントが、通常の起動で、自分で静かに更新する動作。

**既知の制約**

- フェーズ 4(開発者機能)の実装状況は [docs/DEVELOPER.md](docs/DEVELOPER.md) の冒頭に書いています。
- iOS はプッシュ通知なし。デスクトップ版はサーバーに到達できないと UI を表示できません。
- インポートは常に新しい ID のコピーを作り、既存データとはマージしません。設定はインポートされません。
- dsh のログ形式(v4)と dsh プラグインの内部 API は非公開の仕様で、dsh の更新で動かなくなる可能性があります。

## セキュリティの要約

詳細は各文書の該当箇所を参照してください。

- **認証**: ユーザー名 + パスワード(8 文字以上、scrypt で保存)。ログインのたびに端末ごとのトークンを発行(DB にはハッシュのみ)。同じ IP + ユーザー名で 5 分間に 10 回失敗するとログインを一時拒否。管理者は HTTP からは作れず、サーバー上の `omnichat-admin create` で作ります。自己登録(一般ユーザー)は管理者がいて `ALLOW_REGISTRATION=1` のときだけ。
- **OmniChat 自身は HTTPS に対応しません。** LAN では HTTP のままで、Tailscale 経由の通信は WireGuard で暗号化されます。それより外に出すときは、前段で HTTPS にしてください(例: Tailscale Serve。[docs/INSTALL.md](docs/INSTALL.md))。Tailscale Funnel はインターネットに公開する機能で、INSTALL.md の注意に従う場合を除き、おすすめしません。WebSocket の認証トークンは URL のクエリ(`/ws?token=`)で渡されるため、リバースプロキシのアクセスログに残らないよう注意してください。
- **API キー(`ocsk-…`)**は `/v1/*` 専用で、DB にはハッシュのみ保存。端末トークンは `/v1/*` では使えず、API キーは他の API では使えません。
- **プロバイダーの API キー**は暗号化(AES-256-GCM)して保存します。鍵は環境変数 `OMNICHAT_SECRET_KEY`、または、データフォルダの `secret.key` です。バックアップ(`omnichat-*.db`)には暗号化された値だけが入り、鍵のファイルは入りません。`secret.key` はバックアップとは別の場所に保管してください。鍵がないサーバーに復元すると、保存したキーは使えません。エクスポート JSON には含まれません([docs/BACKUP.md](docs/BACKUP.md))。
- **プラグインは完全なサンドボックスではありません。** 管理画面から導入したプラグインは、別の Node プロセス(`--permission`)で動きます。読めるのはプラグイン自身のフォルダだけで、ファイルの書き込みと子プロセスの起動はできず、環境変数は空で、メモリと時間にも上限があります。ただし、ネットワークはこの仕組みでは止められません(`ctx.fetch` だけを仲介します)。手で置いたプラグインは、従来どおりサーバーのプロセス内で、サーバーの OS 権限のまま動きます。`permissions` は承認ダイアログ用の宣言で、サンドボックスではありません。信頼できるものだけを置いてください(Windows サービス版は LocalSystem で動きます)([docs/PLUGINS.md](docs/PLUGINS.md))。
- **dsh の headless ブリッジは承認なしでツール(シェル・ファイル操作)を実行**します。OmniChat のアカウントを持つ人は、ブリッジの PC を操作できます。強いパスワード、HTTPS、専用の作業フォルダ(`--cwd`)で使ってください。プラグイン版は dsh の承認ポリシー(`ask`)に従います([docs/DSH.md](docs/DSH.md))。
- `web_search` と `fetch_url` のようなネットワーク系ツールは、サーバーから見えるアドレス(LAN・localhost を含む)へリクエストできます。承認ダイアログで引数を確認してください。
- CORS は既定で全オリジンを許可します(`CORS_ORIGIN` で制限可能)。認証は Authorization ヘッダーのトークンなので Cookie 経由の CSRF は想定していません。

## 拡張(プロバイダー)

`server/src/providers/index.ts` の `registerProvider(kind, factory)` で新しい種類を追加できます(現在は `openai-compatible` と `dsh-bridge`)。モデルが呼ぶツールを増やしたい場合はコードの変更ではなくプラグインを使います([docs/PLUGINS.md](docs/PLUGINS.md))。

## 免責事項

- OmniChat は、無償で、**現状のまま(AS IS)**提供します。動作すること、特定の目的に合うこと、誤りがないこと、継続して提供されることなどを、明示・黙示を問わず、**一切保証しません**。
- OmniChat を使った、または使えなかったことによって生じた、**いかなる損害や不利益についても、作者と貢献者は責任を負いません**。たとえば、次のようなものです。ただし、これらに限りません。
  - データの消失・破損(会話、設定、サーバーのデータベース、更新やバックアップの失敗を含みます)
  - AI が生成した内容の誤り、不適切な内容、それを信じて行った判断や行動
  - Code 機能や DSH との連携による、PC のファイルの変更・削除、コマンドの実行、その他の操作
  - 第三者のサービス(AI の API、GitHub、Tailscale など)の料金、規約違反、障害、情報の流出
  - サーバーを外部に公開したことによる、不正アクセスなどの被害
- 利用は、**すべて自己責任**です。大切なデータは、定期的にバックアップしてください。Code 機能の承認は、内容を確認してから行ってください。
- この免責は、法令によって免責できない責任には及びません。ライセンス([AGPL-3.0](LICENSE))の第 15 条(保証の否認)と第 16 条(責任の制限)も、あわせて適用されます。

> **Disclaimer.** OmniChat is provided free of charge and "AS IS", without warranty of any kind. To the extent permitted by law, the authors and contributors are not liable for any damage or disadvantage arising from its use or inability to use it, including data loss, incorrect or harmful AI output, file changes or commands executed through the Code / DSH features, third-party service charges or leaks, and attacks on a server you expose. You use it at your own risk. See also sections 15 and 16 of the AGPL-3.0.

## ライセンス

OmniChat は **GNU Affero General Public License v3.0(AGPL-3.0-only)** で公開します。全文は [LICENSE](LICENSE)、著作権表示は [NOTICE](NOTICE) です。Copyright (C) 2026 remuno。

- 自分で使う、家族や社内で使うだけなら、改変しない限り追加の義務はありません。
- **改変したものを配布する場合、または改変したサーバーをネットワーク越しに他人に使わせる場合は、その改変版のソースコードを AGPL-3.0 で利用者に提供する必要があります**(AGPL の第 13 条)。
- **ロゴと名称「OmniChat」は AGPL の対象外です。** 作者が権利を持ち、[TRADEMARKS.md](TRADEMARKS.md) のルールでだけ使えます。フォークを配布するときは、別のロゴと名称に置き換えてください(コードは AGPL のまま自由に改変できます)。
- ソースコード: https://github.com/remuno3751/omnichat (サーバーの `GET /version` も `source` として返します)。
- 依存パッケージは各自のライセンスに従います。一覧は [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)(Node 依存。デスクトップランチャーの Rust 依存は含まれません)。`app/LICENSE` は、`app/` の元になった Expo テンプレートの MIT ライセンス文で、その部分のために残しています。
- 外部の人からの貢献(プルリクエスト)を受け入れる場合、その部分の著作権は貢献者に残ります。将来ライセンスを変更する可能性があるなら、受け入れの前に貢献者ライセンス同意(CLA など)の方針を決めてください。
