# Aria 音声通話: 残りの実装(第2段)

第1段(通話画面、話し方の設定、PCM16、Web / デスクトップ)は実装済みです。仕様と作りは [ARIA-VOICE.md](ARIA-VOICE.md)。
ここは、残りの4つの作業の分担と、先方(Aria)の API です。Aria のリポジトリは、クラウドからは見えないので、必要な情報をここに写しました。

## 共通のルール
- ブランチ: 各作業は、自分のブランチ(`feat/aria-voice-<名前>`)で行い、`feat/v056` へのプルリクエスト(または、マージ可能なブランチ)として返す。ほかの作業のファイルは変更しない。
- 純粋なロジックは、node でテストできる形(React / react-native / ブラウザ API を import しない)で書き、`app/src/__tests__/` に `node:test` のテストを付ける。UI は、型チェック(`cd app && npx tsc --noEmit`)と、全テスト(`node --import tsx --test src/__tests__/*.test.ts`)が通ること。
- 新しい文言は、日本語と英語の両方。自分専用の `app/src/i18n/<名前>Strings.ts` を作り、`i18n/ja.ts` / `en.ts` にマージする(既存の `voiceStrings.ts` は、第1段のもので、変更は最小限)。
- トークン(`token`、`adminToken`)は、ログ・エラーメッセージ・画面に出さない。
- 実機で確認できなかったことは、報告に、はっきり書く(確認したことと、していないことを分ける)。
- 共通部品: `app/src/voice/ariaRest.ts`(`ariaHttpBase(url)`、`ariaFetchJson(base, path, {method, body, token, ...})`、`AriaHttpError`)、`app/src/voice/voiceSettings.ts`(`VoiceSettings`。`adminToken` は管理用の任意のトークン)、`app/src/voice/ariaProtocol.ts`。

## Aria の REST API(認証は `Authorization: Bearer <トークン>`)
Aria の URL は、`deviceSettings.voice.url`(ws / wss / http / https のどれでもよい)。HTTP の基点は `ariaHttpBase(url)`。
応答の JSON の形は、下に書いた以外は、未確認です。足りないフィールドや、知らないフィールドがあっても壊れないように、防御的に読むこと(型は `unknown` から絞る)。

### LLM(read = chat か admin のトークン、admin = admin のトークン)
- `GET /llm/endpoints`(read): 登録済みの接続先、役割(`fast` = 通話の返事、`deep` = 背景思考)の割り当て、役割ごとの使用量(リクエスト数、エラー、フォールバック回数、トークン、遅延)。キーは返らない。
- `GET /llm/models`(read): 既定 provider のモデル一覧。`?endpoint=<名前>` で、登録済みの接続先のモデル一覧。
- `POST /llm/model`(admin): 実行中に切り替える(再起動なし)。本文は次のどれか。
  - `{"target":"default","model":"<モデル>"}`
  - `{"target":"endpoint","name":"<接続先>","model":"<モデル>"}`
  - `{"target":"role","name":"fast"|"deep","model":"<モデル>"}`
  - 追加キー: `"persist": false`(再起動で戻る一時的な切り替え。既定は保存)、`"validate_model": false`(一覧にない名前を許す)。一覧にない名前は 400(本文に `available`)。
- 通話の返事(`fast`)は、遅延に敏感。画面には「通話の返事に使うモデルを遅いものにすると、会話の間が空きます」と注意を出す。

### 音声認識(Whisper)の置き場所
- `GET /voice/placement`(read): GPU の一覧と、現在のモデル、デバイス、GPU 番号、ワーカーのアドレス。
- `POST /voice/placement/stt`(admin): `{"model":"large-v3-turbo","device":"cuda","device_index":1,"url":"","token":"<ワーカーの合言葉。任意>"}`。モデルは `tiny / base / small / medium / large-v3 / large-v3-turbo / distil-large-v3` など。`url` が空なら、Aria のあるPCで動かす。変更は保存され、再起動後も有効。

### 声
- `GET /voices`(read): 声モデルの一覧。名前、権利表示(`license`)、話者とスタイルの ID。スタイル ID を、通話の `settings.voice`(アプリの `voice` 設定)に入れると、その声で話す。
- `POST /voices/models?name=<ファイル名>.aivmx`(admin): 本文に `.aivmx` のバイト列をそのまま送る(`Content-Type: application/octet-stream`)。上限 300 MB、拡張子は `.aivmx` のみ。
- `DELETE /voices/models/<uuid>`(admin): 削除(ファイルも消える)。
- `tts_mode`: `balanced`(AivisSpeech、音質重視)、`fast`(piper-plus、つくよみちゃん。低遅延)。入っているモードは、通話の `ready.tts_modes` で分かる。「つくよみちゃん」は、コーパスの利用規約(クレジット表記、用途の制限)に従う必要がある、と画面に小さく書く。
- 声モデルには、権利表示(`license`)がある。一覧に必ず出す。

## 作業の分担(4つ。担当ファイルは、重ならない)

