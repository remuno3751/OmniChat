# DSH プラグイン化調査: OmniChat bridge を dsh 本物のプラグインとして配布できるか

調査日: 2026-10-15 / 対象: dsh 44.0.0 (Electron 44.0.0, 同梱 Node 24.18.1, DSH ランタイム **0.2.0-rc.2**)
方法: `resources\app.asar` を scratchpad に展開し `@deepseek-ai/*` のソース・README・生成 API カタログ (`dsh-tool-cordis/lib/types/api-catalog.js`) を読んだ。ユーザの dsh は変更していない (`--dump-config` は一時ファイルに出して id/name のみ確認し即削除。`.credentials.yaml` は未読)。
以下 `<pkg>` = `app.asar\dsh\node_modules\@deepseek-ai\<pkg>\lib\...`。

---

## 0. 結論 (Verdict)

**総合判定: FEASIBLE (ほぼ全機能が可能。ただし「公開安定 API ではない」点と数点の実機確認が必要)**

| 機能 | 判定 | 根拠(要約) |
|---|---|---|
| 別 PC から OUTBOUND WebSocket 接続 | FEASIBLE | プラグインは vm サンドボックスではなく **ホスト Node プロセス内で無制限に動く**。Node 24 なので `WebSocket`/`fetch`/`node:*` 全部使える |
| ライブセッションへユーザメッセージ投入 / ターン開始 | FEASIBLE | `ctx.sessionController.prompt({requestId,sessionId,mode,content})` (GUI と同じ経路) |
| イベント/テキスト/ツール呼び出しのストリーム | FEASIBLE | `ctx.on('session/event', …, {global:true})` + `ctx.on('agent/assistant-stream', …, {global:true})` (text-delta まで取れる) |
| GUI で入力したメッセージのリアルタイム反映 | FEASIBLE | 同一プロセスの `session/event` に GUI 起点の `user/message` も流れる。ログファイル監視・別デーモン不要 |
| 停止/キャンセル | FEASIBLE | `ctx.sessionController.cancel({sessionId})` → `agent.cancel({kind:'user'},{keepInbox:true})` |
| セッション一覧 / メッセージ取得 | FEASIBLE | `list()` / `page()` / `follow()` / `search()` |
| 利用可能モデル一覧 | FEASIBLE | `modelCatalog()` → `{default, groups:[{id,name,models[{id,name,reasoning}]}], failures}` |
| ターンごとのモデル選択 | PARTIAL | `selectModel()` はセッションローカルだが **GUI の既定モデル (agentDefaultModel) も上書き保存する副作用**あり。復元処理が必要 |
| ツール承認 (policy `ask`) のリモート処理 | FEASIBLE (要設計) | `approval/request` waterfall を prepend で横取りしてリモートに転送可能。放置すると GUI 未接続時は `unavailable`=ツール拒否 |
| `dsh plugin --profile <name> add <pkg>` で他 PC に導入 | FEASIBLE | npm / 絶対パス / .tgz / git すべて pnpm 経由で可。`dsh.bundle.patch` があれば自動で bundle 有効化 |
| 安定性 (将来のアップデート耐性) | RISK | 公開・安定契約ではない。ランタイムは `0.2.0-rc.2` (rc) で、サービス/イベント名は内部 API |

**推奨アーキテクチャ**: プラグイン = 薄い outbound WS クライアント。既存 bridge の WS ワイヤプロトコル (`ready/models/sessions/run/cancel/event/done`) をそのまま話し、サーバ側は無改修。`dsh headless` の spawn と ログ zstd ミラーを丸ごと `ctx.sessionController` + イベント購読に置換する。詳細は §6。

---

## 1. プラグイン契約 (host 側)

