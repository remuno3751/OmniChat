# OmniChat bridge

自分の PC 上の DeepSeek Harness (dsh) を OmniChat から操作するための常駐プロセスです。
PC から OmniChat サーバーへ **外向きに** WebSocket 接続するだけで、待ち受けポートは一切開きません。
サーバーから受けたプロンプトを `dsh --profile headless --json` で実行し、NDJSON イベントをそのまま中継します。

## 起動

```
npm install
npm start -- --server http://localhost:8787 --username <user> --cwd C:\work\agent
```

- `--server` (必須): OmniChat サーバーの URL (http/https)
- 認証: `--token <token>` または `--username` / `--password`。環境変数 `OMNICHAT_TOKEN` / `OMNICHAT_USERNAME` / `OMNICHAT_PASSWORD` も可 (パスワードはコマンドラインより環境変数推奨)
- `--cwd` (必須): dsh の作業ディレクトリ (存在するフォルダ)
- `--name`: ブリッジ名 (既定: ホスト名)。サーバー側プロバイダーの baseUrl にこの名前を指定します
- `--dsh-app`: dsh のインストール先 (既定: `%LOCALAPPDATA%\Programs\DeepSeek Harness`)
- `--dsh-patch`: オーバーレイ yml (既定: `bridge/dsh-overlay.yml`、`none` で無効)
- `--profile`: dsh プロファイル (既定: `headless`)
- `--allow-preview-fs`: Code のプレビュー用に、作業フォルダのファイルの読み取り(`fs`)を許可する (既定: 無効。下の「プレビュー用のファイル読み取り」を参照)

テスト: `npm test` / 型チェック: `npm run typecheck`

## セキュリティ警告

dsh の headless 実行は **承認なしで** ツール (シェル・ファイル操作) を実行します。
`--cwd` 内で、あなたの OS ユーザー権限のまま動きます。OmniChat アカウントを使える人は誰でもこの PC を操作できるため、
強いパスワードと HTTPS を使い、`--cwd` には専用の低リスクなフォルダを指定してください。

## モデル選択 (v2)

ブリッジは起動中の dsh プロファイル (`~/.dsh/profiles/<profile>/cordis.patch.yml`) の `llm-pi-ai` エントリから
**プロバイダー名・モデル id・モデル名だけ** を読み取り、`ready` / `models` フレームでサーバーへ送ります
(ファイルの mtime を監視し、変更されたら `models` を再送)。`headers` / API キー / baseURL は読み捨てで、ログにも送信にも含めません。
`~/.dsh/.credentials.yaml` は一切読みません。既定モデルは `--dsh-patch` のオーバーレイ (`agent-default-model`) から取得します。

アプリでモデルを選ぶと `run.model` (`<provider>::<id>`) が届き、実行ごとに一時オーバーレイ (OS の temp ディレクトリ) を書いて
`--dsh-patch` の **後ろ** に追加の `--patch` として渡します (後勝ち)。一時ファイルは実行後に削除されます。
`::` を含まない id は、その id を持つプロバイダー (なければ既定モデルのプロバイダー) として扱います。

### ライブ可用性 (10 秒ごと)

dsh は上流プロキシ (例: LM Studio の前段の opencodex) が配信していないモデルを、実行後にしか除外しません。そこでブリッジは
プロファイルの各 `llm-pi-ai` プロバイダーについて、10 秒ごとに上流の `GET {baseURL}/models` (そのプロバイダーの headers 付き、メモリ内のみ)
を確認し、**現在配信中のモデルだけ** を報告します (宣言済みモデルは上流の一覧に id があれば残ります。上流に届かない/エラーの場合は宣言済み一覧にフォールバック)。
`api` が openai 系で、id がチャットモデルらしい (`embed|embedding|rerank|whisper|tts|moderation` を含まない) 場合、宣言されていない配信中モデルも追加されます
(実行ごとのオーバーレイで選択可能)。dsh 側が受け付ける必要があり、`has no configured model` で失敗した場合はそのエラー文がそのまま表示されます。
`models` フレームは一覧が実際に変わったときだけ送られます。

**セキュリティ**: 上流へのリクエストは baseURL のホストが loopback (localhost / 127.0.0.0/8 / ::1) か RFC1918 のプライベート IP のときだけ許可し、
リダイレクトは追いません。headers / baseURL / API キーは、この 1 リクエスト以外には出さず、ログ・フレーム・エラーメッセージにも含めません (エラーは伏せ字化)。

## セッションのミラーリング (双方向同期)

dsh は GUI / headless を問わず全セッションを `~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd` に保存します。
ブリッジはこのログを 1.5 秒ごとに (mtime, size) で監視し、増分だけをデコードして `sessions` フレームでサーバーへ送ります
(接続/再接続直後は更新が新しい 30 セッション・各最大 300 メッセージの `full:true`、以降は差分)。
ヒューマンのメッセージと、ターンごとにまとめたアシスタントメッセージ (ツール呼び出しは `> 🔧 ...` 形式) が対象です。

- 既定では `--cwd` と同じ cwd のセッションだけを送ります。`--mirror-all` で全 cwd、`--no-mirror` でミラー無効。
- `--dsh-home <dir>`: dsh のホーム (既定 `~/.dsh`)。モデル検出とミラー両方に使います。
- **ヒント:** dsh GUI のワークスペースとブリッジの `--cwd` を同じフォルダにすると、アプリからの実行が GUI にも表示され、GUI での会話もアプリに現れます。

