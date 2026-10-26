# Aria 音声通話: サーバーで自前運用(セルフホスト)と、OmniChat の履歴への記録(第3段)

第1・2段([ARIA-VOICE.md](ARIA-VOICE.md)、[ARIA-VOICE-PHASE2.md](ARIA-VOICE-PHASE2.md))は、アプリが Aria に**直接**つなぐ形でした。
第3段は、方針の変更です(ユーザー指示、2026-10-26)。

## 決定事項(ユーザー指示)
1. **OmniChat Server アプリが AI_Aria を自前で動かす**(セルフホスト)。OmniChat にログインしていれば、通話が使える。クライアントで URL を入れない。サーバーが Aria との間を**中継**する(アプリは OmniChat サーバーだけにつなぐ)。
2. **通話は OmniChat の履歴に残る**: ユーザーの発話(文字起こし)も、AI の返事も、チャットのログとして残る(ユーザーも OmniChat のユーザーとして記録)。
3. **チャット画面の上部に電話のロゴ**を置き、そこから通話を始める。**会話の名前の頭に、チャットのロゴ・電話のロゴ・両方**を付けて、通話とチャットが一目で分かる。
4. **クライアントから、声のモデル(ONNX / .aivmx)をアップロード**して、自分好みの声にできる。
5. 読み上げの標準モード(`tts_mode: balanced`)の**速度の既定を 1.3**にする。
6. Server アプリと設定に、**「音声通話」の項目を新設**: 詳細な設定、アップロードされた声モデルの管理、通話で使う LLM の管理、**ユーザーごとの LLM モデルの管理**。
7. 外部の Aria(自分で別に動かしている Aria)につなぐ方式(第1・2段)は、**残す**(「外部の Aria」モード)。

## 動くものの全体像
```
アプリ(Web / デスクトップ / Android)
   │  WS  /voice/ws?token=<端末トークン>&conversationId=<id>   REST /voice/*
   ▼
OmniChat サーバー(server/)  ── 中継 + 認証 + 履歴の記録 + ユーザーごとの設定
   │  WS  <Aria>/live/ws?user=<OmniChat のユーザーID>&token=<サーバーの chat トークン>
   │  REST <Aria>/voices, /llm/*, /voice/placement(サーバーの admin トークン)
   ▼
AI_Aria(Python)  ← OmniChat Server アプリ(Tauri)が子プロセスとして起動・監視(Windows のみ)
```
- Aria の WebSocket / REST の仕様は、[ARIA-VOICE.md](ARIA-VOICE.md)、[ARIA-VOICE-PHASE2.md](ARIA-VOICE-PHASE2.md) にあります(正は Aria 側の `OMNICHAT_VOICE_CONTRACT.md`)。
- Aria のユーザー(`?user=`)は、**OmniChat のユーザー ID** にする。履歴と話し方は、Aria 側でも、ユーザーごとに分かれる。
- Aria は **Windows 専用**。セルフホストは、Windows の Server アプリだけ。それ以外は「外部の Aria」モード。

## 設定の置き場所
サーバーの DB の `server_settings` に、キー `voice`(JSON)で持つ。トークンは `encryptSecret` で暗号化し、読み出しでは返さない。
```ts
interface VoiceServerConfig {
  mode: 'off' | 'hosted' | 'external';
  /** hosted: 'http://127.0.0.1:<port>'(Server アプリが決める)/ external: 管理者が入れた URL */
  baseUrl: string;
  /** 書き込み専用(読み出しは `*Set: boolean` だけ) */
  chatToken?: string;
  adminToken?: string;
  /** 通話で、ユーザーが選んでよい LLM(空 = 管理者が決めた役割のモデルだけ) */
  allowedLlm: { endpoint: string; model: string }[];
}
```
ユーザーごとの設定は、新しいテーブル `voice_user_prefs(user_id PK, prefs JSON, updated_at)`:
```ts
interface VoiceUserPrefs {
  voice?: string;                 // スタイル ID
  ttsMode?: 'balanced' | 'fast';
  speed?: number;                 // 未設定なら: balanced は 1.3、fast は 1.0
  pauseScale?: number; responseDelayMs?: number; endOfTurnMs?: number; bargeIn?: boolean; bargeInDb?: number;
  /** ユーザーごとの LLM(allowedLlm の中から。管理者が割り当てることもできる) */
  llm?: { fast?: { endpoint: string; model: string } };
}
```
声モデルの持ち主は、新しいテーブル `voice_models(uuid PK, owner_user_id, name, created_at)`(Aria の `uuid` と対応)。

