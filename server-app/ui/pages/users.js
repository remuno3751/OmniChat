// Users page: account list (role, disable/enable, password reset, add user) and the self-registration switch.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'users.title': 'ユーザー',
      'users.sub': 'このサーバーのアカウントを管理します。',
      'users.add': 'ユーザーを追加',
      'users.list': 'アカウント',
      'users.empty': 'ユーザーがいません。',
      'users.roleAdmin': '管理者',
      'users.roleUser': '一般ユーザー',
      'users.role': '権限',
      'users.roleOf': '{name} の権限',
      'users.disabledChip': '無効',
      'users.createdAt': '作成: {date}',
      'users.disable': '無効にする',
      'users.enable': '有効にする',
      'users.disableTitle': 'ユーザーを無効にしますか？',
      'users.disableText': '{name} はサインインできなくなります。有効に戻すまで続きます。',
      'users.disabledOk': 'ユーザーを無効にしました',
      'users.enabledOk': 'ユーザーを有効にしました',
      'users.updated': 'ユーザーを更新しました',
      'users.resetPassword': 'パスワードをリセット',
      'users.resetTitle': 'パスワードをリセット: {name}',
      'users.resetNote': '{name} はすべての端末からログアウトされます。',
      'users.resetAction': 'リセット',
      'users.passwordReset': 'パスワードをリセットしました',
      'users.password': 'パスワード',
      'users.passwordHint': '8文字以上',
      'users.confirm': 'パスワード（確認）',
      'users.tooShort': 'パスワードは8文字以上にしてください。',
      'users.mismatch': 'パスワードが一致しません。',
      'users.addTitle': 'ユーザーを追加',
      'users.username': 'ユーザー名',
      'users.usernameHint': '3〜32文字',
      'users.badUsername': 'ユーザー名は3〜32文字にしてください。',
      'users.create': '追加',
      'users.created': 'ユーザーを追加しました',
      'users.registration': '新規登録',
      'users.registrationSub': 'オンにすると、サインイン画面から誰でもアカウントを作成できます。',
      'users.allowReg': '新規登録を許可',
      'users.restartRequired': '変更を反映するにはサーバーの再起動が必要です。',
      'users.restartNow': '再起動',
      'users.later': 'あとで',
      'users.loadError': 'ユーザー情報を取得できませんでした。',
      'users.needRunning': 'ユーザー管理にはサーバーの起動が必要です。'
    },
    en: {
      'users.title': 'Users',
      'users.sub': 'Manage the accounts on this server.',
      'users.add': 'Add user',
      'users.list': 'Accounts',
      'users.empty': 'No users yet.',
      'users.roleAdmin': 'Admin',
      'users.roleUser': 'User',
      'users.role': 'Role',
      'users.roleOf': 'Role of {name}',
      'users.disabledChip': 'Disabled',
      'users.createdAt': 'Created {date}',
      'users.disable': 'Disable',
      'users.enable': 'Enable',
      'users.disableTitle': 'Disable this user?',
      'users.disableText': '{name} will not be able to sign in until re-enabled.',
      'users.disabledOk': 'User disabled',
      'users.enabledOk': 'User enabled',
      'users.updated': 'User updated',
      'users.resetPassword': 'Reset password',
      'users.resetTitle': 'Reset password: {name}',
      'users.resetNote': '{name} will be logged out on all devices.',
      'users.resetAction': 'Reset',
      'users.passwordReset': 'Password has been reset',
      'users.password': 'Password',
      'users.passwordHint': 'At least 8 characters',
      'users.confirm': 'Confirm password',
      'users.tooShort': 'Password must be at least 8 characters.',
      'users.mismatch': 'Passwords do not match.',
      'users.addTitle': 'Add user',
      'users.username': 'Username',
      'users.usernameHint': '3 to 32 characters',
      'users.badUsername': 'Username must be 3 to 32 characters.',
      'users.create': 'Add',
      'users.created': 'User added',
      'users.registration': 'Registration',
      'users.registrationSub': 'When on, anyone can create an account from the sign-in screen.',
      'users.allowReg': 'Allow new registrations',
      'users.restartRequired': 'A server restart is required to apply this change.',
      'users.restartNow': 'Restart',
      'users.later': 'Later',
      'users.loadError': 'Could not load users.',
      'users.needRunning': 'User management needs the server to be running.'
    }
  });

  function roleOptions() {
    return [
      h('option', { value: 'user', text: t('users.roleUser') }),
      h('option', { value: 'admin', text: t('users.roleAdmin') })
    ];
  }

  // Shows an inline error inside a modal body.
  OC.addStrings({
    ja: {
      'users.grants': '使えるモデル',
      'users.grantsTitle': '{name} が使えるモデル',
      'users.grantsLoading': '読み込んでいます…',
      'users.grantsNone': '共有プロバイダーがありません。「モデル」画面で接続先を「ユーザーと共有する」にすると、ここに出ます。',
      'users.grantsOf': '{name} への許可',
      'users.grantDefault': '既定に従う({d})',
      'users.grantAll': '全モデル',
      'users.grantList': '選んだモデルのみ',
      'users.grantNone': '使えない',
      'users.grantPickOne': '「{name}」は、モデルを 1 つ以上選んでください',
      'users.grantsSave': '保存',
      'users.grantsSaved': '許可を保存しました',
      'users.grantsAdminNote': '管理者は制限されません',
      'users.grantsLoadModels': 'モデルを読み込んでいます…',
      'users.grantsNoModels': 'モデルが見つかりません',
      'users.grantCtx': 'コンテキスト {n}', 'users.grantSelAll': 'すべて選ぶ', 'users.grantSelNone': 'すべて外す',
      'users.grantFilter': 'モデルを検索', 'users.grantCount': '{n} / {total} 個を選択中', 'users.grantNoMatch': '一致するモデルがありません'
    },
    en: {
      'users.grants': 'Models',
      'users.grantsTitle': 'Models {name} can use',
      'users.grantsLoading': 'Loading…',
      'users.grantsNone': 'No shared providers yet. Turn on "Share with users" for a provider on the Models page and it appears here.',
      'users.grantsOf': 'Access to {name}',
      'users.grantDefault': 'Follow default ({d})',
      'users.grantAll': 'All models',
      'users.grantList': 'Selected models only',
      'users.grantNone': 'Not allowed',
      'users.grantPickOne': 'Select at least one model for "{name}"',
      'users.grantsSave': 'Save',
      'users.grantsSaved': 'Access saved',
      'users.grantsAdminNote': 'Admins are not restricted',
      'users.grantsLoadModels': 'Loading models…',
      'users.grantsNoModels': 'No models found',
      'users.grantCtx': 'context {n}', 'users.grantSelAll': 'Select all', 'users.grantSelNone': 'Clear',
      'users.grantFilter': 'Search models', 'users.grantCount': '{n} of {total} selected', 'users.grantNoMatch': 'No matching models'
    }
  });

  function setModalError(box, msg) {
    OC.clear(box);
    box.appendChild(h('p', { cls: 'alert', text: msg, attrs: { role: 'alert' } }));
  }

  OC.registerPage({
    id: 'users',
    order: 40,
    icon: 'users',
    titleKey: 'nav.users',
    render: function (root) {
      var alive = true;
      var seq = 0;
      var hasData = false;
      var lastRunning = OC.state ? !!OC.state.running : null;

      var refreshBtn = OC.btn(t('common.refresh'), 'sm', function () { load(); }, 'restart');
      var addBtn = OC.btn(t('users.add'), 'primary sm', function () { openAdd(); }, 'users');
      var actions = h('div', { cls: 'row' }, [refreshBtn, addBtn]);
      root.appendChild(OC.pageHeader(t('users.title'), t('users.sub'), actions));
      var content = h('div', { cls: 'page' });
      root.appendChild(content);

      function show(nodes) {
        OC.clear(content);
        nodes.forEach(function (n) { content.appendChild(n); });
      }

      function stopped() {
        hasData = false;
        actions.hidden = true;
        show([OC.card(t('users.title'), [OC.empty('∅', t('common.serverStopped'), t('users.needRunning'))])]);
      }

      function load() {
        if (!alive) return;
        var s = OC.state;
        if (s && !s.running) { stopped(); return; }
        var my = ++seq;
        actions.hidden = false;
        if (!hasData) show([OC.card(t('users.list'), [h('div', { cls: 'stack' }, [
          h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })
        ])])]);
        Promise.all([
          OC.invoke('list_users'),
          OC.invoke('get_config').then(null, function () { return null; })
        ]).then(function (res) {
          if (!alive || my !== seq) return;
          hasData = true;
          // the command answers { users: [...] }; a bare array is accepted too
          draw(Array.isArray(res[0]) ? res[0] : (res[0] && res[0].users) || [], res[1]);
        }, function (e) {
          if (!alive || my !== seq) return;
          if (OC.state && !OC.state.running) { stopped(); return; }
          show([OC.card(t('users.list'), [h('p', { cls: 'alert', text: (e && e.message) || t('users.loadError'), attrs: { role: 'alert' } })])]);
        });
      }

      function draw(list, cfg) {
        show([regCard(cfg), usersCard(list)]);
      }

      // Restart prompt shown when set_config reports restartRequired.
      function restartToast() {
        var el = h('div', { cls: 'toast', attrs: { role: 'status' } }, [
          h('span', { text: t('users.restartRequired') }),
          h('div', { cls: 'row' }, [
            OC.btn(t('users.restartNow'), 'sm primary', function () { el.remove(); OC.serverAction('restart_server'); }, 'restart'),
            OC.btn(t('users.later'), 'sm', function () { el.remove(); })
          ])
        ]);
        OC.$('toasts').appendChild(el);
        setTimeout(function () { el.remove(); }, 20000);
      }

      function regCard(cfg) {
        if (!cfg) return OC.card(t('users.registration'), [h('p', { cls: 'alert', text: t('users.loadError') })]);
        var sw = OC.switchRow(t('users.allowReg'), null, !!cfg.allowRegistration, function (on, inp) {
          inp.disabled = true;
          // Re-read the config so this switch does not overwrite other settings changed meanwhile.
          OC.invoke('get_config').then(function (c) {
            return OC.invoke('set_config', {
              port: c.port, host: c.host, allowRegistration: on, searxngUrl: c.searxngUrl
            });
          }).then(function (r) {
            inp.disabled = false;
            if (r && r.restartRequired) restartToast();
            else OC.toast(t('common.saved'));
          }, function (e) {
            inp.disabled = false;
            inp.checked = !on;
            OC.toast(e.message, 'err');
          });
        });
        return OC.card(t('users.registration'), [sw], t('users.registrationSub'));
      }

      function usersCard(list) {
        var body = list.length
          ? h('div', { cls: 'list' }, list.map(userRow))
          : OC.empty('∅', t('users.empty'));
        return OC.card(t('users.list'), [body]);
      }

      function setDisabled(u, flag) {
        OC.invoke('set_disabled', { id: u.id, disabled: flag }).then(function () {
          OC.toast(flag ? t('users.disabledOk') : t('users.enabledOk'));
          load();
        }, function (e) { OC.toast(e.message, 'err'); });
      }

      function userRow(u) {
        var name = u.username || '?';
        var sel = h('select', {
          attrs: { 'aria-label': t('users.roleOf', { name: name }) },
          on: { change: function () {
            OC.invoke('set_role', { id: u.id, role: sel.value }).then(function () {
              OC.toast(t('users.updated'));
              load();
            }, function (e) {
              OC.toast(e.message, 'err');
              sel.value = u.role;
            });
          } }
        }, roleOptions());
        sel.value = u.role;

        var toggle = OC.btn(u.disabled ? t('users.enable') : t('users.disable'), u.disabled ? 'sm' : 'sm danger', function () {
          if (u.disabled) { setDisabled(u, false); return; }
          OC.confirm(t('users.disableTitle'), t('users.disableText', { name: name }), t('users.disable'), true).then(function (ok) {
            if (ok) setDisabled(u, true);
          });
        });

        var reset = OC.btn(t('users.resetPassword'), 'sm', function () { openReset(u); });
        // admins are never restricted, so only ordinary users get the model grant editor
        var isAdmin = u.role === 'admin';
        var grantBtn = isAdmin ? null : OC.btn(t('users.grants'), 'sm', function () { openGrants(u); }, 'models');

        return h('div', { cls: 'list-item wrap' }, [
          h('span', { cls: 'avatar', text: name.charAt(0).toUpperCase(), attrs: { 'aria-hidden': 'true' } }),
          h('div', { cls: 'grow' }, [
            h('strong', { text: name }),
            h('div', { cls: 'row' }, [
              u.role === 'admin' ? OC.chip('ok', t('users.roleAdmin')) : OC.chip('', t('users.roleUser')),
              u.disabled ? OC.chip('err', t('users.disabledChip')) : null,
              isAdmin ? h('span', { cls: 'hint', text: t('users.grantsAdminNote') }) : null,
              u.createdAt ? h('span', { cls: 'hint', text: t('users.createdAt', { date: OC.fmtDate(u.createdAt) }) }) : null
            ])
          ]),
          h('div', { cls: 'row item-actions' }, [sel, toggle, reset, grantBtn])
        ]);
      }

      // "使えるモデル": per shared provider, follow the default / all models / selected models / not allowed.
      // Saving sends only the changes: PUT for a new mode, DELETE for "follow the default".
      function openGrants(u) {
        var name = u.username || '?';
        var body = h('div', { cls: 'stack' }, [h('p', { cls: 'hint', text: t('users.grantsLoading') })]);
        var err = h('div');
        var busy = false;
        var close = null;
        var box = null;
        var state = { providers: [], defaultAccess: 'none', rows: {} };

        function showErr(msg) { OC.clear(err); err.appendChild(h('p', { cls: 'alert', text: msg, attrs: { role: 'alert' } })); }

        close = OC.modal({
          title: t('users.grantsTitle', { name: name }),
          wide: true,
          body: [body, err],
          actions: [
            { text: t('common.cancel') },
            { text: t('users.grantsSave'), cls: 'primary', onClick: function () {
              if (busy) return true;
              save();
              return true; // keep open until the requests settle
            } }
          ]
        });
        box = OC.$('modal').firstChild;

        function fmtBytes(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB'; }
        // same sub line as the chat model picker: quantization, size (VRAM when loaded), context
        function stateLine(st) {
          if (!st) return '';
          var parts = [];
          if (st.quantization) parts.push(st.quantization);
          if (st.vramBytes) parts.push(fmtBytes(st.vramBytes) + ' VRAM'); else if (st.sizeBytes) parts.push(fmtBytes(st.sizeBytes));
          var c = (st.loaded ? st.loadedContextLength : undefined) || st.contextLength;
          if (c) parts.push(t('users.grantCtx', { n: c >= 1000 ? Math.round(c / 1024) + 'k' : c }));
          return parts.join(' · ');
        }
        // the maker badge of the chat model picker (generated copy of the app's matching, see tools/gen-model-family.mjs)
        function badge(m) {
          var fam = window.OCFamily ? window.OCFamily.resolveFamily(m.id, m.state && m.state.publisher) : null;
          var el = h('span', { cls: 'mbadge', attrs: { 'aria-hidden': 'true' } });
          if (!fam) return el;
          el.style.backgroundColor = fam.bg;
          var path = fam.mark ? window.OCFamily.MARK_PATHS[fam.mark] : null;
          if (path) {
            var ns = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(ns, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
            var p = document.createElementNS(ns, 'path');
            p.setAttribute('d', path); p.setAttribute('fill', '#fff');
            svg.appendChild(p); el.appendChild(svg);
          } else {
            el.textContent = fam.monogram;
            if (fam.monogram.length > 1) el.classList.add('two');
          }
          return el;
        }

        function renderPick(id) {
          var r = state.rows[id];
          OC.clear(r.pick);
          if (r.sel.value !== 'list') return;
          if (r.models === null) { r.pick.appendChild(h('p', { cls: 'hint', text: t('users.grantsLoadModels') })); return; }
          if (r.error) { r.pick.appendChild(h('p', { cls: 'alert', text: r.error, attrs: { role: 'alert' } })); return; }
          if (!r.models.length) { r.pick.appendChild(h('p', { cls: 'hint', text: t('users.grantsNoModels') })); return; }
          var count = h('span', { cls: 'hint' });
          var listBox = h('div', { cls: 'mlist' });
          var boxes = {};
          function updateCount() { count.textContent = t('users.grantCount', { n: r.selected.length, total: r.models.length }); }
          function setAll(on) {
            r.selected = on ? r.models.map(function (m) { return m.id; }) : [];
            Object.keys(boxes).forEach(function (k) { boxes[k].checked = on; });
            updateCount();
          }
          function drawList() {
            OC.clear(listBox);
            var q = (r.filter || '').trim().toLowerCase();
            var shown = r.models.filter(function (m) { return !q || (m.name + ' ' + m.id).toLowerCase().indexOf(q) >= 0; });
            boxes = {};
            if (!shown.length) { listBox.appendChild(h('p', { cls: 'hint', text: t('users.grantNoMatch') })); return; }
            shown.forEach(function (m) {
              var cb = h('input', { attrs: { type: 'checkbox' }, on: { change: function () {
                var at = r.selected.indexOf(m.id);
                if (cb.checked && at < 0) r.selected.push(m.id);
                if (!cb.checked && at >= 0) r.selected.splice(at, 1);
                updateCount();
              } } });
              cb.checked = r.selected.indexOf(m.id) >= 0;
              boxes[m.id] = cb;
              var line = stateLine(m.state);
              listBox.appendChild(h('label', { cls: 'mrow' }, [
                cb, badge(m),
                h('span', { cls: 'mtext' }, [h('span', { cls: 'mname', text: m.name || m.id, attrs: { title: m.id } }), line ? h('span', { cls: 'msub', text: line }) : null])
              ]));
            });
          }
          var tools = h('div', { cls: 'mtools' }, [
            r.models.length > 8 ? h('input', { cls: 'mfilter', attrs: { type: 'search', placeholder: t('users.grantFilter'), 'aria-label': t('users.grantFilter') }, on: { input: function (e) { r.filter = e.target.value; drawList(); } } }) : null,
            h('span', { cls: 'mbtns' }, [OC.btn(t('users.grantSelAll'), 'sm', function () { setAll(true); }), OC.btn(t('users.grantSelNone'), 'sm', function () { setAll(false); })]),
            count
          ]);
          updateCount();
          drawList();
          r.pick.appendChild(tools);
          r.pick.appendChild(listBox);
        }

        function loadModels(id) {
          var r = state.rows[id];
          if (r.models !== null) { renderPick(id); return; }
          OC.invoke('provider_models_get', { id: id, refresh: false }).then(function (res) {
            r.models = ((res && res.models) || []).map(function (m) { return { id: m.id, name: m.name || m.id, state: m.state || null }; });
            r.error = (res && res.error) || null;
            renderPick(id);
          }, function (e) {
            r.models = [];
            r.error = (e && e.message) || String(e);
            renderPick(id);
          });
        }

        function drawRows() {
          OC.clear(body);
          if (!state.providers.length) { body.appendChild(h('p', { cls: 'hint', text: t('users.grantsNone') })); return; }
          state.providers.forEach(function (p) {
            var g = state.grants[p.id];
            var cur = g ? g.mode : 'default';
            var sel = h('select', {
              attrs: { 'aria-label': t('users.grantsOf', { name: p.name || '?' }) },
              on: { change: function () { if (sel.value === 'list') loadModels(p.id); else renderPick(p.id); } }
            }, [
              h('option', { attrs: { value: 'default' }, text: t('users.grantDefault', { d: t(state.defaultAccess === 'all' ? 'users.grantAll' : 'users.grantNone') }) }),
              h('option', { attrs: { value: 'all' }, text: t('users.grantAll') }),
              h('option', { attrs: { value: 'list' }, text: t('users.grantList') }),
              h('option', { attrs: { value: 'none' }, text: t('users.grantNone') })
            ]);
            sel.value = cur;
            var pick = h('div', { cls: 'stack grant-pick' });
            var original = g && g.mode === 'list' ? g.models.slice() : [];
            state.rows[p.id] = { p: p, sel: sel, pick: pick, models: null, error: null, selected: original.slice(), original: cur, originalModels: original };
            body.appendChild(h('section', { cls: 'grant-prov' }, [
              h('div', { cls: 'gp-head' }, [h('strong', { text: p.name || '?' }), p.owner ? h('span', { cls: 'hint', text: p.owner }) : null]),
              sel,
              pick
            ]));
            if (cur === 'list') loadModels(p.id);
          });
        }

        function sameSet(a, b) {
          if (a.length !== b.length) return false;
          var x = a.slice().sort(); var y = b.slice().sort();
          return x.every(function (v, i) { return v === y[i]; });
        }

        function save() {
          var jobs = [];
          var bad = null;
          state.providers.forEach(function (p) {
            var r = state.rows[p.id];
            var mode = r.sel.value;
            var args = { userId: u.id, providerId: p.id };
            if (mode === 'list') {
              if (!r.selected.length) { bad = bad || t('users.grantPickOne', { name: p.name || '?' }); return; }
              if (r.original === 'list' && sameSet(r.selected, r.originalModels)) return;
              jobs.push(OC.invoke('user_grant_set', Object.assign({ mode: 'list', models: r.selected.slice() }, args)));
            } else if (mode === 'default') {
              if (r.original !== 'default') jobs.push(OC.invoke('user_grant_delete', args));
            } else if (mode !== r.original) {
              jobs.push(OC.invoke('user_grant_set', Object.assign({ mode: mode, models: [] }, args)));
            }
          });
          if (bad) { showErr(bad); return; }
          busy = true;
          Promise.all(jobs).then(function () {
            busy = false;
            if (jobs.length) OC.toast(t('users.grantsSaved'));
            if (box && box.parentNode) close();
          }, function (e) {
            busy = false;
            showErr((e && e.message) || String(e));
          });
        }

        Promise.all([
          OC.invoke('shared_providers_get'),
          OC.invoke('user_grants_get', { userId: u.id })
        ]).then(function (res) {
          state.providers = (res[0] && res[0].providers) || [];
          state.defaultAccess = (res[1] && res[1].defaultSharedAccess) || 'none';
          state.grants = {};
          ((res[1] && res[1].grants) || []).forEach(function (g) { state.grants[g.providerId] = g; });
          drawRows();
        }, function (e) {
          OC.clear(body);
          showErr((e && e.message) || t('users.loadError'));
        });
      }

      function openReset(u) {
        var name = u.username || '?';
        var pw = h('input', { attrs: { type: 'password', autocomplete: 'new-password', minlength: '8', required: 'required' } });
        var pw2 = h('input', { attrs: { type: 'password', autocomplete: 'new-password', minlength: '8', required: 'required' } });
        var err = h('div');
        var busy = false;
        var close = null;
        var box = null;
        close = OC.modal({
          title: t('users.resetTitle', { name: name }),
          body: [
            h('p', { cls: 'hint', text: t('users.resetNote', { name: name }) }),
            OC.field(t('users.password'), pw, t('users.passwordHint'), 'users-rst-pw'),
            OC.field(t('users.confirm'), pw2, null, 'users-rst-pw2'),
            err
          ],
          actions: [
            { text: t('common.cancel') },
            { text: t('users.resetAction'), cls: 'primary', onClick: function () {
              if (busy) return true;
              if (pw.value.length < 8) { setModalError(err, t('users.tooShort')); return true; }
              if (pw.value !== pw2.value) { setModalError(err, t('users.mismatch')); return true; }
              busy = true;
              OC.invoke('set_password', { id: u.id, password: pw.value }).then(function () {
                busy = false;
                if (box && box.parentNode) close();
                OC.toast(t('users.passwordReset'));
              }, function (e) {
                busy = false;
                setModalError(err, e.message);
              });
              return true; // keep open until the request settles
            } }
          ]
        });
        box = OC.$('modal').firstChild;
      }

      function openAdd() {
        var uName = h('input', { attrs: { type: 'text', autocomplete: 'off', minlength: '3', maxlength: '32', required: 'required' } });
        var pw = h('input', { attrs: { type: 'password', autocomplete: 'new-password', minlength: '8', required: 'required' } });
        var role = h('select', {}, roleOptions());
        role.value = 'user';
        var err = h('div');
        var busy = false;
        var close = null;
        var box = null;
        close = OC.modal({
          title: t('users.addTitle'),
          body: [
            OC.field(t('users.username'), uName, t('users.usernameHint'), 'users-add-name'),
            OC.field(t('users.password'), pw, t('users.passwordHint'), 'users-add-pw'),
            OC.field(t('users.role'), role, null, 'users-add-role'),
            err
          ],
          actions: [
            { text: t('common.cancel') },
            { text: t('users.create'), cls: 'primary', onClick: function () {
              if (busy) return true;
              var name = uName.value.trim();
              if (name.length < 3 || name.length > 32) { setModalError(err, t('users.badUsername')); return true; }
              if (pw.value.length < 8) { setModalError(err, t('users.tooShort')); return true; }
              busy = true;
              OC.invoke('create_user', { username: name, password: pw.value, role: role.value }).then(function () {
                busy = false;
                if (box && box.parentNode) close();
                OC.toast(t('users.created'));
                load();
              }, function (e) {
                busy = false;
                setModalError(err, e.message);
              });
              return true; // keep open until the request settles
            } }
          ]
        });
        box = OC.$('modal').firstChild;
      }

      load();

      return {
        onState: function (s) {
          var running = !!(s && s.running);
          if (running !== lastRunning) { lastRunning = running; load(); }
        },
        destroy: function () { alive = false; }
      };
    }
  });
})();
