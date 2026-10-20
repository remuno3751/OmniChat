// i18n strings for SECTIONS_1 (sections1.ts). en and ja must have identical key sets.

export const en: Record<string, string> = {
  // keys
  'tips.keys.enter.title': 'Send and new line',
  'tips.keys.enter.body': 'In the web version, Enter sends the message and Shift+Enter adds a new line. In the native apps, Enter adds a new line.',
  'tips.keys.enter.example': 'Shift+Enter',
  'tips.keys.enter.kw': 'enter, send, shift, new line, newline, keyboard, shortcut, submit, 送信, 改行',

  'tips.keys.search.title': 'Search history (Ctrl/Cmd+K)',
  'tips.keys.search.body': 'In the web version, Ctrl+K (Cmd+K on Mac) opens history search. It only works when history search is available.',
  'tips.keys.search.example': 'Ctrl+K',
  'tips.keys.search.kw': 'shortcut, search, history, find, keyboard, cmd k, ctrl k, 検索, 履歴, ショートカット',

  'tips.keys.slash.title': 'Keys in the / menu',
  'tips.keys.slash.body': 'With the / menu open, Up and Down move the selection and Tab or Enter picks the highlighted item. Esc hides the menu until you change the text. This works in the web version.',
  'tips.keys.slash.example': '/',
  'tips.keys.slash.kw': 'slash, command, menu, arrow, tab, escape, pick, コマンド, メニュー, スラッシュ',

  'tips.keys.esc.title': 'Esc closes sheets',
  'tips.keys.esc.body': 'In the web version, Esc closes the open sheet or popup.',
  'tips.keys.esc.example': 'Esc',
  'tips.keys.esc.kw': 'escape, close, dismiss, popup, sheet, dialog, 閉じる, ポップアップ',

  'tips.keys.slider.title': 'Arrow keys on sliders',
  'tips.keys.slider.body': 'In the web version, a focused slider changes with the arrow keys. The effort control also takes Home and End to jump to its ends.',
  'tips.keys.slider.example': '← →',
  'tips.keys.slider.kw': 'slider, effort, arrow keys, home, end, value, スライダー, 矢印キー',

  // search
  'tips.search.modes.title': 'Web search modes',
  'tips.search.modes.body': 'Each chat has a web search mode: Off, Smart, Auto or Always. The default is Smart, and a chat setting overrides its project, which overrides the global setting.',
  'tips.search.modes.example': '/search auto',
  'tips.search.modes.kw': 'search, web, internet, mode, off, smart, auto, always, default, 検索, ウェブ, モード, オフ, スマート, 自動, 常に',

  'tips.search.smart.title': 'Smart: search when needed',
  'tips.search.smart.body': 'Smart searches the web first only when a message seems to need current information, such as prices, news, releases, dates or the word "latest". It works with any model.',
  'tips.search.smart.kw': 'smart, fresh, latest, news, price, release, current, any model, スマート, 最新, ニュース, 価格, リリース',

  'tips.search.auto.title': 'Auto: the model decides',
  'tips.search.auto.body': 'Auto gives the model the web search tool and lets it decide whether to search. The model must support tool calling.',
  'tips.search.auto.kw': 'auto, tool, tool calling, model decides, function, 自動, ツール, モデル, 判断',

  'tips.search.always.title': 'Always: search every message',
  'tips.search.always.body': 'Always searches the web for every message, using the latest message as the query, and gives the results to the model. It searches each time, even when it is not needed.',
  'tips.search.always.kw': 'always, every message, each time, search every, 常に, 毎回, 毎メッセージ',

  'tips.search.where.title': 'Where to change the mode',
  'tips.search.where.body': 'Use the Web search chip near the composer to change the mode for this chat. The project settings and Settings > Plugins > Web search set the defaults. You can also type /search off, /search smart, /search auto or /search always.',
  'tips.search.where.example': '/search always',
  'tips.search.where.kw': 'change, switch, setting, chip, project, default, slash, 切り替え, 設定, チップ, プロジェクト, 既定',
  'tips.search.openPlugins': 'Open Plugins',

  // ephemeral
  'tips.ephemeral.start.title': 'Start an ephemeral chat',
  'tips.ephemeral.start.body': 'Press the eye-off icon in the sidebar to start an ephemeral chat. Nothing from it is kept in history, search or exports.',
  'tips.ephemeral.start.kw': 'ephemeral, temporary, private, incognito, no history, not saved, eye off, 消える, 一時, プライベート, 保存されない',
  'tips.ephemeral.start': 'Start ephemeral chat',

  'tips.ephemeral.delete.title': 'When it is deleted',
  'tips.ephemeral.delete.body': 'The chat is deleted when you leave it, end it with End and delete, stay idle for the set time (30 minutes by default), or log out. It is also deleted if the device stays disconnected for 2 minutes. You can change the idle time in Settings > Chat.',
  'tips.ephemeral.delete.kw': 'delete, leave, idle, timeout, logout, disconnect, end, destroy, 削除, 離れる, 無操作, ログアウト',

  'tips.ephemeral.limits.title': 'Limits and where it is not offered',
  'tips.ephemeral.limits.body': 'Up to 5 ephemeral chats can be open at once. They are available in the Chat tab only, not in the Code tab.',
  'tips.ephemeral.limits.kw': 'limit, maximum, five, code tab, chat tab, 上限, 5件, コードタブ, チャットタブ',

  'tips.ephemeral.provider.title': 'The AI provider may keep a copy',
  'tips.ephemeral.provider.body': 'Nothing is saved on this server or device, but the AI provider receives your messages and may keep a copy. Screenshots and text you copy are not covered.',
  'tips.ephemeral.provider.kw': 'provider, log, retain, copy, privacy, screenshot, clipboard, プロバイダー, 記録, 控え, コピー, スクリーンショット',

  // artifacts
  'tips.artifacts.preview.title': 'Preview documents and email',
  'tips.artifacts.preview.body': 'Artifacts open in a side panel. Word, PowerPoint, Excel and email artifacts show a preview, and the Source tab shows the raw text.',
  'tips.artifacts.preview.kw': 'preview, docx, pptx, xlsx, eml, word, excel, powerpoint, panel, source, プレビュー, ワード, パワーポイント, エクセル, パネル, ソース',

  'tips.artifacts.download.title': 'Download in other formats',
  'tips.artifacts.download.body': 'Download an artifact as Markdown, HTML, email (.eml), Word, PowerPoint or Excel. Word, PowerPoint and Excel are converted on the server and can only be downloaded in the web version.',
  'tips.artifacts.download.kw': 'download, export, save, docx, pptx, xlsx, eml, markdown, html, word, excel, ダウンロード, 保存, 書き出し, エクスポート',

  'tips.artifacts.import.title': 'Open a file in the panel',
  'tips.artifacts.import.body': 'In the web version, Open file loads a .docx, .xlsx, .pptx, .eml, .md, .txt or .csv file (up to 5 MB) into the panel. Use in chat adds its content to the message box so you can ask for changes.',
  'tips.artifacts.import.kw': 'import, open file, upload, docx, xlsx, pptx, csv, txt, attach, インポート, 取り込み, ファイル, アップロード, 開く',

  'tips.artifacts.email.title': 'Email drafts and the mail app',
  'tips.artifacts.email.body': 'An email artifact shows To, Cc, Bcc and Subject. Open in mail app starts a draft in your mail app, and Copy body or Copy all copies the text. Templates such as Reply, Decline and Schedule in the / menu create email artifacts.',
  'tips.artifacts.email.kw': 'email, mail, draft, reply, decline, schedule, to, cc, bcc, subject, メール, 下書き, 返信, 断り, 日程調整, 件名',

  // code
  'tips.code.tab.title': 'Code tab',
  'tips.code.tab.body': 'The Code tab in the sidebar runs chats through a DeepSeek Harness provider on this PC. The Chat tab does not use that provider.',
  'tips.code.tab.kw': 'code, dsh, deepseek, harness, coding, pc, provider, sidebar, コード, ディープシーク, ハーネス, PC, プロバイダー',

  'tips.code.connect.title': 'Connect DeepSeek Harness',
  'tips.code.connect.body': 'In Settings > Plugins, press Connect on the DeepSeek Harness card. DeepSeek Harness then asks you to allow the request, so you do not need to copy a code. This feature works on PCs only.',
  'tips.code.connect.kw': 'connect, pair, pairing, approve, allow, plugin, dsh, pc only, 接続, ペアリング, 承認, 許可, プラグイン',
  'tips.code.openPlugins': 'Open Plugins',

  'tips.code.provider.title': 'Add the DSH provider',
  'tips.code.provider.body': 'After connecting, add a provider with the DeepSeek Harness (PC bridge) preset and enter your bridge name in the base URL. Then send a short test message such as "hello" in a Code chat.',
  'tips.code.provider.kw': 'provider, preset, bridge name, base url, test, hello, プロバイダー, プリセット, ブリッジ名, テスト',
};

