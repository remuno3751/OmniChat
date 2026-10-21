# VS Code bridge: ツールを提供する拡張機能 (`vscode-ext/`)

対象: server / app / 新規 `vscode-ext/`。**すべて追加のみ**(dsh bridge と古い client は影響を受けない)。
ベース: `BRIDGE.md`(WS の基本)、`BRIDGE-v2.md` D(workspaces/cwd)、`PROTOCOL-v4.md`(approval rules・changes・checkpoint/rewind)、`docs/PLUGINS.md`(ツール機構。6 ラウンド・openai-compatible 限定は **Chat のまま**)、`docs/design/CODE-WORKSPACES.md`、`docs/design/THEMES-IMPL.md`。

```
OmniChat app ──WS/REST──> OmniChat server (モデル + エージェントループ) <──outbound WS /bridge?kind=vscode── VS Code 拡張 (ツール実行)
```

## 1. 決定事項

1. **エージェントループはサーバー側**。拡張は「ツール実行 + ワークスペース報告 + 承認の防御層」だけ。モデルは OmniChat に登録された任意のプロバイダー。
2. 新 provider kind **`vscode-bridge`**: `baseUrl` = bridge 名(= 端末名)、apiKey なし。使うモデルは会話の `model` に `"<providerId>::<modelId>"`(BRIDGE-v2 の modelRef と同形)で持つ。`dsh-bridge` と同じ制限(線形会話、分岐/再生成なし、ephemeral 不可、添付はドキュメントのみ)。作成時 `mode:'code'`。
3. **1 端末 = 1 bridge 名、複数ウィンドウ**: 拡張は VS Code ウィンドウ(拡張ホスト)ごとに 1 本接続し、`?instance=<activation ごとの UUID>` を付ける。サーバーは `(user, name, instance)` で保持し、`GET /bridges` では同名を 1 件にまとめる(workspaces は和集合)。run は `cwd` を持つ instance へ送る。どの instance も持たない cwd は `workspace_not_open`。同じ instance の再接続は置換(close 4000)。dsh は instance なし(従来どおり)。
4. 接続: `ws(s)://<server>/bridge?token=<device token>&name=<bridge name>&kind=vscode&instance=<uuid>`。`kind` 省略 = `dsh`。
5. **サーバーが承認の最終権限**。拡張は realpath(symlink)・秘密情報の防御チェックを重ねて、足りなければ `approval` フレームでエスカレーションする。
6. Git は `bridge/src/gitops.ts` を再利用(esbuild でバンドル。複製しない)。checkpoint は**全モードで毎 run の前**。

## 2. ワイヤ(WS JSON テキストフレーム、1 フレーム ≤ 8 MB)

### 2.1 接続順序

```
E: connect → E: ready → S: welcome → (S: run → E: checkpoint → E: run_ack → [tool_call ⇄ tool_result]* → S: run_end → E: changes → E: done)*
```
- E = 拡張、S = サーバー。`ready` は接続ごとに 1 回。`ready` 前の他フレームは無視。WS ping/pong は BRIDGE.md と同じ(20 s)。再接続は指数バックオフ 1 s〜30 s、再接続時に `ready` を再送。
- 未知の `type` / 未知のフィールドは無視(前方互換)。

### 2.2 E → S

```jsonc
{"type":"ready","kind":"vscode","name":"my-pc","instance":"6f1c…","version":"0.1.0","protocol":1,
 "vscodeVersion":"1.96.0","platform":"linux","shell":"bash","remote":null /* "ssh-remote"|"wsl"|"dev-container"|null */,
 "cwd":"/work/app","workspaces":["/work/app","/work/lib"],"allowAnyCwd":false,"trusted":true,
 "capabilities":{"workspaces":true,"fs":false,"approval":true,"checkpoints":true,"transcript":false,
   "tools":["read_file","list_dir","glob","grep","write_file","edit_file","run_command","get_diagnostics","git_status","git_diff","git_log","git_commit"]}}
{"type":"workspaces","workspaces":["/work/app"],"allowAnyCwd":false}          // 一覧が変わったとき(BRIDGE-v2 D)
{"type":"run_ack","runId":"r1","ok":true}                                      // run を受理。ok:false なら error: "busy"|"cwd not allowed"|"untrusted_workspace"
{"type":"checkpoint","requestId":"r1","checkpointId":"…","ref":"refs/omnichat/checkpoints/…","createdAt":1760000000000,"dirty":false}
{"type":"checkpoint","requestId":"r1","unavailable":"not a git repository"}     // 警告のみ。run は続行
{"type":"event","runId":"r1","event":{"type":"tool_progress","callId":"c1","stream":"stdout","text":"…"}}  // run_command の途中出力。100 ms ごとにまとめ、1 call 合計 64 KB まで
{"type":"tool_result","runId":"r1","callId":"c1","ok":true,"result":{…},"truncated":false,"durationMs":12}
{"type":"tool_result","runId":"r1","callId":"c1","ok":false,"error":{"code":"not_found","message":"…","details":{…}}}
{"type":"approval","requestId":"r1","approvalId":"a1","callId":"c1","tool":"read_file","path":"/etc/hosts","reason":"outside workspace (symlink)"}   // PROTOCOL-v4 §4 と同形 + callId
{"type":"changes","requestId":"r1","changes":[{"path":"src/a.ts","status":"modified","additions":3,"deletions":1,"patch":"…"}],"truncated":false}
{"type":"done","runId":"r1","ok":true}                                         // run ごとにちょうど 1 回。cancel 後は ok:false,error:"cancelled"
{"type":"rewound","requestId":"q1","ok":true}                                  // §2.4
```

