# ダウンロード

OmniChat の配布物は GitHub の Releases にあります。ここでは「どれを入れるか」「入れ方」「ファイルの確認方法」をまとめます。

最新版: **[Releases の最新リリース](https://github.com/remuno3751/omnichat/releases/latest)** ・ [すべてのリリース](https://github.com/remuno3751/omnichat/releases)

> ファイル名には版(例 `1.2.3`)やタグ(例 `v1.2.3`)が入るため、ボタンは固定のファイルではなく最新リリースのページへ移動します。ページの「Assets」から下の表のファイルを選んでください。

> **v0.5.0 で配布しているもの**: Windows(クライアントの `.exe` / `.msi`、サーバーアプリ、サーバーのバンドル zip)、macOS(クライアントの `.dmg`)、Android(APK)、DSH プラグイン(`omnichat-dsh-bridge-<版>.tgz`)。Linux 向けのファイル、macOS / Linux のサーバー(tar.gz)、Windows サービス版(`OmniChat-Server-Setup`)は、この版では配布していません。その環境では、[INSTALL.md](INSTALL.md) の手順(ソースから)を使ってください。Docker イメージは近日公開予定です。下の表の「未配布」の行も同じです。

> **免責**: OmniChat は無保証(AS IS)で提供します。利用によって生じた損害や不利益について、作者は責任を負いません。詳しくは [README の免責事項](../README.ja.md#免責事項)を見てください。

## ダウンロードボタン

### OmniChat アプリ(クライアント)

[![Windows 版クライアントをダウンロード](https://img.shields.io/badge/Windows-.exe_%2F_.msi-0078D6?style=for-the-badge)](https://github.com/remuno3751/omnichat/releases/latest) [![macOS 版クライアントをダウンロード](https://img.shields.io/badge/macOS-.dmg-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest) [![Linux 版クライアントをダウンロード](https://img.shields.io/badge/Linux-.AppImage_%2F_.deb-FCC624?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest) [![Android 版(APK)をダウンロード](https://img.shields.io/badge/Android-.apk-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest) [![Web 版の使い方](https://img.shields.io/badge/Web-browser-555555?style=for-the-badge&logo=googlechrome&logoColor=white)](#web-版)

文字リンク: [Windows](https://github.com/remuno3751/omnichat/releases/latest) / [macOS](https://github.com/remuno3751/omnichat/releases/latest) / [Linux](https://github.com/remuno3751/omnichat/releases/latest) / [Android](https://github.com/remuno3751/omnichat/releases/latest) / [Web 版](#web-版)

| 端末 | Assets のファイル名 | メモ |
|---|---|---|
| Windows | `OmniChat-Desktop-<タグ>-Windows-x64-Setup.exe`(推奨)/ `OmniChat-Desktop-<タグ>-Windows-x64.msi` | `.exe` は個人用インストール、`.msi` は管理者向け |
| macOS | `OmniChat-Desktop-<タグ>-macOS-universal.dmg` | Apple Silicon / Intel 共通 |
| Linux | `OmniChat-Desktop-<タグ>-Linux-x64.AppImage` / `.deb` | **v0.5.0 では未配布**(Web 版を使うか、ソースからビルド) |
| Android | `OmniChat-<版>.apk` | 提供元不明アプリの許可が必要 |

### OmniChat Server(サーバー)

[![Windows 版サーバーをダウンロード](https://img.shields.io/badge/Windows-Setup.exe-0078D6?style=for-the-badge)](https://github.com/remuno3751/omnichat/releases/latest) [![macOS 版サーバーをダウンロード](https://img.shields.io/badge/macOS-tar.gz-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest) [![Linux 版サーバーをダウンロード](https://img.shields.io/badge/Linux-tar.gz-FCC624?style=for-the-badge&logo=linux&logoColor=white)](https://github.com/remuno3751/omnichat/releases/latest) ![Docker は近日公開予定](https://img.shields.io/badge/Docker-%E8%BF%91%E6%97%A5%E5%85%AC%E9%96%8B%E4%BA%88%E5%AE%9A-lightgrey?style=for-the-badge&logo=docker&logoColor=white)

文字リンク: [Windows](https://github.com/remuno3751/omnichat/releases/latest) / [macOS](https://github.com/remuno3751/omnichat/releases/latest) / [Linux](https://github.com/remuno3751/omnichat/releases/latest) / Docker(近日公開予定)

| 方式 | Assets のファイル名 / 入手先 | メモ |
|---|---|---|
| Windows(Node.js 不要、サービス常駐) | `OmniChat-Server-Setup-<版>.exe` | **v0.5.0 では未配布**(代わりにサーバーアプリを使う) |
| Windows / Linux のサーバーアプリ(GUI) | `OmniChat-Server-App-<タグ>-Windows-x64-Setup.exe` / `OmniChat-Server-App-<タグ>-Linux-x64.AppImage`・`.deb` | 詳細は [SERVER-APP.md](SERVER-APP.md) |
| macOS | `omnichat-server-<版>-macos-arm64.tar.gz`(Apple Silicon)/ `omnichat-server-<版>-macos-x64.tar.gz`(Intel) | **v0.5.0 では未配布** |
| Linux | `omnichat-server-<版>-linux-x64.tar.gz` / `omnichat-server-<版>-linux-arm64.tar.gz` | **v0.5.0 では未配布**(Docker を使う) |
| Docker | イメージ `ghcr.io/remuno3751/omnichat` | **近日公開予定**(公開までは、[INSTALL.md](INSTALL.md) の手順を使ってください) |
| 自動更新用 | `omnichat-server-bundle-<版>.zip` | 手動で入れる必要はありません([UPDATES.md](UPDATES.md)) |

チェックサム: サーバー関連は `SHA256SUMS`、デスクトップは `SHA256SUMS-desktop.txt`、サーバーアプリは `SHA256SUMS-server-app.txt`、APK は `OmniChat-<版>.apk.sha256`。

## どれを入れればいい?

| やりたいこと | 入れるもの |
|---|---|
| すでにあるサーバーに、スマホや PC からチャットしたいだけ | **クライアント**(Android は APK、PC はデスクトップ版、またはブラウザで Web 版) |
| 自分でサーバーを立てたい(自宅 PC) | **サーバー**(Windows / macOS / Linux)を入れ、クライアントを各端末に入れる |
| NAS・VPS・常時稼働の機器で動かしたい | **Docker**(`docker compose up -d`) |
| サーバーを GUI で管理したい(Windows / Linux) | **サーバーアプリ**([SERVER-APP.md](SERVER-APP.md)) |

はじめて使う場合の流れは [QUICKSTART.md](QUICKSTART.md) を参照してください。

## OS ごとのインストール手順

インストーラーやアプリは **署名・公証していません**。そのため初回に OS が警告を出しますが、故障ではありません。入手元が自分のリポジトリの Releases であることを確認してから進めてください。

### Windows

1. `...-Setup.exe`(サーバーは `OmniChat-Server-Setup-<版>.exe`)をダウンロードして実行します。
2. SmartScreen の「WindowsによってPCが保護されました」が出たら **「詳細情報」(さらに表示) → 「実行」** を選びます。
3. 画面の案内に従って完了です。サーバー版は Windows サービス `OmniChat` として自動起動します。

### macOS

1. クライアントは `.dmg` を開き、アプリを Applications へドラッグします。サーバーは tar.gz を展開して `./install.sh` を実行します。
2. 初回は Gatekeeper にブロックされます。アプリを **右クリック → 開く** を選び、もう一度「開く」を押します。
3. 「壊れているため開けません」と出るときは、ターミナルで次を実行します。
   ```bash
   xattr -dr com.apple.quarantine /Applications/OmniChat.app
   ```
   サーバーは `xattr -dr com.apple.quarantine <展開したフォルダ>` です。

### Linux

1. AppImage は実行権限を付けて起動します。
   ```bash
   chmod +x OmniChat-Desktop-*-Linux-x64.AppImage
   ./OmniChat-Desktop-*-Linux-x64.AppImage
   ```
2. deb は `sudo apt install ./OmniChat-Desktop-*-Linux-x64.deb` で入ります。
3. サーバーの tar.gz は展開して `sudo ./install.sh`(systemd サービスとして登録)を実行します。

### Android

1. 端末のブラウザで Releases から `OmniChat-<版>.apk` をダウンロードします。
2. 開くと許可を求められるので、ダウンロードに使ったアプリ(ブラウザなど)に **「提供元不明のアプリ」のインストール** を許可します。
3. インストール後、ログイン画面でサーバー URL を入力します。許可はインストール後に戻して構いません。

### Docker

> **近日公開予定です。** イメージ(`ghcr.io/remuno3751/omnichat`)は、まだ公開していません。次の手順は、公開後のものです。

```bash
docker pull ghcr.io/remuno3751/omnichat:latest
docker compose up -d
```

compose ファイルの例、データ(`/data`)の扱い、初回の管理者作成は [INSTALL.md](INSTALL.md) と [QUICKSTART.md](QUICKSTART.md) を参照してください。

### Web 版

サーバーが動いていれば、ブラウザで `http://<サーバー>:8787/` を開くだけで使えます。ダウンロードは不要です。

## チェックサムの確認

ダウンロードしたファイルが壊れていないか、リリースの `SHA256SUMS*`(または各ファイルの `.sha256`)の値と比べます。

```powershell
# Windows
certutil -hashfile OmniChat-Server-Setup-1.2.3.exe SHA256
```

```bash
# macOS
shasum -a 256 omnichat-server-1.2.3-macos-arm64.tar.gz
# Linux
sha256sum omnichat-server-1.2.3-linux-x64.tar.gz
```

出力された値が一致すれば問題ありません。Linux では `sha256sum -c --ignore-missing SHA256SUMS` で、ダウンロードしたファイルだけをまとめて確認できます。

## 自動更新

サーバーは新しい版を検知して更新できます。仕組みと設定は [UPDATES.md](UPDATES.md) を参照してください。更新に使うのは `omnichat-server-bundle-<版>.zip` と `SHA256SUMS` で、ファイル名は変えないでください。

## リポジトリが private の間

リポジトリが private の間は、Releases のダウンロードにも GitHub へのログインと、このリポジトリへのアクセス権が必要です。権限のないアカウントやログアウト状態では 404 になります。Docker イメージ(ghcr.io)も同様に `docker login ghcr.io` が必要です。public になれば誰でもダウンロードできます。

## 関連ドキュメント

- [QUICKSTART.md](QUICKSTART.md): はじめての手順
- [CLIENTS.md](CLIENTS.md): クライアント(スマホ・デスクトップ)の詳細
- [SERVER-APP.md](SERVER-APP.md): サーバーアプリ
- [INSTALL.md](INSTALL.md): サーバーのインストール詳細
- [UPDATES.md](UPDATES.md): 自動更新
- [RELEASING.md](RELEASING.md): リリース作業(開発者向け)