## OmniChat サーバーの API(`server/src/`、新規: `voice-*.ts`)
認証は、既存の REST と同じ(`Authorization: Bearer <端末トークン>`、WS は `?token=`)。管理者専用の API は、管理者のアカウントだけ。
`/local-admin/voice/*` は、`/voice/admin/*` と同じ内容を、Server アプリ向けに(ループバック + local-admin トークン。`local-admin-mirror.ts` の仕組みを使う)。

| メソッド・パス | 誰が | 内容 |
|---|---|---|
| `GET /voice/status` | ログイン済みなら誰でも | `{ mode, ready, ttsModes: string[], me: VoiceUserPrefs & {effective}, canAdmin }`。`ready` = Aria に届いている |
| `WS /voice/ws?token=&conversationId=` | 誰でも | 中継(下の「中継の規則」) |
| `GET /voice/me` / `PUT /voice/me` | 本人 | `VoiceUserPrefs` の取得と更新(範囲を丸める。`llm` は `allowedLlm` の中だけ) |
| `GET /voice/voices` | 誰でも | Aria の `GET /voices`(声モデルの一覧)に、`ownerUserId` と `mine: boolean` を付ける |
| `POST /voice/voices/models?name=<ファイル名>` | 誰でも | 声モデルのアップロード(本文は生のバイト列、上限 300 MB)。`.aivmx` はそのまま Aria の `POST /voices/models` へ。`.onnx` は、Aria が受け付けるか変換できる場合だけ通し、できないときは `415 {code:"unsupported_format", message}`。成功したら `voice_models` に持ち主を記録 |
| `DELETE /voice/voices/models/:uuid` | 持ち主 / 管理者 | 削除(Aria の `DELETE /voices/models/<uuid>` と、`voice_models`) |
| `GET /voice/admin/config` / `PUT /voice/admin/config` | 管理者 | `VoiceServerConfig`(トークンは `chatTokenSet` / `adminTokenSet` だけ返す) |
| `GET /voice/admin/llm` | 管理者 | Aria の `GET /llm/endpoints`(役割、接続先、使用量)と、`allowedLlm` |
| `PUT /voice/admin/llm/roles` | 管理者 | `{ role: 'fast'|'deep', endpoint?, model }` → Aria の `POST /llm/model`(`target:"role"`) |
| `PUT /voice/admin/llm/allowed` | 管理者 | `allowedLlm` の更新 |
| `GET /voice/admin/users` | 管理者 | ユーザー一覧と、それぞれの `VoiceUserPrefs`(`llm` を含む)、声モデルの数 |
| `PUT /voice/admin/users/:id/llm` | 管理者 | そのユーザーの `llm` の割り当て(`null` で解除) |
| `GET /voice/admin/placement` / `PUT /voice/admin/placement/stt` | 管理者 | Aria の `/voice/placement` の中継(Whisper の置き場所) |
| `GET /voice/admin/models` | 管理者 | 全ユーザーの声モデル(持ち主付き)。削除は上の DELETE |

エラーは、既存の REST と同じ形(`{error}`)。Aria に届かないときは `502 {code:"aria_unreachable"}`、`mode` が `off` なら `409 {code:"voice_off"}`。Aria のトークンや URL は、ユーザーには返さない。

### 中継の規則(`WS /voice/ws`)
- 接続時に、端末トークンを検証 → ユーザー ID を得る。`mode=off` なら、WS を `4409 voice_off` で閉じる。`conversationId` が無ければ、新しい会話を作る(タイトルは通話の開始時刻から、`kinds` に `voice`)。ある場合は、その会話(本人のもの)を使う。
- Aria へ `…/live/ws?user=<ユーザーID>&token=<chatToken>` で接続し、**JSON とバイナリをそのまま双方向に流す**。例外は次の3つ。
  1. クライアントの `hello` / `settings` の `values` に、サーバーが、`voice_user_prefs`(と既定: balanced の `speed` は 1.3)を**下敷きとして足す**(クライアントが送った値が優先)。
  2. `llm` の割り当てがあるときは、Aria に伝える(伝え方は、Aria 側の対応待ち。下の「Aria 側に依頼すること」)。
  3. クライアントには、`ready` に `conversationId` を足して返す。