export const ja: Record<string, string> = {
  // keys
  'tips.keys.enter.title': '送信と改行',
  'tips.keys.enter.body': 'Web版では Enter で送信し、Shift+Enter で改行する。ネイティブアプリでは Enter で改行される。',
  'tips.keys.enter.example': 'Shift+Enter',
  'tips.keys.enter.kw': 'enter, send, shift, new line, newline, keyboard, shortcut, submit, 送信, 改行, エンター, ショートカット',

  'tips.keys.search.title': '履歴検索（Ctrl/Cmd+K）',
  'tips.keys.search.body': 'Web版では Ctrl+K（Mac は Cmd+K）で履歴検索を開く。履歴検索が使える状態のときだけ動く。',
  'tips.keys.search.example': 'Ctrl+K',
  'tips.keys.search.kw': 'shortcut, search, history, find, keyboard, cmd k, ctrl k, 検索, 履歴, ショートカット, 探す',

  'tips.keys.slash.title': '/メニューのキー',
  'tips.keys.slash.body': '/メニューが開いているとき、↑↓で選び、TabかEnterで決定する。Escで閉じると、文字を変えるまで再び開かない。Web版の機能。',
  'tips.keys.slash.example': '/',
  'tips.keys.slash.kw': 'slash, command, menu, arrow, tab, escape, pick, コマンド, メニュー, スラッシュ, 矢印, 決定',

  'tips.keys.esc.title': 'Escで閉じる',
  'tips.keys.esc.body': 'Web版では、開いているシートやポップアップを Esc で閉じる。',
  'tips.keys.esc.example': 'Esc',
  'tips.keys.esc.kw': 'escape, close, dismiss, popup, sheet, dialog, 閉じる, ポップアップ, シート, エスケープ',

  'tips.keys.slider.title': 'スライダーの矢印キー',
  'tips.keys.slider.body': 'Web版では、フォーカスしたスライダーを矢印キーで動かせる。強さの設定では Home と End で両端に移動できる。',
  'tips.keys.slider.example': '← →',
  'tips.keys.slider.kw': 'slider, effort, arrow keys, home, end, value, スライダー, 矢印キー, 強さ, ホーム, エンド',

  // search
  'tips.search.modes.title': 'Web検索のモード',
  'tips.search.modes.body': 'チャットごとにWeb検索のモードを選ぶ。オフ、スマート、自動、常にの4つ。既定はスマートで、チャットの設定がプロジェクトより優先され、プロジェクトが全体の設定より優先される。',
  'tips.search.modes.example': '/search auto',
  'tips.search.modes.kw': 'search, web, internet, mode, off, smart, auto, always, default, 検索, ウェブ, モード, オフ, スマート, 自動, 常に, 既定',

  'tips.search.smart.title': 'スマート: 必要なときだけ検索',
  'tips.search.smart.body': 'スマートは、価格・ニュース・リリース・日付・「最新」など最新の情報が必要そうなメッセージのときだけ、先にWeb検索する。どのモデルでも使える。',
  'tips.search.smart.kw': 'smart, fresh, latest, news, price, release, current, any model, スマート, 最新, ニュース, 価格, リリース, 日付',

  'tips.search.auto.title': '自動: モデルが判断',
  'tips.search.auto.body': '自動は、Web検索をツールとしてモデルに渡し、検索するかどうかをモデルに決めさせる。モデルがツール呼び出しに対応している必要がある。',
  'tips.search.auto.kw': 'auto, tool, tool calling, model decides, function, 自動, ツール, モデル, 判断, ツール呼び出し',

  'tips.search.always.title': '常に: 毎回検索',
  'tips.search.always.body': '常には、送るメッセージのたびに最新の発言でWeb検索し、その結果をモデルに渡す。必要がなくても毎回検索する。',
  'tips.search.always.kw': 'always, every message, each time, search every, 常に, 毎回, 毎メッセージ, 毎回検索',

  'tips.search.where.title': 'モードの変更場所',
  'tips.search.where.body': '入力欄の近くにある「Web検索」チップで、このチャットのモードを変える。既定値はプロジェクトの設定と「設定 > プラグイン > Web検索」で決まる。/search off、/search smart、/search auto、/search always と入力しても変えられる。',
  'tips.search.where.example': '/search always',
  'tips.search.where.kw': 'change, switch, setting, chip, project, default, slash, 切り替え, 設定, チップ, プロジェクト, 既定, 変更',
  'tips.search.openPlugins': 'プラグインを開く',

  // ephemeral
  'tips.ephemeral.start.title': '消えるチャットを始める',
  'tips.ephemeral.start.body': 'サイドバーの目が斜線のアイコンを押すと、消えるチャットを始める。開いている間の内容は、履歴・検索・エクスポートに残らない。',
  'tips.ephemeral.start.kw': 'ephemeral, temporary, private, incognito, no history, not saved, eye off, 消える, 一時, プライベート, 保存されない, シークレット',
  'tips.ephemeral.start': '消えるチャットを始める',

  'tips.ephemeral.delete.title': '削除されるタイミング',
  'tips.ephemeral.delete.body': 'チャットを離れる、「終了して削除」を押す、設定した時間（既定は30分）操作しない、ログアウトする、のいずれかで削除される。端末の接続が2分切れたままでも削除される。無操作の時間は「設定 > チャット」で変えられる。',
  'tips.ephemeral.delete.kw': 'delete, leave, idle, timeout, logout, disconnect, end, destroy, 削除, 離れる, 無操作, ログアウト, 終了, 接続',

  'tips.ephemeral.limits.title': '上限と使えない場所',
  'tips.ephemeral.limits.body': '消えるチャットは同時に最大5件まで開ける。チャットタブでだけ使え、コードタブでは使えない。',
  'tips.ephemeral.limits.kw': 'limit, maximum, five, code tab, chat tab, 上限, 5件, コードタブ, チャットタブ, 最大',

  'tips.ephemeral.provider.title': 'AIプロバイダーには残る場合がある',
  'tips.ephemeral.provider.body': 'このサーバーや端末には何も保存されないが、AIプロバイダーは送った内容を受け取り、控えを残す場合がある。スクリーンショットや、コピーした文字は対象外。',
  'tips.ephemeral.provider.kw': 'provider, log, retain, copy, privacy, screenshot, clipboard, プロバイダー, 記録, 控え, コピー, スクリーンショット, 保存',

  // artifacts
  'tips.artifacts.preview.title': '書類とメールのプレビュー',
  'tips.artifacts.preview.body': 'アーティファクトはサイドパネルで開く。Word・PowerPoint・Excel・メールはプレビューで表示され、「ソース」タブで元のテキストを見られる。',
  'tips.artifacts.preview.kw': 'preview, docx, pptx, xlsx, eml, word, excel, powerpoint, panel, source, プレビュー, ワード, パワーポイント, エクセル, パネル, ソース',

  'tips.artifacts.download.title': '別の形式でダウンロード',
  'tips.artifacts.download.body': 'アーティファクトを Markdown・HTML・メール(.eml)・Word・PowerPoint・Excel で保存できる。Word・PowerPoint・Excel はサーバーで変換するため、Web版でのみダウンロードできる。',
  'tips.artifacts.download.kw': 'download, export, save, docx, pptx, xlsx, eml, markdown, html, word, excel, ダウンロード, 保存, 書き出し, エクスポート',

  'tips.artifacts.import.title': 'ファイルをパネルで開く',
  'tips.artifacts.import.body': 'Web版では「ファイルを開く」で .docx・.xlsx・.pptx・.eml・.md・.txt・.csv（5 MB まで）をパネルに読み込める。「チャットで使う」を押すと内容が入力欄に入るので、修正を頼める。',
  'tips.artifacts.import.kw': 'import, open file, upload, docx, xlsx, pptx, csv, txt, attach, インポート, 取り込み, ファイル, アップロード, 開く',

  'tips.artifacts.email.title': 'メールの下書きとメールアプリ',
  'tips.artifacts.email.body': 'メールのアーティファクトには宛先（To・Cc・Bcc）と件名が表示される。「メールアプリで開く」で下書きを作り、「本文をコピー」や「すべてコピー」でも取り出せる。/ メニューの「返信を作成」「断りの返信」「日程調整の返信」などでメールを作れる。',
  'tips.artifacts.email.kw': 'email, mail, draft, reply, decline, schedule, to, cc, bcc, subject, メール, 下書き, 返信, 断り, 日程調整, 件名, 宛先',

  // code
  'tips.code.tab.title': 'コードタブ',
  'tips.code.tab.body': 'サイドバーのコードタブでは、この PC 上の DeepSeek Harness のプロバイダーを使ってチャットする。チャットタブでは、そのプロバイダーは使われない。',
  'tips.code.tab.kw': 'code, dsh, deepseek, harness, coding, pc, provider, sidebar, コード, ディープシーク, ハーネス, PC, プロバイダー, サイドバー',

  'tips.code.connect.title': 'DeepSeek Harnessに接続',
  'tips.code.connect.body': '設定 > プラグイン の DeepSeek Harness 連携で「接続」を押す。DeepSeek Harness 側で要求を許可すれば接続されるので、コードをコピーする必要はない。この機能は PC でだけ使える。',
  'tips.code.connect.kw': 'connect, pair, pairing, approve, allow, plugin, dsh, pc only, 接続, ペアリング, 承認, 許可, プラグイン, PCのみ',
  'tips.code.openPlugins': 'プラグインを開く',

  'tips.code.provider.title': 'DSH のプロバイダーを追加',
  'tips.code.provider.body': '接続したら、プロバイダーの追加で「DeepSeek Harness (PC bridge)」のプリセットを選び、ベース URL にブリッジ名を入れる。そのあとコードモードのチャットで「hello」などの短いメッセージを送って確認する。',
  'tips.code.provider.kw': 'provider, preset, bridge name, base url, test, hello, プロバイダー, プリセット, ブリッジ名, テスト, 確認',
};