### 形
実例 `C:\Users\<ユーザー名>\.dsh\profiles\desktop\node_modules\@ian_p\dsh-web-search\dist\index.js`:
```js
export const name = 'dsh-web-search'
export const inject = ['web', 'credentials', 'typert']
export function apply(ctx) { /* ctx.on / ctx.effect / ctx.get('credentials') ... */ }
```
- Cordis (`@deepseek-ai/cordis ~4.0.4`) のプラグイン形式。クラス形式 (`static inject`, `static Config`, `constructor(ctx, config)`) も可 (`<dsh-api-session-controller>/index.js:2816-2829` の `SessionController`)。
- **Config は Standard Schema**: `<cordis>/index.js:956-958` `runtime.Config["~standard"].validate(config)`。`export const Config = z.object({...})` (zod) か schemastery で宣言し、`apply(ctx, config)` で受け取る。`Config` 未宣言なら生の config がそのまま渡る。
- 設定は patch yml の行 `config:` から: `- id: <id>\n  name: '<pkg>'\n  config: {...}` (profile の `cordis.patch.yml` で `- id: <id>` 上書き行を書けば後から変更可。例: desktop の `cordis.patch.yml` が `- id: llm-pi-ai ... config:` で同様に上書きしている)。
- `!!js process.env.X` 式も使える (`<dsh-web-app>/cordis.patch.yml` の `mode: !!js process.env.DSH_TOOLS_MODE`)。トークンを yml に平文で書かず env 経由にできる。
- **ライフサイクル/破棄**: `ctx.effect(() => { …; return () => cleanup })` (`<cordis>/index.js:337,614`)。`ctx.on()` もフレームに紐づき自動 dispose。WS はここで close する。HMR 有効 (web プロファイル) ならプラグイン再読込時に dispose → 再 apply される。

### 実行レルム (サンドボックスか?)
- **サンドボックスなし**。`dsh-cordis-host-runner` README: 「Host halves run in a `node:vm` realm」は *動的 (ランタイム生成) パッケージ* 限定。`dsh-plugin-manager` README: 「installed Host code executes in-process outside the workspace sandbox」。インストール済み bundle は通常の ESM として main の Node で import される。
- dsh-web-search README の "Host realm has fetch/URL" はその動的版 (vm) の話で、npm 版には当てはまらない(同プラグインの `dist/index.js` は普通に `import` している)。
- 実測: `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" -e …` → `node 24.18.1 / electron 44.0.0 / typeof WebSocket=function, fetch=function, EventSource=undefined, node:net.connect/zlib/child_process あり`。
- Desktop ではホストは Electron 内ではなく子プロセス: `<dsh-desktop-host>/index.js:219-240` (`runProfile({profile:"desktop", args:["--no-open","--port","19387"]})`)。つまり GUI の Web ホストと同じプロセス・同じ `ctx` にプラグインが載る。
- 結論: **outbound WebSocket、HTTP long-poll/SSE (fetch ストリーム)、`ws` パッケージ、fs、child_process すべて可能。** 依存ゼロで済ませるなら Node 組込みの `WebSocket` (Node ≥22) を使う。サンドボックスはプラグイン自体ではなく bash ツール子プロセス側にだけかかる。

---

## 2. どのプロファイルがプラグインをホストするか

- プロファイル = `$DSH_HOME/profiles/<name>` (`package.json` の `dsh.profile.bundles` + `cordis.patch.yml`)。**全プロファイルが同じ仕組みでプラグイン bundle を読む** (`dsh-app-boot` README 50 行: "A profile is how one dsh installation ships different app surfaces: web, headless, acp, sdk, sdk-minimal")。
- **GUI (desktop) もプロファイル `desktop` の bundle を読む**: 実機 `C:\Users\<ユーザー名>\.dsh\profiles\desktop\package.json` の `dsh.profile.bundles = [dsh-base, dsh-web-app, @ian_p/dsh-web-search]`。`web` も `[dsh-base, dsh-web-app]` で同じ構成 (desktop = web アプリを `--no-open --port 19387` で起動したもの)。
- `desktop` は `dsh --profile desktop` では起動不可 (`dsh\lib\bin.js:35-37` "managed exclusively by the Electron application") だが、**`dsh plugin --profile desktop add …` はインストール済みシム `dsh.cmd` なら可** (`<dsh-desktop-host>/cli.js` が `manageDesktopProfile:true`)。条件: 一度 GUI を起動して初期化済み、かつ **GUI を完全終了してから実行** (`dsh\lib\plugin-BGnVfe_D.js:11`)。
- 同一パッケージを複数プロファイルに入れるのは可 (profile ごとに `add` を実行するだけ)。ただし各プロファイルが別プロセスなので、**同時に 2 つ起動すると別々に outbound 接続してしまう** → bridge の `name` を分けるかプロセス単位の排他が必要 (§6 リスク)。
- 必須サービスの有無: `sessionController` / `agents` / `sessions` を持つのは Web 系 (`dsh-api-session-controller` が web-app 構成に含まれる; `--profile web --dump-config` で確認)。`headless` は 1 タスク実行用でセッションコントローラ無し → **対象は `desktop` と `web`**。

---

## 3. セッション駆動に使えるサービス/API

