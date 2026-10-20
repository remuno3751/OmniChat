# 全 OS のビルド手順(リリース担当者向け)

リリースの成果物を、どの環境で、どのコマンドで作るかをまとめます。タグの付け方とワークフローの規約は [RELEASING.md](RELEASING.md) を参照してください。

以下の `<タグ>` は `v0.3.0-beta.1` のような形です。インストーラーの版は、タグから自動で決まります(`desktop/tools/set-version.mjs`)。

| タグ | Windows / macOS のインストーラーの版 | Android の versionName / versionCode |
|---|---|---|
| `v0.3.0-beta.1` | `0.3.0-1` | `0.3.0` / `300` |
| `v0.3.0-beta.2` | `0.3.0-2` | `0.3.0` / `300` |
| `v0.3.0` | `0.3.0` | `0.3.0` / `300` |
| `v0.3.1-beta.2` | `0.3.1-2` | `0.3.1` / `301`(beta.1 の 300 より大きいので、上書き更新できる) |
| `v0.4.0-beta.1` | `0.4.0-1` | `0.4.0` / `400`(ベータは Windows だけ作る。Android は作らない) |
| `v0.4.0` | `0.4.0` | `0.4.0` / `400` |

- **ビルドの範囲**: ベータ版(`-beta.N`)は **Windows だけ**作ります(`packaging/local/build-windows.sh <タグ>`)。**正式版(`-beta` なし)のときだけ、全プラットフォーム**(Windows + Android + Mac。Mac は、Mac 上で `packaging/local/build-mac.sh <タグ>` を実行する)を作ります。
- Android の `versionCode` は `(メジャー×10000 + マイナー×100 + パッチ) × 100 + ベータ番号` です(正式版は末尾が 99)。例: `v0.4.0-beta.4` = 40004、`v0.4.0` = 40099。同じ版のベータどうしも番号が増えるので、上書き更新できます。0.4.0 までの旧方式(例: v0.4.0 = 400)よりも新方式の方が大きいので、旧版の上にも更新できます。
- Windows のインストーラーは、数字つきのプレリリース(`-1`、`-2`)で上書き更新できます。`0.3.0-1` は、安定版 `0.3.0` より古い版として扱われます。

## 担当表

| 成果物 | どこで作るか | 方法 |
|---|---|---|
| Windows: サーバーアプリ(NSIS)、デスクトップ(NSIS / MSI)、サーバーの zip | Windows PC(Git Bash) | `packaging/local/build-windows.sh` |
| Android: APK | Windows PC(Git Bash) | `packaging/local/build-android.sh` |
| macOS: デスクトップ(DMG、universal) | Mac | `packaging/local/build-mac.sh` |
| Linux: デスクトップ(AppImage / deb)、サーバーアプリ | **GitHub Actions**(公開後) | `desktop.yml`、`server-app.yml` |
| サーバー: Linux / macOS の tar.gz、Windows のヘッドレス版 `.exe`、Docker イメージ、ブリッジの `.tgz`、更新用の zip と `SHA256SUMS` | **GitHub Actions**(公開後) | `release.yml` |

非公開のリポジトリでは Actions の無料枠をすぐに使い切るため、手元で作れるものは手元で作ります。**公開リポジトリの Actions は無料**なので、Linux と Docker は公開後に Actions で作ります。

## 準備(共通)

1. 作業ツリーをきれいにして、変更をコミットします。ビルドスクリプトは、終了時に版の書き換えを `git checkout` で戻すため、コミットしていない `tauri.conf.json` や `Cargo.*` の編集は消えます。
2. 新しい clone では、先に秘密情報の誤コミットを防ぐフックを入れます。
   ```bash
   sh packaging/local/git-hooks/install.sh
   ```
3. テストを通します。
   ```bash
   (cd server && npx tsc --noEmit && npm test)
   (cd app && npx tsc --noEmit && node scripts/check-i18n.mjs && npm run lint:hooks)
   (cd server-app/src-tauri && cargo test)
   ```
4. アップロードには、GitHub のトークンが必要です。`git credential fill`(`git push` と同じ認証)から取得します。トークンを画面やログに出さないでください。`upload.mjs` は、リリースの下書きが無ければ作り、同じ名前のファイルは置き換えます。

## Windows(この PC)

```bash
bash packaging/local/build-windows.sh <タグ>              # ビルド + アップロード
bash packaging/local/build-windows.sh <タグ> --no-upload  # ビルドだけ(out-windows/)
```

- 必要なもの: Node 24、Rust(rustup)、Visual Studio Build Tools(C++)、WiX(デスクトップの MSI 用。NSIS は Tauri が取得)。
- 成果物(`out-windows/`):
  - `OmniChat-Server-App-<タグ>-Windows-x64-Setup.exe`(サーバーアプリ。MSI は日本語で WiX が失敗するため作らない)
  - `OmniChat-Desktop-<タグ>-Windows-x64-Setup.exe` と `.msi`
  - `omnichat-server-bundle-<版>.zip`
  - チェックサム
