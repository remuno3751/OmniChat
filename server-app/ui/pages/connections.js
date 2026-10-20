// Connections page: connected devices, bridges (incl. DSH bridges), and active chats. Refreshes every 4 seconds while running.
(function () {
  'use strict';
  var OC = window.OC;
  var t = OC.t;
  var h = OC.h;
  var REFRESH_MS = 4000;

  OC.addStrings({
    ja: {
      'connections.sub': '接続中の端末・ブリッジ・チャット',
      'connections.devices': '接続中の端末',
      'connections.devicesSub': 'Web UI やアプリからサーバーに接続している端末です。',
      'connections.sockets': '接続数',
      'connections.noDevices': '接続中の端末はありません。',
      'connections.users': 'サインイン中のユーザー',
      'connections.noUsers': 'サインイン中のユーザーはいません。',
      'connections.bridges': 'ブリッジ',
      'connections.bridgesSub': 'DSH などのローカルセッションを、このサーバーにつなぐブリッジです。',
      'connections.noBridges': 'ブリッジは接続されていません。',
      'connections.noBridgesHint': 'DSH のブリッジを起動し、このサーバーに接続すると、ここに名前・作業フォルダー・所有者が表示されます。',
      'connections.owner': '所有者',
      'connections.cwd': '作業フォルダー',
      'connections.chats': 'アクティブなチャット',
      'connections.chatsSub': '現在アクティブなチャットの数です。',
      'connections.autoRefresh': '4秒ごとに自動更新されます。',
      'connections.stoppedTitle': 'サーバーは停止しています',
      'connections.stoppedSub': '起動すると、接続中の端末やブリッジが表示されます。',
      'connections.loadFailed': 'サーバー情報を取得できませんでした'
    },
    en: {
      'connections.sub': 'Devices, bridges and chats right now',
      'connections.devices': 'Connected devices',
      'connections.devicesSub': 'Clients connected to the server, such as the web UI or the app.',
      'connections.sockets': 'Connections',
      'connections.noDevices': 'No devices are connected.',
      'connections.users': 'Signed-in users',
      'connections.noUsers': 'No users are signed in.',
      'connections.bridges': 'Bridges',
      'connections.bridgesSub': 'Bridges connect local sessions such as DSH to this server.',
      'connections.noBridges': 'No bridges are connected.',
      'connections.noBridgesHint': 'Start a DSH bridge and connect it to this server. Its name, working folder and owner will appear here.',
      'connections.owner': 'Owner',
      'connections.cwd': 'Working folder',
      'connections.chats': 'Active chats',
      'connections.chatsSub': 'Chats that are currently active.',
      'connections.autoRefresh': 'Refreshes automatically every 4 seconds.',
      'connections.stoppedTitle': 'The server is stopped',
      'connections.stoppedSub': 'Start it to see connected devices and bridges.',
      'connections.loadFailed': 'Could not load server details'
    }
  });

  function initial(name) { return String(name || '?').charAt(0).toUpperCase(); }

  OC.registerPage({
    id: 'connections', order: 20, icon: 'connections', titleKey: 'nav.connections',
    render: function (root) {
      root.classList.add('p-connections');
      var alertSlot = h('div', { cls: 'stack' });
      var body = h('div', { cls: 'stack' });
      var refs = {};
      var curMode = '', timer = null, inflight = false;

      root.appendChild(OC.pageHeader(t('nav.connections'), t('connections.sub'), null));
      root.appendChild(alertSlot);
      root.appendChild(body);

      function buildLoading() {
        return OC.card(null, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton sk-short' }), h('div', { cls: 'skeleton sk-mid' })]);
      }

      function buildStopped() {
        return OC.empty('○', t('connections.stoppedTitle'), t('connections.stoppedSub'));
      }

      function buildRunning() {
        refs.sockets = h('span', { cls: 'num', text: '—' });
        refs.users = h('div', { cls: 'list' });
        refs.bridges = h('div', { cls: 'list' });
        refs.chats = h('span', { cls: 'num', text: '—' });

        var devicesCard = OC.card(t('connections.devices'), [
          h('div', { cls: 'stat' }, [h('h3', { text: t('connections.sockets') }), refs.sockets]),
          h('h3', { cls: 'mt', text: t('connections.users') }),
          refs.users
        ], t('connections.devicesSub'));

        var bridgesCard = OC.card(t('connections.bridges'), [refs.bridges], t('connections.bridgesSub'));

        var chatsCard = OC.card(t('connections.chats'), [
          h('div', { cls: 'stat' }, [refs.chats, h('p', { cls: 'hint', text: t('connections.chatsSub') })])
        ]);

        return h('div', { cls: 'stack' }, [
          h('div', { cls: 'grid' }, [devicesCard, bridgesCard, chatsCard]),
          h('p', { cls: 'hint', text: t('connections.autoRefresh') })
        ]);
      }

      function paintUsers(names) {
        OC.clear(refs.users);
        if (!names.length) { refs.users.appendChild(h('p', { cls: 'hint', text: t('connections.noUsers') })); return; }
        names.forEach(function (n) {
          refs.users.appendChild(h('div', { cls: 'list-item' }, [
            h('div', { cls: 'avatar', text: initial(n) }),
            h('div', { cls: 'grow', text: String(n) })
          ]));
        });
      }

      function paintBridges(list) {
        OC.clear(refs.bridges);
        if (!list.length) {
          refs.bridges.appendChild(h('div', { cls: 'empty' }, [
            h('p', { text: t('connections.noBridges') }),
            h('p', { cls: 'small', text: t('connections.noBridgesHint') })
          ]));
          return;
        }
        list.forEach(function (b) {
          refs.bridges.appendChild(h('div', { cls: 'list-item' }, [
            h('div', { cls: 'avatar', text: initial(b.name) }),
            h('div', { cls: 'grow' }, [
              h('strong', { text: String(b.name || '—') }),
              h('div', { cls: 'small' }, [
                h('span', { cls: 'muted', text: t('connections.cwd') + ': ' }),
                h('code', { text: b.cwd || '—' })
              ]),
              h('div', { cls: 'small muted', text: t('connections.owner') + ': ' + (b.owner || '—') })
            ])
          ]));
        });
      }

      function paint(o) {
        var c = o.connections || {};
        refs.sockets.textContent = String(c.sockets || 0);
        paintUsers(Array.isArray(c.users) ? c.users : []);
        paintBridges(Array.isArray(o.bridges) ? o.bridges : []);
        refs.chats.textContent = String(o.activeChats || 0);
      }

      function setError(msg) {
        OC.clear(alertSlot);
        if (msg) alertSlot.appendChild(h('p', { cls: 'alert', attrs: { role: 'alert' }, text: t('connections.loadFailed') + (msg ? ': ' + msg : '') }));
      }

      function load() {
        if (inflight || !OC.state || !OC.state.running) return;
        inflight = true;
        OC.invoke('server_overview').then(function (o) {
          inflight = false;
          if (!OC.state || !OC.state.running) return;
          setError(null);
          paint(o || {});
        }, function (e) {
          inflight = false;
          // Keep the last good values; the state event will switch to the stopped view if the server went down.
          if (OC.state && OC.state.running) setError(e && e.message);
        });
      }

      function ensureTimer(on) {
        if (on && !timer) { timer = setInterval(load, REFRESH_MS); load(); }
        else if (!on && timer) { clearInterval(timer); timer = null; }
      }

      function apply(s) {
        if (s === undefined) s = OC.state;
        var mode = !s ? 'loading' : s.running ? 'running' : 'stopped';
        if (mode !== curMode) {
          curMode = mode;
          OC.clear(alertSlot);
          OC.clear(body).appendChild(mode === 'running' ? buildRunning() : mode === 'stopped' ? buildStopped() : buildLoading());
        }
        if (mode === 'running') ensureTimer(true);
        else ensureTimer(false);
      }

      apply(OC.state);

      return {
        onState: apply,
        destroy: function () { ensureTimer(false); }
      };
    }
  });
})();
