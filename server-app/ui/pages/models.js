// Models page: local LLM servers found by probing (LM Studio, Ollama, llama.cpp, vLLM) and configured providers.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'models.title': 'モデル',
      'models.sub': 'このPCで応答しているローカルのモデルサーバーと、設定済みのプロバイダーを確認します。',
      'models.local': 'ローカルサーバー',
      'models.localSub': '既知のポートを自動検出します（10秒ごとに更新）。',
      'models.reachable': '接続可',
      'models.notDetected': '未検出',
      'models.notFound': '未検出のサーバー',
      'models.defaultPort': '既定ポート {port}',
      'models.notFoundHint': '既定ポートで起動すると自動で検出されます。',
      'models.modelCount': 'モデル {n} 件',
      'models.noLocal': 'ローカルサーバーは見つかりませんでした。',
      'models.add': 'プロバイダーを追加',
      'models.addTitle': 'モデルプロバイダーを追加',
      'models.addHint': 'OpenAI 互換のAPI（LM Studio、Ollama、OpenRouter など）を登録します。登録したプロバイダーは、アカウントで使えます。',
      'models.fName': '表示名', 'models.fUrl': 'ベースURL', 'models.fUrlHint': '例: http://localhost:1234/v1', 'models.fModel': 'モデル名（任意）', 'models.fKey': 'APIキー（任意）', 'models.fOwner': '登録先のアカウント', 'models.fOwnerHint': '空欄なら最初に作ったアカウントです。',
      'models.addBtn': '追加', 'models.added': 'プロバイダーを追加しました', 'models.needFields': '表示名とベースURLを入力してください。',
      'models.addThis': 'プロバイダーに追加', 'models.remove': '削除', 'models.removeTitle': 'プロバイダーを削除', 'models.removeText': '「{name}」を削除します。会話の履歴は消えませんが、このプロバイダーは使えなくなります。', 'models.removed': 'プロバイダーを削除しました',
      'models.providers': 'プロバイダー',
      'models.providersSub': 'このサーバーに設定されているモデルプロバイダーです。',
      'models.noProviders': 'プロバイダーは設定されていません。',
      'models.owner': '所有者: {owner}',
      'models.updated': '最終更新: {time}',
      'models.loadError': 'モデル情報を取得できませんでした。'
    },
    en: {
      'models.title': 'Models',
      'models.sub': 'Local model servers responding on this PC, and the configured providers.',
      'models.local': 'Local servers',
      'models.localSub': 'Detects well-known local servers automatically (refreshes every 10 s).',
      'models.reachable': 'Reachable',
      'models.notDetected': 'Not detected',
      'models.notFound': 'Not found',
      'models.defaultPort': 'Default port {port}',
      'models.notFoundHint': 'Start the server on its default port and it will be detected automatically.',
      'models.modelCount': '{n} models',
      'models.noLocal': 'No local servers found.',
      'models.add': 'Add provider',
      'models.addTitle': 'Add a model provider',
      'models.addHint': 'Register an OpenAI-compatible API (LM Studio, Ollama, OpenRouter, ...). The provider becomes available to the account.',
      'models.fName': 'Display name', 'models.fUrl': 'Base URL', 'models.fUrlHint': 'e.g. http://localhost:1234/v1', 'models.fModel': 'Model name (optional)', 'models.fKey': 'API key (optional)', 'models.fOwner': 'Account', 'models.fOwnerHint': 'Empty = the first account that was created.',
      'models.addBtn': 'Add', 'models.added': 'Provider added', 'models.needFields': 'Enter a display name and a base URL.',
      'models.addThis': 'Add as provider', 'models.remove': 'Remove', 'models.removeTitle': 'Remove provider', 'models.removeText': 'Remove "{name}"? Chat history is kept, but this provider can no longer be used.', 'models.removed': 'Provider removed',
      'models.providers': 'Providers',
      'models.providersSub': 'Model providers configured on this server.',
      'models.noProviders': 'No providers configured.',
      'models.owner': 'Owner: {owner}',
      'models.updated': 'Last updated: {time}',
      'models.loadError': 'Could not load model information.'
    }
  });

  var PROBES = [
    { name: 'LM Studio', port: 1234, terms: ['lm studio', 'lmstudio', 'lm-studio'] },
    { name: 'Ollama', port: 11434, terms: ['ollama'] },
    { name: 'llama.cpp', port: 8080, terms: ['llama.cpp', 'llamacpp', 'llama-cpp', 'llama_cpp'] },
    { name: 'vLLM', port: 8000, terms: ['vllm'] }
  ];

  OC.addStrings({
    ja: {
      'models.sharedBadge': '共有中',
      'models.shareLabel': 'ユーザーと共有する',
      'models.shareHint': '許可したユーザーが、この接続先を使えます。API キーは見えません。',
      'models.shareTitle': 'ユーザーと共有しますか',
      'models.shareText': '許可したユーザーが、あなたの API キーでこの接続先を使えるようになります。',
      'models.shareOk': '共有する',
      'models.sharedOnToast': '共有を有効にしました',
      'models.sharedOffToast': '共有を止めました'
    },
    en: {
      'models.sharedBadge': 'Shared',
      'models.shareLabel': 'Share with users',
      'models.shareHint': 'Permitted users can use this endpoint. They cannot see the API key.',
      'models.shareTitle': 'Share with users?',
      'models.shareText': 'Permitted users will be able to use this endpoint with your API key.',
      'models.shareOk': 'Share',
      'models.sharedOnToast': 'Sharing turned on',
      'models.sharedOffToast': 'Sharing turned off'
    }
  });

  function probeFor(server) {
    var hay = ((server.kind || '') + ' ' + (server.name || '')).toLowerCase();
    for (var i = 0; i < PROBES.length; i++) {
      for (var j = 0; j < PROBES[i].terms.length; j++) {
        if (hay.indexOf(PROBES[i].terms[j]) >= 0) return PROBES[i];
      }
    }
    return null;
  }

  function modelCount(server) {
    var m = server.models;
    if (Array.isArray(m)) return m.length;
    return typeof m === 'number' ? m : 0;
  }

  OC.registerPage({
    id: 'models',
    order: 30,
    icon: 'models',
    titleKey: 'nav.models',
    render: function (root) {
      var alive = true;
      var timer = null;
      var seq = 0;
      var hasData = false;
      var lastRunning = OC.state ? !!OC.state.running : null;

      var refreshBtn = OC.btn(t('common.refresh'), 'sm', function () { load(); }, 'restart');
      root.appendChild(OC.pageHeader(t('models.title'), t('models.sub'), refreshBtn));
      var content = h('div', { cls: 'page' });
      root.appendChild(content);

      function show(nodes) {
        OC.clear(content);
        nodes.forEach(function (n) { content.appendChild(n); });
      }

      function skeleton() {
        return OC.card(t('models.local'), [h('div', { cls: 'stack' }, [
          h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })
        ])]);
      }

      function stopped() {
        hasData = false;
        show([OC.card(t('models.title'), [OC.empty('∅', t('common.serverStopped'), t('common.startFirst'))])]);
      }

      function load() {
        if (!alive) return;
        var s = OC.state;
        if (s && !s.running) { stopped(); return; }
        var my = ++seq;
        if (!hasData) show([skeleton()]);
        OC.invoke('server_overview').then(function (ov) {
          if (!alive || my !== seq) return;
          hasData = true;
          draw(ov || {});
        }, function (e) {
          if (!alive || my !== seq) return;
          if (OC.state && !OC.state.running) { stopped(); return; }
          show([OC.card(t('models.title'), [h('p', { cls: 'alert', text: (e && e.message) || t('models.loadError'), attrs: { role: 'alert' } })])]);
        });
      }

      // "share with users" switch for an admin-owned provider (dsh-bridge is never shown here)
      function sharedSwitch(p) {
        function setShared(on, inp) {
          OC.invoke('shared_provider_set', { id: p.id, shared: on }).then(function () {
            OC.toast(t(on ? 'models.sharedOnToast' : 'models.sharedOffToast'));
            load();
          }, function (e) { inp.checked = !on; OC.toast((e && e.message) || String(e), 'err'); });
        }
        return h('div', { cls: 'shared-switch' }, [OC.switchRow(t('models.shareLabel'), t('models.shareHint'), !!p.shared, function (on, inp) {
          if (!on) { setShared(false, inp); return; }
          OC.confirm(t('models.shareTitle'), t('models.shareText'), t('models.shareOk'), false).then(function (ok) {
            if (ok) setShared(true, inp); else inp.checked = false;
          });
        })]);
      }

      function removeProvider(p) {
        OC.confirm(t('models.removeTitle'), t('models.removeText', { name: p.name }), t('models.remove'), true).then(function (ok) {
          if (!ok) return;
          OC.invoke('provider_delete', { id: p.id }).then(function () { OC.toast(t('models.removed')); load(); }, function (e) { OC.toast((e && e.message) || String(e), 'err'); });
        });
      }

      function openAdd(pre) {
        var name = h('input', { attrs: { type: 'text', autocomplete: 'off', maxlength: '80' }, value: pre.name || '' });
        var url = h('input', { attrs: { type: 'url', autocomplete: 'off', placeholder: 'http://localhost:1234/v1' }, value: pre.baseUrl || '' });
        var model = h('input', { attrs: { type: 'text', autocomplete: 'off' } });
        var key = h('input', { attrs: { type: 'password', autocomplete: 'new-password' } });
        var owner = h('input', { attrs: { type: 'text', autocomplete: 'off' } });
        var err = h('p', { cls: 'alert', attrs: { role: 'alert' } });
        err.hidden = true;
        var busy = false, close = null, box = null;
        function fail(msg) { err.textContent = msg; err.hidden = false; }
        close = OC.modal({
          title: t('models.addTitle'),
          body: [
            h('p', { cls: 'hint', text: t('models.addHint') }),
            OC.field(t('models.fName'), name, null, 'models-add-name'),
            OC.field(t('models.fUrl'), url, t('models.fUrlHint'), 'models-add-url'),
            OC.field(t('models.fModel'), model, null, 'models-add-model'),
            OC.field(t('models.fKey'), key, null, 'models-add-key'),
            OC.field(t('models.fOwner'), owner, t('models.fOwnerHint'), 'models-add-owner'),
            err
          ],
          actions: [
            { text: t('common.cancel') },
            { text: t('models.addBtn'), cls: 'primary', onClick: function () {
              if (busy) return true;
              if (!name.value.trim() || !url.value.trim()) { fail(t('models.needFields')); return true; }
              busy = true;
              OC.invoke('provider_add', { name: name.value.trim(), baseUrl: url.value.trim(), model: model.value.trim(), apiKey: key.value, owner: owner.value.trim() || null }).then(function () {
                busy = false;
                if (box && box.parentNode) close();
                OC.toast(t('models.added'));
                load();
              }, function (e) { busy = false; fail((e && e.message) || String(e)); });
              return true;
            } }
          ]
        });
        box = OC.$('modal').firstChild;
      }

      function draw(ov) {
        var locals = ov.localServers || [];
        var providers = ov.providers || [];
        var found = {};

        var localRows = locals.map(function (sv) {
          var p = probeFor(sv);
          if (p) found[p.name] = true;
          return h('div', { cls: 'list-item' }, [
            h('div', { cls: 'grow' }, [
              h('div', { cls: 'row' }, [
                h('strong', { text: sv.name || (p ? p.name : '?') }),
                OC.chip('ok', t('models.reachable'))
              ]),
              h('code', { text: sv.baseUrl || '' })
            ]),
            OC.chip('', t('models.modelCount', { n: modelCount(sv) }), true),
            OC.btn(t('models.addThis'), '', function () { openAdd({ name: sv.name || '', baseUrl: sv.baseUrl || '' }); })
          ]);
        });

        var missing = PROBES.filter(function (p) { return !found[p.name]; }).map(function (p) {
          return h('div', { cls: 'list-item' }, [
            h('div', { cls: 'grow' }, [
              h('strong', { text: p.name }),
              h('p', { cls: 'hint', text: t('models.defaultPort', { port: p.port }) })
            ]),
            OC.chip('', t('models.notDetected'))
          ]);
        });

        var localKids = [];
        if (localRows.length) localKids.push(h('div', { cls: 'list' }, localRows));
        else localKids.push(h('p', { cls: 'hint', text: t('models.noLocal') }));
        if (missing.length) {
          localKids.push(h('h3', { text: t('models.notFound') }));
          localKids.push(h('div', { cls: 'list' }, missing));
          localKids.push(h('p', { cls: 'hint', text: t('models.notFoundHint') }));
        }

        var provRows = providers.map(function (p) {
          return h('div', { cls: 'list-item' }, [
            h('div', { cls: 'grow' }, [
              h('div', { cls: 'row' }, [
                h('strong', { text: p.name || '?' }),
                p.kind ? OC.chip('', p.kind, true) : null,
                p.shared ? OC.chip('ok', t('models.sharedBadge')) : null
              ]),
              h('code', { text: p.baseUrl || '' }),
              p.owner ? h('p', { cls: 'hint', text: t('models.owner', { owner: p.owner }) }) : null,
              (p.adminOwned && p.kind !== 'dsh-bridge' && p.id) ? sharedSwitch(p) : null
            ]),
            p.id ? OC.btn(t('models.remove'), 'danger', function () { removeProvider(p); }) : null
          ]);
        });
        var provKids = provRows.length
          ? [h('div', { cls: 'list' }, provRows)]
          : [h('p', { cls: 'hint', text: t('models.noProviders') })];

        show([
          OC.card(t('models.local'), localKids, t('models.localSub')),
          OC.card(t('models.providers'), provKids.concat([h('div', { cls: 'actions' }, [OC.btn(t('models.add'), 'primary', function () { openAdd({}); })])]), t('models.providersSub')),
          h('p', { cls: 'hint small', text: t('models.updated', { time: OC.fmtDate(Date.now()) }) })
        ]);
      }

      load();
      timer = setInterval(load, 10000);

      return {
        onState: function (s) {
          var running = !!(s && s.running);
          if (running !== lastRunning) { lastRunning = running; load(); }
        },
        destroy: function () {
          alive = false;
          if (timer) clearInterval(timer);
          timer = null;
        }
      };
    }
  });
})();