### 2.3 S → E

```jsonc
{"type":"welcome","protocol":1,"serverVersion":"0.6.0","minExtensionVersion":"0.1.0"}
{"type":"run","runId":"r1","conversationId":"c…","cwd":"/work/app","approvalMode":"manual","checkpoint":true,"roots":["/work/app"]}
{"type":"tool_call","runId":"r1","callId":"c1","tool":"read_file","args":{"path":"src/a.ts"},
 "approval":{"by":"mode:manual"|"user"|"rule:<id>","protectedOk":false},"timeoutMs":60000}
{"type":"cancel","runId":"r1"}
{"type":"approval_reply","approvalId":"a1","decision":"allowed-once"|"rejected"}   // 拡張発の approval への返答
{"type":"run_end","runId":"r1"}                                                    // ループ終了(正常/異常とも)。拡張は changes → done を返す
{"type":"rewind","requestId":"q1","ref":"refs/omnichat/checkpoints/…","cwd":"/work/app","removeNew":false}
```
`approvalMode` は情報用(UI/ログ)。実行可否は `tool_call.approval` が決める: `by` が無い tool_call は拒否(`denied`)。

### 2.4 意味論

- **同時実行**: 1 instance につき run は 1 つ。実行中の `run` は `run_ack {ok:false,error:"busy"}`。run 内の tool_call は、読み取り系を最大 4 並列、write_file / edit_file / run_command / git_commit は到着順に直列化。`callId` は run 内で一意。
- **protectedOk**: サーバーが保護項目をユーザーに明示承認させた場合のみ `true`(その call 限り)。拡張が自前チェックで保護項目と判定し `protectedOk:false` のとき、実行せず `approval` を送って `approval_reply` を待つ(サーバーは `requestBridgeApproval` に流す。「常に許可」は不可)。`rejected` なら `tool_result {ok:false,error:{code:"denied"}}`。
- **タイムアウト**: サーバーは `tool_call.timeoutMs`(既定 60 s、`run_command` は `timeoutMs + 10 s`)で待つ。承認待ちの時間は含めない。超過したらその call だけを `timeout` エラーとしてモデルに返す(run 全体の `cancel` は送らない)。拡張も `timeoutMs` 経過後に自分でその call を中止し、遅れて届いた `tool_result` はサーバーが捨てる。承認の待機は既存の `TOOL_APPROVAL_TIMEOUT_MS`(120 s)。
- **cancel**: 実行中の全 call を中止(プロセスツリーを kill)、保留中の `approval` を破棄し、各 call に `cancelled` の `tool_result`、続けて `changes` → `done {ok:false,error:"cancelled"}`。
- **切断**: 拡張側は切断を検知したら実行中コマンドを kill し、run を破棄(再開しない)。サーバー側は `Bridge 'x' disconnected during the run` で run を失敗させ、保留中の承認を `abort` にする。再接続後は新しい `ready` から。
- **順序保証**: 同一 `callId` の `tool_progress` はその `tool_result` より前。`checkpoint` は `run_ack` より前。`changes` は `done` より前(サーバーは `done` 後 30 s は late frame も受理 — 既存 `recent`)。
- **rewind**: PROTOCOL-v4 §6 と同じ。拡張は `rewindTo()` の後、開いているエディタを再読み込みする。拡張が編集した覚えのない dirty バッファがあれば `rewound {ok:false,error:"dirty_editors"}`。run 中は不可。
- **非 git の cwd**: `checkpoint` は `unavailable`、`changes` は空 + `done.warning:"not a git repository"`。git_* ツールは `not_git`。
- **信頼されていないワークスペース**(Workspace Trust): `trusted:false`、`capabilities.tools` は読み取り系のみ、`run` は `untrusted_workspace`。