- **履歴への記録**(サーバー側で行う。クライアントの実装に依存しない):
  - `transcript`(`final:true`)→ ユーザーのメッセージ(`role:'user'`、`via:'voice'`)として保存。`source` が `mic` か `text`。`transcript_retract` が来たら、そのターンの未確定の user メッセージを取り消す。
  - `text` の `delta` → そのターンの assistant のメッセージ(`via:'voice'`)に追記。`turn_end` で `done`、`interrupted` で、聞こえた分だけを残して `stopped`。
  - 保存は、既存のメッセージの仕組み(`messages` テーブル、`upsert` の WS ブロードキャスト)を使う。ほかの端末でも、通話の内容がリアルタイムに見える。
  - `messages` に、新しい列 `via TEXT NULL`(`'voice'` か null)。会話の JSON に `kinds: ('chat'|'voice')[]`(そのメッセージの `via` から導く。`voice` を含めば電話のロゴ、`chat` を含めばチャットのロゴ)。マイグレーションは、既存の DB を壊さない(列の追加のみ)。
  - 返事は、Aria の LLM が作る。OmniChat のチャット用のモデルは、通話では使わない。
- 切断(どちらか側)で、もう一方も閉じる。1ユーザーの同時通話は 1 つ(2つ目は `4429 busy`)。

## クライアント(`app/`)
- **チャット画面の上部に、電話のロゴのボタン**。押すと、いまの会話の中で通話が始まる(会話が未作成の下書きなら、新しい会話を作る)。通話中は、同じ画面の上部に、通話のバー(状態、ミュート、割り込み、終了、設定)。通話の文字は、そのチャットのメッセージとして、リアルタイムに流れる(サーバーが記録した `upsert` を、いつものチャットと同じ描画で見る。通話のメッセージには、小さな電話のロゴ)。
- **会話の一覧の、会話名の頭に、ロゴ**: `kinds` が `['chat']` ならチャットのロゴ、`['voice']` なら電話のロゴ、両方なら両方。ロゴは、既存の `Icon` の仕組みに、`phone` を足す。
- 接続は、`mode` が `hosted` / `external` のどちらでも、**OmniChat サーバーの `/voice/ws`**。アプリでの URL の入力は、いらない。設定の「音声通話」の接続先の欄は、削除する(第1・2段の URL / トークン / 管理用トークンの欄と、`VoiceModelsCard`、`VoiceVoicesCard` の Aria への直接アクセスも、サーバー経由に置き換える)。
- 設定の「音声通話」: 話し方(`GET/PUT /voice/me`)、声のモード、声の選択、**声モデルのアップロード**(ONNX / .aivmx。`POST /voice/voices/models`)と、自分のモデルの削除、LLM の選択(`allowedLlm` の中から)。`speed` の既定は、balanced で **1.3**。
- `voiceEngine.web.ts` / `voiceEngine.native.ts` は、接続の URL の作り方だけ変える(`/voice/ws` + `?token=<端末トークン>&conversationId=`)。音声のやり取りは、今のまま(PCM16、Opus)。
- 外部の Aria に直接つなぐ方式は、**やめる**(中継に一本化する。外部の Aria も、管理者が `mode: external` + URL で指す)。第1・2段の `ariaRest.ts` の直接アクセスは、不要になれば削除してよい。

## Server アプリ(`server-app/`)
- **Aria のホスト**(Rust、`server-app/src-tauri/src/aria.rs` を新規): 設定(`ariaDir` = Aria のフォルダ、`pythonPath`(空なら `ariaDir` の venv)、`port`(既定は空きポートを自動)、`autostart`、追加の環境変数)、起動・停止・再起動、状態(`stopped | starting | running | failed`)、ログの末尾、Server アプリの終了時の停止(`jobobj.rs` のジョブオブジェクトを使う。`lib.rs` のサーバーの子プロセスと同じ作り)、クラッシュ時の自動再起動(回数制限つき)。起動したら、`VoiceServerConfig`(`mode: hosted`、`baseUrl`)を、`/local-admin/voice/config` で書き込む。初回の準備(chat / admin トークンの発行)は、Aria 側の CLI(`python -m aria_core.auth create <名前> --scopes chat`)を使う。出力の読み方は、Aria 側の確認待ち。**Aria のセットアップ(Python の依存のインストールなど)は、Server アプリでは行わない**: `ariaDir` が使える状態になっているかの、検査(`python` が動く、必要なファイルがある)と、足りないものの案内だけ。
- **「音声通話」ページ**(`server-app/ui/pages/voice.js` を新規、`index.html` と `core.js` のナビに登録): (1) モード(オフ / このPCで Aria を動かす / 外部の Aria)と、Aria のホストの設定・状態・起動停止・ログ。(2) 声モデルの管理(全ユーザー分。持ち主、名前、権利表示、削除)。(3) 通話で使う LLM の管理(役割 fast / deep のモデル、ユーザーが選んでよいモデルの一覧)。(4) ユーザーごとの LLM の割り当て(ユーザー一覧 + 選択)。(5) Whisper の置き場所。API は、すべて `/local-admin/voice/*`(上の表の `/voice/admin/*` と同じ形)。Tauri のコマンドは、既存の `extra.rs` の `admin_call` の作りに合わせる。
- 既存の「セキュリティ」「ユーザー」のページとは、衝突しないこと(新しいページを足すだけ)。

