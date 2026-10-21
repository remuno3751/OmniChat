# OmniChat for VS Code

[日本語](#日本語) | [English](#english)

---

## 日本語

OmniChat のサーバーから、この VS Code ウィンドウのツール(ファイル読み書き、検索、編集、診断、git、コマンド実行)を、あなたの承認付きで使えるようにする拡張機能です。

- **必要なもの**: 自分で運用する OmniChat サーバー(セルフホスト)。この拡張単体では動作しません。
- **インストール**: `.vsix` を入手し、次を実行します。
  ```sh
  code --install-extension omnichat-vscode-0.2.0.vsix
  ```
- **ペアリング**:
  1. OmniChat アプリの「設定」→「VS Code」カードを開き、ペアリングコードを作成します。
  2. VS Code でコマンドパレットを開き、**OmniChat: Pair with Server** を実行してコードを貼り付けます(`vscode://omnichat.omnichat-vscode/pair?code=…` のリンクからも可能)。
  3. 接続状態はステータスバーに表示されます。
- **承認モード**(会話ごとにアプリで切替):
  - `manual`(既定): 読み取り以外のすべて(編集・コマンド実行・git 書き込み)を確認します。
  - `auto`: 編集を自動許可し、コマンドは許可リスト(`npm test`、`git status` など)のみ自動実行します。
  - `full`: 保護項目以外を自動許可します。アプリ再起動で `manual` に戻ります。
  - **保護項目**(全モードで必ず確認): ワークスペース外のパス、`.git` 内の編集、`.env`・秘密鍵・`.ssh` などの秘密ファイル、`git push --force`・`reset --hard`・`rm -r` などの破壊的コマンド、`sudo` など。
- **セキュリティ上の注意**:
  - ツールは **VS Code を実行している OS のユーザー権限**で、ワークスペース内で動きます。
  - 保護リストと許可リストは安全網であり、OS のサンドボックスではありません。信頼できないリポジトリでは VS Code の Workspace Trust を使ってください(未信頼のワークスペースは読み取りのみ)。
  - ペアリングを解除するには、コマンド **OmniChat: Unpair This Device** を実行するか、アプリのデバイス一覧で失効させてください。

### 設定

| 設定 | 既定値 | 説明 |
|---|---|---|
| `omnichat.theme` | `frontier` | パネルのテーマ。フロンティア(既定、アプリの見た目)、シンプル(0.2.2 までの見た目)、アストラル(シンプルの形でアストラルの色)。変更はすぐ反映されます |
| `omnichat.serverUrl` | (空) | セルフホスト OmniChat サーバーの URL(ペアリングで設定されます) |
| `omnichat.deviceName` | (空) | アプリに表示される名前。空ならマシン名 |
| `omnichat.shell` | (空) | `run_command` のシェル。空なら `$SHELL`(Linux/macOS)または cmd.exe(Windows) |
| `omnichat.autoSave` | `true` | OmniChat の編集後にファイルを保存する |

---

## English

OmniChat for VS Code lets your self-hosted OmniChat server use this VS Code window's tools (reading and writing files, search, edits, diagnostics, git, and commands) with your approval.

- **Requirement**: a self-hosted OmniChat server that you run yourself. The extension does not work on its own.
- **Install**: download the `.vsix` and run:
  ```sh
  code --install-extension omnichat-vscode-0.2.0.vsix
  ```
- **Pair**:
  1. In the OmniChat app, open Settings → the **VS Code** card and generate a pairing code.
  2. In VS Code, open the Command Palette, run **OmniChat: Pair with Server**, and paste the code. (The `vscode://omnichat.omnichat-vscode/pair?code=…` link also works.)
  3. The connection status appears in the status bar.
- **Approval modes** (set per conversation in the app):
  - `manual` (default): asks before every edit, command, and git write. Reads inside the workspace are automatic.
  - `auto`: edits are automatic; commands run automatically only when they match the allowlist (for example `npm test` or `git status`).
  - `full`: everything except protected items is automatic. Restarting the app switches back to `manual`.
  - **Protected items** always ask, in every mode: paths outside the workspace, edits inside `.git`, secret files such as `.env`, private keys, and `.ssh`, destructive commands such as `git push --force`, `git reset --hard`, and `rm -r`, and `sudo`.
- **Security notes**:
  - Tools run with **the OS permissions of the user running VS Code**, inside the workspace.
  - The protected list and the allowlist are safety nets, not an OS sandbox. For untrusted repositories, use VS Code Workspace Trust (untrusted workspaces are read-only).
  - To unpair, run **OmniChat: Unpair This Device**, or revoke the device in the app's device list.

### Settings

| Setting | Default | Description |
|---|---|---|
| `omnichat.theme` | `frontier` | Theme for the OmniChat views: Frontier (default, the app's look), Simple (the look up to 0.2.2), Astral (Simple layout with Astral colours). Applies at once |
| `omnichat.serverUrl` | (empty) | URL of your self-hosted OmniChat server (set by pairing) |
| `omnichat.deviceName` | (empty) | Name shown in the app. Empty uses the machine name |
| `omnichat.shell` | (empty) | Shell for `run_command`. Empty uses `$SHELL` (Linux/macOS) or cmd.exe (Windows) |
| `omnichat.autoSave` | `true` | Save files after OmniChat edits |
