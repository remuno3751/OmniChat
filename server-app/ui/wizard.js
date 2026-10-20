// OmniChat Server setup wizard: 5 steps rendered into #wizard. DOM APIs only (no innerHTML).
// window.OCWizard.show() starts it; finishing calls setup_done_set, then emits 'wizard-done' (main.js shows the shell).
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var TOTAL = 5;
  var DEFAULT_PORT = 8787;

  OC.addStrings({
    ja: {
      'wiz.title': 'セットアップ', 'wiz.stepCount': '手順 {n} / {total}', 'wiz.progress': '手順 {n} / {total}',
      'wiz.t.welcome': 'OmniChat Server へようこそ', 'wiz.t.admin': '管理者アカウントを作成', 'wiz.t.data': 'データフォルダと接続ポート',
      'wiz.t.network': 'ほかの端末から接続する', 'wiz.t.auto': '自動起動',
      'wiz.lang': '言語', 'wiz.welcome.body': 'このアプリで、このPCを OmniChat のサーバーとしてセットアップします。数分で終わります。',
      'wiz.welcome.note': 'これはサーバー用のアプリです。チャットを使う画面（クライアント）は別のアプリです。',
      'wiz.admin.exists': '管理者アカウントは作成済みです。この手順はスキップされます。',
      'wiz.admin.stopped': 'サーバーが停止しています。', 'wiz.admin.needStart': '管理者アカウントは、サーバーが起動している間に作成します。',
      'wiz.admin.start': 'サーバーを起動', 'wiz.admin.user': 'ユーザー名', 'wiz.admin.userHint': '3〜32文字。このアカウントが最初の管理者になります。',
      'wiz.admin.pass': 'パスワード', 'wiz.admin.passHint': '8文字以上。', 'wiz.admin.pass2': 'パスワード（確認）', 'wiz.admin.create': '作成して次へ',
      'wiz.data.label': 'データフォルダ', 'wiz.data.hint': 'サーバーのデータはこのフォルダに保存されます（読み取り専用）。', 'wiz.data.open': 'フォルダを開く',
      'wiz.port.fb': 'ポート {c} は別のプログラムが使っているため、一時的にポート {p} で起動しています。次の「データの保存先とポート」の手順で、空いているポートを指定してください。',
      'wiz.port.label': '接続ポート', 'wiz.port.hint': '通常は 8787 のままで大丈夫です（1〜65535）。', 'wiz.port.restart': 'ポートを変更すると、稼働中のサーバーは再起動されます。',
      'wiz.fw': 'Windows の確認画面が出たら:初回の起動時に「Windows Defender ファイアウォール」の確認(Node.js)が出ることがあります。他の端末(スマートフォンなど)から使うには「プライベート ネットワーク」にチェックして「許可」を押してください。許可するまで、アプリは待ち状態に見えます。',
      'wiz.net.intro': '他の端末（スマホや別のPC）からこのサーバーに接続するためのアドレスです。',
      'wiz.net.allow': 'ほかの端末からの接続を許可', 'wiz.net.allowHint': 'オフにすると、このPCからしか接続できません（既定: オン）。',
      'wiz.net.localOnly': '今はこのPCからしか接続できません。ほかの端末から使うには、上のスイッチをオンにしてください。',
      'wiz.net.addresses': '接続先アドレス', 'wiz.net.none': 'ネットワークアドレスが見つかりませんでした。',
      'wiz.net.qr': 'スマホでこのQRコードを読み取ると、接続先が開きます。',
      'wiz.net.tailscale': '外出先（自宅のWi-Fi以外）からも使うには、スマホとこのPCの両方に Tailscale をインストールし、同じアカウントでサインインしてください。',
      'wiz.net.reg': 'ユーザーが自分で登録することを許可', 'wiz.net.regHint': 'オフ（推奨）: 管理者だけがアカウントを作成できます。',
      'wiz.auto.label': 'PCの起動時に OmniChat Server を自動で起動する（推奨）', 'wiz.auto.mech': '方式: {m}',
      'wiz.auto.delay': '起動後の待ち時間（秒）',
      'wiz.auto.delayHint': 'PCの起動直後は Tailscale やネットワークの準備がまだ整っていないことがあります。少し待つと接続が安定します（0〜300秒）。',
      'wiz.auto.unsupported': 'この環境では自動起動の設定に対応していません。サーバーはこのアプリから手動で起動してください。',
      'wiz.auto.bgLine': 'PC 起動の約{n}秒後にバックグラウンドで自動起動します(画面は出ません)',
      'wiz.auto.bgLabel': '自動起動のときは画面を出さずバックグラウンドで動かす',
      'wiz.auto.bgNote': 'ウィンドウを閉じても、サーバーは動き続けます(トレイから終了できます)',
      'wiz.finish': '完了 / ダッシュボードを開く',
      'wiz.err.needStart': '先にサーバーを起動してください。', 'wiz.err.username': 'ユーザー名は3〜32文字で入力してください。',
      'wiz.err.password': 'パスワードは8文字以上にしてください。', 'wiz.err.confirm': 'パスワードが一致しません。',
      'wiz.err.port': 'ポートは1〜65535の数字で入力してください。', 'wiz.err.delay': '待ち時間は0〜300の数字で入力してください。',
      'wiz.loadFailed': '設定を読み込めませんでした。アプリを再起動してください。'
    },
    en: {
      'wiz.title': 'Setup', 'wiz.stepCount': 'Step {n} of {total}', 'wiz.progress': 'Step {n} of {total}',
      'wiz.t.welcome': 'Welcome to OmniChat Server', 'wiz.t.admin': 'Create the admin account', 'wiz.t.data': 'Data folder and port',
      'wiz.t.network': 'Connect from other devices', 'wiz.t.auto': 'Autostart',
      'wiz.lang': 'Language', 'wiz.welcome.body': 'This sets up this PC as your OmniChat server. It takes a few minutes.',
      'wiz.welcome.note': 'This is the server app. Chat clients (the screens you chat in) are separate products.',
      'wiz.admin.exists': 'An admin account already exists. This step is skipped.',
      'wiz.admin.stopped': 'The server is stopped.', 'wiz.admin.needStart': 'The admin account is created while the server is running.',
      'wiz.admin.start': 'Start server', 'wiz.admin.user': 'Username', 'wiz.admin.userHint': '3 to 32 characters. This account becomes the first admin.',
      'wiz.admin.pass': 'Password', 'wiz.admin.passHint': 'At least 8 characters.', 'wiz.admin.pass2': 'Confirm password', 'wiz.admin.create': 'Create and continue',
      'wiz.data.label': 'Data folder', 'wiz.data.hint': 'Server data is stored in this folder (read-only).', 'wiz.data.open': 'Open folder',
      'wiz.port.fb': 'Port {c} is used by another program, so the server is temporarily running on port {p}. Choose a free port in the next step (Data folder and port).',
      'wiz.port.label': 'Port', 'wiz.port.hint': 'Usually 8787 is fine (1 to 65535).', 'wiz.port.restart': 'Changing the port restarts the running server.',
      'wiz.fw': 'If Windows asks: on the first start a "Windows Defender Firewall" prompt for Node.js may appear. To use the server from other devices (phone etc.) tick "Private networks" and press "Allow access". Until you answer it the app can look stuck.',
      'wiz.net.intro': 'These are the addresses other devices (phones, other PCs) use to reach this server.',
      'wiz.net.allow': 'Allow other devices to connect', 'wiz.net.allowHint': 'When off, only this PC can connect. Default: on.',
      'wiz.net.localOnly': 'Only this PC can connect right now. Turn on the switch above to use other devices.',
      'wiz.net.addresses': 'Addresses', 'wiz.net.none': 'No network addresses were found.',
      'wiz.net.qr': 'Scan this QR code with your phone to open the server.',
      'wiz.net.tailscale': 'To use it away from home, install Tailscale on both your phone and this PC and sign in with the same account.',
      'wiz.net.reg': 'Allow self-registration', 'wiz.net.regHint': 'Off (recommended): only admins create accounts.',
      'wiz.auto.label': 'Start OmniChat Server automatically when this PC starts (recommended)', 'wiz.auto.mech': 'Method: {m}',
      'wiz.auto.delay': 'Delay after boot (seconds)',
      'wiz.auto.delayHint': 'Right after boot, Tailscale and the network may not be ready yet. A short delay keeps connections stable (0 to 300 seconds).',
      'wiz.auto.unsupported': 'Autostart is not supported on this system. Start the server manually from this app.',
      'wiz.auto.bgLine': 'Starts in the background about {n} seconds after the PC boots (no window appears).',
      'wiz.auto.bgLabel': 'On autostart, run in the background without a window',
      'wiz.auto.bgNote': 'Closing the window keeps the server running (quit from the tray icon).',
      'wiz.finish': 'Done / Open dashboard',
      'wiz.err.needStart': 'Start the server first.', 'wiz.err.username': 'Username must be 3 to 32 characters.',
      'wiz.err.password': 'Password must be at least 8 characters.', 'wiz.err.confirm': 'Passwords do not match.',
      'wiz.err.port': 'Port must be a number from 1 to 65535.', 'wiz.err.delay': 'Delay must be a number from 0 to 300.',
      'wiz.loadFailed': 'Could not load settings. Restart the app.'
    }
  });

  // ---------- state ----------
  var visible = false, subscribed = false, unsubs = [];
  var step = 0, busy = false, lastKey = null;
  var cfg = null, cfgFailed = false, loadingCfg = false;   // get_config
  var net = null, loadingNet = false;                       // network_info
  var auto = null, loadingAuto = false;                     // autostart_get
  var bgSaved = { startInBackground: true, alwaysHidden: false }; // background_get, as loaded
  // user input, kept across re-renders (lang change, state change, going back and forth)
  var draft = { username: '', password: '', confirm: '', port: '', allowOthers: true, allowReg: false, autoOn: true, delay: '30', bg: true };
  var ui = {};      // refs of the current frame: body, err, back, next
  var fields = {};  // inputs of the current step, for validation focus

  function t(k, v) { return OC.t(k, v); }
  function fail(msg) { return Promise.reject(new Error(msg)); }
  function bad(el, msg) {
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    return fail(msg);
  }
  function isLocal(host) { return host === '127.0.0.1' || host === 'localhost'; }
  // integer string -> number within [lo, hi], or null
  function parseRange(v, lo, hi) {
    var s = String(v == null ? '' : v).trim();
    if (!/^\d+$/.test(s)) return null;
    var n = parseInt(s, 10);
    return n >= lo && n <= hi ? n : null;
  }
  function skeleton() {
    var wrap = h('div', { cls: 'stack', attrs: { 'aria-busy': 'true' } });
    [60, 85, 40].forEach(function (w) { var s = h('div', { cls: 'skeleton' }); s.style.width = w + '%'; wrap.appendChild(s); });
    return wrap;
  }
  // changes only when something the steps display changes; the poll itself does not re-render
  function stKey(s) {
    return s ? [s.running, s.userCount, s.port, s.portFallback, s.error, (s.lanUrls || []).join(',')].join('|') : 'none';
  }

  // ---------- data loading (cached per wizard run) ----------
  function loadCfg() {
    if (loadingCfg) return Promise.resolve();
    loadingCfg = true;
    return OC.invoke('get_config').then(function (c) {
      cfg = c || {}; cfgFailed = false;
      draft.port = String(cfg.port || DEFAULT_PORT);
      draft.allowOthers = !isLocal(cfg.host);
      draft.allowReg = !!cfg.allowRegistration;
    }, function () { cfgFailed = true; }).then(function () { loadingCfg = false; });
  }
  function loadNet() {
    if (loadingNet || net) return;
    loadingNet = true;
    OC.invoke('network_info').then(function (n) { net = n || {}; }, function (e) { net = { lan: [], tailscale: [], error: e.message }; })
      .then(function () { loadingNet = false; if (visible && STEPS[step].key === 'net') render(); });
  }
  function loadAuto() {
    if (loadingAuto || auto) return;
    loadingAuto = true;
    var autoP = OC.invoke('autostart_get').catch(function (e) { return { supported: false, error: e.message }; });
    var bgP = OC.invoke('background_get').catch(function () { return null; });
    Promise.all([autoP, bgP]).then(function (r) {
      var a = r[0], bg = r[1];
      auto = a || { supported: false };
      if (a && typeof a.delaySecs === 'number') draft.delay = String(a.delaySecs);
      bgSaved = {
        startInBackground: !(bg && typeof bg.startInBackground === 'boolean') || bg.startInBackground,
        alwaysHidden: !!(bg && bg.alwaysHidden)
      };
      draft.bg = bgSaved.startInBackground;
    })
      .then(function () { loadingAuto = false; if (visible && STEPS[step].key === 'auto') render(); });
  }
  // patch the saved config; restarts the server when it is running and something changed
  function saveConfig(patch) {
    if (!cfg || cfgFailed) return fail(t('wiz.loadFailed'));
    var next = {}, changed = false;
    Object.keys(cfg).forEach(function (k) { next[k] = cfg[k]; });
    Object.keys(patch).forEach(function (k) { if (next[k] !== patch[k]) { next[k] = patch[k]; changed = true; } });
    if (!changed) return Promise.resolve();
    return OC.invoke('set_config', next).then(function () {
      cfg = next;
      var s = OC.state;
      if (s && s.running) return OC.serverAction('restart_server');
    });
  }

  // ---------- step renderers: fill body, return the element to focus ----------
  function renderWelcome(body) {
    var cur = OC.lang(), first = null;
    var opts = [['ja', '日本語'], ['en', 'English']].map(function (o) {
      var inp = h('input', { attrs: { type: 'radio', name: 'wiz-lang' }, value: o[0], checked: cur === o[0],
        on: { change: function () { OC.setLang(o[0]); } } });
      if (cur === o[0]) first = inp;
      return h('label', { cls: 'wiz-opt' }, [inp, h('span', { text: o[1] })]);
    });
    body.appendChild(h('div', { cls: 'wiz-logo', text: 'O', attrs: { 'aria-hidden': 'true' } }));
    body.appendChild(h('p', { text: t('wiz.welcome.body') }));
    body.appendChild(h('fieldset', { cls: 'wiz-lang' }, [h('legend', { text: t('wiz.lang') }), h('div', { cls: 'row' }, opts)]));
    body.appendChild(h('p', { cls: 'hint', text: t('wiz.welcome.note') }));
    return first;
  }

  function renderAdmin(body) {
    var s = OC.state;
    if (!s) { body.appendChild(skeleton()); return null; }
    if (s.userCount > 0) { body.appendChild(h('div', { cls: 'alert ok', text: t('wiz.admin.exists') })); return null; }
    if (s.error) body.appendChild(h('div', { cls: 'alert', text: s.error }));
    if (s.portFallback) body.appendChild(h('div', { cls: 'alert warn', text: t('wiz.port.fb').replace('{c}', s.configuredPort).replace('{p}', s.port) }));
    if (!s.running) {
      var start = OC.btn(t('wiz.admin.start'), 'primary', function () {
        start.disabled = true;
        OC.serverAction('start_server').then(function () { start.disabled = false; });
      }, 'play');
      body.appendChild(h('div', { cls: 'alert warn', text: t('wiz.admin.stopped') }));
      body.appendChild(h('p', { cls: 'hint', text: t('wiz.admin.needStart') }));
      body.appendChild(h('div', { cls: 'row' }, [start]));
      return start;
    }
    var iu = h('input', { attrs: { type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' },
      value: draft.username, on: { input: function () { draft.username = iu.value; } } });
    var ip = h('input', { attrs: { type: 'password', autocomplete: 'new-password' },
      value: draft.password, on: { input: function () { draft.password = ip.value; } } });
    var ic = h('input', { attrs: { type: 'password', autocomplete: 'new-password' },
      value: draft.confirm, on: { input: function () { draft.confirm = ic.value; } } });
    fields = { user: iu, pass: ip, pass2: ic };
    body.appendChild(OC.field(t('wiz.admin.user'), iu, t('wiz.admin.userHint'), 'wiz-user'));
    body.appendChild(OC.field(t('wiz.admin.pass'), ip, t('wiz.admin.passHint'), 'wiz-pass'));
    body.appendChild(OC.field(t('wiz.admin.pass2'), ic, null, 'wiz-pass2'));
    return iu;
  }

  function renderData(body) {
    if (cfgFailed) { body.appendChild(h('div', { cls: 'alert', text: t('wiz.loadFailed') })); return null; }
    if (!cfg) { body.appendChild(skeleton()); return null; }
    var s = OC.state || {};
    var dir = h('input', { attrs: { type: 'text', readonly: '', spellcheck: 'false' }, value: s.dataDir || '' });
    var openBtn = OC.btn(t('wiz.data.open'), 'sm', function () { OC.safe(OC.invoke('open_folder', { which: 'data' })); }, 'external');
    var port = h('input', { attrs: { type: 'number', min: '1', max: '65535', step: '1', inputmode: 'numeric' },
      value: draft.port, on: { input: function () { draft.port = port.value; } } });
    fields = { port: port };
    body.appendChild(OC.field(t('wiz.data.label'), dir, t('wiz.data.hint'), 'wiz-data'));
    body.appendChild(h('div', { cls: 'row' }, [openBtn]));
    body.appendChild(OC.field(t('wiz.port.label'), port, t('wiz.port.hint'), 'wiz-port'));
    if (s.running) body.appendChild(h('p', { cls: 'hint', text: t('wiz.port.restart') }));
    if (/Windows/i.test(navigator.userAgent || '')) body.appendChild(h('div', { cls: 'alert warn', text: t('wiz.fw') }));
    return port;
  }

  function renderNet(body) {
    if (cfgFailed) { body.appendChild(h('div', { cls: 'alert', text: t('wiz.loadFailed') })); return null; }
    if (!cfg) { body.appendChild(skeleton()); return null; }
    if (!net) { loadNet(); body.appendChild(skeleton()); return null; }
    var port = (OC.state && OC.state.running && OC.state.port) || cfg.port || DEFAULT_PORT;
    var urls = [];
    (net.tailscale || []).forEach(function (x) { urls.push({ label: 'Tailscale', url: 'http://' + x.ip + ':' + port + '/', ts: true }); });
    (net.lan || []).forEach(function (x) { urls.push({ label: 'LAN' + (x.name ? ' (' + x.name + ')' : ''), url: 'http://' + x.ip + ':' + port + '/', ts: false }); });

    body.appendChild(h('p', { text: t('wiz.net.intro') }));
    var sw = OC.switchRow(t('wiz.net.allow'), t('wiz.net.allowHint'), draft.allowOthers, function (v) { draft.allowOthers = v; render(); });
    body.appendChild(sw);
    if (!draft.allowOthers) body.appendChild(h('div', { cls: 'alert warn', text: t('wiz.net.localOnly') }));

    body.appendChild(h('h3', { text: t('wiz.net.addresses') }));
    if (!urls.length) {
      body.appendChild(h('p', { cls: 'hint', text: t('wiz.net.none') }));
    } else {
      body.appendChild(h('div', { cls: 'list' }, urls.map(function (u) {
        return h('div', { cls: 'list-item' }, [
          h('div', { cls: 'grow' }, [h('div', { cls: 'small muted', text: u.label }), h('code', { text: u.url })]),
          OC.btn(t('common.copy'), 'sm', function () { OC.copy(u.url); }, 'copy')
        ]);
      })));
      var best = null;
      urls.forEach(function (u) { if (!best && u.ts) best = u; });
      best = best || urls[0];
      var qr = null;
      try { qr = OC.qr(best.url); } catch (e) { qr = null; }
      body.appendChild(h('div', { cls: 'row wiz-qr' }, [qr, h('div', { cls: 'stack' }, [
        h('p', { cls: 'small', text: t('wiz.net.qr') }), h('code', { text: best.url })])]));
    }
    body.appendChild(h('p', { cls: 'hint', text: t('wiz.net.tailscale') }));
    body.appendChild(OC.switchRow(t('wiz.net.reg'), t('wiz.net.regHint'), draft.allowReg, function (v) { draft.allowReg = v; }));
    body.appendChild(h('div', { cls: 'row' }, [OC.btn(t('common.refresh'), 'sm ghost', function () { net = null; render(); }, 'restart')]));
    return sw.querySelector('input');
  }

  function renderAuto(body) {
    if (!auto) { loadAuto(); body.appendChild(skeleton()); return null; }
    if (!auto.supported) { body.appendChild(h('div', { cls: 'alert warn', text: t('wiz.auto.unsupported') })); return null; }
    // the boot-delay line follows the delay field; falls back to 30 while the field is not a valid number
    function bgLineText() { var n = parseRange(draft.delay, 0, 300); return t('wiz.auto.bgLine', { n: n === null ? 30 : n }); }
    var bgLine = h('p', { cls: 'small', text: bgLineText() });
    bgLine.hidden = !draft.autoOn;
    var delay = h('input', { attrs: { type: 'number', min: '0', max: '300', step: '1', inputmode: 'numeric' },
      value: draft.delay, on: { input: function () { draft.delay = delay.value; bgLine.textContent = bgLineText(); } } });
    delay.disabled = !draft.autoOn;
    fields = { delay: delay };
    var bgIn = null;
    var sw = OC.switchRow(t('wiz.auto.label'), auto.mechanism ? t('wiz.auto.mech', { m: auto.mechanism }) : null, draft.autoOn, function (v) {
      draft.autoOn = v; delay.disabled = !v; bgLine.hidden = !v; if (bgIn) bgIn.disabled = !v;
    });
    var bgSw = OC.switchRow(t('wiz.auto.bgLabel'), null, draft.bg, function (v) { draft.bg = v; });
    bgIn = bgSw.querySelector('input');
    bgIn.disabled = !draft.autoOn;
    body.appendChild(sw);
    body.appendChild(bgLine);
    body.appendChild(OC.field(t('wiz.auto.delay'), delay, t('wiz.auto.delayHint'), 'wiz-delay'));
    body.appendChild(bgSw);
    body.appendChild(h('p', { cls: 'hint', text: t('wiz.auto.bgNote') }));
    return sw.querySelector('input');
  }

  // ---------- step submit: resolve to advance, reject with a message to stay ----------
  function submitAdmin() {
    var s = OC.state;
    if (s && s.userCount > 0) return Promise.resolve();
    if (!s || !s.running) return fail(t('wiz.err.needStart'));
    var name = draft.username.trim();
    if (name.length < 3 || name.length > 32) return bad(fields.user, t('wiz.err.username'));
    if (draft.password.length < 8) return bad(fields.pass, t('wiz.err.password'));
    if (draft.password !== draft.confirm) return bad(fields.pass2, t('wiz.err.confirm'));
    return OC.invoke('create_user', { username: name, password: draft.password, role: 'admin' }).then(function () {
      draft.password = ''; draft.confirm = '';
      return OC.refreshState();
    });
  }
  function submitData() {
    if (!cfg || cfgFailed) return fail(t('wiz.loadFailed'));
    var port = parseRange(draft.port, 1, 65535);
    if (port === null) return bad(fields.port, t('wiz.err.port'));
    return saveConfig({ port: port }).then(function () { draft.port = String(port); });
  }
  function submitNet() {
    if (!cfg || cfgFailed) return fail(t('wiz.loadFailed'));
    // keep an explicit LAN address the user had; otherwise "allow" means bind all interfaces
    var host = draft.allowOthers ? (cfg.host && !isLocal(cfg.host) ? cfg.host : '0.0.0.0') : '127.0.0.1';
    return saveConfig({ host: host, allowRegistration: !!draft.allowReg });
  }
  function submitAuto() {
    if (!auto || !auto.supported) return Promise.resolve();
    var secs = parseRange(draft.delay, 0, 300);
    if (draft.autoOn && secs === null) return bad(fields.delay, t('wiz.err.delay'));
    if (secs === null) secs = 30;
    var bgChanged = !!draft.bg !== bgSaved.startInBackground;
    return OC.invoke('autostart_set', { enabled: !!draft.autoOn, delaySecs: secs }).then(function (a) {
      if (a) auto = a;
      if (!bgChanged) return;
      return OC.invoke('background_set', { startInBackground: !!draft.bg, alwaysHidden: bgSaved.alwaysHidden }).then(function (r) {
        if (r) bgSaved = { startInBackground: !!r.startInBackground, alwaysHidden: !!r.alwaysHidden };
      });
    });
  }

  var STEPS = [
    { key: 'welcome', title: 'wiz.t.welcome', render: renderWelcome, submit: null,
      next: function () { return 'common.next'; } },
    { key: 'admin', title: 'wiz.t.admin', render: renderAdmin, submit: submitAdmin,
      next: function () { var s = OC.state; return s && s.running && !(s.userCount > 0) ? 'wiz.admin.create' : 'common.next'; } },
    { key: 'data', title: 'wiz.t.data', render: renderData, submit: submitData,
      next: function () { return 'common.next'; } },
    { key: 'net', title: 'wiz.t.network', render: renderNet, submit: submitNet,
      next: function () { return 'common.next'; } },
    { key: 'auto', title: 'wiz.t.auto', render: renderAuto, submit: submitAuto,
      next: function () { return 'wiz.finish'; } }
  ];

  // ---------- frame, navigation ----------
  function render() {
    if (!visible) return;
    var root = OC.$('wizard');
    var def = STEPS[step];
    fields = {};
    document.title = t('wiz.title') + ' – OmniChat Server';
    OC.clear(root);

    var bars = [];
    for (var i = 0; i < TOTAL; i++) bars.push(h('i', { cls: i <= step ? 'on' : null }));
    var body = h('div', { cls: 'stack' });
    var err = h('div', { cls: 'alert', attrs: { role: 'alert' } });
    err.hidden = true;
    var back = h('button', { cls: 'btn ghost', attrs: { type: 'button' }, text: t('common.back'), on: { click: goBack } });
    back.disabled = step === 0;
    var next = h('button', { cls: 'btn primary', attrs: { type: 'submit' }, text: t(def.next()) });
    ui = { body: body, err: err, back: back, next: next };

    var focus = def.render(body);
    root.appendChild(h('form', { cls: 'card wiz-card p-wizard', attrs: { novalidate: '', 'aria-labelledby': 'wiz-title' }, on: { submit: onSubmit } }, [
      h('div', { cls: 'wiz-steps', attrs: { role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(TOTAL),
        'aria-valuenow': String(step + 1), 'aria-valuetext': t('wiz.progress', { n: step + 1, total: TOTAL }) } }, bars),
      h('p', { cls: 'small muted', text: t('wiz.stepCount', { n: step + 1, total: TOTAL }) }),
      h('h1', { attrs: { id: 'wiz-title' }, text: t(def.title) }),
      body,
      err,
      h('div', { cls: 'wiz-actions' }, [back, next])
    ]));
    root.hidden = false;
    (focus || body.querySelector('input,button') || next).focus();
  }
  function go(n) { step = n; render(); }
  function goBack() { if (busy || step === 0) return; go(step - 1); }
  function setBusy(on) {
    busy = on;
    if (ui.next) ui.next.disabled = on;
    if (ui.back) ui.back.disabled = on || step === 0;
  }
  function showErr(msg) {
    if (!ui.err) return;
    ui.err.textContent = msg || '';
    ui.err.hidden = !msg;
  }
  function onSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (busy || !visible) return;
    var def = STEPS[step];
    var p;
    try { p = def.submit ? def.submit() : Promise.resolve(); } catch (ex) { p = fail(ex.message); }
    showErr('');
    setBusy(true);
    p.then(function () {
      if (step < TOTAL - 1) { setBusy(false); go(step + 1); return; }
      return OC.invoke('setup_done_set', { done: true }).then(finish);
    }).then(null, function (ex) { setBusy(false); showErr(ex.message); });
  }
  function finish() {
    teardown();
    OC.emit('wizard-done');
  }
  function teardown() {
    visible = false;
    unsubs.forEach(function (f) { f(); });
    unsubs = []; subscribed = false;
    var root = OC.$('wizard');
    OC.clear(root); root.hidden = true;
  }
  function subscribe() {
    if (subscribed) return;
    subscribed = true;
    unsubs.push(OC.on('lang', function () { if (visible) render(); }));
    unsubs.push(OC.on('state', function (s) {
      var k = stKey(s);
      if (k === lastKey) return;
      lastKey = k;
      if (visible && !busy) render();
    }));
  }

  function show() {
    visible = true; step = 0; busy = false;
    OC.$('shell').hidden = true;
    OC.$('wizard').hidden = false;
    lastKey = stKey(OC.state);
    subscribe();
    render();
    if (!cfg && !cfgFailed) loadCfg().then(function () { if (visible) render(); });
  }

  window.OCWizard = { show: show };
})();