## Aria 側に依頼すること(別セッション「Ariaシリーズ開発」。回答待ち)
1. Server アプリが子プロセスとして起動する方法(コマンドライン、ポートとホストの指定、健康確認の URL、停止の方法)、データの置き場所を環境変数で指定できるか、必要な Python と依存。
2. chat / admin トークンを、**非対話で**発行して、出力を機械的に読む方法(例: `--json`)。
3. `?user=` ごとの LLM(fast)のモデルの上書き: `settings` の `values` に `llm_endpoint` / `llm_model` のようなキーで、その接続の間だけ上書きできるか。
4. `.onnx`(素の SBV2 ONNX)の取り込み、または `.aivmx` への変換の可否。
5. `balanced` の速度の既定(1.3)は、サーバーが下敷きとして足すので、Aria 側の変更は不要。
6. 通話の記録に足りないイベントがないか(`transcript` に、安定した ID があると、取り消しが確実になる)。
回答が来るまでは、上の 2・3・4 は、「できる前提のインターフェース」と、「できないときの失敗の表示」で実装し、本物の Aria での確認は、あとで行う。

## 作業の分担(3つ。担当のファイルは重ならない)
- **S: サーバー**(`server/`): 上の「OmniChat サーバーの API」の全部(DB のマイグレーション、`voice-*.ts`、中継、履歴の記録、`/local-admin/voice/*`、テスト。偽の Aria サーバーを、テスト用に作る)。
- **C: クライアント**(`app/`): 上の「クライアント」の全部(電話のロゴ、通話バー、会話名のロゴ、設定の作り直し、アップロード、第1・2段の置き換え、`speed` の既定 1.3、`Icon` に `phone`、テスト)。サーバーの API ができるまでは、`app/src/voice/voiceApi.ts`(`/voice/*` の呼び出しの薄い層)を、この文書の仕様どおりに書き、テストでは、偽の fetch を使う。
- **H: Server アプリ**(`server-app/`): 上の「Server アプリ」の全部(Rust の `aria.rs`、UI の `voice.js`、ナビ、模擬(`ui/dev/mock-tauri.js`)の更新)。`/local-admin/voice/*` の呼び出しは、仕様どおり。

共通のルール: 各作業は、自分のブランチ(`feat/aria-host-<s|c|h>`)で行い、`feat/v056` から始める。ほかの作業のファイルは、変更しない。トークンは、ログ・エラー・画面に出さない。新しい文言は、日本語と英語。実機・本物の Aria で確認できないことは、報告に、はっきり書く。

## クライアント(作業 C)の実装メモ
- `app/src/voice/voiceApi.ts`: `/voice/*` の薄い層(`buildRelayUrl`、`getStatus`、`getMe`/`putMe`、声モデルの一覧・アップロード・削除)。エンジンは `CallOptions.url` に中継 URL をそのまま受け取る。
- `GET /voice/status` に `allowedLlm: {endpoint,model}[]` が含まれる前提(LLM の選択に使う)。`PUT /voice/me` は、自分の設定の全体を送って置き換える前提。
- 通話の終了コード `4409`(voice_off)、`4429`(busy)を、画面の文言に出す。
- 通話バーは `ephemeral` / Code モードの会話では出さない(通話は履歴に残るため)。
- 削除したもの: `VoiceCallScreen`、`VoiceModelsCard`、`VoiceVoicesCard`、`ariaModels.ts`。デバイスに残る音声設定は `codec` だけ。
- 追補(ADDENDUM)の反映: LLM の選択は削除。声モデルは標準 = `.aivmx`、Fast = piper(`.onnx` + `config.json` または zip、`POST /voice/voices/models?kind=piper&name=<id>&file=zip|model|config`)。プライバシー(`&private=1`、`ready.private` で「記録なし」を表示)、プッシュトゥトーク(既定オフ、ウェイクワードの項目なし)、診断(`GET /voice/diagnose` + クライアント側の検査)、遅延(`omni_stats`)、試聴(`POST /voice/preview`、Web のみ再生)、使用量(`GET /voice/usage`)、再接続は 3 秒以上の間隔で自動は最大 3 回。