### 注意事項

- アプリと dsh GUI が **同じセッションで同時にターンを実行しない** でください (書き込みが 2 系統になります)。
  ブリッジは、対象セッションのログが直近 3 秒以内に更新されていて自分の実行が無い場合、`run` を `done ok:false error:"session busy in dsh"` で拒否します。
- ログ形式 (v4) は dsh の内部形式で、変更される可能性があります。解釈できない形式を検出するとミラーは stderr に警告を 1 回出して自動停止し、
  ブリッジ経由のチャット自体は動き続けます。書き込み途中の末尾フレームは無視され、次のポーリングで再試行されます。

## プレビュー用のファイル読み取り (`--allow-preview-fs`)

既定では無効です。`--allow-preview-fs` を付けて起動したときだけ、サーバーが作業フォルダ(`--cwd`)のファイルを読めるようになります。

- **サーバーの管理者が、作業フォルダのファイルを読めるようになります**。家族や友人と 1 台のサーバーを共有する場合など、この PC の作業フォルダをそのサーバーに見せてよいときだけ付けてください。
- 読めるもの: 作業フォルダの中の、許可された種類のファイル(html、css、js、json、txt、md、画像、フォント、音声・動画の一部)。1 回 3 MB まで。一覧は 2000 件まで。
- 読めないもの: `.` で始まる名前(`.git`、`.env`)、`node_modules`、`*.pem`・`*.key`・`*.p12`・`*.pfx`・`*.keystore`・`id_rsa*`・`id_ed25519*`、名前に `credential` / `secret` を含むもの、作業フォルダの外へ出るシンボリックリンク・ジャンクション、許可されていない種類のファイル(exe、sh、db など)。
- 書き込み・削除・実行はできません。実行中の DSH の処理にも影響しません(読み取りだけ)。
- 仕様は `BRIDGE-v2.md` の「C. Preview file access (fs)」を参照してください。

## Code 操作 (チェックポイント・変更一覧・巻き戻し・サブエージェント) — OmniChat v4

契約は `PROTOCOL-v4.md` §3 / §6。`requestId` は run の `runId`。

- **チェックポイント** (`gitops.ts`): `run` の開始前に、`--cwd` の git ワーキングツリーを**ユーザーのブランチ・インデックス・stash に触れずに**スナップショットします
  (一時 `GIT_INDEX_FILE` に HEAD の木を読み込み → `git add -A` → `write-tree` → `commit-tree` → `refs/omnichat/checkpoints/<id>`)。
  フレーム `{type:"checkpoint", requestId, checkpointId, ref, createdAt, dirty}`。`event` フレームより前に送ります。git リポジトリでない場合は
  `{type:"checkpoint", requestId, unavailable:"not a git repository"}`。`.gitignore` されたファイルは対象外です。
  改行は `core.autocrlf=false` で扱うので、`autocrlf=true` の環境でも巻き戻しはバイト単位で一致します(`.gitattributes` の eol/フィルター指定があるファイルは除く)。
  `refs/omnichat/checkpoints/` は新しい 200 件だけ残し、古いものは自動で削除します。
- **変更一覧**: run の終了時(成功・失敗・キャンセルとも)、`done` の前に `{type:"changes", requestId, changes:[{path, status, additions, deletions, patch?}]}`。
  チェックポイントの木と現在の木を `git diff --numstat -M` で比べます(未追跡の新規ファイルも含む)。`patch` は 1 ファイル 200 KB、合計 1 MB、パッチ取得は 500 ファイルまで(超えた分は `patch` なし)。
  バイナリは `"Binary files differ"`。git でない場合は `changes: []` で、`done` に `warning: "not a git repository"`。
- **巻き戻し**: サーバー → `{type:"rewind", requestId, ref, cwd, removeNew?}`。`cwd` がブリッジの `--cwd` と一致し、実行中でないときだけ受け付け、
  `ref` は `refs/omnichat/checkpoints/<id>` の形だけ許可します。一時インデックスに `read-tree` → `checkout-index -a -f` で追跡・追加済みファイルを復元し、
  `removeNew:true` のときだけチェックポイントに無かった新規ファイル(と空になったフォルダ)を削除します。応答 `{type:"rewound", requestId, ok, error?, restored?, removed?, backupRef?}`。
  巻き戻しの直前の状態は `refs/omnichat/checkpoints/pre-rewind-<ms>` に保存します(`backupRef`)。
- **サブエージェント** (`agents.ts`): `dsh headless` の NDJSON から `subagent` / `subagent_fork` ツールの呼び出しを拾い、`{type:"agents", requestId, agents:[{id, role, status, startedAt, endedAt, summary?, log?}]}` を変化のたびに送ります。
  `subagent_fork` は結果で完了(`summary` = 子の最終回答)。`subagent`(バックグラウンド)は結果が `started subagent <id>` だけで、`dsh headless` は親のターン終了で終了するため、
  run 終了時に子のセッションログ(ディスク上)を読んで `done` / `error`(`turn/end` が無ければ「dsh プロセスの終了で中断」)を決めます。実行中の進捗は見えません。詳細は `DSH-PLUGIN-RESEARCH.md` の追補。
- **承認**: `dsh headless` は承認なしで実行するため、デーモン型は `approval` フレームを送りません(`dsh-plugin/` の `approvals: remote` を使ってください)。
