// Quotas page: token limits for shared providers (docs/PROTOCOL-v7-quotas.md). Defaults, per-user overrides and today / month usage.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'nav.quotas': '使用量', 'quota.title': '使用量の上限', 'quota.sub': '共有プロバイダーのモデルの利用に、トークンの上限を設けます。自分のキーと管理者は対象外です。',
      'quota.defaults': '既定の上限', 'quota.defaultsSub': '0 は無制限。日と月はサーバーのローカル時間で区切ります。',
      'quota.enabled': '上限を有効にする', 'quota.daily': '1 日あたり (トークン)', 'quota.monthly': '1 か月あたり (トークン)',
      'quota.users': 'ユーザーごとの上限と使用量', 'quota.usersSub': '空欄は既定に従います。0 はそのユーザーを無制限にします。',
      'quota.empty': 'ユーザーがいません。', 'quota.today': '今日', 'quota.month': '今月', 'quota.default': '既定',
      'quota.unlimited': '無制限', 'quota.override': '上書き', 'quota.edit': '編集', 'quota.resetOverride': '上書きを消す',
      'quota.editTitle': '{name} の上限', 'quota.editHint': '空欄 = 既定に従う、0 = 無制限、数字 = その上限。',
      'quota.saveErr': '0 以上の整数で入力してください。', 'quota.loadError': '読み込めませんでした。'
    },
    en: {
      'nav.quotas': 'Usage', 'quota.title': 'Usage quotas', 'quota.sub': 'Token limits for using models from shared providers. Your own keys and admins are not limited.',
      'quota.defaults': 'Default limits', 'quota.defaultsSub': '0 means unlimited. Days and months follow the server local time.',
      'quota.enabled': 'Turn limits on', 'quota.daily': 'Per day (tokens)', 'quota.monthly': 'Per month (tokens)',
      'quota.users': 'Per-user limits and usage', 'quota.usersSub': 'Leave empty to follow the default. 0 makes that user unlimited.',
      'quota.empty': 'No users.', 'quota.today': 'Today', 'quota.month': 'This month', 'quota.default': 'default',
      'quota.unlimited': 'unlimited', 'quota.override': 'override', 'quota.edit': 'Edit', 'quota.resetOverride': 'Remove override',
      'quota.editTitle': 'Limits for {name}', 'quota.editHint': 'Empty = follow the default, 0 = unlimited, a number = that limit.',
      'quota.saveErr': 'Enter a whole number of 0 or more.', 'quota.loadError': 'Could not load.'
    }
  });

  function parseTokens(raw) {
    var s = String(raw).trim();
    if (s === '') return { ok: true, v: null };
    var n = Number(s);
    return Number.isInteger(n) && n >= 0 ? { ok: true, v: n } : { ok: false };
  }
  // null = follows the default (shown as "default"); 0 = unlimited
  function limitText(v) {
    if (v == null) return t('quota.default');
    return v === 0 ? t('quota.unlimited') : Number(v).toLocaleString();
  }

  OC.registerPage({
    id: 'quotas',
    order: 42,
    icon: 'quota',
    titleKey: 'nav.quotas',
    render: function (root) {
      var alive = true;
      var seq = 0;
      var defaults = null;
      root.appendChild(OC.pageHeader(t('quota.title'), t('quota.sub'), OC.btn(t('common.refresh'), 'sm', load, 'restart')));
      var content = h('div', { cls: 'stack' });
      root.appendChild(content);

      function show(nodes) { OC.clear(content); nodes.forEach(function (n) { content.appendChild(n); }); }

      function load() {
        if (!alive) return;
        if (OC.state && !OC.state.running) { show([OC.card(t('quota.title'), [OC.empty('∅', t('common.serverStopped'), t('common.startFirst'))])]); return; }
        var my = ++seq;
        Promise.all([OC.invoke('quotas_get'), OC.invoke('quota_users_get')]).then(function (res) {
          if (!alive || my !== seq) return;
          defaults = res[0] && res[0].quotas ? res[0].quotas : res[0] || {};
          draw(defaults, (res[1] && res[1].users) || []);
        }, function (e) {
          if (!alive || my !== seq) return;
          show([OC.card(t('quota.title'), [h('p', { cls: 'alert', text: e.message || t('quota.loadError'), attrs: { role: 'alert' } })])]);
        });
      }

      function draw(d, users) {
        var enabled = !!d.enabled;
        var daily = h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off' }, value: d.dailyTokens != null ? d.dailyTokens : 0 });
        var monthly = h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off' }, value: d.monthlyTokens != null ? d.monthlyTokens : 0 });
        var sw = OC.switchRow(t('quota.enabled'), null, enabled, function () { /* applied on save */ });
        var swInput = sw.querySelector('input');
        var save = OC.btn(t('common.save'), 'primary', function () {
          var a = parseTokens(daily.value), b = parseTokens(monthly.value);
          if (!a.ok || !b.ok || a.v == null || b.v == null) { OC.toast(t('quota.saveErr'), 'err'); return; }
          save.disabled = true;
          OC.invoke('quotas_set', { enabled: swInput.checked, dailyTokens: a.v, monthlyTokens: b.v }).then(function () {
            save.disabled = false; OC.toast(t('common.saved')); load();
          }, function (e) { save.disabled = false; OC.toast(e.message, 'err'); });
        });
        var defCard = OC.card(t('quota.defaults'), [sw, OC.field(t('quota.daily'), daily, null, 'q-daily'), OC.field(t('quota.monthly'), monthly, null, 'q-monthly'), h('div', { cls: 'row' }, [save])], t('quota.defaultsSub'));
        show([defCard, usersCard(users, d)]);
      }

      function usersCard(users, d) {
        if (!users.length) return OC.card(t('quota.users'), [h('p', { cls: 'hint', text: t('quota.empty') })], t('quota.usersSub'));
        var rows = users.map(function (u) {
          var id = u.userId || u.id;
          var name = u.username || u.name || id;
          var hasOverride = u.dailyTokens != null || u.monthlyTokens != null;
          var today = Number(u.usedToday || 0), month = Number(u.usedMonth || 0);
          return h('div', { cls: 'list-item' }, [
            h('div', { cls: 'grow' }, [
              h('div', { cls: 'row' }, [h('strong', { text: name }), hasOverride ? OC.chip('warn', t('quota.override'), false) : null]),
              h('div', { cls: 'small muted', text: t('quota.today') + ': ' + today.toLocaleString() + ' / ' + limitText(u.dailyTokens) + ' (' + t('quota.default') + ': ' + limitText(d.dailyTokens) + ')' }),
              h('div', { cls: 'small muted', text: t('quota.month') + ': ' + month.toLocaleString() + ' / ' + limitText(u.monthlyTokens) + ' (' + t('quota.default') + ': ' + limitText(d.monthlyTokens) + ')' })
            ]),
            OC.btn(t('quota.edit'), 'sm', function () { openEdit(u, id, name, hasOverride); })
          ]);
        });
        return OC.card(t('quota.users'), [h('div', {}, rows)], t('quota.usersSub'));
      }

      function openEdit(u, id, name, hasOverride) {
        var daily = h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: t('quota.default') }, value: u.dailyTokens != null ? u.dailyTokens : '' });
        var monthly = h('input', { attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: t('quota.default') }, value: u.monthlyTokens != null ? u.monthlyTokens : '' });
        var close = OC.modal({
          title: t('quota.editTitle', { name: name }),
          body: [h('p', { cls: 'hint', text: t('quota.editHint') }), OC.field(t('quota.daily'), daily), OC.field(t('quota.monthly'), monthly)],
          actions: [
            { text: t('common.cancel') },
            { text: t('quota.resetOverride'), cls: 'danger', onClick: function () {
              if (!hasOverride) return undefined;
              OC.invoke('quota_user_delete', { userId: id }).then(function () { OC.toast(t('common.saved')); load(); }, function (e) { OC.toast(e.message, 'err'); });
              return undefined;
            } },
            { text: t('common.save'), cls: 'primary', onClick: function () {
              var a = parseTokens(daily.value), b = parseTokens(monthly.value);
              if (!a.ok || !b.ok) { OC.toast(t('quota.saveErr'), 'err'); return true; }
              OC.invoke('quota_user_set', { userId: id, dailyTokens: a.v, monthlyTokens: b.v }).then(function () { OC.toast(t('common.saved')); load(); }, function (e) { OC.toast(e.message, 'err'); });
              return undefined;
            } }
          ]
        });
        return close;
      }

      load();
      return { onState: function (s) { if (s && !s.running) load(); }, destroy: function () { alive = false; } };
    }
  });
})();
