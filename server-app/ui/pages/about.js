// About page: product, version, license, data locations, third-party notices and language.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;
  var SOURCE_URL = 'https://github.com/remuno3751/omnichat';

  OC.addStrings({
    ja: {
      'about.sub': 'バージョン、ライセンス、データの場所、著作権表示などです。',
      'about.app': 'アプリ名',
      'about.version': 'バージョン',
      'about.products': 'OmniChat Server（このアプリ）と OmniChat Client は別の製品です。それぞれ独立したバージョンでリリースされます。',
      'about.license': 'ライセンス',
      'about.licenseText': 'AGPL-3.0-only のもとで、自由に使用・改変・再配布できます。改変版をネットワーク越しに他の人へ提供する場合は、その改変版のソースコードを同じ利用者に提供する必要があります。',
      'about.source': 'ソースコードを開く',
      'about.data': 'データと設定',
      'about.dataDir': 'データフォルダ',
      'about.configPath': '設定ファイル',
      'about.openFolder': 'フォルダを開く',
      'about.notices': 'サードパーティ通知',
      'about.noticeQr': 'QR コード生成ライブラリ（Kazuhiko Arase）',
      'about.noticeTauri': 'Tauri',
      'about.noticeNode': 'Node.js',
      'about.theme': 'テーマ',
      'about.themeHint': '画面の見た目を切り替えます。ライト / ダークは、Windows の設定に合わせます。',
      'about.theme.frontier': 'フロンティア(既定)', 'about.theme.astral': 'アストラル', 'about.theme.simple': 'シンプル',
      'about.language': '言語',
      'update.title': 'サーバーのアップデート',
      'update.manualOnly': '自動では確認も更新もしません。ここで「更新を確認」を押したときだけ調べ、「更新する」を押したときだけ更新します。',
      'update.check': '更新を確認', 'update.apply': '更新する', 'update.openPage': 'リリースページを開く',
      'update.loading': '状態を読み込み中…', 'update.never': 'まだ確認していません',
      'update.current': '現在のバージョン: {current}(最新です)', 'update.available': '新しいバージョンがあります: {current} → {latest}',
      'update.lastChecked': '最後に確認した日時: {at}。', 'update.upToDate': '最新のバージョンです。',
      'update.cannotSelf': 'この環境では、アプリからは更新できません。リリースページから新しいインストーラーを入れてください。',
      'update.noBundle': 'このバージョンには更新用のファイルまたはチェックサムがないため、アプリからは更新できません。リリースページを開いてください。',
      'update.error': 'エラー: {message}',
      'update.confirmTitle': 'サーバーを更新しますか?',
      'update.confirmText': 'バージョン {latest} をダウンロードして検証し、データのバックアップを作ってから、サーバーを再起動します(約1分)。その間、接続中のクライアントはつながりません。',
      'update.restartNote': 'サーバーが自動で再起動します。この画面は閉じても構いません。',
      'update.done': '更新しました。現在のバージョン: {current}',
      'update.phase.checking': '確認中', 'update.phase.downloading': 'ダウンロード中', 'update.phase.verifying': '検証中', 'update.phase.staging': '展開中', 'update.phase.backing-up': 'バックアップ中', 'update.phase.restarting': 'サーバーを再起動中',
      'about.langHint': '表示言語を切り替えます。'
    },
    en: {
      'about.sub': 'Version, license, data locations and third-party notices.',
      'about.app': 'Application',
      'about.version': 'Version',
      'about.products': 'OmniChat Server (this app) and OmniChat Client are separate products, each with its own version and release cycle.',
      'about.license': 'License',
      'about.licenseText': 'Licensed under AGPL-3.0-only. You may use, modify and redistribute this software. If you modify it and let other people interact with it over a network, you must offer them the source code of your modified version.',
      'about.source': 'Open source code',
      'about.data': 'Data & configuration',
      'about.dataDir': 'Data folder',
      'about.configPath': 'Config file',
      'about.openFolder': 'Open folder',
      'about.notices': 'Third-party notices',
      'about.noticeQr': 'QR code generator (Kazuhiko Arase)',
      'about.noticeTauri': 'Tauri',
      'about.noticeNode': 'Node.js',
      'about.theme': 'Theme',
      'about.themeHint': 'Changes the look. Light / dark follows the Windows setting.',
      'about.theme.frontier': 'Frontier (default)', 'about.theme.astral': 'Astral', 'about.theme.simple': 'Simple',
      'about.language': 'Language',
      'update.title': 'Server update',
      'update.manualOnly': 'Nothing is checked or installed automatically. It looks for a new version only when you press "Check for updates", and installs only when you press "Update".',
      'update.check': 'Check for updates', 'update.apply': 'Update', 'update.openPage': 'Open release page',
      'update.loading': 'Loading…', 'update.never': 'not checked yet',
      'update.current': 'Current version: {current} (up to date)', 'update.available': 'A new version is available: {current} -> {latest}',
      'update.lastChecked': 'Last checked: {at}.', 'update.upToDate': 'You are on the latest version.',
      'update.cannotSelf': 'This install cannot update itself. Install the new installer from the release page.',
      'update.noBundle': 'This release has no update file or checksum, so it cannot be installed from here. Open the release page.',
      'update.error': 'Error: {message}',
      'update.confirmTitle': 'Update the server?',
      'update.confirmText': 'Version {latest} is downloaded and verified, your data is backed up, and the server restarts (about a minute). Connected clients are disconnected meanwhile.',
      'update.restartNote': 'The server restarts by itself. You can close this page.',
      'update.done': 'Updated. Current version: {current}',
      'update.phase.checking': 'Checking', 'update.phase.downloading': 'Downloading', 'update.phase.verifying': 'Verifying', 'update.phase.staging': 'Unpacking', 'update.phase.backing-up': 'Backing up', 'update.phase.restarting': 'Restarting the server',
      'about.langHint': 'Changes the interface language.'
    }
  });

  function openFolder(which) {
    OC.safe(OC.invoke('open_folder', { which: which }));
  }

  OC.registerPage({
    id: 'about', order: 90, icon: 'about', titleKey: 'nav.about',
    render: function (root) {
      root.classList.add('p-about');
      root.appendChild(OC.pageHeader(t('nav.about'), t('about.sub')));

      // ---- App
      var verEl = h('dd', { text: '…' });
      var appCard = OC.card(t('about.app'), [
        h('dl', { cls: 'kv' }, [
          h('dt', { text: t('about.app') }), h('dd', { text: 'OmniChat Server' }),
          h('dt', { text: t('about.version') }), verEl
        ]),
        h('p', { cls: 'small muted', text: t('about.products') })
      ]);

      // ---- License
      var licCard = OC.card(t('about.license'), [
        h('p', { cls: 'small', text: 'AGPL-3.0-only' }),
        h('p', { cls: 'hint', text: t('about.licenseText') }),
        h('div', { cls: 'row' }, [
          OC.btn(t('about.source'), 'sm', function () { OC.safe(OC.invoke('open_url', { url: SOURCE_URL })); }, 'external'),
          h('code', { text: SOURCE_URL })
        ])
      ]);

      // ---- Data & config
      var dataCard = OC.card(t('about.data'), [
        h('dl', { cls: 'kv' }, [
          h('dt', { text: t('about.dataDir') }),
          h('dd', {}, [h('div', { cls: 'row' }, [
            h('code', { text: '…', attrs: { id: 'about-data-path' } }),
            OC.btn(t('about.openFolder'), 'sm', function () { openFolder('data'); }, 'external')
          ])]),
          h('dt', { text: t('about.configPath') }),
          h('dd', {}, [h('div', { cls: 'row' }, [
            h('code', { text: '…', attrs: { id: 'about-config-path' } }),
            OC.btn(t('about.openFolder'), 'sm', function () { openFolder('config'); }, 'external')
          ])])
        ])
      ]);

      // ---- Third-party notices
      var noticesCard = OC.card(t('about.notices'), [
        h('div', { cls: 'list' }, [
          noticeItem(t('about.noticeQr'), 'MIT License'),
          noticeItem(t('about.noticeTauri'), 'MIT or Apache-2.0'),
          noticeItem(t('about.noticeNode'), 'MIT License')
        ])
      ]);

      // ---- Language
      var langSel = h('select', {
        attrs: { id: 'about-lang', 'aria-describedby': 'about-lang-hint' },
        on: { change: function () { OC.setLang(langSel.value); } }
      }, [
        h('option', { text: '日本語', value: 'ja' }),
        h('option', { text: 'English', value: 'en' })
      ]);
      langSel.value = OC.lang();
      var langCard = OC.card(t('about.language'), [
        OC.field(t('about.language'), langSel, t('about.langHint'), 'about-lang')
      ]);
      langCard.querySelector('.hint').id = 'about-lang-hint';

      root.appendChild(h('div', { cls: 'grid' }, [appCard, licCard]));
      var upd = buildUpdateCard();
      root.appendChild(h('div', { cls: 'grid' }, [upd.card]));
      // ---- Theme
      var swatches = { frontier: ['#fffa00', '#101113'], astral: ['#f9c837', '#202635'], simple: ['#5b4bf0', '#f4f5f8'] };
      var themeBox = h('div', { cls: 'theme-opts', attrs: { role: 'radiogroup', 'aria-label': t('about.theme') } });
      function drawThemes() {
        OC.clear(themeBox);
        OC.themes.forEach(function (id) {
          var input = h('input', { attrs: { type: 'radio', name: 'about-theme', value: id } });
          input.checked = OC.theme() === id;
          input.addEventListener('change', function () { OC.setTheme(id); drawThemes(); });
          var sw = h('span', { cls: 'theme-sw' });
          sw.style.background = 'linear-gradient(135deg,' + swatches[id][1] + ' 50%,' + swatches[id][0] + ' 50%)';
          themeBox.appendChild(h('label', { cls: 'theme-opt' + (input.checked ? ' on' : '') }, [input, sw, h('span', { text: t('about.theme.' + id) })]));
        });
      }
      drawThemes();
      var themeCard = OC.card(t('about.theme'), [h('p', { cls: 'card-sub', text: t('about.themeHint') }), themeBox]);

      root.appendChild(h('div', { cls: 'grid' }, [dataCard, langCard]));
      root.appendChild(h('div', { cls: 'grid' }, [themeCard]));
      root.appendChild(h('div', { cls: 'grid' }, [noticesCard]));

      var dataPathNode = dataCard.querySelector('#about-data-path');
      var cfgPathNode = dataCard.querySelector('#about-config-path');

      function apply(s) {
        verEl.textContent = (s && s.version) || '—';
        dataPathNode.textContent = (s && s.dataDir) || '—';
        cfgPathNode.textContent = (s && s.configPath) || '—';
      }
      apply(OC.state);

      return {
        onState: apply,
        destroy: function () { upd.destroy(); }
      };
    }
  });

  // ---- Manual update of the server (nothing checks or installs by itself)
  function buildUpdateCard() {
    var alive = true;
    var timer = null;
    var statusEl = h('p', { cls: 'small', text: '' });
    var detailEl = h('p', { cls: 'hint', text: '' });
    var errEl = h('p', { cls: 'hint', attrs: { hidden: '' } });
    var status = null;
    var working = false;
    var checkBtn = OC.btn(t('update.check'), 'sm', function () { doCheck(); });
    var applyBtn = OC.btn(t('update.apply'), 'sm primary', function () { doApply(); });
    var pageBtn = OC.btn(t('update.openPage'), 'sm', function () {
      if (status && status.latest && /^https:\/\//.test(status.latest.htmlUrl || '')) OC.safe(OC.invoke('open_url', { url: status.latest.htmlUrl }));
    }, 'external');
    pageBtn.hidden = true;
    var card = OC.card(t('update.title'), [
      h('p', { cls: 'card-sub', text: t('update.manualOnly') }),
      statusEl, detailEl, errEl,
      h('div', { cls: 'row' }, [checkBtn, applyBtn, pageBtn])
    ]);

    function when(ms) { return ms ? new Date(ms).toLocaleString() : t('update.never'); }
    function paint() {
      var s = status;
      var busyPhase = s && s.phase && s.phase !== 'idle' && s.phase !== 'error';
      checkBtn.disabled = working || busyPhase;
      var canApply = !!(s && s.updateAvailable && s.selfUpdate && s.bundleAssetFound && !busyPhase && !working);
      applyBtn.hidden = !(s && s.updateAvailable);
      applyBtn.disabled = !canApply;
      pageBtn.hidden = !(s && s.latest);
      errEl.hidden = true;
      if (!s) { statusEl.textContent = t('update.loading'); detailEl.textContent = ''; return; }
      if (busyPhase) {
        var pct = typeof s.progress === 'number' ? ' ' + Math.round(s.progress * 100) + '%' : '';
        statusEl.textContent = t('update.phase.' + s.phase) + pct;
        detailEl.textContent = t('update.restartNote');
        return;
      }
      if (s.updateAvailable && s.latest) statusEl.textContent = t('update.available', { current: s.current, latest: s.latest.version });
      else statusEl.textContent = t('update.current', { current: s.current });
      var parts = [t('update.lastChecked', { at: when(s.lastCheckedAt) })];
      if (s.updateAvailable && !s.selfUpdate) parts.push(s.selfUpdateReason || t('update.cannotSelf'));
      else if (s.updateAvailable && !s.bundleAssetFound) parts.push(t('update.noBundle'));
      detailEl.textContent = parts.join(' ');
      var msg = s.lastError ? s.lastError.message : (s.lastApply && s.lastApply.status === 'failed' ? s.lastApply.message : '');
      if (msg) { errEl.textContent = t('update.error', { message: msg }); errEl.hidden = false; }
    }
    function load() {
      return OC.invoke('update_status').then(function (s) { status = s; if (alive) paint(); return s; }, function () { if (alive) paint(); });
    }
    var applyStart = null;
    function poll() {
      clearTimeout(timer);
      if (!alive) return;
      timer = setTimeout(function () {
        load().then(function (s) {
          if (!alive) return;
          // the server restarts at the end of an update (no answer for a while): keep asking until the version changed,
          // an error was reported, or five minutes passed
          var done = applyStart && ((s && (s.current !== applyStart.version || s.phase === 'error')) || Date.now() - applyStart.at > 300000);
          if (!applyStart || done) {
            var changed = applyStart && s && s.current !== applyStart.version;
            working = false; applyStart = null; paint();
            if (changed) OC.toast(t('update.done', { current: s.current }));
          } else poll();
        });
      }, 2000);
    }
    function doCheck() {
      working = true; paint();
      OC.invoke('update_check').then(function (s) { status = s; working = false; paint(); if (!s.updateAvailable) OC.toast(t('update.upToDate')); },
        function (e) { working = false; OC.toast(e.message, 'err'); paint(); });
    }
    function doApply() {
      if (!status || !status.latest) return;
      OC.confirm(t('update.confirmTitle'), t('update.confirmText', { latest: status.latest.version }), t('update.apply'), false).then(function (ok) {
        if (!ok) return;
        working = true; applyStart = { version: status.current, at: Date.now() }; paint();
        OC.invoke('update_apply').then(function () { poll(); },
          function (e) { working = false; applyStart = null; OC.toast(e.message, 'err'); paint(); });
      });
    }
    paint();
    load();
    return { card: card, destroy: function () { alive = false; clearTimeout(timer); } };
  }

  function noticeItem(name, license) {
    return h('div', { cls: 'list-item' }, [
      h('div', { cls: 'grow' }, [h('div', { text: name, cls: 'small' })]),
      h('span', { cls: 'small muted', text: license })
    ]);
  }
})();
