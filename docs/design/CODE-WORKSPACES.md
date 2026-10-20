# Code タブ: ワークスペース別グループ・デバイス表示・作業フォルダ選択

対象: server / app / dsh-plugin 0.9.0。後方互換(古い bridge・古いサーバー・古いクライアント)を保つ。

## 決定事項

1. **cwd の置き場所は `conversations.cwd`(NULL 可)**。`agent_sessions` ではなく conversations にする。
   理由: 会話 JSON(`toConversation` / sync / `upsert` ブロードキャスト)にそのまま載り、seq で同期され、
   セッション未作成の新規チャットでも「選んだフォルダ」を持てる。`agent_sessions` は会話と 1:1 で追加の価値がない。
2. **cwd の入手元**(新しいものが勝つ):
   - mirror の `sessions` フレームの `cwd`(GUI 起動のセッション。再接続時の full フレームで既存会話にも埋まる = backfill)。
   - bridge の `session` イベントの `cwd`(OmniChat 起動のチャット)。プラグインは**実際に使った cwd** を送る(0.8.x は設定値だけで、`recentCwd` を使った場合に誤っていた)。
   - 新規チャットの初回 `send` の `cwd`(検証後、セッション作成前に会話へ仮保存 = すぐ正しいグループに出る)。
3. **パスの正規化**(グルーピング用キー): `\` → `/`、末尾の `/` を除去、Windows 形式(ドライブ文字 / UNC / `\` を含む)は小文字化。
   プラグインの `normCwd`(wire.js)と同じ規則。サーバー(`server/src/cwd.ts`)とアプリ(`app/src/codeGroups.ts`)に小さく複製(別パッケージのため)。
   表示用フォルダ名は最後のセグメント。フルパスはホバー(web)/ 長押しメニューのタイトルに出す。
4. **デバイス名は bridge 名(provider の `baseUrl`)をそのまま使う**。bridge 名は既定でホスト名なので、別途 hostname フレームは足さない。
   online/offline は既存の `GET /bridges`(接続中のみ返る = 返らなければ offline)。
5. **デバイスが 1 台のときは UI を静かに**: バッジ・「デバイス別」トグル・デバイス選択を出さない。2 台以上で、バッジとトグル(端末ごとに保存)を出す。
6. **ワークスペース一覧は bridge が持つ**: `ready` に `workspaces`(最近順・最大 50)と `allowAnyCwd`、`capabilities.workspaces:true` を追加。
   mirror の集合が変わったら小さな `workspaces` フレームで更新。サーバーは接続中 bridge に保持し `/bridges` に付けて返す。
   オフライン bridge 用には、アプリが会話の cwd の集合から補う(ピッカーは「会話に出てきたフォルダ」+「bridge の一覧」の和)。
7. **新規チャットのフロー**: Code の下書きにピッカー(デバイス → ワークスペース)。既定は「bridge の既定(DSH GUI で最後に使ったフォルダ)」= cwd を送らない。
   選択は `send.cwd`(初回のみ・追加フィールド)で送る。自由入力は UI に出さない(`allowAnyCwd` は API / 設定のみ)。

## セキュリティ(cwd)

- **プラグインが最終判断**。受け付けるのは `config.cwd` と、既知のワークスペース(mirror 済みセッションの cwd、過去の run で使った cwd)だけ。
  設定 `allowAnyCwd: true`(既定 false、明示のスイッチ)のときだけ任意のパスを許す。
- どの場合でも拒否: 相対パス、NUL・制御文字(0x00-0x1f, 0x7f)を含む、`..` セグメントを含む、空、1000 文字超、文字列以外。
  許可リストの比較は正規化後の完全一致(前方一致にしない = `/work/app/../../etc` や `/work/app2` で通らない)。
- 拒否した run は `done {ok:false, error:'cwd not allowed'}` で失敗させ、セッションは作らない。
- サーバーも形式を検証(上と同じ規則)し、さらに bridge が `workspaces` 対応で online かつ `allowAnyCwd` でないなら一覧との一致を要求する。
  セッション作成済みの会話では `cwd` を無視(途中でフォルダを変えられない)。Code(dsh-bridge)以外の会話では無視。

## プロトコルの追加(すべて追加のみ)

| 方向 | 内容 |
|---|---|
| bridge→server `ready` | `workspaces: string[]`, `allowAnyCwd: boolean`, `capabilities.workspaces: true` |
| bridge→server `workspaces` | `{type:'workspaces', workspaces:[…]}`(一覧が変わったとき) |
| bridge→server `event session` | `cwd` を実際に使ったフォルダにする |
| server→bridge `run` | `cwd?: string`(新規セッションのときだけ) |
| client→server `send` | `cwd?: string`(Code の最初のメッセージ) |
| 会話 JSON | `cwd: string \| null` |
| `GET /bridges` | 各 bridge に `workspaces?`, `allowAnyCwd?`, `workspacesSupported?` |

古い bridge は `workspaces` を送らない → サーバーは `workspacesSupported:false`、アプリはピッカーを出さず、`run` に `cwd` も付けない。
古いクライアントは `cwd` を無視するだけ。古いサーバーは `send.cwd` を無視する(従来のフォルダになる)。

## グルーピング(アプリ)

`app/src/codeGroups.ts`(純関数): 会話 → `{key, label, path, latest, convs}[]`。グループは最新更新順、中は updatedAt 降順。
cwd なしは「その他 / Other」(最後)。デバイス別(2 段)はデバイス → ワークスペース。折りたたみは既存の `collapsed`(端末ごとに保存)に `ws:` キーで入れる。
ピン留めはこれまでどおり最上部。検索はサイドバーの検索入口(全文検索)でグルーピングに依存しない。