### 作業 M: モデルの選択(`VoiceModelsCard`)
- 担当ファイル: `app/src/components/VoiceModelsCard.tsx`(今は何も出さない入口。ここを実装する)、`app/src/voice/ariaModels.ts`(純粋な解析)、`app/src/i18n/voiceModelStrings.ts`、`app/src/__tests__/ariaModels.test.ts`。
- 内容: `adminToken` が空なら、カード全体は何も出さない(または、「管理用トークンを入れると使えます」の1行だけ)。あるときは、(1) `GET /llm/endpoints` で、役割 `fast` / `deep` の、現在の接続先とモデル、使用量を表示。(2) `GET /llm/models?endpoint=` で、モデルを選ぶ一覧。(3) 選んだら `POST /llm/model`(`target:"role"`)。成功・失敗を表示し、失敗の理由(400 の `available` を含む)を見せる。(4) 「Whisper の置き場所」: `GET /voice/placement` で、現在の値と GPU 一覧、`POST /voice/placement/stt` で変更(モデルは選択式、デバイスは `cuda` / `cpu`、GPU 番号は一覧から、ワーカーのアドレスは入力欄。ワーカーの合言葉は伏せ字)。
- 応答の形は未確認なので、解析関数を `ariaModels.ts` に分けて、いろいろな形の入力でテストする(欠けたフィールド、未知のフィールド、配列かオブジェクトか、など)。

### 作業 V: 声の管理(`VoiceVoicesCard`)
- 担当ファイル: `app/src/components/VoiceVoicesCard.tsx`(今は何も出さない入口)、`app/src/voice/ariaVoices.ts`(純粋な解析と、アップロードの検査)、`app/src/i18n/voiceVoiceStrings.ts`、`app/src/__tests__/ariaVoices.test.ts`。
- 内容: (1) `GET /voices`(read。`token`(chat)で足りる)で、声モデルの一覧(名前、権利表示、話者とスタイル)を表示し、スタイルを選ぶと、`setDevice({ voice: { voice: <スタイルID> } })` で保存する(今の選択に印を付ける。「サーバーの既定に戻す」も付ける)。(2) `adminToken` があるときだけ、「声モデルを追加」(ファイル選択 → `.aivmx` のみ、300 MB 以下を、送る前に検査 → `POST /voices/models?name=` に、本文として、そのまま送る。進み具合を出す。Web は `<input type="file">`、ネイティブは、既に入っている選択の仕組みがあればそれを使い、新しいパッケージは入れない)と、「削除」(確認ダイアログ → `DELETE /voices/models/<uuid>`)。
- 権利表示は、一覧に必ず出す。

### 作業 O: Opus と、通話中の設定の即時反映
- 担当ファイル: `app/src/voice/voiceEngine.web.ts`(第1段の実装を拡張)、`app/src/voice/opusCodec.web.ts`(新規)、`app/src/screens/VoiceCallScreen.tsx`、`app/src/voice/ariaProtocol.ts`(必要な最小限の追加のみ)、関連のテスト、`app/src/i18n/voiceCallStrings.ts`。
- 内容: (1) 通話中に設定を変えたら、`updateSettings(values, true)` を送って、すぐ反映する(今は、通話を開き直すと反映)。通話画面に、設定のパネル(速さ、間、会話の間、割り込みの感度、声のモード。`ready.ttsModes` に無いモードは選べない)。(2) Opus: `hello` の `codec:"opus"` に対応する(`VoiceSettings` に `codec: 'pcm16' | 'opus'` を追加する。既定は `pcm16`)。Web の `AudioDecoder` / `AudioEncoder`(WebCodecs)が使えるときだけ。受信は、バイナリ1つが 20 ms のパケット(48 kHz、約 32 kbps)。送信は、16 kHz か 48 kHz の Opus 20 ms フレーム(契約書は、送信の Opus を「16 kHz PCM16 または Opus 20 ms」としている)。使えない環境では、自動で `pcm16` に戻す。(3) 切断・再接続の扱い(接続が切れたら、画面に出し、「もう一度つなぐ」ボタン)。
- 設定のパネルと、`VoicePage` の設定は、同じ `deviceSettings.voice` を使う(重複した入力欄を作らない。パネルは、通話に影響する値だけ)。

### 作業 A: Android(ネイティブ)の音声エンジン
- 担当ファイル: `app/src/voice/voiceEngine.native.ts`(新規。今の `voiceEngine.ts` は、`supported=false` の代替)、`app/app.json` と `app/package.json`(必要な最小の追加)、関連のテスト、`docs/design/ARIA-VOICE-ANDROID.md`(選んだ方法の理由)。
- 内容: React Native(Expo)のアプリで、マイクを 16 kHz モノラル PCM16 のストリームで取り込み、受信した PCM16 をすぐ再生する。エコー除去(Android の `VOICE_COMMUNICATION` 入力)を有効にする。候補は、`react-native-audio-api`(Software Mansion。Web Audio 互換)、`expo-audio-stream` など。まず、アプリの Expo の版(`app/package.json`)で動くか、メンテされているか、Web 版の `voiceEngine.web.ts` とほぼ同じ作りで書けるか、を調べて、1つ選ぶ。選んだ理由を `ARIA-VOICE-ANDROID.md` に書く。
- 守ること: `expo export --platform web` が、今までどおり通ること(ネイティブ用のモジュールを、Web のバンドルに入れない。`.native.ts` の拡張子で分ける)。`voiceEngine.ts` の API(`createCall` / `supported` / 型)は変えない。ネイティブの依存は、`app.json` の `plugins` に必要な設定(マイクの権限の文言を含む)を入れる。
- 検証: クラウドでは、実機でのビルドと動作の確認ができない。型チェック、全テスト、`expo export --platform web` までを確認し、Android のビルドと実機は「未確認」と書く。Android のビルド(`packaging/local/build-android.sh`)は、あとで、手元のPCで行う。

## 返すもの
- 各作業の、変更したファイルの一覧、確認したこと(型チェックとテストの件数)、確認していないこと、仕様とずれた点。
