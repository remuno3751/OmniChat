// Dashboard page: server status, primary controls, stats, and access URLs (Tailscale / LAN) with a QR code.
(function () {
  'use strict';
  var OC = window.OC;
  var t = OC.t;
  var h = OC.h;
  var POLL_MS = 5000;
  var LOOPBACK = '127.0.0.1';

  OC.addStrings({
    ja: {
      'dashboard.sub': 'サーバーの状態と接続先',
      'dashboard.start': '開始',
      'dashboard.stop': '停止',
      'dashboard.restart': '再起動',
      'dashboard.update': 'アップデートあり',
      'dashboard.uptime': '稼働時間',
      'dashboard.port': 'ポート',
      'dashboard.portFb': 'ポート {c} は別のプログラムが使っているため、一時的にポート {p} で起動しています。「設定」でポートを変更してください。',
      'dashboard.version': 'バージョン',
      'dashboard.users': 'ユーザー数',
      'dashboard.activeChats': 'アクティブなチャット',
      'dashboard.otherDevices': '他の端末から開く',
      'dashboard.otherDevicesSub': '同じネットワーク、またはTailscaleに参加している端末から、次のアドレスでWeb UIを開けます。',
      'dashboard.openWebUi': 'Web UIを開く',
      'dashboard.copyAria': 'URLをコピー: {url}',
      'dashboard.lan': 'LAN',
      'dashboard.tailscale': 'Tailscale',
      'dashboard.localOnlyTitle': 'このPCからしか接続できません',
      'dashboard.localOnlyHint': '待ち受けアドレスが 127.0.0.1 になっています。「設定」で 0.0.0.0 に変更すると、他の端末からも接続できます。',
      'dashboard.noUrls': '接続先のアドレスが見つかりません。',
      'dashboard.qrCaption': 'スマートフォンでスキャン',
      'dashboard.stoppedTitle': 'サーバーは停止しています',
      'dashboard.stoppedSub': '開始すると、チャットサーバーが利用できるようになります。'
    },
    en: {
      'dashboard.sub': 'Server status and access addresses',
      'dashboard.start': 'Start',
      'dashboard.stop': 'Stop',
      'dashboard.restart': 'Restart',
      'dashboard.update': 'Update available',
      'dashboard.uptime': 'Uptime',
      'dashboard.port': 'Port',
      'dashboard.portFb': 'Port {c} is used by another program, so the server is temporarily running on port {p}. Change the port in Settings.',
      'dashboard.version': 'Version',
      'dashboard.users': 'Users',
      'dashboard.activeChats': 'Active chats',
      'dashboard.otherDevices': 'Open from other devices',
      'dashboard.otherDevicesSub': 'Devices on the same network or on your Tailscale network can open the web UI at these addresses.',
      'dashboard.openWebUi': 'Open web UI',
      'dashboard.copyAria': 'Copy URL: {url}',
      'dashboard.lan': 'LAN',
      'dashboard.tailscale': 'Tailscale',
      'dashboard.localOnlyTitle': 'Only reachable from this PC',
      'dashboard.localOnlyHint': 'The server listens on 127.0.0.1. Change the listen address to 0.0.0.0 in Settings to allow other devices to connect.',
      'dashboard.noUrls': 'No network address was found.',
      'dashboard.qrCaption': 'Scan with your phone',
      'dashboard.stoppedTitle': 'The server is stopped',
      'dashboard.stoppedSub': 'Start it to bring the chat server online.'
    }
  });

  function countOf(v) {
    if (Array.isArray(v)) return v.length;
    return typeof v === 'number' ? v : null;
  }
  function hostPart(ip) { return ip.indexOf(':') >= 0 ? '[' + ip + ']' : ip; }

  // Tailscale addresses first, then LAN; falls back to state.lanUrls when network_info gives nothing.
  function buildNetItems(s, info) {
    var items = [];
    var base = 'http://';
    var tail = ':' + s.port + '/';
    if (info) {
      (info.tailscale || []).forEach(function (x) { if (x && x.ip) items.push({ kind: 'tailscale', url: base + hostPart(x.ip) + tail }); });
      (info.lan || []).forEach(function (x) { if (x && x.ip) items.push({ kind: 'lan', url: base + hostPart(x.ip) + tail }); });
    }
    if (!items.length && s.lanUrls && s.lanUrls.length) {
      s.lanUrls.forEach(function (u) { items.push({ kind: 'lan', url: u }); });
    }
    return items;
  }

  OC.addStrings({
    ja: { 'maint.banner': 'メンテナンス中', 'maint.bannerDefault': '現在メンテナンス中です。AI 機能は一般ユーザーには利用できません。' },
    en: { 'maint.banner': 'Under maintenance', 'maint.bannerDefault': 'The server is under maintenance. AI features are unavailable to regular users.' }
  });

  OC.registerPage({
    id: 'dashboard', order: 10, icon: 'dashboard', titleKey: 'nav.dashboard',
    render: function (root) {
      root.classList.add('p-dashboard');

      var alertSlot = h('div', { cls: 'stack' });
      var body = h('div', { cls: 'stack' });
      var runChip = h('span', { cls: 'chip', text: t('common.loading') });
      var updChip = h('span', { cls: 'chip warn', text: t('dashboard.update'), attrs: { id: 'dash-update', hidden: '' } });
      var refs = {};
      var curMode = '', pollTimer = null, pollBusy = false, netKey = '', netSeq = 0, ov = null;
      var maint = null; // maintenance state (local admin API), shown as a banner while the server runs

      function act(cmd) {
        return function () { if (!OC.isBusy()) OC.serverAction(cmd); };
      }
      function makeBtn(key, text, cls, cmd, icon) {
        var b = OC.btn(text, cls, act(cmd), icon);
        b.setAttribute('data-act', key);
        return b;
      }

      // Start is enabled only when stopped; Stop/Restart only when running. All are disabled while busy.
      function updateButtons() {
        var s = OC.state, run = !!(s && s.running), busy = OC.isBusy();
        Array.prototype.forEach.call(root.querySelectorAll('button[data-act]'), function (b) {
          var key = b.getAttribute('data-act');
          b.disabled = busy || !s || (key === 'start' ? run : !run);
        });
      }
      var unBusy = OC.on('busy', function () { updateButtons(); });

      root.appendChild(OC.pageHeader(t('nav.dashboard'), t('dashboard.sub'), h('div', { cls: 'row' }, [
        runChip, updChip,
        makeBtn('start', t('dashboard.start'), 'primary', 'start_server', 'play'),
        makeBtn('stop', t('dashboard.stop'), 'danger', 'stop_server', 'stop'),
        makeBtn('restart', t('dashboard.restart'), '', 'restart_server', 'restart')
      ])));
      root.appendChild(alertSlot);
      root.appendChild(body);

      function buildLoading() {
        return OC.card(null, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton sk-short' }), h('div', { cls: 'skeleton sk-mid' })]);
      }

      function buildStopped() {
        return h('div', { cls: 'empty' }, [
          h('div', { cls: 'big', text: '○' }),
          h('h2', { text: t('dashboard.stoppedTitle') }),
          h('p', { cls: 'small', text: t('dashboard.stoppedSub') }),
          makeBtn('start', t('dashboard.start'), 'primary', 'start_server', 'play')
        ]);
      }

      function stat(label) {
        var num = h('span', { cls: 'num', text: '—' });
        return { el: h('section', { cls: 'card' }, [h('div', { cls: 'stat' }, [h('h3', { text: label }), num])]), num: num };
      }

      function buildRunning() {
        var up = stat(t('dashboard.uptime')), port = stat(t('dashboard.port')), ver = stat(t('dashboard.version'));
        var usr = stat(t('dashboard.users')), chats = stat(t('dashboard.activeChats'));
        refs.uptime = up.num; refs.port = port.num; refs.version = ver.num; refs.users = usr.num; refs.chats = chats.num;
        refs.netBox = h('div', { cls: 'stack' });
        refs.fb = h('div', { cls: 'alert warn' });
        refs.fb.hidden = true;
        netKey = '';
        return h('div', { cls: 'stack' }, [
          refs.fb,
          h('div', { cls: 'stats' }, [up.el, port.el, ver.el, usr.el, chats.el]),
          refs.netBox
        ]);
      }

      function paintStats(s) {
        refs.port.textContent = s.port != null ? String(s.port) : '—';
        if (refs.fb) { refs.fb.hidden = !s.portFallback; refs.fb.textContent = s.portFallback ? t('dashboard.portFb').replace('{c}', s.configuredPort).replace('{p}', s.port) : ''; }
        refs.version.textContent = s.version || '—';
        var users = ov ? countOf(ov.users) : null;
        if (users == null) users = countOf(s.userCount);
        refs.users.textContent = users == null ? '—' : String(users);
        refs.uptime.textContent = ov && ov.uptimeSec != null ? OC.fmtDuration(ov.uptimeSec) : '—';
        refs.chats.textContent = ov && ov.activeChats != null ? String(ov.activeChats) : '—';
      }

      function urlRow(item) {
        var label = item.kind === 'tailscale' ? t('dashboard.tailscale') : t('dashboard.lan');
        var copy = OC.btn(t('common.copy'), 'sm', function () { OC.copy(item.url); }, 'copy');
        copy.setAttribute('aria-label', t('dashboard.copyAria', { url: item.url }));
        return h('div', { cls: 'urlbox' }, [OC.chip('', label, true), h('code', { text: item.url }), copy]);
      }

      function renderNet(s, items) {
        var card;
        if (s.host === LOOPBACK) {
          card = OC.card(t('dashboard.otherDevices'), [
            h('div', { cls: 'alert warn', attrs: { role: 'alert' } }, [
              h('strong', { text: t('dashboard.localOnlyTitle') }),
              h('p', { text: t('dashboard.localOnlyHint') })
            ])
          ], t('dashboard.otherDevicesSub'));
        } else if (!items || !items.length) {
          card = OC.card(t('dashboard.otherDevices'), [h('p', { cls: 'hint', text: t('dashboard.noUrls') })], t('dashboard.otherDevicesSub'));
        } else {
          var qrEl = null;
          try { qrEl = OC.qr(items[0].url); } catch (e) { qrEl = null; }
          var figure = h('figure', { cls: 'qrfig' }, [qrEl, h('figcaption', { cls: 'hint', text: t('dashboard.qrCaption') })]);
          card = OC.card(t('dashboard.otherDevices'), [
            h('div', { cls: 'net' }, [h('div', { cls: 'stack' }, items.map(urlRow)), figure]),
            h('div', { cls: 'row' }, [OC.btn(t('dashboard.openWebUi'), '', function () { OC.safe(OC.invoke('open_web_ui')); }, 'external')])
          ], t('dashboard.otherDevicesSub'));
        }
        OC.clear(refs.netBox).appendChild(card);
      }

      // Loads addresses once per host/port pair (not on every state tick).
      function loadNet(s) {
        var key = s.host + '|' + s.port;
        if (key === netKey) return;
        netKey = key;
        var seq = ++netSeq;
        if (s.host === LOOPBACK) { renderNet(s, null); return; }
        OC.clear(refs.netBox).appendChild(OC.card(t('dashboard.otherDevices'), [h('p', { cls: 'hint', text: t('common.loading') })], t('dashboard.otherDevicesSub')));
        function finish(info) {
          if (seq !== netSeq) return;
          var cur = OC.state || s;
          renderNet(cur, buildNetItems(cur, info));
        }
        OC.invoke('network_info').then(function (info) { finish(info); }, function () { finish(null); });
      }

      function poll() {
        if (pollBusy || !OC.state || !OC.state.running) return;
        pollBusy = true;
        OC.invoke('server_overview').then(function (o) {
          pollBusy = false;
          if (!OC.state || !OC.state.running) return;
          ov = o || null;
          paintStats(OC.state);
        }, function () { pollBusy = false; /* stopped or briefly unavailable: keep last values */ });
      }

      function ensurePoll(on) {
        if (on && !pollTimer) { pollTimer = setInterval(poll, POLL_MS); poll(); }
        else if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }

      function paintAlert(s) {
        OC.clear(alertSlot);
        if (s && s.error) alertSlot.appendChild(h('p', { cls: 'alert', text: s.error, attrs: { role: 'alert' } }));
        if (s && s.running && maint && maint.enabled) {
          alertSlot.appendChild(h('div', { cls: 'alert warn', attrs: { role: 'status', id: 'dash-maint' } }, [
            h('strong', { text: t('maint.banner') }),
            h('p', { text: maint.message || t('maint.bannerDefault') }),
            maint.eta ? h('p', { cls: 'small', text: t('maint.etaShow', { t: OC.fmtDate(maint.eta) }) }) : null
          ]));
        }
      }
      function refreshMaint() {
        OC.invoke('maintenance_get').then(function (r) { maint = r.maintenance; paintAlert(OC.state); }, function () { /* server not reachable: no banner */ });
      }
      var unMaint = OC.on('maintenance', function (m) { if (m) { maint = m; paintAlert(OC.state); } });

      function apply(s) {
        if (s === undefined) s = OC.state;
        var mode = !s ? 'loading' : s.running ? 'running' : 'stopped';
        runChip.className = 'chip ' + (!s ? '' : s.running ? 'ok' : 'err');
        runChip.textContent = !s ? t('common.loading') : s.running ? t('state.running') : t('state.stopped');
        updateButtons();

        paintAlert(s);

        if (mode !== curMode) {
          curMode = mode;
          netSeq++;
          ov = null;
          OC.clear(body).appendChild(mode === 'running' ? buildRunning() : mode === 'stopped' ? buildStopped() : buildLoading());
          if (mode === 'running') refreshMaint();
        }
        if (mode === 'running') {
          paintStats(s);
          loadNet(s);
          ensurePoll(true);
        } else {
          ensurePoll(false);
        }
      }

      apply(OC.state);

      return {
        onState: apply,
        destroy: function () {
          ensurePoll(false);
          netSeq++;
          unBusy();
          unMaint();
        }
      };
    }
  });
})();
