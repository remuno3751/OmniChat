# 設計: 添付(画像・ファイル・音声)と自動削除

状態: **実装中**(2026-10-19)。決めてほしい点は、既定値を置いて進め、最後の「既定値と、あとで変えられる点」にまとめた。

## 目的
チャットに、画像、文書(pptx / docx / xlsx / pdf / md / txt / csv など)、音声を添付して、AI に読ませる。**画像が読めないモデルでは、「読み込めない場合があります」と警告する。** 保存期間(自動削除)を設定できる。

## 保存
- ファイルはサーバーのディスク(`<DATA_DIR>/attachments/<userId>/<attachmentId>`、拡張子なし。内容は変更しない)。メタ情報は表 `attachments`。
- 表 `attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT, message_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL /* image|document|audio|other */, size INTEGER NOT NULL, sha256 TEXT NOT NULL, text_path TEXT /* 抽出済みテキスト(あれば) */, text_chars INTEGER, transcript TEXT, status TEXT NOT NULL DEFAULT 'ready' /* ready|deleted */, created_at INTEGER NOT NULL, deleted_at INTEGER, seq INTEGER NOT NULL)`。
- 添付は、アップロード時は「未接続」(`message_id` が NULL)。メッセージの送信で接続する。24 時間たっても接続されない添付は、自動で消す。
- 重複は、同じユーザーの同じ内容(sha256)なら、ファイルを共有してよい(実装は任意。まずは共有しない)。

## 上限と形式(管理者設定。サーバー設定 `attachments`)
| 設定 | 既定 | 意味 |
|---|---|---|
| `maxFileMB` | 25 | 1 ファイルの上限 |
| `quotaMB` | 2048 | 1 ユーザーの保存の合計の上限(`0` = 無制限)|
| `retentionDays` | 0 | 0 = 無期限。N 日たった添付を、ファイルごと削除する |
| `maxPerMessage` | 10 | 1 メッセージの添付数 |
| `extractMaxChars` | 60000 | 文書から AI へ渡すテキストの上限(超えたら切って、その旨を添える) |
| `transcribeModel` | なし | 音声の文字起こしに使うモデル(`<providerId>::<model>`)。なしなら、音声は保存できるが、AI には渡せない |
許可する形式: 画像(png / jpeg / webp / gif)、文書(pdf、docx、pptx、xlsx、md、txt、csv、json、xml、html、よくあるソースコードの拡張子)、音声(wav、mp3、m4a、ogg、webm、flac)。**拡張子と中身(マジックナンバー)の両方を見る**。実行ファイルや、アーカイブ(zip など)は拒否する。表示名は、パスの区切りや制御文字を取り除く。

## API
- `POST /attachments`(認証あり): 本文は、ファイルのバイト列そのもの(`Content-Type` はファイルの MIME。新しい依存を増やさないため、multipart にしない)。ファイル名は `X-File-Name`(URL エンコード)。応答 `{ attachment: { id, name, mime, kind, size, textChars, status, vision?: ... } }`。上限・形式・容量の超過は 413 / 415 / 507 とエラーコード(`attachment_too_large`、`attachment_type_not_allowed`、`attachment_quota_exceeded`)。メンテナンスモードの一般ユーザーは遮断しない(閲覧と同じ扱い)。
- `GET /attachments/:id`: 所有者のみ(他人・共有でも 404)。`Content-Disposition`、`X-Content-Type-Options: nosniff`、画像以外は `attachment` 扱い(ブラウザで実行させない)。HTML や SVG を、同じオリジンで描画させない。
- `DELETE /attachments/:id`: 所有者のみ。ファイルを消し、メタを `deleted` に。メッセージは残り、添付は「(削除済み)」と表示する。
- `GET /attachments?conversationId=`: 一覧(メタのみ)。
- 管理者設定: 既存のサーバー設定(`general` と同じ作法)の `attachments` を `GET/PUT /admin/attachments`。

## メッセージとの関係
- WS の `send`(と `regenerate` の元メッセージ)に `attachmentIds: string[]`。サーバーは所有者・状態(ready)・数を検査して、メッセージに接続する。メッセージの JSON に `attachments: [{ id, name, mime, kind, size, status }]`(同期にも乗る。本文は含まない)。
- 会話の削除・メッセージの削除で、接続された添付も削除する。
- **分岐(再生成・編集して再送)**: 添付は元のメッセージに付いたまま、枝で共有する(コピーしない)。