型は `dsh-tool-cordis/lib/types/api-catalog.js` (生成された「公式の拡張 API 一覧」: `SERVICE_API` / `EVENT_API` / `TYPE_API`) と `dsh-api-session-controller` ソースより。`inject: ['sessionController', 'sessions', 'agents', …]` で取得。

### `ctx.sessionController` (`@Remote` メソッドだが同一プロセスから直接呼べる設計。`SessionController` クラス, `<dsh-api-session-controller>/index.js:2846-3186`)
| 目的 | メソッド | 型 (カタログ) |
|---|---|---|
| 一覧 | `list(req, signal)` | `{items: SessionSummary[]}` = `{sessionId, updatedAt, running, blank, cwd?, parentSessionId?, origin?, agentAvailable}` |
| 検索 | `search({query}, signal)` | |
| 新規作成 | `create({workspaceId?\|cwd?, sessionId?, agentPreset?})` | `{sessionId, agentPreset?}` (cwd 省略時はホスト `process.cwd()`) |
| **ユーザ発話→ターン開始** | `prompt({requestId, sessionId, mode:'queue'\|'steer', content:[{type:'text',text}], clientTimeZone?}, signal)` | `{accepted:true}`。内部で `resolveAgent`(コールド→再開) → `agent.followup(msg)` / `steer(msg)` (`types/commands.js:290-352`)。`source:{kind:'user', rpcId:requestId}` |
| **キャンセル** | `cancel({sessionId})` | `agent.cancel({kind:'user'},{keepInbox:true})` (`commands.js:468-478`)。attach 済みでないと `session/not-found` |
| 履歴 | `page({address,beforeSeq?,maxMessages?,throughSeq,turnWindow?}, signal)` | `{records: SessionHistoryRecord[], hasMore}` (コールド読み可) |
| ライブ追従 | `follow({address, assistantStream:true}, signal)` | async iterable: `snapshot` → `event` → `assistant-stream` フレーム |
| モデル一覧 | `modelCatalog()` | `{default:{provider,model,reasoningEffort?}, routableProviders, groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts,defaultEffort}}]}], failures}` (`types/catalog.js`) |
| モデル選択 | `selectModel({sessionId, provider, model, reasoningEffort?})` | セッションの次リクエストに適用 (`model/selection` イベントを append)。**副作用: `agentDefaultModel.saveSelection` で GUI 既定も書き換え** (`commands.js:164-166`) |
| タイトル/フォーク | `rename` / `fork` | |

### イベント購読 (GUI 起点セッションも同一プロセスなので全部見える)
- `ctx.on('session/event', (session, event) => …, { global: true })` — 耐久ログの post-commit 通知。`event = {type, seq, time, data}`。型: `turn/start|end{turn,reason}`, `step/start|end`, `user/message` (`data.source.kind==='user'` が人間発話, `source.rpcId` があれば RPC 起点), `assistant/message{message,stream,usage}`, `tool/call{callId,name,arguments}`, `tool/result{message,error?}`, `approval/asked|decided`, `session/title`, `model/selection` … (`dsh-session/lib/types/known-event-types.js`, `SessionEventMap`)。
  **`{global:true}` が必須**: 既定は agent スコープ限定 (EVENT_API: "Scope-filtered dispatch")。api-session-controller 自身も `{ global: true }` で購読している (`index.js:1388,1464`)。
- `ctx.on('agent/assistant-stream', ({agent, frame}) => …, { global: true })` — 一時的なストリームフレーム `start|chunk|end`、`chunk.chunk` は `text-delta{index,text}` / `reasoning-delta` / `tool-call-delta{id,name?,argumentsDelta}` / `block-end` / `usage` / `finish` (`StreamChunk`)。**リアルタイムのテキスト差分はこちら**(耐久イベントはブロック完了後)。
- `ctx.on('agent/status', ({agent, status:'idle'|'running'}))`, `api-session/added|removed|status|activity|error`, `session/created|disposed`, `agent/error`, `agent/created|disposed`。
- 直接操作の代替: `ctx.agents.get(sessionId)` → `Agent`、`agent.followup(createUserMessage({content,source}))`, `agent.steer`, `agent.cancel`。`ctx.sessions.get/list()`、セッション cwd は `session.header.cwd` / `SessionSummary.cwd`。

