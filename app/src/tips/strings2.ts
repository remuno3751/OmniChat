// Tip texts for SECTIONS_2 (modelload, context, themes, privacy) and WHATS_NEW. Keys must match in en and ja.
// Every claim was checked against the code (see the commit history and the named files) before it was written here.

export const en: Record<string, string> = {
  // ---- modelload ----
  'tips.modelload.choices.title': 'When another model is already loaded',
  'tips.modelload.choices.body': 'LM Studio or Ollama may already have a different chat model loaded. The dialog offers: Unload, then load (recommended); Use the already-loaded model; Load both (uses much more memory); or Cancel, which keeps your message in the composer.',
  'tips.modelload.choices.kw': 'model, load, unload, memory, VRAM, LM Studio, Ollama, モデル, 読み込み, アンロード, メモリ',

  'tips.modelload.default.title': 'Set a default choice',
  'tips.modelload.default.body': 'Settings > Chat > Model loading sets what happens on this device. Always ask (the default) shows the dialog every time. The dialog also has Remember my choice.',
  'tips.modelload.default.kw': 'model loading, policy, default, remember, 既定, 覚える, 読み込み',

  'tips.modelload.scope.title': 'Per device, chat only',
  'tips.modelload.scope.body': 'The setting is saved on this device only. The Code tab is not affected.',
  'tips.modelload.scope.kw': 'device, code tab, per device, 端末, コードタブ',

  'tips.modelload.connect.title': 'Getting started: connect a model',
  'tips.modelload.connect.body': 'Settings > Models can find LM Studio or Ollama running on this PC and add it in one tap. For cloud models, enter an API key instead.',
  'tips.modelload.connect.kw': 'LM Studio, Ollama, provider, プロバイダー, 接続, 検出, はじめに, connect, setup',

  // ---- context ----
  'tips.context.bar.title': 'Context bar',
  'tips.context.bar.body': 'The bar above the composer shows how full the context window is. Tap it for details: the limit, how much is kept for the reply, and a manual limit if the server does not report one.',
  'tips.context.bar.kw': 'context, window, tokens, limit, bar, コンテキスト, 上限, トークン, バー',

  'tips.context.compact.title': '/compact',
  'tips.context.compact.body': 'Summarizes older messages to free up context. Add a focus after the command to steer the summary. Needs a chat with messages, and is not available in the Code tab.',
  'tips.context.compact.example': '/compact keep the API decisions',
  'tips.context.compact.kw': 'compact, summarize, summary, free context, 圧縮, 要約, コンテキスト, 空き',

  'tips.context.auto.title': 'Auto-compress',
  'tips.context.auto.body': 'When the prompt reaches 80% of the context limit, the oldest exchanges are replaced by one summary note, and the prompt is shortened down to 50%. Both values are set in Settings > Chat. Clear "Compress when the prompt reaches" to turn it off. It needs Drop oldest or Summarize as the overflow mode.',
  'tips.context.auto.kw': 'auto compress, compression, summary, 80%, 50%, 自動圧縮, 圧縮, 要約',

  'tips.context.overflow.title': 'When the context is full',
  'tips.context.overflow.body': 'Drop oldest (the default) leaves the oldest exchanges out of the request. Summarize replaces them with a summary note. Stop does not send the new message and shows an overflow notice. Your chat history is never deleted; messages are only left out of the request.',
  'tips.context.overflow.kw': 'overflow, drop oldest, summarize, stop, full, 超過, 古いものを削除, 要約, 停止',

  'tips.context.usage.title': '/usage and the Usage screen',
  'tips.context.usage.body': '/usage today, week, month or all shows token totals in the chat. The Usage screen adds tokens per day, top chats and a breakdown by model. Ephemeral chats are not counted.',
  'tips.context.usage.example': '/usage week',
  'tips.context.usage.kw': 'usage, tokens, statistics, per day, per model, 使用量, トークン, 統計',

  // ---- themes ----
  'tips.themes.names.title': 'Three themes',
  'tips.themes.names.body': 'Simple is the plain default. Frontier and Astral each have their own colors, fonts and decorations. Pick one in Settings > Appearance.',
  'tips.themes.names.kw': 'theme, simple, frontier, astral, look, テーマ, シンプル, フロンティア, アストラル',

  'tips.themes.mode.title': 'Light, dark or system',
  'tips.themes.mode.body': 'Mode follows the system by default. You can also pick Light or Dark. Simple additionally offers Sepia and High contrast.',
  'tips.themes.mode.kw': 'light, dark, system, sepia, contrast, ライト, ダーク, システム, セピア, ハイコントラスト',

  'tips.themes.motion.title': 'Animation amount',
  'tips.themes.motion.body': 'Off turns off transitions, popups and press effects, as does the OS reduce-motion setting. Reduced is lighter for slow phones. The reply text animation (Smooth or Particles) is a separate setting, and Off here disables it too.',
  'tips.themes.motion.kw': 'animation, motion, reduce motion, particles, smooth, アニメーション, 動き, 粒子, 控えめ',

  'tips.themes.size.title': 'Font size and message width',
  'tips.themes.size.body': 'Font size ranges from 12 to 24 (default 16). Message width ranges from 560 to 1200 (default 820). Both are saved per device.',
  'tips.themes.size.kw': 'font size, text size, width, message width, 文字サイズ, 幅, メッセージの幅',

  'tips.themes.pets.title': 'Pets',
  'tips.themes.pets.body': 'Turn on Show pet in Appearance. No pet is bundled with OmniChat. In the web app you can import your own pet files (pet.json and a spritesheet).',
  'tips.themes.pets.kw': 'pet, pets, sprite, animal, ペット, 表示',

  // ---- privacy ----
  'tips.privacy.server.title': 'Where chats are stored',
  'tips.privacy.server.body': 'Chats, the search index, usage statistics and synced settings are kept in one SQLite database on the server: omnichat.db in DATA_DIR (default ./data).',
  'tips.privacy.server.kw': 'data, database, sqlite, storage, DATA_DIR, privacy, データ, データベース, 保存, プライバシー',
  'tips.privacy.admin.title': 'Server administration',
  'tips.privacy.admin.body': 'Administrators see Settings > Server: change the server name and registration, manage accounts, check the network, restart, view logs and the audit list of every change. Passwords and keys are never shown.',
  'tips.privacy.admin.kw': 'admin, administrator, server, users, registration, restart, audit, logs, 管理者, サーバー管理, ユーザー, 監査, 再起動',

  'tips.privacy.apikeys.title': 'API keys are stored in plain text',
  'tips.privacy.apikeys.body': 'Provider API keys are saved in plain text in the server database and are included in backups. The app never shows them again. The JSON export leaves them out. Protect the data folder and any backup files.',
  'tips.privacy.apikeys.kw': 'api key, secret, token, plain text, backup, API キー, 平文, バックアップ',

  'tips.privacy.device.title': 'This device or your account',
  'tips.privacy.device.body': 'Display settings such as theme, font size, animation, language and the model-loading choice stay on this device. Chat settings such as the system prompt, effort and context settings are synced through the server. Unsent drafts are kept on this device.',
  'tips.privacy.device.kw': 'device, sync, synced, draft, storage, 端末, 同期, 下書き',

  'tips.privacy.ephemeral.title': 'Ephemeral chats leave no trace',
  'tips.privacy.ephemeral.body': 'Messages stay only in server memory and on screen. They are not saved to the database, search, exports, backups or logs. They are deleted when you leave, end the chat, go idle (30 minutes by default) or log out. Your AI provider may still keep a copy of what you send.',
  'tips.privacy.ephemeral.kw': 'ephemeral, temporary, not saved, incognito, 消える, 一時, 履歴に残さない',
  'tips.privacy.ephemeral.btn': 'Start an ephemeral chat',

  'tips.privacy.export.title': 'Export and backup',
  'tips.privacy.export.body': 'Export one chat as Markdown or JSON from its menu. Under Connections > History and data, "Data: export / import" exports everything as JSON. Imports always create new IDs. Server backups are made by the administrator.',
  'tips.privacy.export.kw': 'export, import, backup, download, JSON, Markdown, エクスポート, インポート, バックアップ',

  // ---- what's new ----
  'tips.new.tips.title': 'Tips and shortcuts sheet',
  'tips.new.tips.body': 'A searchable help sheet with tips, keyboard shortcuts, slash commands and links to the matching settings.',
  'tips.new.modelload.title': 'Model loading choices',
  'tips.new.modelload.body': 'When LM Studio or Ollama already has another model loaded, choose to unload it, use the loaded model, or load both. Set a default in Settings > Chat.',
  'tips.new.slash.title': 'Slash commands and usage',
  'tips.new.slash.body': '/compact, /context, /usage, /retry, /export, /model and more. Type / in the composer to see the list. /usage shows token totals for a period.',
  'tips.new.animation.title': 'Animation amount and reply effects',
  'tips.new.animation.body': 'Choose Off, Reduced, Standard or Rich. Replies can fade in smoothly or as particles (web only).',
  'tips.new.themes.title': 'Three themes',
  'tips.new.themes.body': 'Simple, Frontier and Astral, with Light, Dark and System modes.',
  'tips.new.dsh.title': 'DSH pairing by approval',
  'tips.new.dsh.body': 'On the web, press Connect and allow OmniChat in DeepSeek Harness. No code to copy.',
  'tips.new.ephemeral.title': 'Ephemeral chats',
  'tips.new.ephemeral.body': 'Chats that leave no history. Nothing is saved to the database, search or exports, and the chat is deleted when you leave it.',
  'tips.new.artifacts.title': 'Word, Excel, PowerPoint and email artifacts',
  'tips.new.artifacts.body': 'Replies can include Word, PowerPoint, Excel and email (.eml) artifacts, each with a preview.',
};

