/**
 * @omnichat/dsh-bridge — browser half, shipped as a hand-written loader factory
 * bundle (the exact artifact format tsdown's client preset emits, written by
 * hand so local `--patch` development needs no bundler):
 *
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return module.exports } })
 *
 * `react` is a module-table row (baseline platform module), so the only
 * `require` here is `react`. The `omnichatbridge` Remote contribution is mounted
 * by this very plugin (the api-remotes assembly does not know our namespace),
 * then the settings page talks to it through `ctx.get('remote.omnichatbridge')`.
 *
 * Component identity note (same fix as the dsh-web-search plugin): components are
 * defined once in the apply scope, never inside the slot render callback, so
 * React does not remount the subtree on every render and lose local state
 * (Show/Hide, Copy feedback, the OmniChat URL field).
 *
 * `__internals` exposes the dictionaries and the Remote contribution so
 * test/client-bundle.test.js can exercise exactly the code users load.
 */

window.__ModuleLoader__.load({
  id: '@omnichat/dsh-bridge',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    // ================= Remote contribution (mirrors the SRC side of the bridge remote) =================
    // Client requires a strict codec exposing `create(): TypertSchema`, where TypertSchema is a
    // { parse(value) } interface — a transparent passthrough works, no zod needed. The schema holds
    // no state, so one shared object is handed out (the gateway calls create().parse(value) per decode).
    var NS = 'omnichatbridge';
    var PACKAGE = 'omnichat-dsh-bridge';
    var SERVICE = 'omniChatBridgeController';
    var TYPE_SYMBOL = 'omnichat-dsh-bridge#json';

    var passthrough = { parse: function (value) { return value; } };
    function jsonCodec() {
      return { mode: 'strict', typeSymbol: TYPE_SYMBOL, create: function () { return passthrough; } };
    }
    // `params` is the optional Typert parameter list (defaults to none).
    function descriptor(method, params) {
      return {
        id: PACKAGE + '#' + NS + '/' + method,
        service: SERVICE,
        namespace: NS,
        method: method,
        invocation: { kind: 'direct' },
        parameters: params || [],
        result: jsonCodec(),
      };
    }

    // Every method that takes an argument takes ONE json parameter named `args` (same shape as
    // dsh-web-search). approve/deny receive { id }; the omni* methods receive their args object.
    function argsParameters() {
      return [{ name: 'args', wire: 'args', source: 'json', codec: jsonCodec() }];
    }

    var contribution = {
      package: PACKAGE,
      descriptors: [
        descriptor('getState'),
        descriptor('regenerate'),
        descriptor('approve', argsParameters()),
        descriptor('deny', argsParameters()),
        // Settings-page methods for importing OmniChat models (PROTOCOL-v7-dshmodels.md section 2.4).
        descriptor('omniModels', argsParameters()),
        descriptor('omniImport', argsParameters()),
        descriptor('omniSync', argsParameters()),
        descriptor('omniRemove', argsParameters()),
        // Plugin update check and staging (updater.js). Both take one json `args` parameter.
        descriptor('updateState', argsParameters()),
        descriptor('updateRun', argsParameters()),
      ],
    };

    // ================= i18n =================
    // Flat key -> string dictionaries registered with the host's `locale` service. Keys must stay
    // identical across en / ja / zh. `{seconds}` is a placeholder filled in by the component.
    var DOMAIN = 'omnichat-dsh-bridge';
    var EN = {
      title: 'OmniChat',
      summary: 'Pair OmniChat with this DeepSeek Harness session bridge',
      intro: 'The OmniChat bridge lets OmniChat drive and mirror dsh sessions on this machine. When OmniChat asks to connect, you can approve or deny the request here. The pairing code below stays available as a manual fallback.',
      pairingHeading: 'Pairing code',
      codeHelp: 'Keep this code private. Anyone who has it can pair with this bridge. It is masked by default; use Show to reveal it.',
      noCodeNote: 'No pairing code is shown in remote mode. Switch the bridge to local mode to pair OmniChat.',
      show: 'Show',
      hide: 'Hide',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      statusHeading: 'Status',
      rowBridge: 'Bridge',
      rowMode: 'Mode',
      modeLocal: 'local',
      modeRemote: 'remote',
      rowListening: 'Listening',
      notListening: 'Not listening',
      rowClients: 'Connected clients',
      rowPaired: 'Paired',
      yes: 'Yes',
      no: 'No',
      rowOrigins: 'Allowed origins',
      noOrigins: 'None',
      lockedNotice: 'Pairing is temporarily locked after repeated failed attempts. Try again in {seconds} s.',
      regenerate: 'Regenerate pairing code',
      regenerating: 'Regenerating...',
      regenerateConfirm: 'Regenerate the pairing code?\n\nExisting OmniChat pairings will be invalidated, and OmniChat will need to be paired again with the new code.',
      errorRegenerate: 'Failed to regenerate the pairing code',
      openHeading: 'Open OmniChat',
      openUrlLabel: 'OmniChat URL',
      openButton: 'Open',
      openUrlInvalid: 'Enter a URL that starts with http:// or https://.',
      openHelp: 'Opens OmniChat in a new tab and passes the pairing code in the URL fragment.',
      loading: 'Loading bridge status...',
      errorLoad: 'Failed to load bridge status',
      errorNoBridge: 'The omnichatbridge Remote namespace is not mounted (ctx.remote.omnichatbridge is undefined)',
      pendingBanner: 'OmniChat ({origin}) wants to connect — client "{name}".',
      pendingMore: '+{count} more request(s) waiting',
      pendingExpires: 'Expires in {seconds} s',
      allow: 'Allow',
      deny: 'Deny',
      errorApprove: 'Failed to answer the request',
      omniHeading: 'Models from OmniChat',
      omniHelp: 'The paired OmniChat server serves these models through its /v1 endpoint. Each import uses a per-device API key that is stored in the dsh credential store, never in the plugin settings or the logs.',
      omniLoading: 'Loading models from OmniChat...',
      omniLoadFailed: 'Failed to load models from OmniChat',
      omniNotConnected: 'Open OmniChat and connect it to this bridge, then press Refresh.',
      omniEndpoint: 'Server endpoint',
      omniUrlLabel: 'Server URL override',
      omniUrlHelp: 'Leave empty to use the endpoint above. A value entered here is sent with the next import.',
      omniNoModels: 'OmniChat offers no chat models.',
      omniImportedBadge: 'Imported',
      omniRemovedBadge: 'Removed on server',
      omniSelectNew: 'Select all new',
      omniImportSelected: 'Import selected',
      omniSync: 'Sync',
      omniRemoveAll: 'Remove all imported models',
      omniRemoveConfirm: 'Remove all models imported from OmniChat? This deletes the OmniChat provider and its stored key from dsh and revokes the key on the server where possible.',
      omniRefresh: 'Refresh',
      omniWorking: 'Working...',
      omniImportedOk: 'Imported {count} model(s). They appear under the provider "OmniChat" in the dsh model list, prefixed [OmniChat]. If they do not show up, restart dsh.',
      omniSyncOk: 'Added {added}, updated {updated}, removed {removed}',
      omniRemovedOk: 'Removed all models imported from OmniChat.',
      omniSnippetHelp: 'dsh could not update its settings automatically. Paste this into cordis.patch.yml by hand. It contains no key.',
      updateHeading: 'Plugin update',
      updateHelp: 'Checks GitHub for a newer version of this plugin, at most every 6 hours. A new version is downloaded and its SHA-256 checksum is verified. It is installed only after you close DSH and run the command below.',
      updateCurrent: 'Plugin version',
      updateLatest: 'Latest version',
      updateUpToDate: 'Up to date',
      updateAvailable: 'Update available',
      updateNotChecked: 'Not checked yet',
      updateFailed: 'Check failed',
      updateCheck: 'Check for updates',
      updateChecking: 'Checking...',
      updateInstall: 'Update',
      updateStaging: 'Downloading and verifying...',
      updateStagedVersion: 'Downloaded and verified: version {version}',
      updateCloseFirst: 'Close DSH completely, then run this in a terminal.',
      updateCopyCommand: 'Copy command',
      updateCommandHelp: 'Run this once DSH is closed. It replaces the old plugin with the verified package.',
    };
    var JA = {
      title: 'OmniChat',
      summary: 'この dsh セッションブリッジと OmniChat をペアリングします',
      intro: 'OmniChat ブリッジを使うと、OmniChat からこのマシン上の dsh セッションを操作・ミラーできます。OmniChat から接続の要求があった場合は、ここで許可または拒否できます。手動でペアリングする場合は、下のペアリングコードを入力してください。',
      pairingHeading: 'ペアリングコード',
      codeHelp: 'このコードは秘密にしてください。知っている人は誰でもこのブリッジとペアリングできます。初期状態では伏せ字で表示されます。「表示」で内容を確認できます。',
      noCodeNote: 'リモートモードではペアリングコードは表示されません。OmniChat をペアリングするには、ブリッジをローカルモードに切り替えてください。',
      show: '表示',
      hide: '隠す',
      copy: 'コピー',
      copied: 'コピーしました',
      copyFailed: 'コピーに失敗しました',
      statusHeading: 'ステータス',
      rowBridge: 'ブリッジ',
      rowMode: 'モード',
      modeLocal: 'local',
      modeRemote: 'remote',
      rowListening: '待ち受けアドレス',
      notListening: '待ち受けていません',
      rowClients: '接続中のクライアント',
      rowPaired: 'ペアリング済み',
      yes: 'はい',
      no: 'いいえ',
      rowOrigins: '許可されたオリジン',
      noOrigins: 'なし',
      lockedNotice: '失敗が続いたため、ペアリングは一時的にロックされています。{seconds} 秒後に再試行してください。',
      regenerate: 'ペアリングコードを再生成',
      regenerating: '再生成中...',
      regenerateConfirm: 'ペアリングコードを再生成しますか？\n\n既存の OmniChat のペアリングは無効になります。新しいコードで OmniChat を再度ペアリングする必要があります。',
      errorRegenerate: 'ペアリングコードの再生成に失敗しました',
      openHeading: 'OmniChat を開く',
      openUrlLabel: 'OmniChat の URL',
      openButton: '開く',
      openUrlInvalid: 'http:// または https:// で始まる URL を入力してください。',
      openHelp: '新しいタブで OmniChat を開き、ペアリングコードを URL のフラグメントとして渡します。',
      loading: 'ブリッジの状態を読み込んでいます...',
      errorLoad: 'ブリッジの状態を読み込めませんでした',
      errorNoBridge: 'omnichatbridge Remote 名前空間がマウントされていません（ctx.remote.omnichatbridge が undefined です）',
      pendingBanner: 'OmniChat（{origin}）が接続を求めています — クライアント「{name}」。',
      pendingMore: 'ほかに {count} 件の要求が待機中です',
      pendingExpires: '{seconds} 秒後に期限切れ',
      allow: '許可',
      deny: '拒否',
      errorApprove: '要求への応答に失敗しました',
      omniHeading: 'OmniChat のモデル',
      omniHelp: 'ペアリング済みの OmniChat サーバーが、これらのモデルを /v1 エンドポイント経由で提供します。インポートごとに端末専用の API キーを使用します。キーは dsh の認証情報ストアに保存され、プラグイン設定やログには保存されません。',
      omniLoading: 'OmniChat からモデルを読み込んでいます...',
      omniLoadFailed: 'OmniChat からモデルを読み込めませんでした',
      omniNotConnected: 'OmniChat を開いてこのブリッジに接続し、「更新」を押してください。',
      omniEndpoint: 'サーバーのエンドポイント',
      omniUrlLabel: 'サーバー URL の上書き',
      omniUrlHelp: '空欄の場合は上のエンドポイントを使います。ここに入力した値は次回のインポートで送信されます。',
      omniNoModels: 'OmniChat にはチャットモデルがありません。',
      omniImportedBadge: 'インポート済み',
      omniRemovedBadge: 'サーバーから削除済み',
      omniSelectNew: '新規をすべて選択',
      omniImportSelected: '選択したモデルをインポート',
      omniSync: '同期',
      omniRemoveAll: 'インポート済みのモデルをすべて削除',
      omniRemoveConfirm: 'OmniChat からインポートしたモデルをすべて削除しますか？dsh から OmniChat プロバイダーと保存済みのキーを削除し、可能な場合はサーバー上のキーも取り消します。',
      omniRefresh: '更新',
      omniWorking: '処理中...',
      omniImportedOk: '{count} 件のモデルをインポートしました。dsh のモデル一覧では「OmniChat」プロバイダーの下に [OmniChat] の接頭辞付きで表示されます。表示されない場合は dsh を再起動してください。',
      omniSyncOk: '追加 {added}、更新 {updated}、削除 {removed}',
      omniRemovedOk: 'OmniChat からインポートしたモデルをすべて削除しました。',
      omniSnippetHelp: 'dsh の設定を自動で更新できませんでした。次の内容を cordis.patch.yml に手動で貼り付けてください。キーは含まれていません。',
      updateHeading: 'プラグインの更新',
      updateHelp: '新しいバージョンのこのプラグインを、最大 6 時間に 1 回 GitHub で確認します。新しいバージョンは取得され、SHA-256 チェックサムで検証されます。インストールされるのは、dsh を終了してから下のコマンドを実行したときだけです。',
      updateCurrent: 'プラグインのバージョン',
      updateLatest: '最新のバージョン',
      updateUpToDate: '最新です',
      updateAvailable: '更新があります',
      updateNotChecked: 'まだ確認していません',
      updateFailed: '確認に失敗しました',
      updateCheck: '更新を確認',
      updateChecking: '確認しています...',
      updateInstall: '更新',
      updateStaging: 'ダウンロードして検証しています...',
      updateStagedVersion: 'ダウンロードと検証が完了しました: バージョン {version}',
      updateCloseFirst: 'DSH を完全に終了してから、次のコマンドをターミナルで実行してください。',
      updateCopyCommand: 'コマンドをコピー',
      updateCommandHelp: 'DSH を終了したあとに実行してください。検証済みのパッケージで古いプラグインを置き換えます。',
    };
    var ZH = {
      title: 'OmniChat',
      summary: '将 OmniChat 与此 DeepSeek Harness 会话桥接器配对',
      intro: 'OmniChat 桥接器允许 OmniChat 在本机上驱动并镜像 dsh 会话。当 OmniChat 请求连接时，可在此处允许或拒绝。下方的配对码仍可用于手动配对。',
      pairingHeading: '配对码',
      codeHelp: '请妥善保管此配对码。拥有它的人都可以与此桥接器配对。默认以掩码显示，点击“显示”可查看。',
      noCodeNote: '远程模式下不显示配对码。请将桥接器切换为本地模式后再配对 OmniChat。',
      show: '显示',
      hide: '隐藏',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
      statusHeading: '状态',
      rowBridge: '桥接器',
      rowMode: '模式',
      modeLocal: 'local',
      modeRemote: 'remote',
      rowListening: '监听地址',
      notListening: '未监听',
      rowClients: '已连接客户端',
      rowPaired: '已配对',
      yes: '是',
      no: '否',
      rowOrigins: '允许的来源',
      noOrigins: '无',
      lockedNotice: '多次失败后配对已暂时锁定，请在 {seconds} 秒后重试。',
      regenerate: '重新生成配对码',
      regenerating: '生成中...',
      regenerateConfirm: '要重新生成配对码吗？\n\n现有的 OmniChat 配对将失效，需要使用新配对码重新配对 OmniChat。',
      errorRegenerate: '重新生成配对码失败',
      openHeading: '打开 OmniChat',
      openUrlLabel: 'OmniChat 地址',
      openButton: '打开',
      openUrlInvalid: '请输入以 http:// 或 https:// 开头的地址。',
      openHelp: '在新标签页中打开 OmniChat，并通过 URL 片段传递配对码。',
      loading: '正在加载桥接器状态...',
      errorLoad: '加载桥接器状态失败',
      errorNoBridge: 'omnichatbridge Remote 命名空间未挂载（ctx.remote.omnichatbridge 为 undefined）',
      pendingBanner: 'OmniChat（{origin}）请求连接 — 客户端“{name}”。',
      pendingMore: '另有 {count} 个请求等待处理',
      pendingExpires: '{seconds} 秒后过期',
      allow: '允许',
      deny: '拒绝',
      errorApprove: '响应请求失败',
      omniHeading: '来自 OmniChat 的模型',
      omniHelp: '已配对的 OmniChat 服务器通过其 /v1 端点提供这些模型。每次导入使用按设备生成的 API 密钥，该密钥保存在 dsh 的凭据存储中，不会写入插件设置或日志。',
      omniLoading: '正在从 OmniChat 加载模型...',
      omniLoadFailed: '无法从 OmniChat 加载模型',
      omniNotConnected: '请打开 OmniChat 并将其连接到此桥接器，然后点击“刷新”。',
      omniEndpoint: '服务器端点',
      omniUrlLabel: '服务器地址覆盖',
      omniUrlHelp: '留空则使用上方的端点。此处输入的值将用于下一次导入。',
      omniNoModels: 'OmniChat 没有可用的聊天模型。',
      omniImportedBadge: '已导入',
      omniRemovedBadge: '服务器已移除',
      omniSelectNew: '选择所有新模型',
      omniImportSelected: '导入所选',
      omniSync: '同步',
      omniRemoveAll: '移除所有已导入的模型',
      omniRemoveConfirm: '要移除所有从 OmniChat 导入的模型吗？这将从 dsh 删除 OmniChat 提供方及其保存的密钥，并在可能时撤销服务器上的该密钥。',
      omniRefresh: '刷新',
      omniWorking: '处理中...',
      omniImportedOk: '已导入 {count} 个模型。它们会显示在 dsh 模型列表的“OmniChat”提供方下，并带有 [OmniChat] 前缀。若未出现，请重启 dsh。',
      omniSyncOk: '新增 {added}，更新 {updated}，移除 {removed}',
      omniRemovedOk: '已移除所有从 OmniChat 导入的模型。',
      omniSnippetHelp: 'dsh 无法自动更新设置。请手动将以下内容粘贴到 cordis.patch.yml 中，其中不包含密钥。',
      updateHeading: '插件更新',
      updateHelp: '每 6 小时最多向 GitHub 检查一次此插件的新版本。新版本会被下载并通过 SHA-256 校验和验证。只有在关闭 DSH 后运行下方命令，才会安装。',
      updateCurrent: '插件版本',
      updateLatest: '最新版本',
      updateUpToDate: '已是最新版本',
      updateAvailable: '有可用更新',
      updateNotChecked: '尚未检查',
      updateFailed: '检查失败',
      updateCheck: '检查更新',
      updateChecking: '检查中...',
      updateInstall: '更新',
      updateStaging: '正在下载并校验...',
      updateStagedVersion: '已下载并校验：版本 {version}',
      updateCloseFirst: '请完全关闭 DSH，然后在终端中运行此命令。',
      updateCopyCommand: '复制命令',
      updateCommandHelp: '关闭 DSH 后运行。将使用已校验的安装包替换旧插件。',
    };

    var DICTS = { en: EN, ja: JA, zh: ZH };
    var DEFAULT_OPEN_URL = 'http://localhost:8787';
    var OPEN_URL_KEY = 'omnichat-dsh-bridge.openUrl';
    var POLL_MS = 1500;
    var COPIED_MS = 1500;
    var MASK = '••••••••••••';

    // Fallback translator used when the host has no locale service: JA when the browser says so,
    // otherwise EN. A missing key falls back to the key itself.
    function fallbackLanguage() {
      var lang = (typeof navigator !== 'undefined' && navigator.language) ? String(navigator.language) : '';
      return lang.indexOf('ja') === 0 ? JA : EN;
    }
    function fallbackT(key) {
      var dict = fallbackLanguage();
      return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    }

    // ================= Styles =================
    // Colours inherit from the host page; the few fixed values are CSS variables with fallbacks,
    // redefined for dark mode both by the OS preference and by an explicit data-theme attribute.
    var STYLES = [
      '.ocb-page{--ocb-border:rgba(128,128,128,.35);--ocb-error:#d93025;padding:16px;color:inherit}',
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .ocb-page{--ocb-error:#f28b82}}',
      ':root[data-theme="dark"] .ocb-page{--ocb-error:#f28b82}',
      '.ocb-section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:inherit}',
      '.ocb-heading{margin:0;font-size:18px;font-weight:600;color:inherit}',
      '.ocb-sub{margin:0;font-size:13px;font-weight:600;color:inherit}',
      '.ocb-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--ocb-border);border-radius:12px;color:inherit}',
      '.ocb-muted{margin:0;font-size:12px;line-height:1.5;opacity:.7;color:inherit}',
      '.ocb-error{margin:0;font-size:12px;line-height:1.5;color:var(--ocb-error)}',
      '.ocb-notice{margin:0;font-size:13px;line-height:1.5;padding:8px 10px;border:1px solid var(--ocb-border);border-radius:8px;color:inherit}',
      '.ocb-banner{display:flex;flex-direction:column;gap:10px;padding:12px;border:2px solid var(--ocb-accent,#2563eb);border-radius:12px;color:inherit}',
      '.ocb-banner-text{margin:0;font-size:14px;line-height:1.5;font-weight:600;color:inherit}',
      '.ocb-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}',
      '.ocb-code{flex:1 1 200px;min-width:0;margin:0;padding:8px 10px;border:1px solid var(--ocb-border);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:14px;line-height:1.5;overflow-wrap:anywhere;color:inherit;background:transparent}',
      '.ocb-rows{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:13px;color:inherit}',
      '.ocb-rows dt{margin:0;opacity:.7}',
      '.ocb-rows dd{margin:0;min-width:0;overflow-wrap:anywhere}',
      '.ocb-list{margin:0;padding:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
      '.ocb-input{flex:1 1 200px;min-width:0;height:34px;padding:0 10px;font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--ocb-border);border-radius:8px}',
      '.ocb-input:focus{outline:2px solid var(--ocb-border);outline-offset:1px}',
      '.ocb-btn{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;border:1px solid var(--ocb-border);border-radius:8px;white-space:nowrap;cursor:pointer;color:inherit;background:transparent}',
      '.ocb-btn:hover:not(:disabled){background:rgba(128,128,128,.12)}',
      '.ocb-btn:focus-visible{outline:2px solid var(--ocb-border);outline-offset:1px}',
      '.ocb-btn:disabled{opacity:.4;cursor:default}',
      '.ocb-btn--primary{font-weight:600;background:rgba(128,128,128,.2)}',
      '.ocb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.5;overflow-wrap:anywhere;color:inherit}',
      '.ocb-model-list{display:flex;flex-direction:column;gap:6px}',
      '.ocb-model{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-size:13px;color:inherit}',
      '.ocb-model-name{min-width:0;overflow-wrap:anywhere;font-weight:500;color:inherit}',
      '.ocb-badge{font-size:11px;line-height:1.5;padding:0 8px;border:1px solid var(--ocb-border);border-radius:999px;white-space:nowrap;color:inherit}',
      '.ocb-pre{margin:0;padding:8px 10px;border:1px solid var(--ocb-border);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto;color:inherit}',
    ].join('\n');

    var STYLE_ID = 'omnichat-dsh-bridge-style';

    // The loader tags untagged <style> elements with its own data-plugin attribute, so this one
    // carries data-plugin-css to stay identifiable. Runs at materialization, where document exists.
    function injectStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement('style');
      el.id = STYLE_ID;
      el.setAttribute('data-plugin-css', DOMAIN);
      el.textContent = STYLES;
      document.head.appendChild(el);
    }

    // ================= Pure helpers =================
    function isHttpUrl(value) {
      try {
        var url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (e) {
        return false;
      }
    }

    // Builds the OmniChat pairing URL. The code travels in the fragment, never in the query string.
    function buildOpenTarget(baseUrl, code) {
      return String(baseUrl).trim().replace(/\/+$/, '') + '/#dsh-pair=' + encodeURIComponent(code);
    }

    function remainingSeconds(lockedUntilMs, nowMs) {
      return Math.max(0, Math.ceil((Number(lockedUntilMs) - nowMs) / 1000));
    }

    // The approval banner's view of getState().pending: the first request, how many wait behind it,
    // and the seconds left on it. Countdown = expiresInSec minus the time elapsed since the status
    // was received (receivedAt), so it keeps counting down between polls. `seconds` is null when the
    // server sent no usable expiry; the countdown is then hidden. Returns null when nothing is pending.
    function pendingView(status, receivedAt, now) {
      var raw = status && Array.isArray(status.pending) ? status.pending : [];
      var list = raw.filter(function (item) { return item && typeof item === 'object'; });
      if (list.length === 0) return null;
      var first = list[0];
      var elapsedSec = receivedAt == null ? 0 : Math.max(0, (Number(now) - Number(receivedAt)) / 1000);
      var expires = first.expiresInSec;
      var seconds = typeof expires === 'number' && isFinite(expires)
        ? Math.max(0, Math.ceil(expires - elapsedSec))
        : null;
      return { request: first, more: list.length - 1, seconds: seconds };
    }

    function errorMessage(err) {
      if (err && typeof err.message === 'string' && err.message) return err.message;
      return String(err);
    }

    // The dsh remote gateway resolves to a { ok, value } / { ok: false, error: {message, code, details} }
    // envelope. A state object also carries a boolean `ok` (OmniState does), so only objects that match
    // the envelope shape are unwrapped: ok:true with a `value` key, or ok:false with an object `error`.
    // A plain state, including OmniState with ok:false and a string `error`, passes through unchanged.
    function isEnvelope(result) {
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return false;
      if (result.ok) return 'value' in result;
      return !!result.error && typeof result.error === 'object';
    }

    // Runs fn and always returns a promise, so synchronous throws become rejections.
    function call(fn) {
      return new Promise(function (resolve) { resolve(fn()); }).then(function (result) {
        if (isEnvelope(result)) {
          if (result.ok) return result.value;
          var err = new Error(String((result.error && result.error.message) || 'Remote call failed'));
          err.code = result.error && result.error.code;
          err.details = result.error && result.error.details;
          throw err;
        }
        return result;
      });
    }

    // True when a RemoteError code equals `name`, with or without the "omnichatbridge/" namespace prefix.
    function codeIs(code, name) {
      if (typeof code !== 'string') return false;
      return code === name || code.slice(code.length - name.length - 1) === '/' + name;
    }

    // Replaces {key} placeholders with vars[key]; unknown placeholders are left as they are.
    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
      });
    }

    // Object entries of an array field, or [] when the field is missing or not an array.
    function listOf(value) {
      return Array.isArray(value) ? value.filter(function (item) { return item && typeof item === 'object'; }) : [];
    }

    // A diff count: an array contributes its length, a number is used as is.
    function countOf(value) {
      if (Array.isArray(value)) return value.length;
      var n = Number(value);
      return isFinite(n) ? n : 0;
    }

    function loadStoredUrl() {
      try {
        var stored = window.localStorage.getItem(OPEN_URL_KEY);
        if (typeof stored === 'string' && stored.length > 0) return stored;
      } catch (e) {
        // Storage can be blocked or unavailable; fall through to the default.
      }
      return DEFAULT_OPEN_URL;
    }

    function saveStoredUrl(value) {
      try {
        window.localStorage.setItem(OPEN_URL_KEY, value);
      } catch (e) {
        // Remembering the URL is a convenience only.
      }
    }

    // Clipboard API first, then a hidden textarea + execCommand for contexts without it.
    function copyText(text) {
      return new Promise(function (resolve, reject) {
        var clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (clip && typeof clip.writeText === 'function') {
          clip.writeText(text).then(resolve, function () { fallbackCopy(text, resolve, reject); });
          return;
        }
        fallbackCopy(text, resolve, reject);
      });
    }

    function fallbackCopy(text, resolve, reject) {
      var area = null;
      try {
        area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '-9999px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve();
        else reject(new Error('copy command was rejected'));
      } catch (e) {
        if (area && area.parentNode) area.parentNode.removeChild(area);
        reject(e);
      }
    }

    // ================= Component factory (created once in the apply scope) =================
    function createComponents(bridge, t) {
      var h = function () { return React.createElement.apply(React, arguments); };

      // Children are spread as varargs so React does not treat them as an unkeyed array.
      function Section(props) {
        var head = props.title ? h('h3', { className: 'ocb-sub' }, props.title) : null;
        var kids = [].concat(props.children === undefined ? [] : props.children);
        return h.apply(null, ['section', { className: 'ocb-card' }, head].concat(kids));
      }

      function BridgeSettings() {
        var statusState = React.useState(null);
        var status = statusState[0];
        var setStatus = statusState[1];

        var loadingState = React.useState(true);
        var loading = loadingState[0];
        var setLoading = loadingState[1];

        var loadErrorState = React.useState(null);
        var loadError = loadErrorState[0];
        var setLoadError = loadErrorState[1];

        var actionErrorState = React.useState(null);
        var actionError = actionErrorState[0];
        var setActionError = actionErrorState[1];

        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];

        var revealState = React.useState(false);
        var revealed = revealState[0];
        var setRevealed = revealState[1];

        // null | 'ok' | 'err' — result of the last copy attempt, cleared after COPIED_MS.
        var copiedState = React.useState(null);
        var copied = copiedState[0];
        var setCopied = copiedState[1];

        var nowState = React.useState(function () { return Date.now(); });
        var now = nowState[0];
        var setNow = nowState[1];

        var urlState = React.useState(loadStoredUrl);
        var openUrl = urlState[0];
        var setOpenUrl = urlState[1];

        // Approval banner: when the current status was received (drives the countdown), whether an
        // Allow/Deny call is in flight, and the last failure tagged with the request it belongs to.
        var receivedState = React.useState(null);
        var receivedAt = receivedState[0];
        var setReceivedAt = receivedState[1];

        var answeringState = React.useState(false);
        var answering = answeringState[0];
        var setAnswering = answeringState[1];

        var answerErrorState = React.useState(null);
        var answerError = answerErrorState[0];
        var setAnswerError = answerErrorState[1];

        var alive = React.useRef(true);
        var copyTimer = React.useRef(null);
        var inFlight = React.useRef(false);

        // Guards every async setState against running after unmount.
        React.useEffect(function () {
          alive.current = true;
          return function () {
            alive.current = false;
            if (copyTimer.current) clearTimeout(copyTimer.current);
          };
        }, []);

        // Every new status goes through here so the banner countdown starts from this moment.
        function applyStatus(next) {
          var at = Date.now();
          setStatus(next || null);
          setReceivedAt(at);
          setNow(at);
        }

        // One getState call at a time: a tick is skipped while the previous call is still in flight.
        function poll() {
          if (!bridge || inFlight.current) return;
          inFlight.current = true;
          call(function () { return bridge.getState(); }).then(function (next) {
            inFlight.current = false;
            if (!alive.current) return;
            applyStatus(next);
            setLoadError(null);
            setLoading(false);
          }, function (err) {
            inFlight.current = false;
            if (!alive.current) return;
            setLoadError(t('errorLoad') + ': ' + errorMessage(err));
            setLoading(false);
          });
        }

        // Load on mount, then poll. Without a bridge there is nothing to poll.
        React.useEffect(function () {
          if (!bridge) {
            setLoading(false);
            setLoadError(t('errorNoBridge'));
            return undefined;
          }
          poll();
          var timer = setInterval(poll, POLL_MS);
          return function () { clearInterval(timer); };
        }, []);

        var locked = !!(status && status.locked);
        var pending = pendingView(status, receivedAt, now);
        var hasPending = pending !== null;

        // Lockout and approval countdowns tick once a second while either one is shown.
        React.useEffect(function () {
          if (!locked && !hasPending) return undefined;
          var timer = setInterval(function () {
            if (alive.current) setNow(Date.now());
          }, 1000);
          return function () { clearInterval(timer); };
        }, [locked, hasPending]);

        function flashCopied(kind) {
          if (!alive.current) return;
          setCopied(kind);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(function () {
            copyTimer.current = null;
            if (alive.current) setCopied(null);
          }, COPIED_MS);
        }

        function handleCopy() {
          if (!status || !status.code) return;
          copyText(status.code).then(function () { flashCopied('ok'); }, function () { flashCopied('err'); });
        }

        function handleRegenerate() {
          if (busy || !bridge) return;
          var confirmFn = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : null;
          if (!confirmFn || !confirmFn(t('regenerateConfirm'))) return;
          setBusy(true);
          setActionError(null);
          call(function () { return bridge.regenerate(); }).then(function (next) {
            if (!alive.current) return;
            setBusy(false);
            setCopied(null);
            if (next) applyStatus(next);
          }, function (err) {
            if (!alive.current) return;
            setBusy(false);
            setActionError(t('errorRegenerate') + ': ' + errorMessage(err));
          });
        }

        function handleUrlChange(ev) {
          var value = ev.target.value;
          setOpenUrl(value);
          saveStoredUrl(value);
        }

        function handleOpen() {
          var code = status && status.code;
          if (!code || !isHttpUrl(openUrl.trim())) return;
          window.open(buildOpenTarget(openUrl, code), '_blank', 'noopener');
        }

        // Allow / Deny for one request. `id` is the request that was on screen when clicked.
        function answerRequest(id, allow) {
          if (!bridge || answering) return;
          setAnswering(true);
          setAnswerError(null);
          var action = allow
            ? function () { return bridge.approve({ id: id }); }
            : function () { return bridge.deny({ id: id }); };
          call(action).then(function (next) {
            if (!alive.current) return;
            setAnswering(false);
            if (next && typeof next === 'object') applyStatus(next);
          }, function (err) {
            if (!alive.current) return;
            setAnswering(false);
            setAnswerError({ id: id, text: t('errorApprove') + ': ' + errorMessage(err) });
            poll();
          });
        }

        var children = [];
        children.push(h('h2', { key: 'title', className: 'ocb-heading' }, t('title')));

        // Approval banner: first pending request only, placed above the intro.
        if (pending) {
          var first = pending.request;
          var requestId = first.id;
          var bannerText = t('pendingBanner')
            .split('{origin}').join(String(first.origin == null ? '' : first.origin))
            .split('{name}').join(String(first.clientName == null ? '' : first.clientName));
          var bannerKids = [h('p', { key: 'banner-text', className: 'ocb-banner-text' }, bannerText)];
          if (pending.more > 0) {
            bannerKids.push(h('p', { key: 'more', className: 'ocb-muted' },
              t('pendingMore').split('{count}').join(String(pending.more))));
          }
          if (pending.seconds !== null) {
            bannerKids.push(h('p', { key: 'expires', className: 'ocb-muted' },
              t('pendingExpires').split('{seconds}').join(String(pending.seconds))));
          }
          if (answerError && answerError.id === requestId) {
            bannerKids.push(h('p', { key: 'answer-error', className: 'ocb-error' }, answerError.text));
          }
          bannerKids.push(h('div', { key: 'actions', className: 'ocb-row' },
            h('button', {
              className: 'ocb-btn ocb-btn--primary',
              type: 'button',
              onClick: function () { answerRequest(requestId, true); },
              disabled: answering || pending.seconds === 0,
            }, t('allow')),
            h('button', {
              className: 'ocb-btn',
              type: 'button',
              onClick: function () { answerRequest(requestId, false); },
              disabled: answering,
            }, t('deny')),
          ));
          children.push(h.apply(null, ['div', { key: 'pending', className: 'ocb-banner', role: 'alert' }].concat(bannerKids)));
        }

        children.push(h('p', { key: 'intro', className: 'ocb-muted' }, t('intro')));
        if (loadError) children.push(h('p', { key: 'load-error', className: 'ocb-error' }, loadError));
        if (loading && !status && !loadError) children.push(h('p', { key: 'loading', className: 'ocb-muted' }, t('loading')));

        if (status) {
          var code = status.code;
          var active = !!status.active;
          var remaining = remainingSeconds(status.lockedUntilMs, now);

          // (1) Pairing code, masked by default.
          if (code) {
            children.push(h(Section, { key: 'code', title: t('pairingHeading') },
              h('div', { className: 'ocb-row' },
                h('code', { className: 'ocb-code' }, revealed ? code : MASK),
                h('button', {
                  className: 'ocb-btn',
                  type: 'button',
                  onClick: function () { setRevealed(!revealed); },
                }, revealed ? t('hide') : t('show')),
                h('button', {
                  className: 'ocb-btn ocb-btn--primary',
                  type: 'button',
                  onClick: handleCopy,
                }, copied === 'ok' ? t('copied') : t('copy')),
              ),
              copied === 'err' ? h('p', { className: 'ocb-error' }, t('copyFailed')) : null,
              h('p', { className: 'ocb-muted' }, t('codeHelp')),
            ));
          } else {
            children.push(h(Section, { key: 'code', title: t('pairingHeading') },
              h('p', { className: 'ocb-muted' }, t('noCodeNote')),
            ));
          }

          // (3) Lockout notice.
          if (locked && remaining > 0) {
            children.push(h('p', { key: 'locked', className: 'ocb-notice', role: 'status' },
              String(t('lockedNotice')).replace('{seconds}', String(remaining))));
          }

          // (2) Status rows.
          var origins = Array.isArray(status.allowedOrigins) ? status.allowedOrigins : [];
          var listening = active && status.port != null ? '127.0.0.1:' + status.port : t('notListening');
          var paired = status.paired ? t('yes') : t('no');
          if (status.paired && status.pairedAt) paired += ' (' + status.pairedAt + ')';
          children.push(h(Section, { key: 'status', title: t('statusHeading') },
            h('dl', { className: 'ocb-rows' },
              h('dt', null, t('rowBridge')),
              h('dd', null, [status.name, status.version].filter(Boolean).join(' ') || '-'),
              h('dt', null, t('rowMode')),
              h('dd', null, status.mode === 'remote' ? t('modeRemote') : t('modeLocal')),
              h('dt', null, t('rowListening')),
              h('dd', null, listening),
              h('dt', null, t('rowClients')),
              h('dd', null, String(status.clients == null ? 0 : status.clients)),
              h('dt', null, t('rowPaired')),
              h('dd', null, paired),
              h('dt', null, t('rowOrigins')),
              h('dd', null, origins.length === 0
                ? t('noOrigins')
                : h('ul', { className: 'ocb-list' }, origins.map(function (origin) {
                    return h('li', { key: origin }, origin);
                  }))),
            ),
          ));

          // (4) Regenerate.
          children.push(h(Section, { key: 'regenerate' },
            h('div', { className: 'ocb-row' },
              h('button', {
                className: 'ocb-btn',
                type: 'button',
                onClick: handleRegenerate,
                disabled: busy || !bridge,
              }, busy ? t('regenerating') : t('regenerate')),
            ),
            actionError ? h('p', { className: 'ocb-error' }, actionError) : null,
          ));

          // (5) Open OmniChat.
          var trimmed = openUrl.trim();
          var urlOk = isHttpUrl(trimmed);
          var canOpen = !!code && urlOk;
          children.push(h(Section, { key: 'open', title: t('openHeading') },
            h('label', { className: 'ocb-muted', htmlFor: 'ocb-open-url' }, t('openUrlLabel')),
            h('div', { className: 'ocb-row' },
              h('input', {
                id: 'ocb-open-url',
                className: 'ocb-input',
                type: 'url',
                value: openUrl,
                onChange: handleUrlChange,
              }),
              h('button', {
                className: 'ocb-btn ocb-btn--primary',
                type: 'button',
                onClick: handleOpen,
                disabled: !canOpen,
              }, t('openButton')),
            ),
            trimmed.length > 0 && !urlOk ? h('p', { className: 'ocb-error' }, t('openUrlInvalid')) : null,
            h('p', { className: 'ocb-muted' }, t('openHelp')),
          ));
        }

        children.push(h(UpdateSettings, { key: 'plugin-update', bridge: bridge }));
        children.push(h(OmniModels, { key: 'omni-models', bridge: bridge }));

        return h('div', { className: 'ocb-page' }, h('div', { className: 'ocb-section' }, children));
      }

      // "Models from OmniChat": imports the paired OmniChat server's models into dsh through the
      // omni* remote methods. Independent of the bridge status above, so it is always shown.
      // Defined here (never inside a render callback) so its selection and inputs survive re-renders.
      function OmniModels(props) {
        var omniBridge = props.bridge;

        var omniState = React.useState(null);
        var omni = omniState[0];
        var setOmni = omniState[1];

        var loadingState = React.useState(true);
        var loading = loadingState[0];
        var setLoading = loadingState[1];

        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];

        // { text, snippet } for the last failed action or load; snippet is set only for settings-unavailable.
        var errorState = React.useState(null);
        var actionError = errorState[0];
        var setActionError = errorState[1];

        var noticeState = React.useState(null);
        var notice = noticeState[0];
        var setNotice = noticeState[1];

        var selectedState = React.useState([]);
        var selected = selectedState[0];
        var setSelected = selectedState[1];

        var overrideState = React.useState('');
        var overrideUrl = overrideState[0];
        var setOverrideUrl = overrideState[1];

        // null | 'ok' | 'err' — result of the last snippet copy, cleared after COPIED_MS.
        var snippetCopiedState = React.useState(null);
        var snippetCopied = snippetCopiedState[0];
        var setSnippetCopied = snippetCopiedState[1];

        var omniAlive = React.useRef(true);
        var copyTimer = React.useRef(null);

        React.useEffect(function () {
          omniAlive.current = true;
          return function () {
            omniAlive.current = false;
            if (copyTimer.current) clearTimeout(copyTimer.current);
          };
        }, []);

        // Maps a rejected call (RemoteError or plain Error) to the text and optional snippet to show.
        function failureOf(err) {
          var code = err && err.code;
          var snippet = err && err.details && typeof err.details.snippet === 'string' ? err.details.snippet : null;
          return {
            text: codeIs(code, 'omni-not-connected') ? t('omniNotConnected') : errorMessage(err),
            snippet: codeIs(code, 'omni-settings-unavailable') ? snippet : null,
          };
        }

        // Text for an OmniState that came back with ok:false (omniModels reports failures in-band).
        function stateErrorText(state) {
          if (codeIs(state.errorCode, 'omni-not-connected')) return t('omniNotConnected');
          return String(state.error || state.errorCode || t('omniLoadFailed'));
        }

        function loadModels() {
          if (!omniBridge) {
            setLoading(false);
            setActionError({ text: t('errorNoBridge'), snippet: null });
            return;
          }
          setLoading(true);
          call(function () { return omniBridge.omniModels({}); }).then(function (next) {
            if (!omniAlive.current) return;
            var result = next && typeof next === 'object' ? next : null;
            setLoading(false);
            setOmni(result);
            setActionError(null);
            // Keep only the selections that are still offered.
            var offered = {};
            listOf(result && result.available).forEach(function (m) { offered[m.id] = true; });
            setSelected(function (prev) {
              return prev.filter(function (id) { return offered[id]; });
            });
          }, function (err) {
            if (!omniAlive.current) return;
            setLoading(false);
            setActionError(failureOf(err));
          });
        }

        // Runs one mutating call. Success replaces the state with the returned OmniState.
        function runAction(action, onDone) {
          if (busy || !omniBridge) return;
          setBusy(true);
          setActionError(null);
          setNotice(null);
          call(action).then(function (next) {
            if (!omniAlive.current) return;
            setBusy(false);
            var result = next && typeof next === 'object' ? next : {};
            setOmni(result);
            if (result.ok === false) {
              setActionError({ text: stateErrorText(result), snippet: null });
              return;
            }
            onDone(result);
          }, function (err) {
            if (!omniAlive.current) return;
            setBusy(false);
            setActionError(failureOf(err));
          });
        }

        function toggleModel(id) {
          setSelected(function (prev) {
            return prev.indexOf(id) >= 0
              ? prev.filter(function (x) { return x !== id; })
              : prev.concat([id]);
          });
        }

        function selectNew() {
          var fresh = listOf(omni && omni.available).filter(function (m) { return !m.imported; });
          setSelected(function (prev) {
            var add = fresh.map(function (m) { return m.id; }).filter(function (id) { return prev.indexOf(id) < 0; });
            return prev.concat(add);
          });
        }

        function importSelected() {
          var ids = selected.slice();
          if (ids.length === 0) return;
          var args = { ids: ids };
          var override = overrideUrl.trim();
          if (override) args.baseUrl = override;
          runAction(function () { return omniBridge.omniImport(args); }, function () {
            setSelected([]);
            setNotice(fill(t('omniImportedOk'), { count: ids.length }));
          });
        }

        function syncModels() {
          runAction(function () { return omniBridge.omniSync({ addNew: true }); }, function (result) {
            var diff = result.diff && typeof result.diff === 'object' ? result.diff : {};
            setNotice(fill(t('omniSyncOk'), {
              added: countOf(diff.added),
              updated: countOf(diff.updated),
              removed: countOf(diff.removed),
            }));
          });
        }

        function removeAll() {
          var confirmFn = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : null;
          if (!confirmFn || !confirmFn(t('omniRemoveConfirm'))) return;
          runAction(function () { return omniBridge.omniRemove({ all: true }); }, function () {
            setSelected([]);
            setNotice(t('omniRemovedOk'));
          });
        }

        function flashSnippetCopied(kind) {
          if (!omniAlive.current) return;
          setSnippetCopied(kind);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(function () {
            copyTimer.current = null;
            if (omniAlive.current) setSnippetCopied(null);
          }, COPIED_MS);
        }

        function copySnippet(text) {
          copyText(text).then(function () { flashSnippetCopied('ok'); }, function () { flashSnippetCopied('err'); });
        }

        // Initial load on mount (the bridge is the only dependency, and it is fixed for this instance).
        React.useEffect(function () {
          loadModels();
        }, []);

        var available = listOf(omni && omni.available);
        var importedList = listOf(omni && omni.imported);
        var serverOk = !omni || omni.ok !== false;
        var endpoint = omni && typeof omni.baseUrl === 'string' && omni.baseUrl ? omni.baseUrl : null;

        var offered = {};
        available.forEach(function (m) { offered[m.id] = true; });
        var newCount = available.filter(function (m) { return !m.imported; }).length;
        // With the server reachable, imported entries no longer offered are shown as removed on the server.
        var staleList = serverOk ? importedList.filter(function (m) { return m.stale && !offered[m.id]; }) : [];
        // With the server unreachable, the list cannot be checked, so the recorded imports are shown as they are.
        var recordedList = serverOk ? [] : importedList;

        var rows = [];
        available.forEach(function (m) {
          rows.push(h('label', { key: 'a-' + m.id, className: 'ocb-model' },
            h('input', {
              type: 'checkbox',
              checked: selected.indexOf(m.id) >= 0,
              disabled: busy,
              onChange: function () { toggleModel(m.id); },
            }),
            h('span', { className: 'ocb-model-name' }, String(m.name || m.id)),
            m.providerName ? h('span', { className: 'ocb-muted' }, String(m.providerName)) : null,
            m.imported ? h('span', { className: 'ocb-badge' }, t('omniImportedBadge')) : null,
          ));
        });
        recordedList.forEach(function (m) {
          rows.push(h('div', { key: 'r-' + m.id, className: 'ocb-model' },
            h('span', { className: 'ocb-model-name' }, String(m.name || m.id)),
            m.providerName ? h('span', { className: 'ocb-muted' }, String(m.providerName)) : null,
            h('span', { className: 'ocb-badge' }, t('omniImportedBadge')),
          ));
        });
        staleList.forEach(function (m) {
          rows.push(h('div', { key: 's-' + m.id, className: 'ocb-model' },
            h('span', { className: 'ocb-model-name' }, String(m.name || m.id)),
            m.providerName ? h('span', { className: 'ocb-muted' }, String(m.providerName)) : null,
            h('span', { className: 'ocb-badge' }, t('omniRemovedBadge')),
          ));
        });

        var kids = [];
        kids.push(h('p', { key: 'help', className: 'ocb-muted' }, t('omniHelp')));
        if (loading) kids.push(h('p', { key: 'loading', className: 'ocb-muted' }, t('omniLoading')));
        if (omni && omni.ok === false) {
          kids.push(h('p', { key: 'omni-error', className: 'ocb-error', role: 'alert' }, stateErrorText(omni)));
        }
        if (actionError) kids.push(h('p', { key: 'action-error', className: 'ocb-error', role: 'alert' }, actionError.text));
        if (actionError && actionError.snippet) {
          kids.push(h('p', { key: 'snippet-help', className: 'ocb-muted' }, t('omniSnippetHelp')));
          kids.push(h('pre', { key: 'snippet', className: 'ocb-pre' }, actionError.snippet));
          kids.push(h('div', { key: 'snippet-row', className: 'ocb-row' },
            h('button', {
              className: 'ocb-btn',
              type: 'button',
              onClick: function () { copySnippet(actionError.snippet); },
            }, snippetCopied === 'ok' ? t('copied') : t('copy')),
            snippetCopied === 'err' ? h('span', { className: 'ocb-error' }, t('copyFailed')) : null,
          ));
        }
        if (notice) kids.push(h('p', { key: 'notice', className: 'ocb-notice', role: 'status' }, notice));
        if (busy) kids.push(h('p', { key: 'working', className: 'ocb-muted' }, t('omniWorking')));

        if (endpoint) {
          kids.push(h('div', { key: 'endpoint', className: 'ocb-row' },
            h('span', { className: 'ocb-muted' }, t('omniEndpoint')),
            h('code', { className: 'ocb-mono' }, endpoint),
          ));
        }
        kids.push(h('label', { key: 'url-label', className: 'ocb-muted', htmlFor: 'ocb-omni-url' }, t('omniUrlLabel')));
        kids.push(h('div', { key: 'url-row', className: 'ocb-row' },
          h('input', {
            id: 'ocb-omni-url',
            className: 'ocb-input',
            type: 'text',
            value: overrideUrl,
            placeholder: endpoint || '',
            disabled: busy,
            onChange: function (ev) { setOverrideUrl(ev.target.value); },
          }),
        ));
        kids.push(h('p', { key: 'url-help', className: 'ocb-muted' }, t('omniUrlHelp')));

        if (rows.length > 0) kids.push(h('div', { key: 'list', className: 'ocb-model-list' }, rows));
        if (omni && serverOk && !loading && available.length === 0 && staleList.length === 0) {
          kids.push(h('p', { key: 'none', className: 'ocb-muted' }, t('omniNoModels')));
        }

        kids.push(h('div', { key: 'actions', className: 'ocb-row' },
          h('button', {
            className: 'ocb-btn',
            type: 'button',
            onClick: selectNew,
            disabled: busy || newCount === 0,
          }, t('omniSelectNew')),
          h('button', {
            className: 'ocb-btn ocb-btn--primary',
            type: 'button',
            onClick: importSelected,
            disabled: busy || selected.length === 0,
          }, t('omniImportSelected')),
          h('button', {
            className: 'ocb-btn',
            type: 'button',
            onClick: syncModels,
            disabled: busy || loading,
          }, t('omniSync')),
          importedList.length > 0
            ? h('button', {
                className: 'ocb-btn',
                type: 'button',
                onClick: removeAll,
                disabled: busy,
              }, t('omniRemoveAll'))
            : null,
          h('button', {
            className: 'ocb-btn',
            type: 'button',
            onClick: loadModels,
            disabled: busy || loading,
          }, t('omniRefresh')),
        ));

        return h.apply(null, [Section, { key: 'omni-models', title: t('omniHeading') }].concat(kids));
      }

      // "Plugin update": the installed and latest plugin versions, a check button, and Update, which only
      // downloads and verifies the new package. Installing needs DSH closed, so the page shows the command.
      // State comes from updateState (host-side: at most one GitHub check per 6 hours) and updateRun.
      function UpdateSettings(props) {
        var upBridge = props.bridge;

        var stateSlot = React.useState(null);
        var up = stateSlot[0];
        var setUp = stateSlot[1];

        // null | 'check' | 'stage' while a call is in flight.
        var busySlot = React.useState(null);
        var upBusy = busySlot[0];
        var setUpBusy = busySlot[1];

        var errorSlot = React.useState(null);
        var upError = errorSlot[0];
        var setUpError = errorSlot[1];

        // null | 'ok' | 'err' — result of the last command copy, cleared after COPIED_MS.
        var copiedSlot = React.useState(null);
        var upCopied = copiedSlot[0];
        var setUpCopied = copiedSlot[1];

        var upAlive = React.useRef(true);
        var copyTimer = React.useRef(null);

        React.useEffect(function () {
          upAlive.current = true;
          return function () {
            upAlive.current = false;
            if (copyTimer.current) clearTimeout(copyTimer.current);
          };
        }, []);

        // Reads the cached state when the page opens (the host checks only when the cache is older than 6 hours).
        React.useEffect(function () {
          if (!upBridge) return undefined;
          call(function () { return upBridge.updateState({}); }).then(function (next) {
            if (!upAlive.current) return;
            if (next && typeof next === 'object') setUp(next);
          }, function (err) {
            if (!upAlive.current) return;
            setUpError(errorMessage(err));
          });
          return undefined;
        }, []);

        // One action at a time. A success replaces the state; a failure shows its message.
        function runUpdate(args, kind) {
          if (upBusy || !upBridge) return;
          setUpBusy(kind);
          setUpError(null);
          call(function () { return upBridge.updateRun(args); }).then(function (next) {
            if (!upAlive.current) return;
            setUpBusy(null);
            if (next && typeof next === 'object') setUp(next);
          }, function (err) {
            if (!upAlive.current) return;
            setUpBusy(null);
            setUpError(errorMessage(err));
          });
        }

        function flashCommandCopied(kind) {
          if (!upAlive.current) return;
          setUpCopied(kind);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(function () {
            copyTimer.current = null;
            if (upAlive.current) setUpCopied(null);
          }, COPIED_MS);
        }

        function copyCommand(text) {
          copyText(text).then(function () { flashCommandCopied('ok'); }, function () { flashCommandCopied('err'); });
        }

        var latest = up && up.latest ? up.latest : null;
        var stateError = up && up.error ? up.error : null;
        var command = up && typeof up.command === 'string' ? up.command : null;

        var statusText;
        if (upBusy === 'check') statusText = t('updateChecking');
        else if (upBusy === 'stage') statusText = t('updateStaging');
        else if (stateError) statusText = t('updateFailed') + ': ' + String(stateError.message || stateError.code || '');
        else if (!up || up.checkedAt == null) statusText = t('updateNotChecked');
        else if (up.updateAvailable) statusText = t('updateAvailable');
        else statusText = t('updateUpToDate');

        var kids = [];
        kids.push(h('p', { key: 'help', className: 'ocb-muted' }, t('updateHelp')));
        kids.push(h('dl', { key: 'rows', className: 'ocb-rows' },
          h('dt', null, t('updateCurrent')),
          h('dd', null, up && up.current ? String(up.current) : '-'),
          h('dt', null, t('updateLatest')),
          h('dd', null, latest ? String(latest.version) : '-'),
        ));
        kids.push(h('p', { key: 'status', className: stateError ? 'ocb-error' : 'ocb-notice', role: 'status' }, statusText));
        if (upError) kids.push(h('p', { key: 'action-error', className: 'ocb-error', role: 'alert' }, upError));
        kids.push(h('div', { key: 'actions', className: 'ocb-row' },
          h('button', {
            className: 'ocb-btn',
            type: 'button',
            onClick: function () { runUpdate({ check: true }, 'check'); },
            disabled: !!upBusy || !upBridge,
          }, t('updateCheck')),
          h('button', {
            className: 'ocb-btn ocb-btn--primary',
            type: 'button',
            onClick: function () { runUpdate({ stage: true }, 'stage'); },
            disabled: !!upBusy || !upBridge || !(up && up.updateAvailable),
          }, t('updateInstall')),
        ));
        if (command) {
          kids.push(h('p', { key: 'staged', className: 'ocb-muted' },
            t('updateStagedVersion').split('{version}').join(String(up.staged ? up.staged.version : ''))));
          kids.push(h('pre', { key: 'command', className: 'ocb-pre', 'aria-readonly': 'true' }, command));
          kids.push(h('p', { key: 'close-first', className: 'ocb-notice', role: 'note' }, t('updateCloseFirst')));
          kids.push(h('div', { key: 'command-row', className: 'ocb-row' },
            h('button', {
              className: 'ocb-btn',
              type: 'button',
              onClick: function () { copyCommand(command); },
            }, upCopied === 'ok' ? t('copied') : t('updateCopyCommand')),
            upCopied === 'err' ? h('span', { className: 'ocb-error' }, t('copyFailed')) : null,
            h('span', { className: 'ocb-muted' }, t('updateCommandHelp')),
          ));
        }

        return h.apply(null, [Section, { key: 'plugin-update', title: t('updateHeading') }].concat(kids));
      }

      return { BridgeSettings: BridgeSettings, OmniModels: OmniModels, UpdateSettings: UpdateSettings };
    }

    async function apply(ctx) {
      // Localized through the host's injected `locale` service: register the dictionaries
      // before the slot is registered so the first render resolves, and bind once — the
      // bound `t` reads the active locale at call time, so it follows a language switch.
      var locale = ctx.locale;
      var t = locale && typeof locale.bind === 'function' ? locale.bind(DOMAIN) : fallbackT;
      if (locale && typeof locale.register === 'function') {
        try {
          ctx.effect(function () { return locale.register(DOMAIN, DICTS); });
        } catch (e) {
          // A live plugin reload materializes this bundle a second time and the namespace already
          // carries our dictionaries; register() throws and that must not take the client half down.
          console.warn('[omnichat-dsh-bridge] locale dictionaries were already registered: ' + ((e && e.message) || String(e)));
        }
      }

      // Nothing to undo: the <style> element lives as long as the document.
      injectStyles();

      // Mount the omnichatbridge namespace (self-mounted by this package).
      const dispose = await ctx.remote.$mount(contribution);
      ctx.effect(function () { return dispose; });

      // The namespace service is provided in $mount's child fiber, so it is read from the global
      // store after $mount (ctx.remote.omnichatbridge would not be available here).
      const bridge = ctx.get('remote.' + NS);

      // Components defined once in the apply scope (stable function identity).
      var components = createComponents(bridge, t);

      var slots = ctx.get('slots');
      if (!slots) return;
      var page = function (props) {
        if (props && props.view === 'summary') return t('summary');
        return React.createElement(components.BridgeSettings, null);
      };
      slots.inject('plugins.item', function () {
        return slots.register(
          // Unique id, listed next to the other plugin entries. The label is a thunk so it follows
          // the host language, and `locale` lets the renderer re-render it on a language switch.
          { name: 'plugins.item', id: 'omnichat-bridge', order: 13, label: function () { return t('title'); }, locale: DOMAIN },
          page,
        );
      });
    }

    module.exports = {
      name: '@omnichat/dsh-bridge',
      inject: ['slots', 'remote', 'locale'],
      apply: apply,
      // Test-only handle on the dictionaries and the Remote contribution users actually load.
      __internals: {
        EN: EN,
        JA: JA,
        ZH: ZH,
        contribution: contribution,
        POLL_MS: POLL_MS,
        pendingView: pendingView,
        createComponents: createComponents,
      },
    };

    return module.exports;
  },
});
