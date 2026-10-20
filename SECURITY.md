# セキュリティ / Security policy

## 脆弱性の報告 / Reporting a vulnerability

脆弱性を見つけたら、**公開の Issue には書かず**、GitHub の「Security」タブ →「Report a vulnerability」(Private vulnerability reporting)から報告してください。

Please do **not** open a public issue for a security problem. Use the repository's *Security → Report a vulnerability* form (private vulnerability reporting).

報告に含めてほしいこと / Please include:

- 影響を受ける版(`GET /version` またはアプリの「OmniChat について」)/ the affected version
- 再現手順と、何ができてしまうか / steps to reproduce and the impact
- 可能なら、実際のアドレスやトークンを伏せたログ / logs with real addresses and tokens removed

## 対応方針 / What to expect

個人が空き時間で保守しているため、返信は数日かかることがあります。ベータ版の間は、修正を次のベータ版に含め、リリースノートに記載します。

OmniChat is maintained by one person in spare time, so replies can take a few days. During the beta, fixes ship in the next beta and are noted in the release notes.

## 対象 / Scope

- サーバー(`server/`)、サーバーアプリ(`server-app/`)、クライアント(`app/`、`desktop/`)、DSH プラグイン(`dsh-plugin/`)
- 想定している使い方は、**自分のネットワーク(LAN や Tailscale などの VPN)の中で動かすこと**です。インターネットへ直接公開する場合は、HTTPS とリバースプロキシを使い、`docs/INSTALL.md` を読んでください。

友人へ Tailscale Funnel で公開する場合は、[docs/INSTALL.md の「友人へ公開する(Tailscale Funnel)」](docs/INSTALL.md)のチェックリストに従ってください。 / To publish to friends through Tailscale Funnel, follow the checklist in [docs/INSTALL.md](docs/INSTALL.md) ("友人へ公開する(Tailscale Funnel)").

Intended use is on your own network (LAN or a VPN such as Tailscale). If you expose a server to the internet, put it behind HTTPS and a reverse proxy and read `docs/INSTALL.md`.
