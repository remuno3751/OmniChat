# Aria 音声通話 第3段: 追加決定(2026-10-26 午後)

[ARIA-HOST.md](ARIA-HOST.md) への変更と追加です。**食い違うときは、この文書が優先**です。

## 変更1: 声モデルの窓口を 2 つに分ける
- **標準モード(`tts_mode: balanced`、AivisSpeech)**: `.aivmx` をアップロードする窓口。
- **Fast モード(`tts_mode: fast`、piper-plus)**: `.onnx`(piper の声モデル。設定の `.json` が要る場合は、ONNX と一緒に受け取る)をアップロードする窓口。
- サーバーの API: `POST /voice/voices/models?name=<ファイル名>&kind=aivmx|piper`(`kind` 省略時は、拡張子から: `.aivmx` → `aivmx`、`.onnx` → `piper`)。一覧は `GET /voice/voices` が `kind` を付けて返す(`aivmx` / `piper`)。`DELETE /voice/voices/models/:uuid` は、同じ。`voice_models` テーブルに `kind` の列を足す。
- piper の取り込みの、Aria 側の API(アップロード先、一覧、削除、声の選び方)は、Aria 側に確認中。決まるまでは、サーバーは、`kind=piper` を、「Aria 側の対応待ち」として `501 {code:"not_supported_yet"}` で返す(インターフェースと画面は作る)。`.zip` の変換案は、取り下げ(使わない)。
- クライアントとサーバーの画面: 窓口は、声のモードごとに 2 つ(標準 = `.aivmx` の選択、Fast = `.onnx` の選択)。拡張子の検査は、1か所の関数にまとめる。

## 変更2: LLM は、ユーザー一律
- **ユーザーごとの LLM の割り当て、ユーザーが選べる LLM の一覧(`allowedLlm`)、`VOICE_LLM_ALLOWED` は、やめる**(ARIA-HOST.md から削除)。`llm_endpoint` / `llm_model` の、接続ごとの上書きも、使わない。
- 通話で使う LLM は、**管理者が GUI で指定する**(Server アプリの「音声通話」ページ。役割 `fast`(通話の返事)と `deep`(背景思考)のモデルを、選択式で指定)。`PUT /voice/admin/llm/roles` が、Aria の `POST /llm/model`(`target:"role"`)を呼ぶ。`GET /voice/admin/llm` は、役割、接続先、モデルの一覧、使用量を返す。`voice_user_prefs` の `llm`、`/voice/admin/users/:id/llm`、`/voice/admin/llm/allowed` は、なくす。
- クライアントの設定から、LLM の選択をなくす。

## 追加機能(すべて実装する)
1. **プライバシー: 「この通話は、履歴に残さない」**: 通話の開始前のスイッチ(通話バーと設定の既定)。サーバーは、`WS /voice/ws?...&private=1` のとき、メッセージの保存と会話の作成をしない(Aria にも、`?user=` ではなく、`private:<ユーザーID>` のような別のユーザー名で、記憶を分ける案があるが、Aria 側に確認中。まずは、OmniChat の履歴に残さないことだけ)。通話バーに「記録なし」の表示。
2. **会話のタイトルの自動生成**: 通話が終わったら、会話のタイトルが、まだ仮のもの(「通話 HH:mm」など)なら、既存のタイトル生成の仕組み(`autoTitle`)で、通話の内容から付ける。
3. **通話中の文字起こしの、編集と削除**: 通話のメッセージは、普通のチャットのメッセージ。既存の、メッセージの削除と編集の操作を、通話のメッセージにも出す(クライアント)。聞き間違いの直しと、1発話だけの削除。
4. **押している間だけ話す(プッシュトゥトーク)**: 通話バーのボタンと、キー(スペース)を押している間だけ、マイク音声を送る。設定で、オン / オフ(既定はオフ)。**ウェイクワード**は、Aria 側(音声認識)の対応が要るので、Aria に確認中。決まるまでは、設定の項目だけ作り、「準備中」と出す。
5. **使用量**: 通話の時間(秒)と、ターン数を、ユーザーごとに集計(テーブル `voice_usage(user_id, day, call_seconds, turns)`)。`GET /voice/usage`(本人)と、管理者向けのユーザー別の一覧を、既存の「使用量」ページと Server アプリの「音声通話」ページに出す。管理者が、ユーザーごと・1日あたりの通話時間の上限(分)を設定でき、超えたら、新しい通話を `4429 quota` で断る(既存のクォータの仕組みに合わせる)。トークンの使用量は、Aria の `turn_end.stats` に、トークン数があれば、記録する(無ければ、時間とターン数だけ)。
6. **通話の失敗の診断と、遅延の表示**: `GET /voice/diagnose`(本人。サーバー側の検査の一覧: Aria に届く、`/health` の `status`、`/voice/placement` の Whisper の状態、`tts_modes` に `balanced` / `fast`、LLM の役割の接続)を、`[{id, ok, message, hint}]` で返す。クライアントの通話画面と、設定の「音声通話」に、「診断」ボタン(マイクの権限、WebSocket の接続、`ready` までの時間もクライアント側で検査)。中継は、「文字を送って(または、発話の終了から)最初の `audio` が届くまで」の時間を測り、`{type:"omni_stats", latencyMs}` の JSON を、クライアントに流す(Aria の JSON と区別するため、`type` は `omni_` で始める)。通話バーに、直近の遅延を、小さく表示。
7. **声の試聴**: 声を選ぶ前や、アップロードの直後に、短い文を読み上げさせて、聞ける。`POST /voice/preview {text?, voice?, ttsMode?}` → 音声(PCM16 の WAV)を返す。Aria 側に、読み上げだけの REST があるかを確認中。ない間は、試聴は、「通話中のテキスト送信 → 返事の音声」で代用する(通話中だけ、「この声で話す」の確認)。サーバーは、Aria に REST がなければ `501 {code:"not_supported_yet"}`。
8. **(対象外)Mac / Android でのセルフホスト**: Aria が Windows 専用のため。外部の Aria(`mode: external`)で代用。

## 作業の分担の、変更点
- **S(サーバー)**: 上の「変更1・2」と「追加機能 1(サーバー側)、2、5、6(サーバー側)、7(サーバー側)」。`kind`、`voice_usage`、クォータ、`/voice/diagnose`、`/voice/usage`、`/voice/preview`、`omni_stats`、`private=1`。
- **C(クライアント)**: 「変更1・2」の画面(2 つの窓口、LLM の選択の削除)、「追加機能 1(スイッチ)、3、4、6(診断ボタンと遅延の表示)、7(試聴ボタン)」、使用量の表示(本人の通話時間)。
- **H(Server アプリ)**: 「変更1」(声モデルの管理に、`kind` の列と、2 つの一覧)、「変更2」(LLM の管理は、役割 `fast` / `deep` のモデルの GUI 指定のみ。ユーザーごとの LLM の画面は、作らない)、「追加機能 5(ユーザー別の使用量と、上限の設定)、6(診断の表示)」。

## Aria 側の確認事項(別セッションで回答待ち)
(a) piper-plus の声モデル(`.onnx` + 設定)の、アップロード・一覧・削除・選択の REST API。(b) 読み上げだけの REST(試聴用)。(c) ウェイクワード。(d) `?user=` を、記憶を共有しない別名にする、プライバシー用の使い方。(e) `turn_end.stats` に、トークン数の有無。