### 2.5 互換性

- 拡張は `ready.version`(semver)と `protocol`(整数)を送る。サーバーは定数 `VSCODE_EXT_MIN_VERSION` を `welcome.minExtensionVersion` で返す。拡張が古い → サーバーは run を `VS Code extension 0.1.0 is outdated (need >= 0.2.0). Update the .vsix.` で拒否、`GET /bridges` に `compat:{ok:false,minVersion}`。拡張も `package.json` の `omnichat.minServerVersion` と `welcome.serverVersion` を比べ、足りなければ通知(標準 `showWarningMessage`)。
- `protocol` が合わないときは `welcome` 後に接続を維持するが run は受けない。互換表は `docs/VSCODE.md`(§10)。

## 3. ツール(v1)

共通: `path` は run の `roots` のいずれかからの相対、または roots 内の絶対パス。`workspace`(任意、複数ルート時のルート指定)は不要 — 絶対パスで指定する。行は 1 始まり。文字コードは UTF-8(BOM は保持)。全引数は JSON Schema(`additionalProperties:false`)で検証し、違反は `invalid_args`。

| tool | 区分 | args(必須は *) | result |
|---|---|---|---|
| `read_file` | read | `path*`, `offset`(行, 既定 1), `limit`(行, 既定 2000, 最大 5000) | `{path, content, startLine, endLine, totalLines, truncated}`。開いている dirty バッファの内容を返す |
| `list_dir` | read | `path`(既定 `.`), `depth`(1〜3, 既定 1), `includeHidden`(既定 false) | `{entries:[{path,type:"file"\|"dir"\|"symlink",size?}], truncated}` 最大 500 件。depth>1 では `node_modules`・`.git` に入らない |
| `glob` | read | `pattern*`, `path`, `limit`(既定 200, 最大 1000) | `{files:[string], truncated}`。`files.exclude` と `**/node_modules/**`・`**/.git/**` を除く。パス昇順 |
| `grep` | read | `pattern*`, `path`, `glob`, `regex`(既定 true), `caseSensitive`(既定 false), `context`(0〜5), `limit`(既定 100, 最大 500) | `{matches:[{path,line,text,before?,after?}], truncated}`。行テキストは 300 文字で切る。1 MB 超・バイナリは飛ばす。20 s で打ち切り(`truncated:true`) |
| `write_file` | edit | `path*`, `content*`(≤ 1 MB), `createDirs`(既定 true) | `{path, created, bytes}`。WorkspaceEdit で作成/置換し保存(`omnichat.autoSave`、既定 true)。Undo 可 |
| `edit_file` | edit | `path*`, `oldString*`, `newString*`, `replaceAll`(既定 false) | `{path, replacements}`。`oldString` が 0 件 → `not_found`、複数かつ `replaceAll:false` → `not_unique {details:{count}}`。WorkspaceEdit(Undo 可、ラベル "OmniChat edit")+ 保存 |
| `run_command` | exec | `command*`(≤ 8000 文字), `cwd`(roots 内, 既定 run の cwd), `timeoutMs`(既定 120000, 最大 600000) | `{exitCode, signal?, stdout, stderr, timedOut, truncated}` |
| `get_diagnostics` | read | `path`(省略 = 全体), `severity`(`"error"\|"warning"\|"all"`, 既定 `"warning"` = error+warning), `limit`(既定 200) | `{items:[{path,line,col,endLine,endCol,severity,source?,code?,message}], truncated}` |
| `git_status` | read | なし | `{branch, upstream?, ahead, behind, files:[{path,index,worktree}], truncated}`(最大 500) |
| `git_diff` | read | `staged`(既定 false), `path`, `base`(ref), `context`(0〜20, 既定 3) | `{patch, truncated}`(200 KB) |
| `git_log` | read | `limit`(既定 20, 最大 100), `path`, `ref` | `{commits:[{hash,short,author,date,subject}]}` |
| `git_commit` | gitwrite | `message*`(≤ 4000), `paths`(これらをステージ), `all`(= `-a`) | `{hash}`。amend・`--no-verify`・push は**存在しない**。フックは動く |