- インストーラーの見た目は `packaging/windows-installer/gen-installer-art.mjs` で作る画像と、`{server-app,desktop}/src-tauri/windows/installer.nsi`(Tauri の既定テンプレートの改変版)で決まります。Tauri を更新したら、テンプレートの差分を確認してください。

## Android(この PC)

```bash
bash packaging/local/build-android.sh <タグ>              # ビルド + アップロード
bash packaging/local/build-android.sh <タグ> --no-upload  # ビルドだけ(out-android/)
```

- 必要なもの: Node 24、Android Studio(同梱の JDK と SDK)。JDK 24 以降では CMake の段階が失敗するため、スクリプトが `--enable-native-access=ALL-UNNAMED` を付けます。
- **リリース用の署名**: 次の環境変数を設定すると、リリース用のキーストアで署名します(`app/android-signing.init.gradle`)。無いと、デバッグ署名になります。
  - `OMNICHAT_KEYSTORE_FILE`(キーストアのパス)、`OMNICHAT_KEYSTORE_PASSWORD`、`OMNICHAT_KEY_ALIAS`、`OMNICHAT_KEY_PASSWORD`
- **キーストアはリポジトリの外に保管します**(`.gitignore` と pre-commit フックで、コミットを防いでいます)。一度公開した署名は変えられません。変えると、更新インストールができなくなります。
- 成果物(`out-android/`): `OmniChat-<版>.apk`、版なしの `OmniChat.apk`、`SHA256SUMS-android.txt`。ABI は arm64-v8a と armeabi-v7a です。

## macOS(Mac)

Mac 上の Claude / 手作業で行います。手順はそのまま使える形で、`packaging/local/build-mac.sh` の先頭に書いてあります。

```bash
git fetch --tags origin && git checkout main && git pull origin main
sh packaging/local/git-hooks/install.sh
bash packaging/local/build-mac.sh <タグ>              # ビルド + アップロード
bash packaging/local/build-mac.sh <タグ> --no-upload  # DMG は out/
```

- 必要なもの: Node 24、Rust(rustup)、Xcode のコマンドラインツール。
- 署名と公証はしていません。初回の起動に Gatekeeper の手動許可が要ります(`xattr -dr com.apple.quarantine /Applications/OmniChat.app`)。
- 動作確認: 版番号、http:// のサーバーへの接続、アプリアイコンの切り替え、テーマの切り替え、旧版の上からの更新。

## Linux・サーバー・Docker(公開後に GitHub Actions)

リポジトリを公開したあとに、タグを push します。

```bash
git tag <タグ> && git push origin <タグ>
```

- `release.yml` が、サーバーの tar.gz(Linux / macOS)、Windows のヘッドレス版 `.exe`、Docker イメージ(`ghcr.io/<所有者>/omnichat`)、ブリッジの `.tgz`、更新用の zip と `SHA256SUMS` を、リリースの**下書き**に添付します。
- `desktop.yml` と `server-app.yml` は、タグを入力して手動実行します(Actions → 実行したいワークフロー → Run workflow → `tag` に `<タグ>`)。Linux の AppImage / deb が作られます。手元で作った Windows / macOS のファイルと同じ名前のものは、置き換えられます。
- 初回は、ワークフロー自体が未検証です([README の「状態と検証範囲」](../README.md#状態と検証範囲))。失敗したら、ログを見て直し、同じタグで再実行します([RELEASING.md の 2](RELEASING.md))。

## 公開までの順番(ベータ版の例)

アップロード先は、環境変数 `OMNICHAT_REPO`(既定は `remuno3751/omnichat`)で決まります。**今の非公開リポジトリの名前を `omnichat-dev` に変えるまでは、`remuno3751/omnichat` は古いほうを指します**。そのため、ビルドは `--no-upload` で行い、新しいリポジトリができてからまとめてアップロードします。

1. Windows と Android を `--no-upload` でビルドする(`out-windows/`、`out-android/`)。macOS の DMG は Mac で `--no-upload` で作ってもらい、`out/` を受け取る。
2. 公開用のファイル一式を作り、監査する(`bash packaging/public/make-public-tree.sh <出力先>`)。
3. 古い非公開リポジトリの名前を `omnichat-dev` に変え、新しい `omnichat` を **Private** で作る。1 コミットで push し(`docs/RELEASING.md` の 6-3 を参考)、タグを付ける。
4. 手元で作ったファイルを、新しいリポジトリの下書きリリースにアップロードする。
   ```bash
   node packaging/local/upload.mjs <タグ> out-windows/* out-android/* out/*
   ```
5. ブログ記事と X(Twitter)の準備ができたら、リポジトリを Public にして、Actions で Linux / サーバー / Docker を作る。
6. 下書きを確認して、プレリリースとして公開する。**ログインしていない状態で**、ダウンロードできることを確かめる。
