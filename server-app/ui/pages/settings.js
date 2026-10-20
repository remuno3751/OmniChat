// Settings page: general & network, web search, autostart, backup schedule. Each card saves on its own.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'settings.sub': 'ネットワーク、Web検索、自動起動、バックグラウンド動作、自動バックアップの設定',
      'settings.unsaved': '未保存',
      'settings.loadError': '設定を読み込めませんでした',
      'settings.restartTitle': '変更を反映するには、サーバーの再起動が必要です',
      'settings.restartNow': '今すぐ再起動',
      'settings.gen.title': '一般・ネットワーク',
      'settings.gen.sub': 'ポートと接続を許可する範囲、外部から使う URL を設定します',
      'settings.port': 'ポート',
      'settings.portHint': '1〜65535 の整数',
      'settings.host': '接続を許可する範囲',
      'settings.hostAll': '他の端末からの接続を許可',
      'settings.hostAllHint': 'ホスト 0.0.0.0。スマートフォンや他の PC から接続できます',
      'settings.hostLocal': 'このPCのみ',
      'settings.hostLocalHint': 'ホスト 127.0.0.1。他の端末からは接続できません',
      'settings.publicUrl': '公開URL（リバースプロキシ配下のブリッジ用）（任意）',
      'settings.publicUrlHint': '空欄で構いません。http:// または https:// で始まる URL',
      'settings.files': 'ファイル',
      'settings.dataDir': 'データフォルダ',
      'settings.configPath': '設定ファイル',
      'settings.openFolder': 'フォルダを開く',
      'settings.openFile': '開く',
      'settings.errPort': 'ポートは 1〜65535 の整数で入力してください',
      'settings.errUrl': 'URL は http:// または https:// で始めてください',
      'settings.errHours': '間隔は 0〜8760 の整数で入力してください',
      'settings.errKeep': '保持件数は 1〜1000 の整数で入力してください',
      'settings.errDelay': '待機時間は 0〜300 の整数で入力してください',
      'settings.search.title': 'Web検索',
      'settings.search.sub': '検索に使う SearXNG サーバーを指定します',
      'settings.searxng': 'SearXNG の URL',
      'settings.searxngHint': '空欄で無効になります。例: http://localhost:8888',
      'settings.searchAdvanced': '内蔵エンジン、Brave / Tavily の API キー、フォールバックは検索設定で管理されます（ここでは参照のみ）',
      'settings.searchCurrent': '現在の検索設定',
      'settings.searchNone': '検索設定を取得できませんでした',
      'settings.testTitle': 'テスト検索',
      'settings.testPlaceholder': '検索語を入力',
      'settings.testBtn': '検索',
      'settings.testNoResults': '結果はありません',
      'settings.testStopped': 'テスト検索はサーバーの稼働中に使えます',
      'settings.auto.title': '自動起動',
      'settings.auto.sub': 'PC の起動時に OmniChat Server を自動で開始します',
      'settings.auto.enable': 'このPCの起動時に OmniChat Server を自動で開始する（推奨）',
      'settings.auto.delay': '開始までの待機時間（秒）',
      'settings.auto.delayHint': 'Tailscale やネットワークアダプターの準備を待つための時間です。サーバーはさらに最大 120 秒、ネットワークの準備を待ちます',
      'settings.auto.method': '方式: {m}',
      'settings.auto.unsupported': 'この PC では自動起動を設定できません',
      'settings.bg.title': 'バックグラウンド動作',
      'settings.bg.sub': 'サーバーの起動時に画面を出すかどうかを設定します',
      'settings.bg.start': 'PC の起動時(自動起動)は画面を出さず、バックグラウンドで起動する',
      'settings.bg.startHint': 'ウィンドウは出ず、タスクトレイのアイコンから開けます。手動で起動したときは画面が開きます。',
      'settings.bg.always': '手動で起動したときも常に画面を出さない',
      'settings.bg.alwaysHint': 'タスクトレイのアイコンをクリックすると開きます。',
      'settings.bg.note': 'ウィンドウを閉じても、サーバーはバックグラウンドで動き続けます。完全に止めるには、トレイのアイコンから「終了」を選びます。',
      'settings.backup.title': '自動バックアップ',
      'settings.backup.sub': '定期バックアップの間隔と保持件数',
      'settings.backup.interval': 'バックアップ間隔（時間）',
      'settings.backup.intervalHint': '0 で無効。既定値は 24',
      'settings.backup.keep': '保持件数',
      'settings.backup.keepHint': 'これより古い自動バックアップは削除されます',
      'settings.backup.off': '自動バックアップは無効です',
      'settings.backup.summary': '{h} 時間ごとに自動バックアップし、最新 {k} 件を保持します'
    },
    en: {
      'settings.sub': 'Network, web search, autostart, background mode and scheduled backups',
      'settings.unsaved': 'Unsaved',
      'settings.loadError': 'Could not load settings',
      'settings.restartTitle': 'Restart the server to apply these changes.',
      'settings.restartNow': 'Restart now',
      'settings.gen.title': 'General & network',
      'settings.gen.sub': 'Port, who can connect, and the address other devices use.',
      'settings.port': 'Port',
      'settings.portHint': 'Whole number from 1 to 65535.',
      'settings.host': 'Who can connect',
      'settings.hostAll': 'Allow other devices',
      'settings.hostAllHint': 'Host 0.0.0.0. Phones and other PCs can connect.',
      'settings.hostLocal': 'This PC only',
      'settings.hostLocalHint': 'Host 127.0.0.1. Other devices cannot connect.',
      'settings.publicUrl': 'Public URL (used by bridges behind a reverse proxy), optional',
      'settings.publicUrlHint': 'Leave empty if not needed. Must start with http:// or https://.',
      'settings.files': 'Files',
      'settings.dataDir': 'Data folder',
      'settings.configPath': 'Config file',
      'settings.openFolder': 'Open folder',
      'settings.openFile': 'Open',
      'settings.errPort': 'Port must be a whole number from 1 to 65535.',
      'settings.errUrl': 'URL must start with http:// or https://.',
      'settings.errHours': 'Interval must be a whole number from 0 to 8760.',
      'settings.errKeep': 'Backups to keep must be a whole number from 1 to 1000.',
      'settings.errDelay': 'Delay must be a whole number from 0 to 300.',
      'settings.search.title': 'Web search',
      'settings.search.sub': 'SearXNG server used for web search.',
      'settings.searxng': 'SearXNG URL',
      'settings.searxngHint': 'Leave empty to disable. Example: http://localhost:8888',
      'settings.searchAdvanced': 'The built-in engine, Brave / Tavily API keys and fallback are managed in the search configuration (read-only here).',
      'settings.searchCurrent': 'Current search configuration',
      'settings.searchNone': 'The search configuration is unavailable.',
      'settings.testTitle': 'Test search',
      'settings.testPlaceholder': 'Enter a query',
      'settings.testBtn': 'Search',
      'settings.testNoResults': 'No results.',
      'settings.testStopped': 'Test search needs the server to be running.',
      'settings.auto.title': 'Autostart',
      'settings.auto.sub': 'Start OmniChat Server when this PC starts.',
      'settings.auto.enable': 'Start OmniChat Server automatically when this PC starts (recommended)',
      'settings.auto.delay': 'Start delay (seconds)',
      'settings.auto.delayHint': 'Waits so that Tailscale/network adapters are ready; the server also waits up to 120 s for the network',
      'settings.auto.method': 'Method: {m}',
      'settings.auto.unsupported': 'Autostart cannot be set up on this PC.',
      'settings.bg.title': 'Background',
      'settings.bg.sub': 'Choose whether the window appears when the server starts.',
      'settings.bg.start': 'On autostart, start in the background without showing the window',
      'settings.bg.startHint': 'No window appears; open it from the tray icon. Launching it manually still opens the window.',
      'settings.bg.always': 'Always start hidden, even when I launch it manually',
      'settings.bg.alwaysHint': 'Click the tray icon to open it.',
      'settings.bg.note': 'Closing the window keeps the server running in the background. To stop it completely, choose Quit from the tray icon.',
      'settings.backup.title': 'Scheduled backups',
      'settings.backup.sub': 'Interval and number of scheduled backups to keep.',
      'settings.backup.interval': 'Backup interval (hours)',
      'settings.backup.intervalHint': '0 turns scheduled backups off. Default 24.',
      'settings.backup.keep': 'Backups to keep',
      'settings.backup.keepHint': 'Older scheduled backups beyond this count are deleted.',
      'settings.backup.off': 'Scheduled backups are off.',
      'settings.backup.summary': 'Backs up every {h} hours and keeps the latest {k}.'
    }
  });

  function running() { return !!(OC.state && OC.state.running); }
  function isInt(v, lo, hi) { var s = String(v).trim(); if (!/^\d+$/.test(s)) return false; var n = Number(s); return n >= lo && n <= hi; }
  function isHttpUrl(s) { return !s || /^https?:\/\/\S+$/i.test(s); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function hostOf(v) { return v === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0'; }
  function assign(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }
  var SECRET = /key|token|secret|password/i;

  // A card with dirty tracking and one Save button. Builders fill c.body and set c.isDirty / c.onSave.
  function makeCard(title, sub) {
    var c = { canSave: true, busy: false, isDirty: function () { return false; }, onSave: null };
    c.chip = OC.chip('warn', t('settings.unsaved'));
    c.chip.hidden = true;
    c.msg = h('div', { cls: 'msg', attrs: { role: 'status' } });
    c.save = OC.btn(t('common.save'), 'primary', function () { if (c.onSave) c.onSave(); });
    c.body = h('div', { cls: 'stack' });
    c.card = h('section', { cls: 'card' }, [
      h('div', { cls: 'row between' }, [h('h2', { text: title }), c.chip]),
      sub ? h('p', { cls: 'card-sub', text: sub }) : null,
      c.body,
      h('div', { cls: 'row between' }, [c.msg, c.save])
    ]);
    c.refresh = function () { var d = c.isDirty(); c.chip.hidden = !d; c.save.disabled = !d || c.busy || !c.canSave; };
    c.setBusy = function (on) { c.busy = on; c.refresh(); };
    c.say = function (text, kind) {
      OC.clear(c.msg);
      if (text) c.msg.appendChild(h('p', { cls: 'alert ' + (kind || ''), text: text }));
    };
    return c;
  }

  // Read-only key/value list; secret-looking keys are masked.
  function kvList(obj) {
    var dl = h('dl', { cls: 'kv small' });
    Object.keys(obj).forEach(function (k) {
      var v = obj[k], s;
      if (SECRET.test(k)) s = v ? '••••••' : '—';
      else if (v === null || v === undefined || v === '') s = '—';
      else if (typeof v === 'object') s = JSON.stringify(v);
      else s = String(v);
      dl.appendChild(h('dt', { text: k }));
      dl.appendChild(h('dd', { cls: 'mono', text: s }));
    });
    return dl;
  }

  function radio(input, label, hint) {
    return h('label', { cls: 'radio-opt' }, [input, h('span', { cls: 'sw-text' }, [h('span', { text: label }), h('span', { cls: 'hint', text: hint })])]);
  }

  OC.registerPage({ id: 'settings', order: 70, icon: 'settings', titleKey: 'nav.settings', render: render });

  function render(root) {
    root.classList.add('p-settings');
    root.appendChild(OC.pageHeader(t('nav.settings'), t('settings.sub'), null));

    var alive = true, restartPending = false;
    var cfg = {}, extra = {}, live = {};
    var banner = h('div', { cls: 'stack' });
    banner.hidden = true;
    root.appendChild(banner);
    var loading = h('section', { cls: 'card' }, [h('div', { cls: 'stack' }, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })])]);
    root.appendChild(loading);

    function markRestart(need) { if (need) restartPending = true; updateBanner(); }
    function updateBanner() {
      OC.clear(banner);
      banner.hidden = !(restartPending && running());
      if (banner.hidden) return;
      var b = OC.btn(t('settings.restartNow'), 'primary sm', function () {
        b.disabled = true;
        OC.serverAction('restart_server').then(function (s) { if (s) restartPending = false; if (alive) updateBanner(); });
      });
      banner.appendChild(h('div', { cls: 'alert warn' }, [h('div', { cls: 'row between' }, [h('span', { text: t('settings.restartTitle') }), b])]));
    }

    function buildGeneral() {
      var c = makeCard(t('settings.gen.title'), t('settings.gen.sub'));
      function upd() { c.refresh(); }
      var portIn = h('input', { attrs: { type: 'number', min: '1', max: '65535', step: '1', inputmode: 'numeric' }, value: cfg.port != null ? String(cfg.port) : '', on: { input: upd } });
      var allIn = h('input', { attrs: { type: 'radio', name: 'oc-set-host', value: '0.0.0.0' }, checked: hostOf(cfg.host) === '0.0.0.0', on: { change: upd } });
      var localIn = h('input', { attrs: { type: 'radio', name: 'oc-set-host', value: '127.0.0.1' }, checked: hostOf(cfg.host) === '127.0.0.1', on: { change: upd } });
      var pubIn = h('input', { attrs: { type: 'url', placeholder: 'https://omni.example.com', autocomplete: 'off' }, value: extra.publicUrl || '', on: { input: upd } });
      var portSaved = cfg.port != null ? String(cfg.port) : '';

      c.isDirty = function () {
        return portIn.value.trim() !== portSaved ||
          (localIn.checked ? '127.0.0.1' : '0.0.0.0') !== hostOf(cfg.host) ||
          pubIn.value.trim() !== (extra.publicUrl || '');
      };
      c.onSave = function () {
        var port = portIn.value.trim(), pub = pubIn.value.trim(), host = localIn.checked ? '127.0.0.1' : '0.0.0.0';
        if (!isInt(port, 1, 65535)) { c.say(t('settings.errPort')); return; }
        if (!isHttpUrl(pub)) { c.say(t('settings.errUrl')); return; }
        var restart = false;
        c.say(''); c.setBusy(true);
        OC.invoke('set_config', { port: Number(port), host: host, allowRegistration: cfg.allowRegistration, searxngUrl: cfg.searxngUrl })
          .then(function (r) {
            cfg = assign(cfg, { port: Number(port), host: host });
            restart = !!(r && r.restartRequired);
            return OC.invoke('set_extra', { publicUrl: pub, backupIntervalHours: extra.backupIntervalHours, backupKeep: extra.backupKeep });
          })
          .then(function (r) {
            if (!alive) return;
            extra = assign(extra, { publicUrl: pub });
            portIn.value = String(cfg.port);
            pubIn.value = pub;
            portSaved = String(cfg.port);
            restart = restart || !!(r && r.restartRequired);
            c.setBusy(false); c.say(t('common.saved'), 'ok'); markRestart(restart);
          }, function (e) {
            if (!alive) return;
            c.setBusy(false); c.say(e.message); markRestart(restart);
          });
      };

      var dataCode = h('code', { text: (OC.state && OC.state.dataDir) || '—' });
      var cfgCode = h('code', { text: (OC.state && OC.state.configPath) || '—' });
      live.dataCode = dataCode; live.cfgCode = cfgCode;
      var files = h('dl', { cls: 'kv' }, [
        h('dt', { text: t('settings.dataDir') }),
        h('dd', {}, [h('div', { cls: 'row' }, [dataCode, OC.btn(t('settings.openFolder'), 'sm', function () { OC.safe(OC.invoke('open_folder', { which: 'data' })); })])]),
        h('dt', { text: t('settings.configPath') }),
        h('dd', {}, [h('div', { cls: 'row' }, [cfgCode, OC.btn(t('settings.openFile'), 'sm', function () { OC.safe(OC.invoke('open_folder', { which: 'config' })); })])])
      ]);

      c.body.appendChild(OC.field(t('settings.port'), portIn, t('settings.portHint'), 'set-port'));
      c.body.appendChild(h('fieldset', { cls: 'radio-group' }, [
        h('legend', { text: t('settings.host') }),
        radio(allIn, t('settings.hostAll'), t('settings.hostAllHint')),
        radio(localIn, t('settings.hostLocal'), t('settings.hostLocalHint'))
      ]));
      c.body.appendChild(OC.field(t('settings.publicUrl'), pubIn, t('settings.publicUrlHint'), 'set-pub'));
      c.body.appendChild(h('h3', { text: t('settings.files') }));
      c.body.appendChild(files);
      c.refresh();
      return c;
    }

    function buildSearch(search) {
      var c = makeCard(t('settings.search.title'), t('settings.search.sub'));
      function upd() { c.refresh(); }
      var urlIn = h('input', { attrs: { type: 'url', placeholder: 'http://localhost:8888', autocomplete: 'off' }, value: cfg.searxngUrl || '', on: { input: upd } });
      c.isDirty = function () { return urlIn.value.trim() !== (cfg.searxngUrl || ''); };
      c.onSave = function () {
        var v = urlIn.value.trim();
        if (!isHttpUrl(v)) { c.say(t('settings.errUrl')); return; }
        c.say(''); c.setBusy(true);
        OC.invoke('set_config', { port: cfg.port, host: cfg.host, allowRegistration: cfg.allowRegistration, searxngUrl: v })
          .then(function (r) {
            if (!alive) return;
            cfg = assign(cfg, { searxngUrl: v });
            urlIn.value = v;
            c.setBusy(false); c.say(t('common.saved'), 'ok'); markRestart(!!(r && r.restartRequired));
          }, function (e) {
            if (!alive) return;
            c.setBusy(false); c.say(e.message);
          });
      };

      c.body.appendChild(OC.field(t('settings.searxng'), urlIn, t('settings.searxngHint'), 'set-searxng'));
      c.body.appendChild(h('p', { cls: 'hint', text: t('settings.searchAdvanced') }));
      c.body.appendChild(h('h3', { text: t('settings.searchCurrent') }));
      c.body.appendChild(search && typeof search === 'object' ? kvList(search) : h('p', { cls: 'hint', text: t('settings.searchNone') }));

      // Test search
      c.body.appendChild(h('h3', { text: t('settings.testTitle') }));
      var qIn = h('input', { attrs: { type: 'search', placeholder: t('settings.testPlaceholder'), 'aria-label': t('settings.testTitle') },
        on: { keydown: function (e) { if (e.key === 'Enter') runTest(); } } });
      var testBtn = OC.btn(t('settings.testBtn'), '', runTest);
      testBtn.disabled = !running();
      live.testBtn = testBtn;
      var results = h('div', { cls: 'stack' });
      c.body.appendChild(h('div', { cls: 'row' }, [h('div', { cls: 'grow' }, [qIn]), testBtn]));
      c.body.appendChild(results);

      function runTest() {
        var q = qIn.value.trim();
        OC.clear(results);
        if (!q) return;
        if (!running()) { results.appendChild(h('p', { cls: 'hint', text: t('settings.testStopped') })); return; }
        testBtn.disabled = true;
        results.appendChild(h('p', { cls: 'hint', text: t('common.loading') }));
        OC.invoke('search_test', { query: q, mode: 'auto' }).then(function (r) {
          if (!alive) return;
          OC.clear(results);
          var list = Array.isArray(r) ? r : ((r && (r.results || r.items)) || []);
          if (!list.length) { results.appendChild(h('p', { cls: 'hint', text: t('settings.testNoResults') })); return; }
          var box = h('div', { cls: 'list' });
          list.slice(0, 5).forEach(function (it) {
            box.appendChild(h('div', { cls: 'list-item' }, [h('div', { cls: 'grow' }, [
              h('div', { text: String((it && (it.title || it.name)) || '') }),
              h('div', { cls: 'mono small muted', text: String((it && (it.url || it.link)) || '') })
            ])]));
          });
          results.appendChild(box);
        }, function (e) {
          if (!alive) return;
          OC.clear(results);
          results.appendChild(h('p', { cls: 'alert', text: e.message }));
        }).then(function () { if (alive) testBtn.disabled = !running(); });
      }

      c.refresh();
      return c;
    }

    function buildAuto(a) {
      var c = makeCard(t('settings.auto.title'), t('settings.auto.sub'));
      var hasErr = !!(a && a.error);
      var supported = !!(a && a.supported) && !hasErr;
      var saved = { enabled: !!(a && a.enabled), delay: num(a && a.delaySecs, 30) };
      var sw = OC.switchRow(t('settings.auto.enable'), null, saved.enabled, function () { c.refresh(); });
      var swIn = sw.querySelector('input');
      var delayIn = h('input', { attrs: { type: 'number', min: '0', max: '300', step: '1', inputmode: 'numeric' }, value: String(saved.delay), on: { input: function () { c.refresh(); } } });
      swIn.disabled = !supported;
      delayIn.disabled = !supported;
      c.canSave = supported;
      c.isDirty = function () { return swIn.checked !== saved.enabled || delayIn.value.trim() !== String(saved.delay); };
      c.onSave = function () {
        if (!isInt(delayIn.value, 0, 300)) { c.say(t('settings.errDelay')); return; }
        c.say(''); c.setBusy(true);
        OC.invoke('autostart_set', { enabled: swIn.checked, delaySecs: Number(delayIn.value.trim()) }).then(function (r) {
          if (!alive) return;
          r = r || {};
          saved = { enabled: !!r.enabled, delay: num(r.delaySecs, 30) };
          swIn.checked = saved.enabled;
          delayIn.value = String(saved.delay);
          c.setBusy(false); c.say(t('common.saved'), 'ok');
        }, function (e) {
          if (!alive) return;
          c.setBusy(false); c.say(e.message);
        });
      };

      c.body.appendChild(sw);
      c.body.appendChild(OC.field(t('settings.auto.delay'), delayIn, t('settings.auto.delayHint'), 'set-delay'));
      if (hasErr) c.body.appendChild(h('p', { cls: 'alert', text: a.error }));
      else if (!supported) c.body.appendChild(h('p', { cls: 'alert warn', text: t('settings.auto.unsupported') }));
      if (a && a.mechanism) c.body.appendChild(h('p', { cls: 'small muted', text: t('settings.auto.method', { m: a.mechanism }) }));
      c.refresh();
      return c;
    }

    function buildBg(bg) {
      var c = makeCard(t('settings.bg.title'), t('settings.bg.sub'));
      var savedBg = {
        startInBackground: !(bg && typeof bg.startInBackground === 'boolean') || bg.startInBackground,
        alwaysHidden: !!(bg && bg.alwaysHidden)
      };
      var startSw = OC.switchRow(t('settings.bg.start'), t('settings.bg.startHint'), savedBg.startInBackground, function () { c.refresh(); });
      var alwaysSw = OC.switchRow(t('settings.bg.always'), t('settings.bg.alwaysHint'), savedBg.alwaysHidden, function () { c.refresh(); });
      var startIn = startSw.querySelector('input');
      var alwaysIn = alwaysSw.querySelector('input');
      c.isDirty = function () { return startIn.checked !== savedBg.startInBackground || alwaysIn.checked !== savedBg.alwaysHidden; };
      c.onSave = function () {
        c.say(''); c.setBusy(true);
        OC.invoke('background_set', { startInBackground: startIn.checked, alwaysHidden: alwaysIn.checked }).then(function (r) {
          if (!alive) return;
          r = r || {};
          savedBg = { startInBackground: !!r.startInBackground, alwaysHidden: !!r.alwaysHidden };
          startIn.checked = savedBg.startInBackground;
          alwaysIn.checked = savedBg.alwaysHidden;
          c.setBusy(false); c.say(t('common.saved'), 'ok'); markRestart(!!(r && r.restartRequired));
        }, function (e) {
          if (!alive) return;
          c.setBusy(false); c.say(e.message);
        });
      };
      c.body.appendChild(startSw);
      c.body.appendChild(alwaysSw);
      c.body.appendChild(h('p', { cls: 'hint', text: t('settings.bg.note') }));
      c.refresh();
      return c;
    }

    function buildBackup() {
      var c = makeCard(t('settings.backup.title'), t('settings.backup.sub'));
      var saved = { h: num(extra.backupIntervalHours, 24), k: num(extra.backupKeep, 10) };
      var hIn = h('input', { attrs: { type: 'number', min: '0', max: '8760', step: '1', inputmode: 'numeric' }, value: String(saved.h), on: { input: function () { c.refresh(); } } });
      var kIn = h('input', { attrs: { type: 'number', min: '1', max: '1000', step: '1', inputmode: 'numeric' }, value: String(saved.k), on: { input: function () { c.refresh(); } } });
      var summary = h('p', { cls: 'hint' });
      function showSummary() {
        summary.textContent = saved.h ? t('settings.backup.summary', { h: saved.h, k: saved.k }) : t('settings.backup.off');
      }
      showSummary();
      c.isDirty = function () { return hIn.value.trim() !== String(saved.h) || kIn.value.trim() !== String(saved.k); };
      c.onSave = function () {
        if (!isInt(hIn.value, 0, 8760)) { c.say(t('settings.errHours')); return; }
        if (!isInt(kIn.value, 1, 1000)) { c.say(t('settings.errKeep')); return; }
        var nh = Number(hIn.value.trim()), nk = Number(kIn.value.trim());
        c.say(''); c.setBusy(true);
        OC.invoke('set_extra', { publicUrl: extra.publicUrl || '', backupIntervalHours: nh, backupKeep: nk }).then(function (r) {
          if (!alive) return;
          extra = assign(extra, { backupIntervalHours: nh, backupKeep: nk });
          saved = { h: nh, k: nk };
          hIn.value = String(nh);
          kIn.value = String(nk);
          showSummary();
          c.setBusy(false); c.say(t('common.saved'), 'ok'); markRestart(!!(r && r.restartRequired));
        }, function (e) {
          if (!alive) return;
          c.setBusy(false); c.say(e.message);
        });
      };
      c.body.appendChild(OC.field(t('settings.backup.interval'), hIn, t('settings.backup.intervalHint'), 'set-bh'));
      c.body.appendChild(OC.field(t('settings.backup.keep'), kIn, t('settings.backup.keepHint'), 'set-bk'));
      c.body.appendChild(summary);
      c.refresh();
      return c;
    }

    Promise.all([
      OC.invoke('get_config'),
      OC.invoke('get_extra'),
      OC.invoke('get_search_config').catch(function () { return null; }),
      OC.invoke('autostart_get').catch(function (e) { return { error: e.message }; }),
      OC.invoke('background_get').catch(function () { return null; })
    ]).then(function (r) {
      if (!alive) return;
      loading.remove();
      cfg = r[0] || {};
      extra = r[1] || {};
      [buildGeneral(), buildSearch(r[2]), buildAuto(r[3]), buildBg(r[4]), buildBackup()].forEach(function (c) { root.appendChild(c.card); });
      updateBanner();
    }, function (e) {
      if (!alive) return;
      loading.remove();
      root.appendChild(h('section', { cls: 'card' }, [
        h('p', { cls: 'alert', text: t('settings.loadError') + ': ' + e.message }),
        OC.btn(t('common.refresh'), '', function () { OC.go('settings'); })
      ]));
    });

    return {
      onState: function (s) {
        if (!alive) return;
        if (!s.running) restartPending = false;
        updateBanner();
        if (live.testBtn) live.testBtn.disabled = !s.running;
        if (live.dataCode) live.dataCode.textContent = s.dataDir || '—';
        if (live.cfgCode) live.cfgCode.textContent = s.configPath || '—';
      },
      destroy: function () { alive = false; }
    };
  }
})();