### 先行実装 (参考になる実在コード)
`dsh-acp` (`<dsh-acp>/index.js:1105-1140`) は同じ `ctx.on('session/event'|'agent/inbox/claimed'|'agent/error'|'approval/request')` を使ってエージェントを外部プロトコルにブリッジしている。ACP のコードが OmniChat プラグインの設計テンプレートになる。`dsh-webhook` は `Agent.followup()` で外部イベントからセッションを起動する公式の拡張パターン(README に「user-authored rule plugins」の記述)。

---

## 4. API は公開・安定か / インストール方法

- **安定契約ではない (内部 API, rc)**。根拠: ランタイム版 `0.2.0-rc.2` (`dsh\package.json`); `dsh-app-boot` README に「Nothing promises byte stability」「pre-stable compatibility policy」; サードパーティ例 `dsh-web-search` README も「targets one DSH train」と明記。ただし `api-catalog.js` は「公式の cordis API カタログ」として `cordis_inspect` ツール経由でモデルにも公開されており、サービス名/イベント名は生成ドキュメントで凍結チェック(`verify-cordis-api`)されている → **事実上の準公開面**。`dsh-webhook` や plugin-manager README が「ユーザ作成のルールプラグイン」を想定している。
- **バージョンゲート** (`dsh-app-boot` README 52 行): import 前に `peerDependencies` のうち `@deepseek-ai/dsh` と `@deepseek-ai/dsh-*` を **単一のランタイム版 (0.2.0-rc.2)** と突き合わせ、不一致の bundle は **スキップされ `skippedBundles` に列挙**される(プレリリースも範囲評価に参加)。**DSH peer を宣言しなければ制約なし**("Missing DSH peers impose no constraint")。`@deepseek-ai/cordis` は `dsh-*` に該当しないので影響しない。例外許可は `dsh plugin --profile X allow-version <pkg@ver> --dsh-version 0.2.0-rc.2 --accept-risk`。
  - 推奨: peer を宣言しない、または `>=0.2.0-rc.2 <0.3.0` のように緩く書き、自前で必要サービスの存在を実行時チェックして警告ログ。
- **インストール**: `dsh plugin --profile <name> <pnpm-args>` は pnpm を profile ディレクトリで実行するだけ (`dsh\lib\bin.js:115-126`, `plugin-BGnVfe_D.js`)。`parseInstallSpec` (`dsh-plugin-manager/lib/types/install-spec.js`) が受理する形: レジストリ名[@range] / **絶対パス (`C:\…\dir`, `file:`/`link:`) / 絶対パスまたは URL の `.tgz`** / git (`github:` 等)。相対パスは不可。**npm 公開不要**。
  - 例: `dsh plugin --profile desktop add C:\path\omnichat-dsh-bridge-0.1.0.tgz` (`pnpm pack` / `npm pack` で作る)。`link:` なら開発用に symlink。
  - 配置先: `C:\Users\<user>\.dsh\profiles\<name>\node_modules\<package>` + その profile の `package.json#dependencies` と `pnpm-lock.yaml`。パッケージが `dsh.bundle` を宣言していれば `reconcile()` が `dsh.profile.bundles` に自動追加 (`dsh-plugin-manager/lib/index.js:240-262`)。宣言が無いと「plain dependency」扱いで有効化されない。
  - pnpm 11 は依存のビルドスクリプトを既定ブロック(git 取得物の `prepare` など)→ **tgz に `dist` を同梱し依存ゼロ**にするのが無難。
  - 適用はプロセス再起動 (desktop は GUI 起動時に反映)。web プロファイルは HMR 有効で即反映の可能性あり。

---

## 5. セキュリティ: 承認ポリシーとの相互作用

