# OmniChat クライアント一覧(デスクトップ / Android / ブラウザ)

OmniChat の **サーバー** は自宅 PC などで動かし、手元の端末からは次のどれかで接続します。
どのクライアントも最初に「サーバー URL」(例: `http://192.168.1.10:8787` / `https://name.tailnet.ts.net`)を入力します。

| 端末 | 推奨クライアント | 入手先 |
| --- | --- | --- |
| Windows | デスクトップ版(`.exe` / `.msi`) | GitHub Release の `OmniChat-Desktop-<tag>-Windows-*` |
| macOS | デスクトップ版(`.dmg`、Apple Silicon / Intel 両対応) | `OmniChat-Desktop-<tag>-macOS-universal.dmg` |
| Linux | AppImage または `.deb` | `OmniChat-Desktop-<tag>-Linux-x64.*` |
| Android | APK(サイドロード) | `OmniChat-<version>.apk` |
| iPhone / iPad | Safari の「ホーム画面に追加」(PWA) | サーバーの URL を Safari で開く |
| その他すべて | ブラウザ(Chrome / Edge / Firefox / Safari) | サーバーの URL を開く |

サーバーが Web UI を配信している場合(`WEB_DIR`、`GET /version` の `webUi: true`)、ブラウザ版はサーバーの URL をそのまま開くだけです。

---

## 1. デスクトップ版(ランチャー方式)

デスクトップ版は **薄いランチャー** です。起動すると小さな入力画面が出て、サーバー URL を確認(`GET {url}/version` が `omnichat-server` を返すか)してから、同じウィンドウでサーバーの Web UI を開きます。
UI はつねにサーバーと同じバージョンになり、`tauri://` オリジンから http サーバーを呼ぶ際の CORS / 混在コンテンツ / WebSocket 問題も起きません。

- 入力した URL は記憶され、次回から自動で接続します(設定ファイル: アプリ設定ディレクトリの `server.json`)。
- メニュー **ファイル → サーバーを変更…**(`Ctrl/Cmd+Shift+S`、macOS は「OmniChat」メニュー内)で別のサーバーに切り替えられます。
- サーバーに約30秒以上つながらないと、「再試行 / サーバーを変更」ボタン付きの画面に切り替わります(復旧すると自動で再接続)。
- 編集メニュー(コピー / ペースト等)あり、ウィンドウ位置・サイズは記憶、二重起動は最初のウィンドウを前面に出します。
- 外部リンクは既定のブラウザで開きます。設定したサーバー以外のオリジンへはウィンドウ内で遷移しません。
- サーバーのページには Tauri の IPC 権限を与えていません(最小権限)。リリースビルドでは DevTools は無効です。

### インストール

- **Windows**: `*-Setup.exe`(ユーザー単位インストール)または `.msi`。未署名のため SmartScreen が「WindowsによってPCが保護されました」と出たら「詳細情報 → 実行」。
- **macOS**: `.dmg` を開いて Applications へドラッグ。**未署名/未公証** のビルドは初回に Gatekeeper にブロックされます。次のどちらかで開いてください。
  - Finder でアプリを **右クリック → 開く → 開く**
  - またはターミナルで `xattr -dr com.apple.quarantine /Applications/OmniChat.app`
  - 「壊れているため開けません」と出る場合も上の `xattr` で解決します。
- **Linux**: AppImage は `chmod +x OmniChat-*.AppImage && ./OmniChat-*.AppImage`。`.deb` は `sudo apt install ./OmniChat-*.deb`(WebKitGTK 4.1 が必要。Ubuntu 22.04+ / Debian 12+)。

### アプリ ID・署名(オーナー向け)