export const ja: Record<string, string> = {
  // ---- modelload ----
  'tips.modelload.choices.title': '別のモデルが読み込まれているとき',
  'tips.modelload.choices.body': 'LM Studio や Ollama に、別のチャット用モデルが読み込まれていることがあります。ダイアログの選択肢は、「読み込み済みのモデルをアンロードしてから読み込む」(推奨)、「読み込み済みのモデルを使う」、「両方を読み込む」(メモリを多く使います)、「キャンセル」(メッセージは入力欄に戻ります)です。',
  'tips.modelload.choices.kw': 'モデル, 読み込み, アンロード, メモリ, VRAM, LM Studio, Ollama, model, load',

  'tips.modelload.default.title': '既定の動作を決める',
  'tips.modelload.default.body': '設定 > チャット > モデルの読み込み で、この端末の既定の動作を決められます。「毎回確認する」(初期値)にすると、毎回ダイアログを表示します。ダイアログの「選択を覚えておく」でも設定できます。',
  'tips.modelload.default.kw': 'モデルの読み込み, 既定, 覚える, policy, default, remember',

  'tips.modelload.scope.title': '端末ごと・チャットのみ',
  'tips.modelload.scope.body': 'この設定はこの端末にだけ保存されます。コードタブには影響しません。',
  'tips.modelload.scope.kw': '端末, コードタブ, device, code tab',

  'tips.modelload.connect.title': 'はじめに: モデルをつなぐ',
  'tips.modelload.connect.body': '設定 > モデルで、同じ PC の LM Studio / Ollama を自動検出して追加できます。クラウドの場合は API キーを入力します。',
  'tips.modelload.connect.kw': 'LM Studio, Ollama, provider, プロバイダー, 接続, 検出, はじめに, connect, setup',

  // ---- context ----
  'tips.context.bar.title': 'コンテキストバー',
  'tips.context.bar.body': '入力欄の上のバーは、コンテキストウィンドウがどれだけ埋まっているかを示します。タップすると詳細が開きます。上限、返信のために残してある量、サーバーが上限を報告しないときの手動の上限を確認できます。',
  'tips.context.bar.kw': 'コンテキスト, ウィンドウ, トークン, 上限, バー, context, tokens, limit',

  'tips.context.compact.title': '/compact',
  'tips.context.compact.body': '古いメッセージを要約して、コンテキストの空きを作ります。コマンドの後に重点を書くと、要約の内容を指定できます。メッセージのあるチャットで使え、コードタブでは使えません。',
  'tips.context.compact.example': '/compact API の決定事項を残す',
  'tips.context.compact.kw': '圧縮, 要約, コンテキスト, 空き, compact, summarize',

  'tips.context.auto.title': '自動圧縮',
  'tips.context.auto.body': 'プロンプトがコンテキスト上限の 80% に達すると、古いやり取りを 1 つの要約メモに置き換え、プロンプトを 50% まで短くします。どちらの値も 設定 > チャット で変えられます。「プロンプトがこの割合に達したら圧縮」を空欄にするとオフになります。超過時の動作が「古いものを削除」か「要約」のときだけ働きます。',
  'tips.context.auto.kw': '自動圧縮, 圧縮, 要約, 80%, 50%, auto compress, summary',

  'tips.context.overflow.title': 'コンテキストがいっぱいのとき',
  'tips.context.overflow.body': '「古いものを削除」(初期値)は、古いやり取りをリクエストから外します。「要約」は、それらを要約メモに置き換えます。「停止」は新しいメッセージを送らず、超過の通知を出します。チャットの履歴が消えることはありません。リクエストから外されるだけです。',
  'tips.context.overflow.kw': '超過, 古いものを削除, 要約, 停止, いっぱい, overflow, drop oldest, stop',

  'tips.context.usage.title': '/usage と使用量画面',
  'tips.context.usage.body': '/usage today、week、month、all で、期間ごとのトークン合計をチャットに表示します。使用量画面では、日ごとのトークン、上位のチャット、モデルごとの内訳を確認できます。一時チャットは集計されません。',
  'tips.context.usage.example': '/usage week',
  'tips.context.usage.kw': '使用量, トークン, 統計, 日ごと, モデルごと, usage, tokens, statistics',

  // ---- themes ----
  'tips.themes.names.title': '3 つのテーマ',
  'tips.themes.names.body': 'シンプルは標準の見た目です。フロンティアとアストラルには、それぞれ独自の配色、フォント、装飾があります。設定 > 外観 で選べます。',
  'tips.themes.names.kw': 'テーマ, シンプル, フロンティア, アストラル, theme, simple, frontier, astral',

  'tips.themes.mode.title': 'ライト・ダーク・システム',
  'tips.themes.mode.body': 'モードは既定でシステムに合わせます。ライトかダークに固定することもできます。シンプルでは、セピアとハイコントラストも選べます。',
  'tips.themes.mode.kw': 'ライト, ダーク, システム, セピア, ハイコントラスト, light, dark, sepia, contrast',

  'tips.themes.motion.title': 'アニメーションの量',
  'tips.themes.motion.body': '「なし」は画面の切り替え、ポップアップ、押したときの動きをすべて止めます。OS の「視差効果を減らす」を有効にしたときも同じです。「控えめ」は低性能なスマホ向けに軽くします。返信の文字の表示(なめらか・粒子)は別の設定ですが、ここで「なし」にすると無効になります。',
  'tips.themes.motion.kw': 'アニメーション, 動き, 粒子, なめらか, 控えめ, animation, motion, particles',

  'tips.themes.size.title': '文字サイズとメッセージの幅',
  'tips.themes.size.body': '文字サイズは 12〜24(初期値 16)、メッセージの幅は 560〜1200(初期値 820)です。どちらも端末ごとに保存されます。',
  'tips.themes.size.kw': '文字サイズ, 幅, メッセージの幅, font size, width',

  'tips.themes.pets.title': 'ペット',
  'tips.themes.pets.body': '外観で「ペットを表示」をオンにします。OmniChat にペットは同梱されていません。ウェブ版では、自分のペットのファイル(pet.json とスプライトシート)を読み込めます。',
  'tips.themes.pets.kw': 'ペット, 表示, pet, sprite',

  // ---- privacy ----
  'tips.privacy.server.title': 'チャットの保存先',
  'tips.privacy.server.body': 'チャット、検索用の索引、使用量の統計、同期される設定は、サーバーの SQLite データベースに 1 つにまとめて保存されます。保存先は DATA_DIR の omnichat.db で、既定は ./data です。',
  'tips.privacy.server.kw': 'データ, データベース, 保存, プライバシー, sqlite, DATA_DIR, privacy',
  'tips.privacy.admin.title': 'サーバーの管理',
  'tips.privacy.admin.body': '管理者は「設定 > サーバー」で、サーバー名と登録の有無を変えたり、アカウントを管理したり、ネットワークを確認したり、再起動したり、ログと全変更の監査一覧を見たりできます。パスワードと鍵は表示されません。',
  'tips.privacy.admin.kw': 'admin, administrator, server, users, registration, restart, audit, logs, 管理者, サーバー管理, ユーザー, 監査, 再起動',

  'tips.privacy.apikeys.title': 'API キーは平文で保存されます',
  'tips.privacy.apikeys.body': 'プロバイダーの API キーは、サーバーのデータベースに平文で保存され、バックアップにも含まれます。アプリには再表示されません。JSON エクスポートからは除外されます。データフォルダとバックアップファイルの保管に注意してください。',
  'tips.privacy.apikeys.kw': 'API キー, 秘密, 平文, バックアップ, api key, secret, plain text',

  'tips.privacy.device.title': 'この端末とアカウント',
  'tips.privacy.device.body': 'テーマ、文字サイズ、アニメーション、言語、モデルの読み込みの選択などの表示設定は、この端末にだけ保存されます。システムプロンプト、推論エフォート、コンテキストの設定などのチャット設定は、サーバー経由で同期されます。送信していない下書きもこの端末に保存されます。',
  'tips.privacy.device.kw': '端末, 同期, 下書き, 保存, device, sync, draft',

  'tips.privacy.ephemeral.title': '消えるチャットは履歴に残りません',
  'tips.privacy.ephemeral.body': 'メッセージはサーバーのメモリと画面にだけ存在します。データベース、検索、エクスポート、バックアップ、ログには保存されません。チャットを離れる、終了する、無操作(既定は 30 分)、ログアウトのいずれかで削除されます。AI プロバイダー側には、送信した内容の控えが残る場合があります。',
  'tips.privacy.ephemeral.kw': '消える, 一時, 履歴に残さない, 保存しない, ephemeral, temporary, not saved',
  'tips.privacy.ephemeral.btn': '消えるチャットを始める',

  'tips.privacy.export.title': 'エクスポートとバックアップ',
  'tips.privacy.export.body': 'チャットの操作メニューから、1 つのチャットを Markdown か JSON で保存できます。接続 > 履歴とデータ の「データ: エクスポート / インポート」では、全データを JSON で保存できます。インポートは常に新しい ID で作られます。サーバーのバックアップは管理者が作ります。',
  'tips.privacy.export.kw': 'エクスポート, インポート, バックアップ, JSON, Markdown, export, import, backup',

  // ---- what's new ----
  'tips.new.tips.title': 'ヒントとショートカットのシート',
  'tips.new.tips.body': 'ヒント、キーボードショートカット、スラッシュコマンドを検索できるヘルプのシートです。関連する設定への近道もあります。',
  'tips.new.modelload.title': 'モデル読み込みの選択',
  'tips.new.modelload.body': 'LM Studio や Ollama に別のモデルが読み込まれているとき、アンロード、読み込み済みのモデルを使う、両方を読み込む、から選べます。既定の動作は 設定 > チャット で決められます。',
  'tips.new.slash.title': 'スラッシュコマンドと使用量',
  'tips.new.slash.body': '/compact、/context、/usage、/retry、/export、/model など。入力欄で / を入力すると一覧が出ます。/usage は期間ごとのトークン合計を表示します。',
  'tips.new.animation.title': 'アニメーションの量と返信の表示',
  'tips.new.animation.body': 'アニメーションの量は「なし」「控えめ」「標準」「リッチ」から選べます。返信は、なめらかに、または粒子として現れます(粒子はウェブ版のみ)。',
  'tips.new.themes.title': '3 つのテーマ',
  'tips.new.themes.body': 'シンプル、フロンティア、アストラルの 3 テーマ。ライト、ダーク、システムのモードも選べます。',
  'tips.new.dsh.title': 'DSH のペアリングを承認方式に',
  'tips.new.dsh.body': 'ウェブ版では「接続」を押し、DeepSeek Harness で OmniChat を許可するだけです。コードのコピーは不要です。',
  'tips.new.ephemeral.title': '消えるチャット',
  'tips.new.ephemeral.body': '履歴を残さないチャットです。データベース、検索、エクスポートには保存されず、離れると削除されます。',
  'tips.new.artifacts.title': 'Word・Excel・PowerPoint・メールのアーティファクト',
  'tips.new.artifacts.body': '返信に Word、PowerPoint、Excel、メール(.eml)のアーティファクトを含められます。それぞれプレビューで確認できます。',
};