- プラグインに権限ゲートは**無い**: 「Installed Host code executes in-process outside the workspace sandbox」(plugin-manager README)。インストール= ユーザ OS 権限での任意コード実行を信頼する行為。唯一のゲートは §4 のバージョン peer チェックと pnpm のビルドスクリプト承認。
- 承認ポリシー: `ApprovalPolicy = 'ask' | 'never'` (`dsh-user-approval/lib/index.js`)。セッション単位 (`approval/policy` イベント) か設定既定。`decide()` (175-176 行): `never` → 即 `rejected`、`ask` → `approval/request` waterfall を発火し、**誰も答えなければ `unavailable` = 拒否**。
- **リモート注入メッセージの扱い**: `prompt()` は GUI の送信と同じ経路なので、セッションのポリシー/サンドボックスをそのまま継承する。`ask` のままだと、危険ツール(書込/shell 等)で `approval/request` が走る。GUI 画面が開いていれば GUI にダイアログが出て**リモートターンは人間の操作待ちでブロック**する。GUI が閉じている(desktop ウィンドウを閉じた/headless 的運用)と `unavailable` で自動拒否。
- **リモートで承認を扱う方法 (可能)**:
  1. `ctx.on('approval/request', (req, next) => …, { prepend: true })` (`prepend` は cordis の `on` オプション, `cordis/index.js:336,372`) で横取りし、`req.{agent.session.id, toolName, callId, reason, displayReason, signal}` を OmniChat に転送、ユーザの回答を `'allowed-once' | 'rejected'` で返す(`signal` abort は `cancelled`)。リモート非対象セッションは `next()` で GUI に委譲。`dsh-acp` が同じことをやっている (`index.js:1116-1140`)。
  2. 事前に `ctx.permissionPresets.set(session, name)` で許可プリセット(`workspace-write`+`ask` / `danger-full-access`+`never` 等, `dsh-permission-presets`)を切り替える。ただし GUI の同セッション設定も変わる。
  3. `approval/asked` / `approval/decided` は耐久イベントなので `session/event` 購読で「承認待ち」状態をリモート表示だけすることも可能。
- 追加: `user-questions/request` (ask_user_question ツール) も同様の waterfall で、リモートに転送しないとターンが止まる。
- bridge 現行の「headless は承認なしで実行」より、プラグイン方式の方が GUI のポリシーを尊重できて安全側。ただし**サーバ/アカウントが奪われると dsh を遠隔操作される**点は同じ。トークンは env (`!!js process.env.X`) か dsh credentials に置く。

---

## 6. 推奨設計・最小パッケージ・リスク

### 6.1 アーキテクチャ
```
OmniChat app ──> OmniChat server <──outbound WS── [dsh プロセス内: omnichat-bridge プラグイン] ──in-process── sessionController / agents
```
- プラグインは既存ワイヤ (`BRIDGE.md`/`BRIDGE-v2.md`) を実装する WS クライアントにする → **サーバ無改修**。
  - 接続: `new WebSocket(`${serverUrl}/bridge?token=…&name=…`)` → `{type:'ready',name,cwd,dshVersion,models,defaultModel}`。指数バックオフ再接続(1s..30s)、ping/pong。
  - `run{runId,sessionId|null,prompt,model?}`: `sessionId==null` なら `create({cwd})`、`model` があれば `selectModel`(副作用対策 §6.3) → `prompt({requestId:runId,mode:'queue',content:[{type:'text',text:prompt}]})`。その runId に紐づけて購読を開始。
  - イベント変換 (現行 NDJSON 互換): `turn/start`→`status turn_start`; `text-delta`→`{type:'text',text}`; `reasoning-delta`→`thinking`; `tool/call`→`tool_call{callId,tool:name,input:JSON.parse(arguments)}`; `tool/result`→`tool_result{callId,status,result}`; `turn/end`→`status turn_end{reason}` + `done{runId,ok,sessionId}`。
  - `cancel{runId}` → `sessionController.cancel({sessionId})` → `done ok:false error:'cancelled'`。
  - `models` フレーム: `modelCatalog()` の `groups[].models[]` を `{provider:group.id,id:model.id,name}` に変換(modelRef = `<provider>::<id>` と一対一)。`llm/adapters-updated` / `settings/document-updated` で再送。**cordis.patch.yml の読み取りは不要になる**(認証情報にも触れない)。
  - **GUI 側入力のリアルタイム反映 (mirror の代替)**: `session/event` を `{global:true}` で購読し、`run` に紐づかない `user/message(source.kind==='user')`/`assistant-stream`/`tool/*`/`turn/end` を `sessions` ミラーフレーム (`BRIDGE-v2.md` §B。key=`u:<turn>:<k>` / `a:<turn>`) に変換して送る。ログ(zstd)パース・ポーリング・別デーモンが全て不要。echo 抑止は `source.rpcId` が自分の `requestId` かで判定。接続時 `full:true` は `sessionController.list()` + `page()` で生成。
  - 排他: 現行の「3 秒以内にログが変わった→session busy」ヒューリスティックは不要。`SessionSummary.running` / `agent.status==='running'` で正確に判定できる(`queue` モードなら実行中でも後続投入され、GUI と同一キューで直列化される)。