- アプリ ID は暫定の **`dev.omnichat.app`** です(`desktop/src-tauri/tauri.conf.json` の `identifier`、`app/app.json` の `android.package` / `ios.bundleIdentifier`)。自分のドメインに変える場合はこの 3 箇所を揃えて変更してください(後から変えると Android は別アプリ扱いになります)。
- アイコンはプレースホルダです。`node desktop/tools/gen-icons.mjs` で再生成するか、1024px の PNG を `desktop/src-tauri/app-icon.png` に置いて `cd desktop && npx tauri icon src-tauri/app-icon.png` を実行します。
- macOS の署名と公証(任意): Apple Developer Program(年 99 USD)に加入し、GitHub のリポジトリ Secrets に次を登録すると `desktop.yml` が自動で署名・公証します。未登録なら未署名ビルドになります。
  `APPLE_CERTIFICATE`(Developer ID Application 証明書の .p12 を base64)、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`(例 `Developer ID Application: 名前 (TEAMID)`)、`APPLE_ID`、`APPLE_PASSWORD`(App 用パスワード)、`APPLE_TEAM_ID`。
- Windows のコード署名は未設定です(必要なら証明書を用意して Tauri の `bundle.windows` に設定)。

### ローカルでビルド

```
cd desktop
npm ci
npx tauri dev                      # 開発起動
npx tauri build --bundles nsis     # Windows 例(Rust と MSVC Build Tools、WebView2 が必要)
```

---

## 2. Android(APK)

GitHub Release の `OmniChat-<version>.apk` を端末にダウンロードして開きます(「提供元不明のアプリ」の許可が必要)。初回に サーバー URL を入力します。

- APK は CI(`.github/workflows/android.yml`)で `expo prebuild` + Gradle `assembleRelease` により作成します。EAS クラウドは使いません。
- **署名**: リポジトリ Secrets に `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` があればそのキーで署名します。無い場合は **デバッグ署名** の APK になります(個人のサイドロードには十分ですが、Google Play には出せず、後でキーを変えると上書きインストールできません)。
  キーストアの作成(一度だけ。**ファイルとパスワードは必ず保管**):
  ```
  keytool -genkeypair -v -storetype PKCS12 -keystore omnichat.keystore -alias omnichat \
    -keyalg RSA -keysize 2048 -validity 10000
  base64 -w0 omnichat.keystore > keystore.b64     # Windows PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("omnichat.keystore"))
  ```
  `keystore.b64` の中身を `ANDROID_KEYSTORE_BASE64` に、他の 3 つも Secrets に登録します。
- **HTTP(平文)通信**: LAN / Tailscale の `http://` サーバーに繋げるため、`usesCleartextTraffic: true` を有効にしています(`app/app.json` の `expo-build-properties`)。同じネットワーク上の第三者に通信を盗み見られる可能性があるため、**インターネット越しや公共 Wi-Fi では HTTPS(Tailscale Serve など)を使ってください**。HTTPS のみで良い場合は `usesCleartextTraffic` を `false` にしてビルドします。
- EAS を使う代替手段: `cd app && npx eas-cli@latest build --profile preview --platform android`(Expo アカウントが必要。`app/eas.json` に `preview` プロファイルあり)。
- `app/android/`・`app/ios/` は `expo prebuild` が生成するもので、コミットしません(`.gitignore` 推奨)。

---

## 3. iPhone / iPad(Safari の PWA)

1. Safari でサーバー URL を開き、サーバー URL を入力してログイン。
2. 共有ボタン → **ホーム画面に追加**。以降はアドレスバー無しのアプリとして起動します(ノッチ / ホームバーの安全領域に対応済み)。

制限:

- **iOS では HTTP(非 HTTPS)の LAN サーバーでも動きますが、Service Worker(オフライン起動のキャッシュ)は HTTPS でのみ有効** です。Tailscale の HTTPS URL を推奨します。
- iOS のホーム画面アプリは、バックグラウンドに回ると WebSocket が切断されます。復帰時に自動再接続します(再接続の瞬間はメッセージが遅れて届きます)。
- **プッシュ通知・バックグラウンド処理は未対応**(生成中に画面を閉じると、戻ったとき同期されます)。
- iOS のストレージは一定期間アクセスしないと消えることがあります(再ログインが必要になる場合があります)。