## AI へ渡す内容
- 画像: モデルが画像を読めると分かっているときだけ、OpenAI 互換の `image_url`(data URL。大きい画像は、長辺 2048px 以下・JPEG に縮小してよい。縮小は新しい依存が要るので、**まずは縮小しない**)で渡す。読めない/不明なときは、渡さず、メッセージに「[画像 name は、このモデルでは読めません]」を添える。
- 文書: サーバーで本文を抽出し(下記)、そのメッセージの `[添付: name]` ブロックとして、ユーザー発言の前に付ける。`extractMaxChars` で切り、切ったときは `(以下省略: 全 N 文字中 M 文字)` と書く。抽出は、アップロード時に 1 回だけ行って保存する(`text_path`)。
- 音声: `transcribeModel` があれば、アップロード時に文字起こしして `transcript` に保存し、文書と同じ形で渡す。なければ、渡さない(警告を出す)。
- コンテキスト(`context.ts`)の見積もりに、抽出テキストと画像(1 枚あたり固定 800 トークンの見積もり)を含める。

## 画像が読めるか(ビジョン対応)の判定
プロバイダーのモデル一覧のメタ情報から、`vision: "yes" | "no" | "unknown"` を決める。
- `architecture.input_modalities` に `image` がある(Strata、llama-swap 経由の Bonsai)→ yes、ない → no。
- `modalities.vision`(llama.cpp の `/props`)が true → yes、false → no。
- Ollama の `capabilities` に `vision` → yes。LM Studio の `vision: true` → yes。
- DSH のモデル定義の `input` に `image` がある → yes。
- どれも無ければ unknown。**unknown と no のときは、添付前に警告を出す**(「このモデルは画像を読めない場合があります」)。モデルが画像を拒否したときの上流エラーは、そのまま表示する。
- 管理者・ユーザーが、モデルごとに上書きできる(`modelVision[<providerId>::<model>]` = true/false。既存の `modelParams` の作法)。

## 文書からのテキスト抽出(サーバー側、新しい依存は最小限)
- txt / md / csv / json / xml / html / コード: UTF-8 として読む(BOM と文字コードの判定は、UTF-8 と Shift_JIS だけ)。html はタグを除く。
- docx / pptx: `jszip`(導入済み)で XML を開いて、本文を抽出(スライドごとに `--- スライド N ---`、ノートも)。
- xlsx: `exceljs`(導入済み)で、シートごとに表を TSV にする(行・列の上限あり)。
- pdf: テキスト層のみ。`pdfjs-dist`(Apache-2.0)の、Node 向けの最小の使い方。新しい依存なので、`THIRD_PARTY_NOTICES.txt` に追加する。ページごとに `--- ページ N ---`。スキャン PDF(文字が取れない)は、「文字が取れませんでした」と伝える(OCR は対象外)。
- 抽出は、サイズと時間に上限を付ける(悪意のあるファイルでサーバーが止まらないように)。失敗したら、添付は残し、`text_chars = 0` と警告で返す。

## 自動削除
- 日次の処理(起動時と、24 時間ごと)。`retentionDays > 0` のとき、`created_at` から N 日たった `ready` の添付を、ファイルごと削除し、`status = 'deleted'`、メッセージには「(削除済み)」と出る。未接続のまま 24 時間たった添付も削除。
- 管理者設定の変更は、次の処理から有効。**削除前の予告**はしない(設定画面に「N 日たった添付は、自動で削除されます。元に戻せません」と明記する)。
- バックアップ(`backup.ts`)には、既定では添付のファイルを含めない(DB のみ)。含めるかは、管理者の選択にする(次の段階)。

## セキュリティ
- 他人の添付は、読み書きできない。ID が推測できても(UUID)、所有者でなければ 404。
- ファイル名・MIME・サイズは、サーバーで検証し直す(クライアントを信用しない)。
- 配信時は、スクリプトを実行させない(上の API の節)。
- ログに、ファイルの中身・抽出テキストを出さない。
- 共有プロバイダー経由でも、添付は利用者のもの(管理者のキーでモデルを呼ぶが、添付は管理者に見えるようにしない)。

## クライアント
- 添付ボタン(画像・ファイルの選択。Web は `<input type=file>`、ネイティブは `expo-image-picker` / `expo-document-picker`)、貼り付け(Web)、ドラッグ&ドロップ(Web)。
- 入力欄の上に、添付のチップ(名前、サイズ、進捗、削除ボタン、画像は小さなサムネイル)。
- 画像が読めないモデルのとき、チップに警告(アイコン + 文言)。
- メッセージの吹き出しに、添付(画像はサムネイル。タップで拡大。文書・音声はファイル名とサイズ)。削除済みは「(削除済み)」。
- 設定: 管理者向けに、サーバー設定の「添付」カード(上の表)。ユーザー向けに、自分の添付の一覧と、容量の使用量、個別の削除。