### 6.2 最小パッケージ構成
```
omnichat-dsh-bridge/
├─ package.json
├─ cordis.patch.yml
└─ dist/index.js          # ESM。tgz に同梱 (ビルド不要・依存ゼロ・Node 組込み WebSocket)
```
`package.json` (web-search に倣う):
```json
{
  "name": "@omnichat/dsh-bridge", "version": "0.1.0", "type": "module",
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js", "./package.json": "./package.json" },
  "files": ["dist/", "cordis.patch.yml"],
  "engines": { "node": "^22.19 || >=24" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```
(DSH peer は宣言しない、または緩く。`dsh.client` は不要 = ブラウザ側 UI なし。)

`cordis.patch.yml` (バンドル patch。`name` はパッケージ名を引用符付きで):
```yaml
- insert:
    - id: omnichat-bridge
      name: '@omnichat/dsh-bridge'
      config:
        serverUrl: wss://omnichat.example.com
        name: my-pc
        token: !!js process.env.OMNICHAT_TOKEN
```
`dist/index.js` 骨子:
```js
export const name = 'omnichat-bridge'
export const inject = ['sessionController', 'sessions', 'agents']   // approval を扱うなら 'approval', 'permissionPresets'
export function apply(ctx, config) {
  ctx.effect(() => { const stop = start(ctx, config); return () => stop() })  // WS close + 購読解除
}
```
配布/導入: `npm pack` → `dsh plugin --profile desktop add C:\path\omnichat-dsh-bridge-0.1.0.tgz`(GUI 終了後)。2 回目以降は profile の `cordis.patch.yml` に `- id: omnichat-bridge` + `config:` 上書き行を書くだけで設定変更可。

### 6.3 リスク・未確定事項 (実機でしか確定しない)
1. **`@Remote` メソッドの直接呼び出し**: `sessionController.prompt/cancel/create/modelCatalog` を `ctx.sessionController.xxx()` として in-process 呼びできるはず(`resolveAgent` は他ドメインから呼ばれる設計とコメントあり, `index.js:2926-2931`)が未実機検証。ダメなら `ctx.agents` + `createUserMessage` で `followup` する代替(`dsh-llm` の `createUserMessage` が必要 → 同梱バージョン依存)。
2. **`selectModel` の GUI 既定上書き副作用**: ターンごとにモデルを変えるたびに GUI の既定が変わる。対策: 呼ぶ前に `ctx.agentDefaultModel.currentSelection()` を保存し、`prompt` 受理後に `saveSelection(元)` で戻す(非同期保存との競合に注意)。代替でセッションに `model/selection` を直接 append するのは内部実装依存で非推奨。
3. **rc 版内部 API の破壊的変更**: DSH ランタイム更新(`0.2.0-rc.3`/`0.3`)でイベント名/型が変わりうる。peer を宣言すると更新時にスキップされる(=無音で動かなくなる)ので、peer 無宣言 + 起動時にサービス存在チェック + 失敗時ログ、が現実的。アプリ更新ごとに実機スモークテスト。
4. **`approval/request` の優先順位**: GUI(api-remotes がブラウザへ転送する listener)と自前 listener の登録順/`prepend` の実際の挙動、GUI 同時操作時に二重ダイアログにならないか。`approval/request` を `next()` に委譲した場合のリモート側の待ち表示。
5. **desktop プロファイルへの導入手順**: `dsh plugin --profile desktop add` が GUI 終了必須(ロック/初期化条件)。`dsh.cmd`(シム)が PATH にあるか。tgz パスは絶対パス必須。pnpm の `allowBuilds` / `autoInstallPeers:false` 影響は依存ゼロ tgz なら回避できるはずだが未検証。
6. **同一マシンで desktop と web を同時起動**した場合の二重接続(両方に入れた場合)。サーバは `(user,name)` につき 1 接続(新が旧を置換)なので、プロファイルごとに別 `name` にするか片方だけに入れる。
7. **ロング接続の維持**: Desktop GUI のウィンドウを閉じるとホストプロセスも終了するか(トレイ常駐設定による; `resources\tray.ico` あり)。常時接続したいなら `web` プロファイル常駐起動(HMR 付き)の方が向く可能性。
8. **コールドセッション**: attach されていないセッション(GUI で開いていない過去ログ)への `prompt` は `resolveAgent` が再開するが、`cancel` は attach 済みのみ。`session/event` は attach 済みセッションのみ流れる → 一覧の `running`/履歴は `list()`/`page()` で補う。
9. **セキュリティ**: プラグインは無権限制御で OS 権限実行、かつ接続先サーバ/トークンの奪取=dsh の遠隔操作。トークンは yml 平文を避け env/credentials に。既定は承認 `ask` を維持し、`approval/request` 転送 UI を実装するまでは危険ツールが止まる前提で運用。
10. **ログ/イベント量**: `agent/assistant-stream` の chunk は高頻度。WS 送出前に 30–50ms 程度でバッチ化(現行 NDJSON `text` と同粒度で十分)。

