# OmniChat のロゴ・名称の利用ルール / Logo and name policy

> 日本語が先、英語は同じ内容の訳です。(Japanese first; the English translation follows.)
> これは作者が定めた利用ルールです。法律の専門家による確認は受けていません(公開前に確認することをおすすめします)。

## 日本語

OmniChat の**ソースコード**は AGPL-3.0 で公開しています([LICENSE](LICENSE))。次の**ロゴと名称は、AGPL の対象ではありません**。コードのライセンスとは別に、作者(remuno)が権利を持ち、この文書のルールで使うことを許可します。

### 対象(以下を「ロゴ・名称」と呼びます)

- 名称「OmniChat」と、そのロゴ・アプリアイコン・ワードマーク。
- 次のフォルダ・ファイルにある画像すべて(アプリアイコン、ファビコン、スプラッシュ、ロゴ案)。
  - `app/assets/`(`app-icons/` を含む)、`app/public/icons/`、`app/public/favicon*`
  - `desktop/src-tauri/icons/`(`variants/` を含む)、`server-app/src-tauri/icons/`、`server-app/src-tauri/app-icon.png`
  - `docs/design/logos/`
- 上のフォルダ以外にあっても、同じロゴを使った画像。

### してよいこと

- このリポジトリの**公式の配布物**(公式サイトまたは公式の Releases にあるもの)を、そのまま配布すること。
- 事実を述べるための参照(「OmniChat 対応」「OmniChat のフォーク」など)。作者の公認だと誤解させない書き方で。
- OmniChat を紹介・拡散するための、SNS、ブログ、記事、動画などでの**ロゴ(改変しないもの)の利用**。作者の公認や提携を受けているかのように見せないこと。
- 開発とプルリクエストのために、このリポジトリをコピー(GitHub の Fork を含む)し、ロゴの画像を**変更せずに**そのまま含めておくこと。

### してはいけないこと(作者の書面の許可がある場合を除く)

- ロゴ・名称を、**フォークや改変版のアプリ・パッケージ・Docker イメージ・ストアの掲載ページ**で使うこと。
- ロゴを改変したものを、公式のものとして、または公式と紛らわしい形で使うこと。
- 作者の公認、提携、推奨を受けているかのように見せること。

### フォークを配布するとき

フォークや改変版を**配布する**(アプリのビルド、インストーラー、Docker イメージ、ストアへの掲載を含む)ときは、次を自分のものに置き換えてください。

1. 上の「対象」のロゴと画像すべて(自作、または自分に使用権のあるもの)。
2. 利用者に見える名称「OmniChat」(アプリ名、ウィンドウタイトル、インストーラー名、パッケージ ID)。
3. 自動更新の確認先(`remuno3751/omnichat` を、自分のリポジトリに)。
4. 公式のアップデートのチャンネルや、配布サイトの URL。

コードそのものは AGPL-3.0 のとおり、自由に改変・配布できます(改変版のソース提供義務は LICENSE の条件に従います)。この文書が制限するのは、ロゴと名称の使い方だけです。

### 許可を求めるとき

上のルールの範囲外で使いたい場合は、リポジトリの Issues または作者の連絡先に、用途を添えて連絡してください。

## English

The **source code** of OmniChat is published under AGPL-3.0 ([LICENSE](LICENSE)). The **logo and the name below are NOT covered by the AGPL.** The author (remuno) holds the rights and permits their use only under the rules of this document.

### Scope ("the Marks")

- The name "OmniChat" and its logo, app icons and wordmark.
- All images in these paths (app icons, favicons, splash, logo drafts):
  - `app/assets/` (including `app-icons/`), `app/public/icons/`, `app/public/favicon*`
  - `desktop/src-tauri/icons/` (including `variants/`), `server-app/src-tauri/icons/`, `server-app/src-tauri/app-icon.png`
  - `docs/design/logos/`
- Any other image that uses the same logo.

### Allowed

- Redistributing the **official builds** (from the official site or the official Releases page) unchanged.
- Factual references ("compatible with OmniChat", "a fork of OmniChat") that do not suggest the author endorses your project.
- **Using the logo (unmodified)** to introduce or spread OmniChat on social media, blogs, articles, videos and the like, as long as it does not suggest endorsement or affiliation by the author.
- Copying this repository (including a GitHub fork) for development and pull requests, keeping the logo files **unmodified**.

### Not allowed without the author's written permission

- Using the Marks in a **fork's or modified version's app, package, Docker image or store listing**.
- Using a modified logo as if it were the official one, or in a way that can be confused with it.
- Suggesting endorsement, affiliation or sponsorship by the author.

### If you distribute a fork

When you **distribute** a fork or modified version (builds, installers, Docker images, store listings), replace:

1. All logos and images listed above (with your own, or ones you have the right to use).
2. The user-visible name "OmniChat" (app name, window title, installer name, package identifiers).
3. The update-check source (`remuno3751/omnichat` -> your own repository).
4. Any official update channel or distribution-site URL.

The code itself remains free to modify and distribute under AGPL-3.0 (source-offer obligations as in LICENSE). This document restricts only the use of the logo and the name. The AGPL permits this: §7(e) lets a licensor decline to grant trademark rights.

### Asking for permission

If you need something outside these rules, open an issue in the repository or contact the author with your intended use.