**run_command の実行**: `child_process.spawn`(シェル: Linux/macOS は `$SHELL -c`、Windows は `cmd.exe /d /s /c`。設定 `omnichat.shell` で上書き)。stdin は閉じる(対話入力は失敗する)。env は `process.env` から `OMNICHAT_*`・`*_TOKEN`・`*_SECRET`・`*_API_KEY` 系を除き、`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `PAGER=cat` を足す。POSIX は `detached` でプロセスグループごと、Windows は `taskkill /T /F` で kill。出力は stdout / stderr 各 64 KB(先頭 16 KB + 末尾 48 KB、間に `\n... [N bytes omitted]\n`)。VS Code の統合ターミナルは v1 では使わない。

**共通上限**: 1 つの `tool_result` のシリアライズ後 ≤ 256 KB(超えたらフィールドを縮め `truncated:true`)。ファイル読み取りは 5 MB 超で `too_large`、バイナリ(先頭 8 KB に NUL)は `binary_file`。

**エラー形** `{code, message, details?}`。`code`: `invalid_args` `not_found` `not_unique` `outside_workspace` `protected_path` `denied`(承認拒否/承認なし)`cancelled` `timeout` `too_large` `binary_file` `io_error` `not_git` `git_failed` `unsupported` `internal`。サーバーはモデルへ `ERROR <code>: <message>` として渡す(スタックトレース・絶対パス以外の環境情報は含めない)。

## 4. 承認

### 4.1 モード(会話ごと。`conversations.approval_mode`: `manual`(既定)`auto` `full`)

| 区分 | manual | auto | full |
|---|---|---|---|
| read(roots 内) | 自動 | 自動 | 自動 |
| edit(roots 内) | 確認 | 自動 | 自動 |
| exec `run_command` | 確認 | 許可リストのみ自動、他は確認 | 自動 |
| gitwrite `git_commit` | 確認 | 確認 | 自動 |
| **保護項目 (§4.2)** | 確認 | 確認 | **確認** |

許可リスト(auto、サーバー定数 + ユーザーの `command` 許可ルール): `npm test` `npm run test` `npm run lint` `npm run build` `npm run typecheck` `pnpm test` `yarn test` `npx tsc --noEmit` `tsc --noEmit` `pytest` `cargo test` `cargo check` `go test ./...` `git status` `git diff` `git log`(それぞれ末尾に空白区切りの引数を足してよい: `npm test -- foo`)。**シェルのメタ文字を含むコマンドは許可リスト不一致**: `; & | < > \` $( ${ ` と改行、`\n`。

### 4.2 評価順(サーバー `vscode-policy.ts`、`approvals.ts` から呼ぶ)

1. **保護判定**: `protected = matchProtected(tool, args, roots)`(§4.3)。
2. `deny` ルール(project > global。PROTOCOL-v4 §4)が一致 → **拒否**(保護項目にも効く)。
3. `protected` なら → **確認**(allow ルール・モードでは下げない。ダイアログに「常に許可」を出さない。`tool_call.approval.protectedOk=true` は 1 回限り)。
4. `allow` ルールが一致 → 許可(`by:"rule:<id>"`)。
5. モード表(§4.1)→ 許可(`by:"mode:<mode>"`)または確認。
6. 既定 = 確認。

確認 = 既存の `requestBridgeApproval` → `tool_approval` WS → ユーザー応答(allow once / deny。通常項目のみ「常に」= `allow` ルール作成)。タイムアウト・abort は拒否。`decidedBy` は `rule:<id>` / `mode:<mode>` / `user` / `timeout` / `abort` を記録し、tool call に残す。

### 4.3 保護項目(正規パターン。サーバーは字句処理のみ、拡張は realpath も)