### 6.4 次の一手 (最小 PoC)
1. `dist/index.js` に `session/event`(global) をコンソール出力するだけのプラグインを作り、`dsh plugin --profile web add <abs path>` → `dsh web` で起動、ブラウザ GUI で送信して `user/message`/`text-delta`/`tool/call` が見えることを確認(課金モデルを避け、ローカル LM Studio/opencodex モデルで)。
2. 同プラグインから `ctx.sessionController.list()/modelCatalog()/prompt()/cancel()` を呼べるか確認 (リスク 1)。
3. 通れば §6.1 の WS 変換を実装し、`bridge-v2.test.ts` のワイヤ互換テストを流用。

---

# 追補 (2026-10-17): サブエージェントの可視性 (OmniChat v4 `agents` フレーム用調査)

対象: 同じ dsh 44.0.0 / ランタイム 0.2.0-rc.2。方法: (a) `app.asar` の `dsh-subagent` / `dsh-tool-subagent` / `dsh-user-approval` / `dsh-acp` のソースと `api-catalog.js` を読む、(b) **隔離した `DSH_HOME`(使い捨てフォルダ)と使い捨て cwd** で `dsh --profile headless --json` を実行し、ローカルの LM Studio モデル(`lfm2.5-24b-a2b` / `google/gemma-4-e4b`)だけを使って実ログを取った。ユーザーの `~/.dsh` のセッション・認証情報には触れていない(隔離ホストの `llm-pi-ai` は LM Studio の `http://localhost:1234/v1` を指す使い捨てパッチ)。

## A. 結論

| 経路 | サブエージェントについて見えるもの | 判定 |
|---|---|---|
| デーモン型(`dsh headless --json`) | NDJSON には `tool_call{tool:"subagent"\|"subagent_fork"}` と `tool_result` だけ。子のイベントは流れない。`subagent_fork`(one-shot)は結果に子の最終回答が入る。`subagent`(continuable, headless 既定の `backgroundMode`)の結果は `started subagent <childId>` だけで、**`dsh headless` は親のターン終了で終了するため、背景で動く子は中断される**(実ログで確認: 子のログは `turn/end` なしで途切れた) | 開始・fork の完了は見える。continuable の結果は、終了後に子のログ(ディスク上の別セッション)を読んで推定。実行中の進捗は見えない |
| プラグイン型(同一プロセス) | 子は**別セッション**として `session/event`(global)に流れる(`header.origin==='subagent'`, `header.parentSession`)。さらに cordis イベント `subagent/start` / `subagent/end`。親の `tool/call` / `subagent/catalog` | 開始・進行・終了・要約・ログまで可能(ソースで確認。実機のプラグイン経由は下記の注記を参照) |

## B. 証拠

1. **サービス / イベント**(`api-catalog.js`):
   - サービス `subagents`(`SubagentRuntime`): `listChildren(parentSessionId)` → `[{id, createdAt, mode:'one-shot'|'continuable'|'unknown', label?}]`、`listDescendants(rootSessionId)` → `+ {parentId, depth, activity:'running'|'inactive', hasChildren}`。`sendMessage` / `interrupt` / `registerProvider` / `start`。
   - cordis イベント `subagent/start` `info = {runId, provider, id /*子セッション id*/, local}`、`subagent/end` `info = {…, stopReason, lastAssistantMessage?: ContentBlock[]}`。`this` は `Scoped<SubagentRuntime>`(委譲した親でスコープされる)。`{global:true}` で全体を購読できる。「in-process provider では `subagent/start` の通知中に `ctx.agents.get(info.id)` が解決する」との記述あり。
   - セッションイベント(耐久ログ): 親に `subagent/catalog {version, childId, childCreatedAt, mode, label}`、子に `subagent/descriptor {version:3, mode, provider, label, agentProvider, agentModel}`、完了通知は親の `agent/inbox/spliced` の `source.kind === 'subagent-settled'`。
   - `agent/status`(idle⇄running)、`agent/error {agent, turn, step, error}`、`agent/inbox/inserted|claimed|discarded` は存在するが、サブエージェント専用ではない。子の状態は子セッションの `turn/start|end` で判定するのが確実。
   - サービス `agents`(`ctx.agents.get(id)`)は生きている Agent の取得用(`status`)。