## 既定値と、あとで変えられる点
上の表の既定値は、決めてほしいことを置いた仮の値で、管理者設定で変えられる。保存期間の既定を無期限にしたのは、「勝手に消える」より「ディスクが増える」のほうが、被害が小さいため。

## Code / DSH での添付

Code(dsh-bridge)の会話でも、文書は添付できる。画像と音声は、AI に渡せないので、添付させない。

### 決め方
- **bridge の `run` フレームには、テキスト(`prompt`)しかない**(`server/src/providers/dsh-bridge.ts` → `bridges.ts` `runOnBridge`、`bridge/src/bridge.ts`)。画像・音声を入れる欄はなく、プロトコルを増やすのは今回の範囲外。そのため、**画像・音声は、モデルが読める(`vision: yes`)かどうかに関係なく、Code では渡さない**。
- 文書は、チャットと同じ抽出テキスト(`attachments-extract.ts`)を使う。ファイルは作らない(作業フォルダに書き込まない)。
- 添付は、所有者だけが使える(他人の添付 ID は `attachment_not_found`)。メッセージの接続・分岐・編集して再送は、チャットと同じ(`checkClaim` / `claimAttachments`)。
- Code の会話の分岐・再生成は、もともと拒否される(linear)。編集して再送(既存の user メッセージ)は、添付をそのまま使う。

### 送信時の検査(サーバー `chat.ts` `handleSendInner`)
- 会話のプロバイダーが `dsh-bridge` で、添付に文書以外(画像・音声・その他)が 1 つでもあれば、**何も保存せず** `{ type: "error", code: "attachment_invalid", message: "attachment_not_supported_in_code: Code では画像・音声は AI に渡されません", messageId }` を返す。上流は呼ばない。
- 検査は、既存の所有者・状態・数の検査(`checkClaim`)の後、メッセージを保存する前に行う。

### プロンプトの組み立て(`attachments-chat.ts` `buildWire` / `codeDocumentNote`)
- 文書は、ユーザー発言の前に `[添付: name]` + 抽出テキストのブロックとして入る。形式はチャットと同じ。
- 1 件ごとの上限は、チャットと同じ `extractMaxChars`(切ったときは `(以下省略: 全 N 文字中 M 文字)`)。
- **1 メッセージの合計も `extractMaxChars` で抑える**(Code の文書だけの合計。超えた分の文書は残りの字数だけ入れ、残りが 0 なら本文を入れず省略の印だけ書く)。
- 削除済みの文書は `[添付: name(削除済み)]`。画像・音声が来た場合(防御的な経路。通常は送信前に拒否される)は `[添付: name(Code では AI に渡せません)]`。

### クライアント(`app/src/attachments.ts` の `splitForCode` / `codeChipRefused` / `codeSendBlocked`)
- Code の会話では、添付メニューの「写真」を出さない。「ファイル」で画像・音声を選んでも、追加せずに「Code では画像・音声は添付できません(N 件は追加されませんでした)」と知らせる。貼り付け・ドロップも同じ。
- 画像・音声のチップ(失敗していないもの)には、チップに警告「Code では画像・音声は AI に渡されません。削除してください」を出す。このチップがあるあいだは送信を止める(入力欄の文字は残る)。
- 画像が読めないモデルの警告・音声の文字起こしの注意は、Code では出さない(Code では画像・音声を渡さないことが、その前の段階で決まるため)。
- 会話が Code かどうかは、`conv.mode === 'code'`(下書きは `draftMode`)で決める。

### 変えないこと
- 所有者だけが見られる、という規則。管理者設定(`attachments` の値)の意味・既定値。
- Code のロック(`codeLock`)とメンテナンスモード: 添付の送信は、従来どおり `maintView.blocksSend` と `canSendAttachments` の条件のまま。Code のロック(Code の画面を開けない・動かせない条件)には触らない。

### 未対応(あとで)
- 画像・音声を Code に渡す: bridge のプロトコル(`run` に添付を載せる欄)と、`bridge/` の受け側が要る。それまでは、画像が読めるモデルでも Code では渡さない。
- Code の会話の添付を、作業フォルダに置く案は採らない(ユーザーのフォルダへの書き込みになるため)。