パスの正規化: `\`→`/`、`.`・`..` を解決、末尾 `/` 除去、Windows 形式(ドライブ/UNC)と macOS/Windows は大文字小文字を無視。`~`・`$HOME`・`%USERPROFILE%` で始まるものは「roots 外」。

| id | 対象 | 条件 |
|---|---|---|
| P1 outside | 全ファイルツールの `path`、`run_command.cwd` | 正規化後に `roots` のどれの配下でもない(拡張は symlink 解決後に判定) |
| P2 git-write | edit 系の `path` | `(^\|/)\.git(/\|$)`(`.git` ファイル=submodule/worktree も) |
| P3 secrets | read **と** edit の `path` | basename が `^\.env(\..+)?$`(`.env.example` `.env.sample` `.env.template` を除く)、`\.(pem\|key\|p12\|pfx\|ppk)$`、`^id_(rsa\|dsa\|ecdsa\|ed25519)(\.pub)?$`、または `(^\|/)\.(ssh\|gnupg\|aws\|kube)(/\|$)`、`(^\|/)(\.npmrc\|\.netrc\|\.git-credentials\|\.docker/config\.json)$` |
| C-git | `run_command` 内の単純コマンド(`git [-C p] [-c k=v]…` の後のサブコマンド) | `push`(全引数)/ `reset` + `--hard` / `clean`(全引数)/ `checkout`・`switch`・`restore` + `-f`\|`--force` / `branch` + `-D`\|`--delete --force` / `stash` + `drop`\|`clear` / `filter-branch` / `update-ref` + `-d` / `reflog` + `expire`\|`delete` / `gc` + `--prune` / 任意のサブコマンドの `--force` `-f` `--force-with-lease` `--force-if-includes` と `+<refspec>`(push) |
| C-rm | 単純コマンド | `rm` で `-r` `-R` `--recursive`(`-rf` `-fr` 等の結合も)、`rmdir /s`、`rd /s`、`del /s`、`Remove-Item … -Recurse`、`find … -delete`、`shred`、`mkfs*`、`dd … of=` |
| C-path | `run_command` のトークン | リテラルの絶対/`~`/`..`-脱出パスが P1(`/dev/null` は除く)、リテラルのトークンが P2/P3 に一致(`git` サブコマンド本体の `.git` は除く)。*追加提案* |
| C-sys | 単純コマンド | `sudo` `su` `doas`、`curl`/`wget` を `sh`/`bash`/`zsh`/`pwsh` にパイプ、`chmod -R`・`chown -R`。*追加提案* |

コマンド解析: `; && \|\| \| & 改行` と `$(…)`・バッククォートで分割し、各単純コマンドを shlex 風にトークン化。`bash|sh|zsh -c "<s>"`、`pwsh -Command`、`eval` は `<s>` を再帰的に解析。解析失敗(引用符の不整合など)・`base64 -d | sh` のような難読化は**保護扱い(確認)**。これは安全網であって **サンドボックスではない**(README に明記)。

**サーバーと拡張で同一の判定**: 正準ケース表は `vscode-ext/test/fixtures/protected-cases.json`(`{tool,args,roots,expect:{protected:boolean,ids:[…]}}`)。`vscode-ext/src/guard/*` と `server/src/vscode-policy.ts` の両方がこの JSON を読むテストを持つ。

### 4.4 その他

- **ファイル/モード/履歴の保持**: モードは会話に保存、`PUT /conversations/:id` で変更、`upsert` で同期。新規会話は常に `manual`。**サーバー起動時**と、**ユーザーの最後の WS クライアントが切れて 60 s 経過したとき**(= アプリ再起動)に、そのユーザーの `auto`/`full` を `manual` に戻して upsert を配信する。
- `full` への変更は `PUT {approvalMode:"full", confirmFull:true}` が必要(無いと 400 `confirm_required`)。アプリは警告ダイアログ(§8 A3)で同意を取る。
- 拡張の VS Code 内承認(P3): サーバーは承認待ち中、`{type:"approval_pending",runId,approvalId,tool,summary,protected,reasons:[…]}` を該当 instance に送り、拡張は E→S `{type:"approval_decision",approvalId,decision:"once"|"deny"}` で答えられる(最初の応答が勝つ。`approval_settled {approvalId,decision,decidedBy}` で閉じる)。`capabilities.approval:true` のときだけ。

## 5. 拡張の UI とデザイン

- **標準 UI はそのまま**: ステータスバー(接続状態 / 保留承認数)、通知、QuickPick(ペアリング、テーマ選択)、Output channel "OmniChat"。
- **Webview 2 枚**(素の TS + CSS、フレームワークなし): chat パネル(run のツール活動のライブ表示。`capabilities.transcript:true` のとき `S→E {type:"transcript",conversationId,runId,items:[…]}` を受け、`E→S {type:"prompt",requestId,cwd,text,conversationId?}` で新しい依頼も出せる — P3)と、承認パネル(保留中の承認、Allow once / Deny、`write_file`/`edit_file` は「差分を表示」で**標準の diff エディタ**を開く、保護バッジ + 理由、キーボード操作可)。CSP は `default-src 'none'`、nonce 付きスクリプト、リモートリソースなし。
- **トークン**: `vscode-ext/scripts/gen-tokens.mjs` が `app/src/themes/{simple,frontier,astral}.ts` を**個別に**(`themes/index.ts` は不可)esbuild でその場バンドルして読み、`media/generated/tokens.css` と `tokens.json` を出す。変数: `--oc-<palette key の kebab>`(`bg` `panel` `text` `accent` `accent-ink` `accent-text` `danger` `diff-add` …)、`--oc-r-xs…pill`、`--oc-dur-1..3`、`--oc-ease`、`--oc-font-body|head`。セレクタ `:root[data-oc-theme="frontier"][data-oc-mode="dark"]`。関数・クラス等の非データ値、`index.ts` への依存が出たらビルド失敗(`themes/*.ts` は純データのまま)。
- **設定** `omnichat.theme`: `simple|frontier|astral`、**既定 frontier**。light/dark は VS Code に従う(`body.vscode-dark|vscode-light`、テーマ変更を MutationObserver で追従)。**高コントラスト**(`vscode-high-contrast[-light]`): `--oc-*` を `--vscode-*`(`editor-background` `foreground` `contrastBorder` `focusBorder`)へ上書きし、装飾オフ・1px 実線枠。設定 `omnichat.decorations`: `auto|on|off`。
- **フォント**: Frontier(Space Grotesk, Syncopate、OFL)は vsix に同梱し常に使う。Astral(Zen Maru Gothic, Outfit, Marcellus)も同梱するが `@font-face` は Astral 選択時の HTML にだけ出す。vsix ≤ 15 MB(超えるなら Zen Maru をサブセット化)。`THIRD_PARTY_NOTICES.txt` に追記。
- **THEMES-IMPL ルール**: 文字色は `accentInk`、塗りは `accent`(ライトの黄は文字にしない)/ 動きは一度きり(`animation-iteration-count:1`)で `prefers-reduced-motion` と装飾オフで 0 / webview 幅 < 480px で装飾を自動で減らす(`data-oc-narrow`)/ `backdrop-filter` 禁止(CSS を grep するテスト)/ AA コントラスト検査(`scripts/check-contrast.mjs` が `tokens.json` の主要ペアを全テーマ×モードで検査、vitest からも実行)。

## 6. 配布・ペアリング

- `.vsix` は `vscode-ext` の `npm run package`(`vsce package --no-dependencies`)で `omnichat-vscode-<version>.vsix`。`packaging/build-release.mjs` がビルドし GitHub Releases に添付、サーバー/アプリのリリースにも同梱(`omnichat-dsh-bridge-1.0.0.tgz` と同じ扱い)。Marketplace は**未公開**だが `package.json` は公開可能な形(`publisher` `icon` `repository` `license` `README.md` `CHANGELOG.md` `LICENSE` `categories` `engines.vscode`)。`extensionKind:["workspace"]`(Remote-SSH / WSL ではリモート側でツールが動く)。
- **ペアリング**: 既存の `POST /bridges/token` を再利用(`{name, kind:"vscode"}` → デバイス名 `VS Code (<name>)`)。アプリの VS Code カードが**ペアリングコード**(base64url の `{s:<serverUrl>,t:<token>,n:<name>}`)と `vscode://omnichat.omnichat-vscode/pair?code=…` を表示。拡張はコマンド "OmniChat: Pair with Server" か URI ハンドラでコードを受け、token を **SecretStorage**(`omnichat.deviceToken`)、serverUrl/name を設定に保存。ログ・Output に token を出さない。解除 = アプリのデバイス一覧で失効 → 4001 で切断され、拡張は再ペアリングを促す。
- 自動プロバイダー作成: アプリが `GET /bridges` で `kind:"vscode"` の bridge を見つけ、同名 `baseUrl` の `vscode-bridge` プロバイダーが無ければ作る(カードのスイッチ "Add provider automatically")。
- インストール: `code --install-extension omnichat-vscode-<ver>.vsix` をカードに表示(コピー可)。

## 7. サーバー変更(アプリ側セッション向け、番号 = 1 PR ≒ 1 テスト)

| # | 内容 | テスト |
|---|---|---|
| S1 | provider kind `vscode-bridge`(作成/更新の検証、`isAgentBridgeKind()` で chat.ts の `dsh-bridge` 分岐=ephemeral/線形/再生成/添付/`cwd`/`mode:'code'` 既定を共通化) | providers + 既存 dsh テストが通る、vscode で ephemeral 拒否 |
| S2 | `/bridge` の `kind` `instance` クエリ、`ready` の解析(version/protocol/platform/capabilities.tools/trusted)、`welcome` 送信、`(user,name,instance)` キー、同一 instance の置換 | fake ws で ready→welcome、2 instance 共存、dsh 不変 |
| S3 | `GET /bridges` に `kind` `version` `protocol` `tools` `trusted` `busy` `compat:{ok,minVersion}`、同名 instance の合算 | listBridges 単体 |
| S4 | ツール転送 `server/src/vscode-bridge.ts`: `openRun / callTool / closeRun / cancel`、cwd で instance 選択、busy、call ごとのタイムアウト、切断で全 call 失敗 | fake ext で往復・timeout・disconnect・cancel |
| S5 | エージェントループ `server/src/code-agent.ts`: §3 のツール定義、Code 用システムプロンプト、**ラウンド上限を Code では `OMNICHAT_CODE_MAX_ROUNDS`(既定 50、最大 200)+ 30 分**、`openai-compatible` 限定を外し「ツール呼び出し対応のプロバイダーアダプタ」全般、`modelRef` 解決、古い tool_result の省略(文脈の 70% 超で)、`toolCalls`/phases 保存。Chat の 6 ラウンドは変更しない | モックプロバイダーで多ラウンド・上限・中止 |
| S6 | `conversations.approval_mode`(migration、`toConversation`、sync/upsert)、`PUT /conversations/:id {approvalMode, confirmFull}`、起動時 + 最後のクライアント切断 60 s 後の `manual` 戻し | PUT 検証、`confirm_required`、リセット |
| S7 | `vscode-policy.ts`: ツール区分、`matchProtected`、許可リスト、評価順(§4.2)。`approvals.ts` に `decideToolCall()` を追加し `requestBridgeApproval` の前段で呼ぶ(既存関数は互換のまま) | `protected-cases.json` 全件、モード表のマトリクス、順序(deny>protected>allow>mode) |
| S8 | 承認の配線: `tool_call.approval` の付与、拡張発 `approval` → 既存 `handleV4Frame`、保護項目は「常に」不可、`decidedBy` を記録、`approval_pending/decision/settled`(P3) | 保護項目は full でも `tool_approval` が出る |
| S9 | checkpoint/changes/rewind を vscode run に適用(`run` に `checkpoint:true`、`rewind` を cwd の instance へ、保存テーブルは既存) | 既存 v4 テストに vscode 版を追加 |
| S10 | `POST /bridges/token` が `kind:"vscode"` を受理(デバイス名)。レート制限は同じ | token 作成テスト |
| S11 | 互換: `VSCODE_EXT_MIN_VERSION` 定数、`welcome`、古い拡張の run 拒否メッセージ | 0.0.9 を拒否 |
| S12 | `transcript` / `prompt` フレーム(P3、任意) | — |
| S13 | `.vsix` の配布メタ(`/updates` かリリース情報に `vsix` 名)、`docs/VSCODE.md`、`docs/API.md`・`docs/RELEASING.md` の追記と互換表 | — |

## 8. アプリ変更

| # | 内容 | テスト |
|---|---|---|
| A1 | `protocol.ts`: `Bridge.kind/version/compat/tools`、`Conversation.approvalMode`、provider kind | tsc |
| A2 | 承認モード切替 UI(Code 会話ヘッダー: 手動 / 自動 / フルアクセスの 3 段、現在値は常にサーバーの値)。`ChatScreen.tsx` の `chat.approvalModeNote` スタブ撤去、`approval_mode:ask|rules` は `manual|auto` の別名、`approval_mode:full` はダイアログ経由 | 純関数 `approvalModeActions` のテスト |
| A3 | フルアクセスの警告ダイアログ(何が自動になるか / 保護項目は引き続き確認 / アプリ再起動で manual に戻る / チェックポイントは作られる、チェック必須の確認ボタン)、`confirmFull:true` を送る。i18n ja/en | ダイアログ状態の純関数 |
| A4 | 承認カード: 保護バッジ + 理由、保護項目では「常に許可」を非表示、`decidedBy` 表示 | 表示条件の純関数 |
| A5 | Settings に **VS Code** カード(`components/VscodeIntegration.tsx`): ペアリングコード生成(`POST /bridges/token`)・コピー・`vscode://` リンク、接続状態(`GET /bridges` の `kind:"vscode"`、version/compat 警告)、プロバイダー自動作成スイッチ、`code --install-extension …` のコピー、.vsix ダウンロード | コード生成/プロバイダー作成の純関数 |
| A6 | Code タブ: vscode bridge をデバイスに表示(アイコン/バッジ)、ワークスペースピッカーは `workspaces` から、オフライン/`workspace_not_open` のメッセージ | `codeGroups` 既存テストに追加 |
| A7 | `.vsix` 名のヘルパー(`dshTgzName` と同形)と `updateTypes` | 名前解析テスト |
| A8 | `themes/*.ts` が純データであることのテスト(`import type` 以外の import・関数を持たない)。`gen-tokens` の前提 | テスト |

## 9. 拡張のモジュール構成(`vscode-ext/`、各ファイル ≤ 300 行)

```
package.json  tsconfig.json  esbuild.mjs  vitest.config.ts  .vscodeignore  README.md  CHANGELOG.md  LICENSE  THIRD_PARTY_NOTICES.txt  media/icon.png
scripts/gen-tokens.mjs  scripts/lib/tokens-core.mjs  scripts/check-contrast.mjs  scripts/package.mjs
src/extension.ts            activate/deactivate、配線のみ
src/config.ts               設定の読み出し・既定値
src/secrets.ts              SecretStorage ラッパ
src/pairing.ts              parsePairing(純) + コマンド + UriHandler
src/protocol/frames.ts      フレームの型
src/protocol/codec.ts       encode/decode/検証(純)、サイズ上限
src/protocol/version.ts     semver 比較(純)
src/conn/client.ts          WS 接続、再接続、ping、ready/welcome
src/conn/runs.ts            run 状態機械(1 run、直列化、cancel、timeout)
src/host/types.ts           HostApi(fs/edit/diagnostics/folders/trust)
src/host/vscode.ts          VS Code 実装   |  src/host/node.ts  Node 実装(テスト用)
src/tools/index.ts          レジストリ・ディスパッチ・引数検証
src/tools/schemas.ts        JSON Schema と型     src/tools/limits.ts  定数・truncate(純)
src/tools/files.ts          read_file list_dir glob    src/tools/grep.ts  grep
src/tools/edit.ts           write_file edit_file       src/tools/exec.ts  run_command
src/tools/diag.ts           get_diagnostics            src/tools/git.ts   git_*
src/guard/paths.ts          roots/symlink/正規化(realpath 注入、純)
src/guard/shell.ts          コマンドのトークン化・分割(純)
src/guard/protected.ts      matchProtected(純、サーバーと同一ケース表)
src/git/checkpoint.ts       ../../bridge/src/gitops の薄いラッパ(checkpoint/changes/rewind)
src/ui/status.ts  src/ui/panels.ts(chat/approval の host)  src/ui/html.ts(CSP/nonce、純)  src/ui/theme.ts(設定→CSS)
webview/chat.ts  webview/approval.ts  webview/base.css  webview/theme-runtime.ts
test/*.test.ts  test/fake-server.ts  test/fixtures/protected-cases.json
```

## 10. テスト戦略

- **vitest、`vscode` モジュール不要の純ロジック**: frame codec(往復・未知フィールド・サイズ超過)、version 比較、`guard/paths`(`..`、symlink 注入、Windows/UNC、大文字小文字)、`guard/shell`、`guard/protected`(`protected-cases.json`)、`tools/limits`(truncate)、`gen-tokens`(`tokens-core`: 全テーマ×モードのキー、非データ値で失敗)、`check-contrast`(AA)、CSS に `backdrop-filter` が無いこと、`ui/html`(CSP/nonce)、`parsePairing`。
- **ツールの結合テスト**: `NodeHost` + 一時ディレクトリ(git init 付き)で全 12 ツールの正常/エラー(`not_unique`、`too_large`、timeout kill、cancel)。
- **fake server**(`test/fake-server.ts`、`ws`): welcome → run → tool_call 列を台本で流し、`checkpoint → run_ack → tool_result → changes → done` の順序、busy、切断、cancel、`approval` エスカレーション、互換 NG を検査。
- **サーバー/アプリ**側は §7/§8 の「テスト」列。保護ケース表は両側で共有。VS Code 実機(`@vscode/test-electron`)のスモークは手動/任意。
- 完了条件の既定: `tsc --noEmit` と指定 vitest が通る。

## 11. セキュリティ・確認したい点

- 保護リストと許可リストは安全網で、OS のサンドボックスではない。信頼できないリポジトリでは Workspace Trust を使う(未信頼 = 読み取りのみ)。
- 拡張が外へ送るのは `tool_result` の内容だけ(ファイル全体の無差別送信はしない)。token は SecretStorage、ログ/テレメトリなし。
- **要確認(提案として入れた拡張)**: (a) 秘密ファイルの**読み取り**も保護(内容が外部モデルへ渡るため)、(b) C-path / C-sys の追加、(c) 起動時 + 切断 60 s での manual 戻し、(d) 1 端末複数 instance の合算。
