# プロトコル v7: 使用量の上限(クォータ)

設計の根拠: [design/SHARED-PROVIDERS.md](design/SHARED-PROVIDERS.md)(上限は「次の段階」としていたもの)。2026-10-19。

## 対象
- **共有プロバイダー**のモデルの利用だけを数える・止める(管理者のキーを使うため)。自分の接続先(自分のキー)と、管理者は対象外。
- 数えるのは、1 回の応答の**入力 + 出力トークン**(上流が返した usage。無ければ、既存のメトリクスの見積もりと同じ方法)。

## 設定(管理者)
- サーバー設定 `quotas`(既存の `general` / `attachments` と同じ作法で `GET/PUT /admin/quotas`):
  `{ enabled: boolean /*既定 false*/, dailyTokens: number /*0 = 無制限*/, monthlyTokens: number /*0 = 無制限*/ }`。これが「既定」。
- ユーザーごとの上書き: 表 `user_quotas (user_id TEXT PRIMARY KEY, daily_tokens INTEGER, monthly_tokens INTEGER, updated_at INTEGER)`。NULL = 既定に従う、0 = そのユーザーは無制限。`GET /admin/quotas/users`(各ユーザーの上書きと今日 / 今月の使用量)、`PUT /admin/quotas/users/:userId` 本文 `{ dailyTokens: number|null, monthlyTokens: number|null }`、`DELETE` で上書きを消す。
- 日 / 月の区切りは、サーバーのローカル時間(日の 0 時、月の 1 日 0 時)。

## 数え方
- 表 `quota_usage (user_id TEXT, day TEXT /*YYYY-MM-DD*/, tokens INTEGER, PRIMARY KEY(user_id, day))`。共有プロバイダーの応答が終わるたびに加算(中断された応答も、出た分を加算)。月の合計は日の合計から求める。古い行(400 日より前)は掃除する。

## 判定
- 共有プロバイダーのモデルを使う入口(チャット送信、再生成、比較、ベンチ、`/v1`)で、**開始前**に、今日と今月の使用量が上限以上なら拒否する(応答の途中では止めない。1 回の応答で少し超えるのは許す)。
- 拒否: WebSocket のエラー `code: "quota_exceeded"`、HTTP は `429 { error: { type: "rate_limit", code: "quota_exceeded", message } }`。`message` は、どの上限(日 / 月)か、リセットの時刻を含む(日本語・英語は既存の作法に従う)。メンテナンスモード・`model_not_allowed` の判定と同じ入口に置く。

## 利用者への表示
- `GET /quota`(ログインしたユーザー): `{ enabled, applies: boolean /*共有プロバイダーを使う一般ユーザーか*/, daily: {used, limit|null, resetsAt}, monthly: {used, limit|null, resetsAt} }`。
- クライアント: 設定に「使用量」(今日と今月の使用量と上限の棒、リセット時刻)。`quota_exceeded` を受けたら、チャットにわかりやすい文言を出す(`model_not_allowed` と同じ扱い)。
- 管理画面(クライアントと OmniChat Server アプリ): 既定の編集、ユーザーごとの上書きと使用量の一覧。
