# リリース手順

> 全 OS のビルドの担当と手順(手元で作るもの / Actions で作るもの)は [BUILD-ALL.md](BUILD-ALL.md) にまとめています。

## 1. リリースを切る

1. `main` が CI(`.github/workflows/ci.yml`)で緑であることを確認します。
2. バージョンを決めます(例 `1.2.3`)。`server/package.json` の `version` を合わせます(ビルド時はタグ名の版が優先されて同梱 `package.json` / `VERSION` に入ります)。クライアント(`app/app.json`、`desktop/`)の版は各担当ワークフローのドキュメント([CLIENTS.md](CLIENTS.md))に従って揃えます。
3. コミットしてタグを push します。
   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```
   `-rc1` のようにハイフンを含むタグはプレリリース扱いになり、Docker の `latest` タグは更新されません。
4. `release.yml` が走り、次を作ります。

   | ジョブ | 成果物 |
   |---|---|
   | build | Web クライアント + サーバーを 1 回だけビルド(中間成果物) |
   | docker | `ghcr.io/remuno3751/omnichat:<版>`, `:<major>.<minor>`, `:latest`(amd64 + arm64) |
   | windows | `OmniChat-Server-Setup-<版>.exe`(Node 24 同梱、WinSW、Inno Setup) |
   | unix | `omnichat-server-<版>-{linux,macos}-{x64,arm64}.tar.gz`(Node 24 同梱) |
   | tools | `bridge/` と `dsh-plugin/` の `npm pack` で作る `.tgz` |
   | release | 上記 + `SHA256SUMS` を **ドラフト** の GitHub Release に添付 |

5. `desktop.yml` / `android.yml`(クライアント担当)も同じタグで動き、同じリリースにファイルを追加します。
6. すべて揃ったら Releases のドラフトを確認して **Publish** します。

### 複数ワークフローが同じリリースに添付する規約

- リリースは **タグ名 = リリース名の元** で 1 つだけ。`release.yml` が `softprops/action-gh-release` で **ドラフト**として作成/更新します。
- ほかのワークフロー(`desktop.yml`, `android.yml`)も、同じタグに対して同じアクション(`draft: true` を指定、`generate_release_notes` は付けない)でファイルを追加してください。このアクションは既存のドラフトがあれば追記し、無ければ作るので実行順序に依存しません。
- 既存ファイルと同名の成果物を作らない(ファイル名に OS/arch を含める)。
- `SHA256SUMS` は `release.yml` が作る分(サーバー関連)だけを対象にします。デスクトップ/Android 側は必要なら `SHA256SUMS-desktop` のように別名で添付してください。
- 公開(ドラフト解除)は人間が最後に 1 回だけ行います。

## 1A. 自動更新のための配布物

サーバーの自動更新(詳しくは [UPDATES.md](UPDATES.md))は、リリースの中の次のファイルを使います。ファイル名は変えないでください(更新の判定に使います)。

| ファイル名 | 作るワークフロー | チェックサム |
|---|---|---|
| `omnichat-server-bundle-<版>.zip` | `release.yml`(build。`packaging/make-bundle-zip.mjs`) | `SHA256SUMS`(`release.yml` の release ジョブ) |
| `OmniChat-Server-Setup-<版>.exe` | `release.yml`(windows) | `SHA256SUMS` |
| `omnichat-server-<版>-{linux,macos}-{x64,arm64}.tar.gz` | `release.yml`(unix) | `SHA256SUMS` |
| `omnichat-bridge-<版>.tgz` / `omnichat-dsh-bridge-<版>.tgz` | `release.yml`(tools。`npm pack`) | `SHA256SUMS` |
| `omnichat-vscode-<版>.vsix` | 手動(下記)または `packaging/build-release.mjs --vsix` | リリースに手で添付 |
| `OmniChat-Desktop-<タグ>-<プラットフォーム>.<拡張子>` | `desktop.yml` | `SHA256SUMS-desktop.txt` と各ファイルの `.sha256` |
| `OmniChat-Server-App-<タグ>-<プラットフォーム>.<拡張子>` | `server-app.yml` | `SHA256SUMS-server-app.txt` と各ファイルの `.sha256` |
| `OmniChat-<版>.apk` | `android.yml` | `OmniChat-<版>.apk.sha256` |

- サーバーの更新に必要なのは、`omnichat-server-bundle-<版>.zip` と、その行を含む `SHA256SUMS`(または `<zip名>.sha256`)です。どちらか片方があれば足ります。無ければ、その版は「チェックサムが無い」として更新を提示しません。
- `SHA256SUMS` の形式は `sha256sum` の出力(`<hex>  <ファイル名>`)です。`.sha256` は `<hex>  <ファイル名>` か `<hex>` の 1 行です。
- zip の中身: `dist/boot.js` と `bundle.json` が必須です(無いと `make-bundle-zip.mjs` が作るのを拒否します)。`runtime/`、`start.cmd`、`start.sh` は入りません。
- **DSH プラグインの版は、サーバーの版とは別に番号を付けます。** `dsh-plugin/package.json` の `version` を上げてから tag を打ってください。`@omnichat/dsh-bridge` は `npm pack` で `omnichat-dsh-bridge-<版>.tgz` になります(更新の判定はこのファイル名の形に合わせています)。版を上げなければ、DSH 側に新しい版として出ません。
- 同じタグで再ビルドしたら、ファイルは上書き(`--clobber`)されます。公開後にファイル名や中身を変えないでください。チェックサムが合わなくなります。

- **VS Code 拡張(`omnichat-vscode-<版>.vsix`)** は `vscode-ext/package.json` の `version` で別に番号を付けます。作り方: `cd vscode-ext && npm ci && npm run package`(`vscode-ext/` の直下に `.vsix` ができます)。それをリリースに添付してください(ファイル名は変えない)。`node packaging/build-release.mjs --vsix` なら、`vscode-ext/node_modules` があるときだけ作って出力フォルダに置きます(無ければ警告のみで、通常のビルドは失敗しません)。サーバーの版との対応は [VSCODE.md](VSCODE.md) の互換表を更新してください。

### プレリリース

- タグにハイフンを含めると(例: `v1.3.0-rc.1`)、リリースは **プレリリース** として作られます(`release.yml` と、ほかのワークフローが下書きを作るとき)。
- サーバーの「stable」チャンネルはプレリリースを無視します。「prerelease」チャンネルは、安定版より新しいプレリリースも対象にします。
- Docker イメージの `latest` は更新されません(既存の規則)。

### 公開前の確認

1. Releases の下書きに `omnichat-server-bundle-<版>.zip` と `SHA256SUMS` があり、`SHA256SUMS` にその zip の行がある。
2. ダウンロードした zip の SHA-256(`sha256sum`)が、`SHA256SUMS` の値と一致する。
3. zip の直下に `dist/boot.js` と `bundle.json` がある(`bundle.json` の `version` がタグと一致)。
4. 下書きは、公開するまで更新の判定に使われません。公開後、テスト用のサーバーで「確認」を押し、ポップアップが出ることを見る(チャンネルを `prerelease` にすると、プレリリースでも確認できます)。

ローカルで同じ zip を作るには次の 2 行です(タグ版と同じ手順です)。

```bash
node packaging/build-release.mjs --out .release/stage --version 1.2.3
node packaging/make-bundle-zip.mjs .release/stage/server out/omnichat-server-bundle-1.2.3.zip
```

## 2. 失敗したとき / やり直し

- 同じタグを再ビルド: Actions から `Release` を `workflow_dispatch`(tag を入力)で再実行できます。
- タグを打ち直す場合: `git push --delete origin v1.2.3` → ドラフトの Release を削除 → 再タグ。公開済みの Docker タグは上書きされるので注意。

## 3. GitHub リポジトリ設定チェックリスト

- [ ] Settings → Actions → General → Workflow permissions: **Read repository contents**(既定でよい)。各ジョブが必要な権限(`packages: write`, `contents: write`)を個別に宣言しています。
- [ ] ghcr への push は組み込みの `GITHUB_TOKEN` で行うため、シークレットの追加は不要です(`packages: write` はワークフロー側で付与済み)。
- [ ] 初回 push 後、Packages の `omnichat` を開き、**Package settings → Change visibility → Public**(家の PC から `docker login` なしで pull したい場合)。また Package settings で「Connect repository」と Actions のアクセスを確認します。
- [ ] Docker イメージ名は `ghcr.io/<リポジトリ所有者(小文字)>/omnichat`。所有者名を変えた場合は `docker-compose.yml` の既定値(`remuno3751`)も直します。
- [ ] Settings → Actions で "Allow actions" が GitHub 公式 + 使用中のサードパーティ(`softprops`, `docker`)を許可していること。
- [ ] ブランチ保護で CI の 4 ジョブ(server / bridge / dsh-plugin / app)を必須にする(任意)。
- [ ] Windows の SmartScreen / macOS の Gatekeeper 警告を避けるには別途コード署名・公証が必要です(現状は未署名。INSTALL.md に回避手順あり)。

## 4. 固定している外部入力

- Node.js: 公式 `latest-v24.x` の最新を取得し、`SHASUMS256.txt` で SHA-256 を検証。
- WinSW: v2.12.0(`release.yml` の `WINSW_URL`)。バージョンを上げるときは URL と `packaging/windows/omnichat-service.xml` のコメントを更新。
- GitHub Actions は `vX.Y.Z` で固定。より厳密にするなら commit SHA に置換してください(Dependabot の `github-actions` エコシステムが便利です)。

## 5. ライセンス

OmniChat は **AGPL-3.0-only** です(ルートの `LICENSE`、`NOTICE`、Copyright (C) 2026 remuno)。

- 配布物(tarball、Docker イメージ、インストーラー)には `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.txt` が入ります(`packaging/build-release.mjs` がコピーします)。
- 依存を追加・更新したら `THIRD_PARTY_NOTICES.txt` を作り直します(`cd server && npx license-checker-rseidelsohn --production --plainVertical` を server / app / bridge で実行して連結。冒頭の説明文は既存のものを残す)。デスクトップランチャーの Rust 依存は `cargo about` などで別途。
- GPL/AGPL と非互換のライセンスの依存(GPL-2.0-only、独自ライセンス、非商用限定など)は足さない。MIT / BSD / ISC / Apache-2.0 / MPL-2.0 は可。
- AGPL 第 13 条のため、サーバーは `GET /version` で `source`(ソースのURL)を返します。リポジトリのURLを変えたら `server/src/static.ts` も直してください。
- `app/LICENSE` は Expo テンプレートの MIT ライセンス文で、その部分のために残しています。
- 外部の貢献を受け入れる前に、貢献者ライセンス同意(CLA など)の方針を決めてください。
- iOS の App Store 配布は、GPL 系ライセンスとストア規約が衝突しうるため、出す前に確認が必要です。