---

## 4. ブラウザ対応

Web 版は Expo(react-native-web)の静的書き出しで、PWA(Web App Manifest + 手書き Service Worker)としてインストール可能です。

| ブラウザ | 利用 | インストール | 検証状況 |
| --- | --- | --- | --- |
| Chrome / Edge(Windows, macOS, Android) | 可 | アドレスバーの「インストール」/ メニュー「アプリとしてインストール」 | **実測**(Edge 155: インストール可能判定エラー 0、SW 登録、シェルのキャッシュ、オフライン再読込、API 非キャッシュを確認) |
| Safari(macOS / iOS / iPadOS 15.4+) | 可 | iOS は「ホーム画面に追加」、macOS Safari 17+ は「Dock に追加」 | 機能チェックのみ(非対応 API を使わない) |
| Firefox(Windows, macOS, Linux, Android) | 可 | デスクトップ版 Firefox は PWA インストール非対応(通常のタブで利用) | 機能チェックのみ |

- Service Worker は **HTTPS または `localhost` のときだけ** 登録されます。`http://192.168.x.x` ではブラウザ仕様により使えないため登録をスキップし、通常のウェブページとして動きます(アプリ自体は問題なく動作)。
- Service Worker がキャッシュするのは HTML シェル、ハッシュ付きの `/_expo/static/*` と `/assets/*`、アイコン類のみです。`/ws`、`/auth`、`/sync`、`/v1`、その他 API、POST 等の非 GET、Authorization ヘッダ付きリクエストは **決してキャッシュしません**。オフライン時は画面のシェル(ログイン / 接続中の状態)が表示されます。
- 新しいバージョンは次回のページ読み込みで有効になります。強制リセットは `app/public/sw.js` の `VERSION` を上げます。
- 使用 API: `fetch` / `WebSocket` / `localStorage` / `crypto.randomUUID`(`app/src/api.ts` に代替実装あり)。CSS は `100dvh`(非対応ブラウザは `100%` にフォールバック)と `env(safe-area-inset-*)` を使用。
- サーバー側のヘッダ: Service Worker を使うため `/sw.js` と `/index.html` は `Cache-Control: no-cache`(または短時間)で配信してください。

---

## 5. HTTPS / Tailscale のヒント

- 外出先から使うなら Tailscale が簡単です。サーバー PC で `tailscale serve --bg 8787`(または `tailscale funnel` は公開になるので非推奨)を実行すると `https://<machine>.<tailnet>.ts.net` で HTTPS 接続できます。PWA の Service Worker とブラウザの「安全な接続」表示も有効になります。
- `http://192.168.x.x:8787` は自宅 LAN 内での利用に留めてください(通信は暗号化されません)。
- 自己署名証明書は Safari / ランチャーで警告・拒否されます。信頼された証明書(Tailscale、Let's Encrypt)か、OS に CA を登録してください。
- ランチャーのエラー表示: 「接続できません」= サーバー停止 / URL・ポート違い / 別ネットワーク、「証明書の検証に失敗」= 期限切れ・自己署名・名前不一致、「OmniChat サーバーではありません」= `/version` が別のサービス、「HTTPS から HTTP へリダイレクト」= リバースプロキシ設定。

## 6. 既知の制限まとめ

- iOS: プッシュ通知なし、バックグラウンドで WebSocket 切断(復帰時に再接続)、HTTP では Service Worker 不可。
- macOS: 未署名ビルドは Gatekeeper の手動許可が必要(上記)。
- Android: デバッグ署名の APK は Google Play 不可。HTTP を許可している点に注意。
- デスクトップ版はサーバーに到達できないと UI を表示できません(オフライン動作なし)。