2. **既定のプロファイル**(隔離ホストで `--dump-config`): `headless` は `tool-subagent`(`subagent`, `backgroundMode: continuable`)、`tool-subagent-fork`(`subagent_fork`, one-shot)、`tool-subagent-control` が**有効**。`web` はこれらのツールが `disabled: true`(エージェントプリセットや patch で有効化する)。
3. **実ログ(headless, gemma-4-e4b)**:
   - fork: `{"type":"tool_call","tool":"subagent_fork","input":{"description":"Read a.txt file","prompt":"…"}}` → `{"type":"tool_result","status":"completed","result":"The contents of `a.txt` are:\n\n1: hello"}`。
   - continuable: `{"type":"tool_call","tool":"subagent",…}` → `{"type":"tool_result","status":"completed","result":"started subagent 9c778e9d-a3e7-46dd-8224-e209b15b7ae3"}`。その後、親は次のステップで普通に終了し、プロセスが終わる。
   - ディスク: 子は `sessions/<cwd-slug>/<childUuid>/session.v4.jsonl.zstd`(**`session-` 接頭辞なしの素の uuid**)。ヘッダに `parentSession: "session-…"`。先頭レコードは `subagent/descriptor {mode:"continuable", provider:"spawn", label}`、続いて通常の `turn/start`, `assistant/message`, `tool/call`(`read`), `tool/result`。このテストでは step 2 の途中で終わり、`turn/end` がなかった(親プロセスの終了で中断)。
   - 親のログ: `tool/call(subagent)` → `subagent/catalog{childId,…}` → `tool/result("started subagent <id>")`。
4. 失敗例も確認: LM Studio のコンテキスト超過で子が失敗した場合、親の `agent/inbox/spliced` に `source.kind: "subagent-settled"`(本文は `Background subagent <id> failed before it finished.`)が入り、子のログは `turn/end` に `reason.kind:"error"` を持つ。

## C. OmniChat での扱い(実装範囲)

- デーモン型: NDJSON の `subagent*` ツール呼び出しから `agents` を作る(id = callId、role = `input.description`)。`subagent_fork` は結果で `done`/`error` と要約。continuable は run 終了時に子のログを読み、`turn/end` があればその結果、なければ `error`(「dsh プロセスの終了で中断」)。進捗の逐次表示はしない。
- プラグイン型: 子セッションのイベントと `subagent/start|end` から、状態・要約・ログ(64 KB まで)を逐次更新して `agents` を送る。
- `phase: "subagent"` はサーバー側が `tool_call` の名前(`subagent*`)から導出できるので、ブリッジは生イベントをそのまま転送する(追加のフレームは不要)。
- **プラグイン経由の実機確認(隔離 `DSH_HOME` の `web` プロファイル + 本プラグイン + 偽の OmniChat サーバー + LM Studio のローカルモデル)**:
  - `subagent`(continuable)を呼ばせると、`agents` フレームが `running`(`role` = 親の `subagent/catalog` のラベル)→ 子の `tool/call`(`read` など)が `log` に追記 → 完了で `done`(`summary` = 子の最終メッセージ、`endedAt`)と進んだ。親の `done` の後に子が完了するケースも、追跡を続けて最終の `agents` を送れた(web プロファイルではプロセスが残るため子は中断されない)。
  - 子の `subagent/descriptor` イベントは `session/event` では拾えなかった(子セッション作成時に追記されるため購読前)。ラベルは親の `subagent/catalog` から取る。
  - この web プロファイルでは `subagent_fork`(one-shot 設定のツール)の結果も `started subagent <id>` で、バックグラウンド扱いだった(headless では結果に最終回答が入った)。どちらも子セッションのイベントで完了を追える。
  - 承認: 作業フォルダ外への `write`(サンドボックス昇格)で `approval/request` が発火し、`{type:"approval", tool:"write", path, reason}` を転送、`allowed-once` を返すとファイルが作られた。OmniChat 外のセッションは `next()` に渡す設計(単体テストで確認)。
  - チェックポイント → `changes` → `rewind`/`rewound` も同環境で往復を確認。
  - 未確認: `desktop` プロファイル、実際の dsh GUI(ユーザー自身の画面)との併用、`rejected` / タイムアウトの実機挙動(単体テストのみ)。
