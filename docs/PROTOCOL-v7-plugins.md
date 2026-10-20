# プロトコル v7: プラグインの導入(GitHub / ZIP / 手元のフォルダ)

設計: [design/PLUGIN-INSTALL.md](design/PLUGIN-INSTALL.md)。決定事項(2026-10-19): 導入は**管理者のみ**、取得元は **GitHub のみ**(ZIP のアップロードは段階 1 に含めない)、警告つきで導入可(段階 1 = 警告のみ、サンドボックスなし)、確認は**プラグインの id の入力**、**依存パッケージを持つプラグインは断る**。

## 動作の変更(サーバー)
- 表 `plugin_installs` に行がある(= この仕組みで入れた)プラグインは、`enabled = 0` の間は**モジュールを import しない**(コードを一切実行しない)。`/tools` には `available:false, error:"disabled by the administrator"` の 1 件として出す。
- 表に行がない(手で置いたフォルダ)プラグインは、従来どおり(読み込まれ、使える)。
- 有効 / 無効の単位は**プラグイン**(ツールごとではない。ツールごとの有効化は、従来どおり設定の `tools` で行う)。
- 変更(導入・有効化・無効化・更新・削除)は、プラグインを再読込し、監査ログ(`recordAudit(actorOf(userId), "plugin.<action>", pluginId, ...)`)に残す。

## 表
```
plugin_installs (
  id TEXT PRIMARY KEY,            -- plugin.json の id(= フォルダ名)
  source TEXT NOT NULL,           -- 'github'
  repo TEXT,                      -- 'owner/name'
  ref TEXT,                       -- 入力された ref(タグ / ブランチ / SHA)。なければ NULL(既定ブランチ)
  subdir TEXT,                    -- リポジトリ内のサブフォルダ(なければ '')
  commit_sha TEXT,                -- 取得したコミット(40 桁)
  version TEXT,                   -- plugin.json の version
  files_sha256 TEXT NOT NULL,     -- JSON {"相対パス":"sha256hex"}
  scan_json TEXT NOT NULL,        -- 導入時の静的スキャン結果(JSON)
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0
)
```

## API(すべて管理者のみ。`Authorization: Bearer`。メンテナンスモード中も可)
エラーの形: `{ error: string, code: string }`。

### `POST /admin/plugins/inspect`
本文: `{ source: "github", repo: string, ref?: string, subdir?: string }`。`repo` は `owner/name` または `https://github.com/owner/name`(末尾の `.git`、`/` は許す。ほかのホストは `400 bad_source`)。
サーバーが GitHub から zip を取得して**メモリ上で**検査する(ディスクには置かない)。応答:
```
{ inspectionId: string,               // 15 分で失効。1 回の導入にだけ使える
  source: {repo, ref, subdir, commitSha},
  manifest: {id,name,version,description,main,tools:[{name,description,permissions}]},
  alreadyInstalled: boolean, installedCommitSha?: string,
  files: [{path,size,sha256}], totalBytes: number,
  scan: { findings: [{ rule, severity: "high"|"medium"|"info", file, line, snippet }], permissionMismatch: [{tool, used: [...], declared: [...]}] },
  warnings: string[] }                // 人が読む文(ja)。導入を妨げない注意
```
断る(導入できない)場合は、`4xx` とコード:
`bad_source`、`github_not_found`(404)、`github_rate_limited`(429)、`download_failed`(502)、`too_large`(413: zip 5MB / 展開後 2MB / ファイル 200 個まで)、`bad_archive`(パスに `..`・絶対パス・シンボリックリンク)、`bad_manifest`(`plugin.json` が無い・不正。理由を `error` に)、`has_dependencies`(`package.json` に `dependencies` / `optionalDependencies` / `peerDependencies` がある、または `main` が `node_modules` を指す)、`id_conflict`(同じ `id` のフォルダが、この仕組みの外(手で置いた)に既にある)、`tool_conflict`(組み込み・別のプラグインとツール名が重複)。
取得は `https://api.github.com/repos/<repo>/zipball/<ref>`(ref なしは既定ブランチ)。コミット SHA は、取得後に `GET /repos/<repo>/commits/<ref|HEAD>` で確定する。環境変数 `OMNICHAT_GITHUB_API`(既定 `https://api.github.com`)で、テストが偽の GitHub に差し替えられる。`GITHUB_TOKEN` は使わない。

### `POST /admin/plugins/install`
本文: `{ inspectionId, confirmId }`。`confirmId` が検査した `manifest.id` と**完全に一致**しなければ `400 confirm_mismatch`。失効・使用済みは `410 inspection_expired`。成功: ファイルを `$PLUGINS_DIR/<id>/` に書き(既にこの仕組みで入れた同じ id がある場合は置き換え = 更新。事前に検査時のハッシュと照合)、`plugin_installs` に **enabled = 0** で記録(更新のときは `enabled` を保つ)、再読込して `{ plugin: PluginRow }`。

### 一覧・操作
- `GET /admin/plugins` → `{ plugins: PluginRow[] }`。`PluginRow = { id, name, version, description, source: "github"|"local", repo?, ref?, commitSha?, enabled, installedAt?, updatedAt?, tools: [{name, permissions, available, error?}], scan?: {high:number, medium:number, info:number}, modified?: boolean }`。`source:"local"` は、表に行がない(手で置いた)もの(`enabled` は常に true、操作は削除不可・無効化不可)。`modified: true` は、ディスク上のファイルのハッシュが、導入時の `files_sha256` と違う(導入後に書き換わった)とき。
- `PATCH /admin/plugins/:id` 本文 `{ enabled: boolean }` → `{ plugin }`。表に行がないものは `409 not_managed`。
- `DELETE /admin/plugins/:id` → `{ ok: true }`。この仕組みで入れたものだけ(`409 not_managed`)。フォルダを消し、行を消し、再読込。そのプラグインのツールの「常に許可」の記録(`tool_grants`)も消す。
- `POST /admin/plugins/:id/check-update` → `{ updateAvailable: boolean, latestCommitSha: string, inspectionId?: string, ...inspect の応答と同じ項目, diff?: { added: string[], removed: string[], changed: string[], toolsAdded: string[], toolsRemoved: string[], permissionsAdded: [{tool, permission}] } }`。`updateAvailable` が true のときだけ検査結果を付ける。導入は `POST /admin/plugins/install`(同じ `inspectionId` / `confirmId`)。**自動更新はしない。**

## 静的スキャンの規則(目安であり、安全の保証ではない)
`scan.findings[].rule`: `child_process`(high)、`fs_write`(high。`writeFile` / `appendFile` / `rm` / `unlink` / `rename` / `mkdir` など)、`env_access`(high。`process.env`)、`eval`(high。`eval(` / `new Function`)、`dynamic_import`(medium。`import(` に文字列リテラル以外)、`raw_network`(medium。`node:http(s)` / `net` / `dgram` / `tls` / `WebSocket` の import)、`fs_read`(info)、`obfuscation`(medium。1 行が 2000 文字を超える、`\x` が 20 回以上続く、`atob` + `eval`)、`undeclared_network`(high。`fetch(` / `ctx.fetch` を使うが `network` を宣言していないツール)。`permissionMismatch` は、コードが使っている種類が、その plugin のどのツールにも宣言されていないとき(`shell` ↔ `child_process`、`filesystem-write` ↔ `fs_write`、`filesystem-read` ↔ `fs_read`、`network` ↔ `raw_network` / `fetch`)。
