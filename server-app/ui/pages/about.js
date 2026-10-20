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
        destroy: function () {}
      };
    }
  });

  function noticeItem(name, license) {
    return h('div', { cls: 'list-item' }, [
      h('div', { cls: 'grow' }, [h('div', { text: name, cls: 'small' })]),
      h('span', { cls: 'small muted', text: license })
    ]);
  }
})();
