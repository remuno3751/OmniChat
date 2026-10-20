// Security page: network exposure, local admin token, first admin account.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'security.sub': '接続できる範囲、ローカル管理アクセス、管理者アカウントを確認します。',
      'security.net.title': 'ネットワーク公開範囲',
      'security.net.sub': '待ち受けアドレスによって、接続できる端末が決まります。',
      'security.net.lan': '他の端末から接続できます',
      'security.net.local': 'このPCのみ',
      'security.net.current': '待ち受けアドレス',
      'security.net.explain': '0.0.0.0 は同じネットワーク上の他の端末から接続できる状態です。127.0.0.1 はこの PC からのみ接続できる状態です。',
      'security.net.advice': 'リモートから使う場合は Tailscale か信頼できる LAN を使ってください。HTTPS のリバースプロキシを挟まずに、インターネットへポート転送しないでください。',
      'security.net.toLan': '他の端末からの接続を許可…',
      'security.net.toLocal': 'このPCのみに変更…',
      'security.net.allow': '許可',
      'security.net.switch': '変更',
      'security.net.confirmLanTitle': '他の端末からの接続を許可しますか？',
      'security.net.confirmLanText': 'サーバーはすべてのネットワークインターフェース (0.0.0.0) で待ち受けます。同じネットワーク上の端末から接続できるようになるため、そのネットワークを信頼できることを確認してください。',
      'security.net.confirmLocalTitle': 'このPCのみに制限しますか？',
      'security.net.confirmLocalText': '再起動後は、他の端末からは接続できなくなります。',
      'security.net.restartTitle': '再起動が必要です',
      'security.net.restartText': '新しい設定は再起動後に反映されます。今すぐ再起動しますか？',
      'security.net.restartNow': '今すぐ再起動',
      'security.net.saved': '保存しました。次回起動時に反映されます。',
      'security.tok.title': 'ローカル管理トークンと鍵',
      'security.tok.sub': 'ローカル管理 API の認証に使われます。',
      'security.tok.explain': 'このアプリの管理 API はこの PC のループバックからのみ待ち受けます。起動のたびに作られるトークンファイルで認証し、そのファイルは OS にログインしているあなたのユーザーだけが読めます。',
      'security.tok.path': 'トークンファイル',
      'security.tok.stopped': 'トークンファイルは、サーバー起動時に作成されます。',
      'security.tok.device': 'デバイストークンは、クライアントアプリでサインインした端末ごとに発行されます。個別の端末は、ユーザーがクライアントアプリから取り消せます。',
      'security.tok.active': '有効',
      'security.tok.inactive': '無効',
      'security.adm.title': '最初の管理者',
      'security.adm.none': '管理者アカウントがまだありません',
      'security.adm.noneText': '最初の管理者アカウントを作成してください。',
      'security.adm.exists': '管理者あり',
      'security.adm.users': 'ユーザー数: {n}',
      'security.adm.note': '最初の管理者は、このアプリまたは omnichat-admin CLI でのみ作成できます。ネットワーク経由では作成できません。',
      'security.adm.username': 'ユーザー名',
      'security.adm.usernameHint': '3〜32 文字',
      'security.adm.password': 'パスワード',
      'security.adm.passwordHint': '8 文字以上',
      'security.adm.confirm': 'パスワード（確認）',
      'security.adm.create': '管理者を作成',
      'security.adm.errUser': 'ユーザー名は 3〜32 文字で入力してください。',
      'security.adm.errPass': 'パスワードは 8 文字以上にしてください。',
      'security.adm.errMatch': 'パスワードが一致しません。',
      'security.adm.created': '管理者アカウントを作成しました。'
    },
    en: {
      'security.sub': 'Review who can reach this server, local admin access and the admin account.',
      'security.net.title': 'Network exposure',
      'security.net.sub': 'The listen address decides which devices can connect.',
      'security.net.lan': 'Reachable from other devices',
      'security.net.local': 'This PC only',
      'security.net.current': 'Listen address',
      'security.net.explain': '0.0.0.0 makes the server reachable from other devices on your network. 127.0.0.1 keeps it reachable from this PC only.',
      'security.net.advice': 'For remote access, use Tailscale or a trusted LAN. Never port-forward this server to the internet without an HTTPS reverse proxy.',
      'security.net.toLan': 'Allow other devices…',
      'security.net.toLocal': 'Switch to this PC only…',
      'security.net.allow': 'Allow',
      'security.net.switch': 'Switch',
      'security.net.confirmLanTitle': 'Allow other devices to connect?',
      'security.net.confirmLanText': 'The server will listen on all network interfaces (0.0.0.0). Devices on your network will be able to reach it, so make sure you trust that network.',
      'security.net.confirmLocalTitle': 'Limit the server to this PC?',
      'security.net.confirmLocalText': 'After a restart, other devices will no longer be able to connect.',
      'security.net.restartTitle': 'Restart required',
      'security.net.restartText': 'The new setting takes effect after a restart. Restart the server now?',
      'security.net.restartNow': 'Restart now',
      'security.net.saved': 'Saved. It takes effect at the next start.',
      'security.tok.title': 'Local admin token & keys',
      'security.tok.sub': 'Used to authenticate the local admin API.',
      'security.tok.explain': 'The admin API used by this app listens on loopback (this PC) only. It authenticates with a token file that is created on each start and can be read only by your OS user account.',
      'security.tok.path': 'Token file',
      'security.tok.stopped': 'The token file is created when the server starts.',
      'security.tok.device': 'Device tokens are issued per device when a client signs in. You can revoke an individual device from the OmniChat client app.',
      'security.tok.active': 'Active',
      'security.tok.inactive': 'Inactive',
      'security.adm.title': 'First admin',
      'security.adm.none': 'No admin account yet',
      'security.adm.noneText': 'Create the first admin account to finish securing this server.',
      'security.adm.exists': 'Admin exists',
      'security.adm.users': 'Users on this server: {n}',
      'security.adm.note': 'The first admin can only be created in this app or with the omnichat-admin CLI. It is never created over the network.',
      'security.adm.username': 'Username',
      'security.adm.usernameHint': '3–32 characters',
      'security.adm.password': 'Password',
      'security.adm.passwordHint': 'At least 8 characters',
      'security.adm.confirm': 'Confirm password',
      'security.adm.create': 'Create admin',
      'security.adm.errUser': 'Username must be 3–32 characters.',
      'security.adm.errPass': 'Password must be at least 8 characters.',
      'security.adm.errMatch': 'Passwords do not match.',
      'security.adm.created': 'Admin account created.'
    }
  });

  OC.addStrings({
    ja: {
      'shared.title': '共有プロバイダーの既定',
      'shared.sub': '管理者が「ユーザーと共有する」にした接続先を、ユーザーがどう使えるかの既定です。ユーザーごとの許可は「ユーザー」画面で変えられます。',
      'shared.defLabel': '新規ユーザーの既定',
      'shared.defHint': '許可を個別に決めていないユーザーに適用されます。',
      'shared.defNone': '何も使えない',
      'shared.defAll': '全共有プロバイダーの全モデル',
      'shared.ownSwitch': 'ユーザーが自分の接続先を追加できる',
      'shared.ownHint': 'オフにすると、一般ユーザーは接続先を追加できません(編集と削除は今まで通りです)。',
      'shared.saved': '共有の既定を保存しました'
    },
    en: {
      'shared.title': 'Shared provider defaults',
      'shared.sub': 'The default access users have to the endpoints you share with them. Per-user access is changed on the Users page.',
      'shared.defLabel': 'Default for new users',
      'shared.defHint': 'Applies to users with no access decided individually.',
      'shared.defNone': 'Nothing allowed',
      'shared.defAll': 'All models of all shared providers',
      'shared.ownSwitch': 'Users can add their own endpoints',
      'shared.ownHint': 'When off, ordinary users cannot add endpoints (editing and deleting still work).',
      'shared.saved': 'Shared defaults saved'
    }
  });

  function skel() { return h('div', { cls: 'skeleton', attrs: { 'aria-hidden': 'true' } }); }

  // Path of the token file without reading it. Keeps the separator style of the data dir.
  function joinPath(dir, name) {
    if (!dir) return '—';
    var sep = (dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0) ? '\\' : '/';
    return dir.replace(/[\\\/]+$/, '') + sep + name;
  }

  OC.addStrings({
    ja: {
      'maint.title': 'メンテナンスモード', 'maint.sub': 'オンの間、一般ユーザーは AI 機能を使えません。管理者は使えます。変更は接続中の全クライアントに即時反映されます。',
      'maint.on': 'メンテナンス中', 'maint.off': '通常運用', 'maint.switch': 'メンテナンスモード', 'maint.switchHint': 'オンにすると一般ユーザーの AI 利用を止めます。',
      'maint.message': 'お知らせメッセージ', 'maint.messageHint': '一般ユーザーに表示されます(500 文字まで)。空でも構いません。',
      'maint.eta': '完了予定', 'maint.etaHint': '未設定なら空のままにします。', 'maint.etaClear': '完了予定を消す',
      'maint.etaShow': '完了予定: {t}', 'maint.saved': '保存しました', 'maint.saving': '保存中…',
      'maint.errMessage': 'メッセージは 500 文字までです。', 'maint.errEta': '完了予定は未来の日時を指定してください。',
      'maint.confirmTitle': 'メンテナンスモードをオンにしますか?', 'maint.confirmText': '一般ユーザーは AI 機能を使えなくなります。管理者は引き続き使えます。',
      'maint.confirmOn': 'オンにする'
    },
    en: {
      'maint.title': 'Maintenance mode', 'maint.sub': 'While on, regular users cannot use AI features. Admins still can. Changes reach every connected client at once.',
      'maint.on': 'Under maintenance', 'maint.off': 'Normal operation', 'maint.switch': 'Maintenance mode', 'maint.switchHint': 'Turning it on stops AI use for regular users.',
      'maint.message': 'Message', 'maint.messageHint': 'Shown to regular users (up to 500 characters). May be empty.',
      'maint.eta': 'Expected end', 'maint.etaHint': 'Leave empty if unknown.', 'maint.etaClear': 'Clear expected end',
      'maint.etaShow': 'Expected end: {t}', 'maint.saved': 'Saved', 'maint.saving': 'Saving…',
      'maint.errMessage': 'The message can be at most 500 characters.', 'maint.errEta': 'Set the expected end to a future time.',
      'maint.confirmTitle': 'Turn on maintenance mode?', 'maint.confirmText': 'Regular users will not be able to use AI features. Admins can still use them.',
      'maint.confirmOn': 'Turn on'
    }
  });

  OC.registerPage({
    id: 'security', order: 50, icon: 'security', titleKey: 'nav.security',
    render: function (root) {
      root.classList.add('p-security');
      root.appendChild(OC.pageHeader(t('nav.security'), t('security.sub')));

      // ---- Network exposure
      var netSkel = skel();
      var netChipHold = h('span');
      var netHost = h('code');
      var netBtn = OC.btn('', '', toggleNet);
      var netBody = h('div', { cls: 'stack' }, [
        h('div', { cls: 'row' }, [netChipHold, h('span', { cls: 'small muted', text: t('security.net.current') }), netHost]),
        h('p', { cls: 'small', text: t('security.net.explain') }),
        h('p', { cls: 'hint', text: t('security.net.advice') }),
        h('div', { cls: 'row' }, [netBtn])
      ]);
      var netCard = OC.card(t('security.net.title'), [netSkel, netBody], t('security.net.sub'));

      function renderNet(s) {
        netSkel.hidden = !!s;
        netBody.hidden = !s;
        if (!s) return;
        var lan = s.host === '0.0.0.0';
        OC.clear(netChipHold).appendChild(OC.chip(lan ? 'warn' : 'ok', t(lan ? 'security.net.lan' : 'security.net.local')));
        netHost.textContent = s.host || '—';
        netBtn.textContent = t(lan ? 'security.net.toLocal' : 'security.net.toLan');
      }

      function toggleNet() {
        // Read the current config first so that all other fields are kept as they are.
        netBtn.disabled = true;
        OC.invoke('get_config').then(function (cfg) {
          var toLan = cfg.host !== '0.0.0.0';
          return OC.confirm(
            t(toLan ? 'security.net.confirmLanTitle' : 'security.net.confirmLocalTitle'),
            t(toLan ? 'security.net.confirmLanText' : 'security.net.confirmLocalText'),
            t(toLan ? 'security.net.allow' : 'security.net.switch')
          ).then(function (ok) {
            if (!ok) return null;
            return OC.invoke('set_config', {
              port: cfg.port,
              host: toLan ? '0.0.0.0' : '127.0.0.1',
              allowRegistration: cfg.allowRegistration,
              searxngUrl: cfg.searxngUrl
            }).then(afterSave);
          });
        }).catch(function (e) {
          OC.toast(e.message, 'err');
        }).then(function () {
          netBtn.disabled = false;
        });
      }

      function afterSave(r) {
        if (!r || !r.restartRequired || !OC.state || !OC.state.running) {
          OC.toast(t('security.net.saved'));
          return null;
        }
        return OC.confirm(t('security.net.restartTitle'), t('security.net.restartText'), t('security.net.restartNow'))
          .then(function (ok) { if (ok) return OC.serverAction('restart_server'); });
      }

      // ---- Local admin token & keys
      var tokSkel = skel();
      var tokChipHold = h('span');
      var tokPath = h('code');
      var tokPathText = '';
      var tokCopy = OC.btn(t('common.copy'), 'sm ghost', function () { if (tokPathText) OC.copy(tokPathText); }, 'copy');
      var tokStopped = h('p', { cls: 'hint', text: t('security.tok.stopped') });
      var tokBody = h('div', { cls: 'stack' }, [
        h('div', { cls: 'row' }, [tokChipHold]),
        h('p', { cls: 'small', text: t('security.tok.explain') }),
        h('div', { cls: 'stack' }, [
          h('span', { cls: 'small muted', text: t('security.tok.path') }),
          h('div', { cls: 'urlbox' }, [tokPath, tokCopy])
        ]),
        tokStopped,
        h('p', { cls: 'hint', text: t('security.tok.device') })
      ]);
      var tokCard = OC.card(t('security.tok.title'), [tokSkel, tokBody], t('security.tok.sub'));

      function renderTok(s) {
        tokSkel.hidden = !!s;
        tokBody.hidden = !s;
        if (!s) return;
        OC.clear(tokChipHold).appendChild(s.running
          ? OC.chip('ok', t('security.tok.active'))
          : OC.chip('', t('security.tok.inactive')));
        tokPathText = joinPath(s.dataDir, 'local-admin.token');
        tokPath.textContent = tokPathText;
        tokStopped.hidden = !!s.running;
      }

      // ---- First admin
      var admSkel = skel();
      var admNone = h('div', { cls: 'stack' });
      var admExists = h('div', { cls: 'stack' });
      var admCount = h('p', { cls: 'hint' });
      var admStopped = OC.empty('∅', t('common.serverStopped'), t('common.startFirst'));
      var admNote = h('p', { cls: 'hint', text: t('security.adm.note') });

      var userIn = h('input', { attrs: { type: 'text', autocomplete: 'username', spellcheck: 'false' } });
      var passIn = h('input', { attrs: { type: 'password', autocomplete: 'new-password' } });
      var confIn = h('input', { attrs: { type: 'password', autocomplete: 'new-password' } });
      var errBox = h('div', { cls: 'alert', attrs: { role: 'alert' } });
      var createBtn = h('button', { cls: 'btn primary', attrs: { type: 'submit' }, text: t('security.adm.create') });
      var form = h('form', {
        cls: 'stack',
        attrs: { novalidate: 'novalidate' },
        on: { submit: function (e) { e.preventDefault(); createAdmin(); } }
      }, [
        OC.field(t('security.adm.username'), userIn, t('security.adm.usernameHint'), 'sec-adm-user'),
        OC.field(t('security.adm.password'), passIn, t('security.adm.passwordHint'), 'sec-adm-pass'),
        OC.field(t('security.adm.confirm'), confIn, null, 'sec-adm-confirm'),
        errBox,
        h('div', { cls: 'row' }, [createBtn])
      ]);
      errBox.hidden = true;
      OC.clear(admNone).appendChild(h('div', { cls: 'alert warn', attrs: { role: 'status' } }, [
        h('strong', { text: t('security.adm.none') }),
        h('p', { text: t('security.adm.noneText') })
      ]));
      admNone.appendChild(form);
      admExists.appendChild(h('div', { cls: 'row' }, [OC.chip('ok', t('security.adm.exists'))]));
      admExists.appendChild(admCount);
      var admCard = OC.card(t('security.adm.title'), [admSkel, admNone, admExists, admStopped, admNote]);

      function setErr(msg) {
        errBox.textContent = msg || '';
        errBox.hidden = !msg;
      }

      function createAdmin() {
        var u = userIn.value.trim();
        var p = passIn.value;
        var c = confIn.value;
        if (u.length < 3 || u.length > 32) { setErr(t('security.adm.errUser')); userIn.focus(); return; }
        if (p.length < 8) { setErr(t('security.adm.errPass')); passIn.focus(); return; }
        if (p !== c) { setErr(t('security.adm.errMatch')); confIn.focus(); return; }
        setErr(null);
        createBtn.disabled = true;
        OC.invoke('create_user', { username: u, password: p, role: 'admin' }).then(function () {
          userIn.value = ''; passIn.value = ''; confIn.value = '';
          OC.toast(t('security.adm.created'));
          return OC.refreshState();
        }, function (e) {
          setErr(e.message);
        }).then(function () {
          createBtn.disabled = false;
        });
      }

      function renderAdm(s) {
        var mode = !s ? 'skel' : !s.running ? 'stopped' : s.userCount === 0 ? 'none' : typeof s.userCount === 'number' ? 'exists' : 'skel';
        admSkel.hidden = mode !== 'skel';
        admNone.hidden = mode !== 'none';
        admExists.hidden = mode !== 'exists';
        admStopped.hidden = mode !== 'stopped';
        if (mode === 'exists') admCount.textContent = t('security.adm.users', { n: s.userCount });
      }

      // ---- Maintenance mode (local admin API: maintenance_get / maintenance_set)
      var mSkel = skel();
      var mStopped = h('div', { cls: 'alert warn', attrs: { role: 'status' }, text: t('common.serverStopped') });
      var mChip = h('span', { cls: 'chip', text: t('common.loading') });
      var mSummary = h('p', { cls: 'small muted' });
      var mSwitch = OC.switchRow(t('maint.switch'), t('maint.switchHint'), false, function (on, inp) { setMaintEnabled(on, inp); });
      var mSwitchInput = mSwitch.querySelector('input');
      var mMsg = h('textarea', { attrs: { rows: '3', id: 'sec-maint-msg' } });
      var mCount = h('span', { cls: 'hint' });
      var mMsgField = h('div', { cls: 'stack' }, [mMsg, mCount]);
      var mEta = h('input', { attrs: { type: 'datetime-local', id: 'sec-maint-eta' } });
      var mEtaClear = OC.btn(t('maint.etaClear'), '', function () { mEta.value = ''; });
      var mSave = OC.btn(t('common.save'), 'primary', saveMaint);
      var mErr = h('p', { cls: 'alert', attrs: { role: 'alert' } });
      mErr.hidden = true;
      var mBody = h('div', { cls: 'stack' }, [
        h('div', { cls: 'row' }, [mChip, mSummary]),
        mSwitch,
        OC.field(t('maint.message'), mMsgField, t('maint.messageHint')),
        OC.field(t('maint.eta'), h('div', { cls: 'row' }, [mEta, mEtaClear]), t('maint.etaHint')),
        mErr,
        h('div', { cls: 'row' }, [mSave])
      ]);
      mBody.hidden = true;
      mStopped.hidden = true;
      var mCard = OC.card(t('maint.title'), [mSkel, mStopped, mBody], t('maint.sub'));
      var mNow = null, mRun = false, mSaving = false, mLastRun = null;

      function showMaintErr(msg) { mErr.textContent = msg || ''; mErr.hidden = !msg; }
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      function toLocalInput(ms) {
        var d = new Date(ms);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
      function countMsg() { mCount.textContent = [...mMsg.value].length + ' / 500'; }
      mMsg.addEventListener('input', countMsg);

      function syncMaintControls() {
        var off = !mRun || mSaving || OC.isBusy();
        [mSwitchInput, mMsg, mEta, mEtaClear, mSave].forEach(function (c) { c.disabled = off; });
      }

      // fills the form from the server state (not called on every poll, so unsaved typing survives)
      function applyMaint(m) {
        mNow = m;
        mSwitchInput.checked = !!m.enabled;
        mMsg.value = m.message || '';
        mEta.value = m.eta ? toLocalInput(m.eta) : '';
        countMsg();
        mChip.className = 'chip ' + (m.enabled ? 'warn' : 'ok');
        mChip.textContent = t(m.enabled ? 'maint.on' : 'maint.off');
        mSummary.textContent = m.enabled && m.eta ? t('maint.etaShow', { t: OC.fmtDate(m.eta) }) : '';
      }

      function writeMaint(args, revert) {
        mSaving = true; syncMaintControls();
        return OC.invoke('maintenance_set', args).then(function (r) {
          applyMaint(r.maintenance);
          showMaintErr(null);
          OC.emit('maintenance', r.maintenance);
          OC.toast(t('maint.saved'));
        }, function (e) {
          showMaintErr(e.message);
          if (revert && mNow) mSwitchInput.checked = !!mNow.enabled;
        }).then(function () { mSaving = false; syncMaintControls(); });
      }

      function setMaintEnabled(on, inp) {
        if (!on) { writeMaint({ enabled: false, clearEta: false }, true); return; }
        OC.confirm(t('maint.confirmTitle'), t('maint.confirmText'), t('maint.confirmOn'), true).then(function (ok) {
          if (!ok) { inp.checked = false; return; }
          return writeMaint({ enabled: true, clearEta: false }, true);
        });
      }

      function saveMaint() {
        var msg = mMsg.value;
        if ([...msg].length > 500) { showMaintErr(t('maint.errMessage')); return; }
        var args = { message: msg, clearEta: false };
        if (mEta.value) {
          var ms = new Date(mEta.value).getTime();
          if (!isFinite(ms)) { showMaintErr(t('maint.errEta')); return; }
          if ((!mNow || ms !== mNow.eta) && ms <= Date.now()) { showMaintErr(t('maint.errEta')); return; }
          args.eta = ms;
        } else {
          args.clearEta = true;
        }
        writeMaint(args, false);
      }

      function loadMaint() {
        return OC.invoke('maintenance_get').then(function (r) { applyMaint(r.maintenance); showMaintErr(null); }, function (e) { showMaintErr(e.message); });
      }

      function renderMaint(s) {
        mRun = !!(s && s.running);
        mSkel.hidden = !!s;
        mStopped.hidden = !(s && !s.running);
        mBody.hidden = !(s && s.running);
        syncMaintControls();
        if (mRun && mLastRun !== true) loadMaint();
        if (s) mLastRun = mRun;
      }
      var unMaintBusy = OC.on('busy', syncMaintControls);
      var unMaintEvt = OC.on('maintenance', function (m) { if (m) applyMaint(m); });

      // ---- Shared providers defaults (local admin API: shared_settings_get / shared_settings_set)
      var sSkel = skel();
      var sStopped = h('div', { cls: 'alert warn', attrs: { role: 'status' }, text: t('common.serverStopped') });
      var sDefault = h('select', { attrs: { id: 'sec-shared-default' } }, [
        h('option', { attrs: { value: 'none' }, text: t('shared.defNone') }),
        h('option', { attrs: { value: 'all' }, text: t('shared.defAll') })
      ]);
      var sOwn = OC.switchRow(t('shared.ownSwitch'), t('shared.ownHint'), true, function () {});
      var sOwnInput = sOwn.querySelector('input');
      var sSave = OC.btn(t('common.save'), 'primary', saveShared);
      var sErr = h('p', { cls: 'alert', attrs: { role: 'alert' } });
      sErr.hidden = true;
      var sBody = h('div', { cls: 'stack' }, [
        OC.field(t('shared.defLabel'), sDefault, t('shared.defHint'), 'sec-shared-default'),
        sOwn,
        sErr,
        h('div', { cls: 'row' }, [sSave])
      ]);
      sBody.hidden = true;
      sStopped.hidden = true;
      var sCard = OC.card(t('shared.title'), [sSkel, sStopped, sBody], t('shared.sub'));
      var sRun = false, sSaving = false, sLastRun = null;

      function showSharedErr(msg) { sErr.textContent = msg || ''; sErr.hidden = !msg; }
      function syncShared() {
        var off = !sRun || sSaving || OC.isBusy();
        [sDefault, sOwnInput, sSave].forEach(function (c) { c.disabled = off; });
      }
      function applyShared(g) {
        sDefault.value = g && g.defaultSharedAccess === 'all' ? 'all' : 'none';
        sOwnInput.checked = !(g && g.allowOwnProviders === false);
      }
      function loadShared() {
        return OC.invoke('shared_settings_get').then(function (g) { applyShared(g); showSharedErr(null); }, function (e) { showSharedErr(e.message); });
      }
      function saveShared() {
        sSaving = true; syncShared();
        OC.invoke('shared_settings_set', { defaultSharedAccess: sDefault.value, allowOwnProviders: sOwnInput.checked }).then(function (g) {
          applyShared(g);
          showSharedErr(null);
          OC.toast(t('shared.saved'));
        }, function (e) { showSharedErr(e.message); }).then(function () { sSaving = false; syncShared(); });
      }
      function renderShared(s) {
        sRun = !!(s && s.running);
        sSkel.hidden = !!s;
        sStopped.hidden = !(s && !s.running);
        sBody.hidden = !(s && s.running);
        syncShared();
        if (sRun && sLastRun !== true) loadShared();
        if (s) sLastRun = sRun;
      }
      var unSharedBusy = OC.on('busy', syncShared);

      function apply(s) {
        renderNet(s);
        renderTok(s);
        renderAdm(s);
        renderMaint(s);
        renderShared(s);
      }
      apply(OC.state);

      root.appendChild(h('div', { cls: 'grid' }, [netCard, tokCard]));
      root.appendChild(h('div', { cls: 'grid' }, [admCard]));
      root.appendChild(h('div', { cls: 'grid' }, [mCard]));
      root.appendChild(h('div', { cls: 'grid' }, [sCard]));

      return {
        onState: apply,
        destroy: function () { unMaintBusy(); unMaintEvt(); unSharedBusy(); }
      };
    }
  });
})();
