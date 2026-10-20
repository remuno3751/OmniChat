#!/usr/bin/env node
// Prints the per-OS download table (Markdown) for a release tag: node packaging/make-release-notes.mjs v1.2.3
// The file names are the ones the workflows publish (see docs/RELEASING.md 1A); each workflow attaches its own files,
// so a link may appear a few minutes before the file does (a missing file means that build is still running or failed).

const tag = process.argv[2] || "";
if (!/^v\d/.test(tag)) {
  console.error("usage: make-release-notes.mjs <tag, e.g. v1.2.3>");
  process.exit(2);
}
const ver = tag.slice(1);
const repo = process.env.GITHUB_REPOSITORY || "remuno3751/omnichat";
const dl = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
const link = (label, name) => `[${label}](${dl(name)})`;
const label = tag.length > 24 ? tag.slice(0, 24) : tag; // server-app.yml shortens the label the same way

const lines = [];
const add = (s = "") => lines.push(s);

add("## ダウンロード / Downloads");
add();
add("自分の OS の行から、**1 つだけ**選んでください。どれを入れるか迷ったら、下の「どれを入れる?」を見てください。");
add();
add("### OmniChat アプリ(クライアント: スマホ・PC から自分のサーバーに接続)");
add();
add("| OS | ダウンロード | 備考 |");
add("|---|---|---|");
add(`| Windows | ${link("インストーラー (.exe)", `OmniChat-Desktop-${label}-Windows-x64-Setup.exe`)} / ${link(".msi", `OmniChat-Desktop-${label}-Windows-x64.msi`)} | 通常は .exe。.msi は企業配布向け |`);
add(`| macOS | ${link("dmg (Intel / Apple Silicon 両対応)", `OmniChat-Desktop-${label}-macOS-universal.dmg`)} | 署名なし。初回は右クリック > 開く |`);
add(`| Linux | ${link("AppImage", `OmniChat-Desktop-${label}-Linux-x64.AppImage`)} / ${link(".deb", `OmniChat-Desktop-${label}-Linux-x64.deb`)} | AppImage は \`chmod +x\` して実行 |`);
add(`| Android | ${link("APK", `OmniChat-${ver}.apk`)} | 「提供元不明のアプリ」を許可して入れる |`);
add("| iPhone / ブラウザ | サーバーの URL をブラウザで開く(ホーム画面に追加) | アプリは不要 |");
add();
add("### OmniChat Server(サーバー: 会話を保存して各端末をつなぐ本体)");
add();
add("| OS | ダウンロード | 備考 |");
add("|---|---|---|");
add(`| Windows | ${link("OmniChat Server アプリ (.exe)", `OmniChat-Server-App-${label}-Windows-x64-Setup.exe`)} | 画面で管理できる。**初めての人はこちら** |`);
add(`| Windows(サービス版) | ${link("Setup (.exe)", `OmniChat-Server-Setup-${ver}.exe`)} | Windows サービスとして常駐させたい人向け |`);
add(`| Linux | ${link("サーバーアプリ AppImage", `OmniChat-Server-App-${label}-Linux-x64.AppImage`)} / ${link(".deb", `OmniChat-Server-App-${label}-Linux-x64.deb`)} | デスクトップ環境があるとき |`);
add(`| Linux(サーバー専用) | ${link("x64", `omnichat-server-${ver}-linux-x64.tar.gz`)} / ${link("arm64", `omnichat-server-${ver}-linux-arm64.tar.gz`)} | 展開して \`install.sh\`。systemd に登録 |`);
add(`| macOS | ${link("Apple Silicon (M1〜)", `omnichat-server-${ver}-macos-arm64.tar.gz`)} / ${link("Intel", `omnichat-server-${ver}-macos-x64.tar.gz`)} | 展開して \`install.sh\`(launchd)。インストーラー(GUI)ではありません |`);
add("| Docker | `docker pull ghcr.io/" + repo + ":" + ver + "` | NAS / VPS 向け |");
add();
add("### どれを入れる?");
add();
add("- **スマホやPCでチャットしたいだけ** → 「OmniChat アプリ」の自分の OS(またはブラウザ)。サーバーは別の PC / NAS に必要です。");
add("- **自分の PC でサーバーを動かしたい** → 「OmniChat Server」。Windows は **サーバーアプリ**が簡単です。");
add("- **NAS / VPS / 常時起動のマシン** → Docker または Linux のサーバー専用 tar.gz。");
add();
add("### 注意");
add();
add("- インストーラーは署名していないため、初回に OS の警告が出ます(Windows: 「詳細情報」>「実行」/ macOS: 右クリック > 開く、`xattr -dr com.apple.quarantine <アプリ>`)。");
add("- 自動更新用のファイル(`omnichat-server-bundle-*.zip`、`omnichat-dsh-bridge-*.tgz`、`SHA256SUMS*`)は更新機能が使います。通常は手で入れる必要はありません。");
add("- チェックサムの確認: `SHA256SUMS`(サーバー関連)/ `SHA256SUMS-desktop.txt` / `SHA256SUMS-server-app.txt` / `*.sha256`。");
add("- 詳しい手順: [docs/DOWNLOAD.md](https://github.com/" + repo + "/blob/" + tag + "/docs/DOWNLOAD.md)");
add();

process.stdout.write(lines.join("\n") + "\n");
