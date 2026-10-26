// Voice call page: voice mode (off / Aria on this PC / external Aria), the Aria host on Windows (config incl. AivisSpeech URL,
// start/stop, checks, log tail, connection token setup), voice models (standard and fast), call LLM roles, usage with
// per-user daily limits, diagnostics, Whisper placement.
// Talks to Aria through OC.invoke('aria_*') and OC.invoke('voice_admin', {method, path, body}). Rendering: DOM only.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'voice.title': '音声通話', 'voice.sub': '音声通話で使う Aria（音声エンジン）と、その言語モデルを設定します。',
      'voice.offNote': '音声通話は off です。上の動作モードを選ぶと、ほかの項目を設定できます。',
      'voice.errVoiceOff': '音声通話が off のため、この項目は使えません。',
      'voice.errAriaUnreachable': 'Aria に接続できません。Aria が起動しているか確認してください。',
      'voice.errNotSupported': '未対応(Aria 側の対応待ち)',
      'voice.mode.title': '動作モード', 'voice.mode.sub': 'Aria をどこで動かすかを選びます。',
      'voice.mode.off': '使わない', 'voice.mode.offHint': '音声通話を無効にします。',
      'voice.mode.hosted': 'このPCで Aria を動かす', 'voice.mode.hostedHint': 'このサーバーが Aria を起動し、見守ります。',
      'voice.mode.external': '外部の Aria', 'voice.mode.externalHint': 'ほかの場所で動いている Aria に接続します。',
      'voice.mode.winOnly': 'Aria のホストは Windows のみ。他の OS では外部の Aria だけ使えます',
      'voice.ext.baseUrl': 'Aria の URL', 'voice.ext.baseUrlHint': 'http:// または https:// で始まるアドレス',
      'voice.ext.baseUrlBad': 'http:// または https:// から始まる URL を入力してください。',
      'voice.ext.chatToken': 'チャット用トークン', 'voice.ext.chatTokenHint': 'Aria への接続に使うトークンです。空欄で保存すると変更しません。',
      'voice.ext.adminToken': '管理用トークン', 'voice.ext.adminTokenHint': 'モデルや設定の変更に使うトークンです。空欄で保存すると変更しません。',
      'voice.tokenSet': '設定済み', 'voice.tokenUnset': '未設定',
      'voice.host.title': 'Aria（このPC）', 'voice.host.sub': 'このPCで Aria を起動・停止します。',
      'voice.host.config': '設定', 'voice.host.ariaDir': 'Aria のフォルダ', 'voice.host.ariaDirHint': 'Aria のソースまたはインストール先のフォルダ',
      'voice.host.pythonPath': 'Python のパス', 'voice.host.pythonPathHint': '空欄なら既定の Python を使います',
      'voice.host.aivisUrl': 'AivisSpeech の URL', 'voice.host.aivisUrlHint': 'AivisSpeech Engine の場所です。Aria とは別のプロセスとして動きます。',
      'voice.host.aivisUrlBad': 'http:// または https:// から始まる URL を入力してください。',
      'voice.host.port': 'ポート', 'voice.host.portHint': '0 または空欄で自動選択します', 'voice.host.portBad': 'ポートは 0 から 65535 の数字で入力してください。',
      'voice.host.autostart': 'サーバーと一緒に Aria を起動', 'voice.host.autostartHint': 'サーバーが起動するとき、Aria も起動します。',
      'voice.host.env': '環境変数', 'voice.host.envHint': 'Aria に渡す追加の環境変数です。値は画面に表示されます。',
      'voice.host.envKey': '名前', 'voice.host.envValue': '値', 'voice.host.envAdd': '行を追加',
      'voice.host.envBad': '名前は英字かアンダースコアで始まり、英数字とアンダースコアだけを使えます。',
      'voice.host.check': '状態を確認',
      'voice.host.setupTokens': '接続用トークンを発行して設定する',
      'voice.host.setupTokensTitle': '接続用トークンを発行しますか？',
      'voice.host.setupTokensBody': '以前に発行したトークンは無効になります。同じ名前のトークンは上書きされます。',
      'voice.host.tokensSet': '接続用トークンを設定しました',
      'voice.host.degraded': 'degraded: 一部不調(起動はしています)',
      'voice.ok': 'OK', 'voice.ng': '要確認',
      'voice.status.stopped': '停止中', 'voice.status.starting': '起動中', 'voice.status.running': '稼働中', 'voice.status.failed': '失敗',
      'voice.host.info': 'ポート {port} · PID {pid} · 再起動 {restarts} 回',
      'voice.host.start': '起動', 'voice.host.stop': '停止', 'voice.host.restart': '再起動',
      'voice.host.logs': 'ログ', 'voice.host.logsHint': '2 秒ごとに更新します。', 'voice.host.logsEmpty': 'ログはまだありません。',
      'voice.models.title': '音声モデル', 'voice.models.sub': 'Aria に登録されている音声モデルです。',
      'voice.models.standard': '標準', 'voice.models.fast': 'Fast',
      'voice.models.name': '名前', 'voice.models.owner': '所有者', 'voice.models.rights': '権限', 'voice.models.state': '状態',
      'voice.models.builtin': '内蔵', 'voice.models.ready': '準備済み', 'voice.models.notReady': '未準備',
      'voice.models.empty': '音声モデルはまだありません。',
      'voice.models.deleteTitle': '音声モデルを削除しますか？', 'voice.models.deleteBody': '「{name}」を削除します。この操作は取り消せません。',
      'voice.models.deleted': '音声モデルを削除しました',
      'voice.llm.title': '通話の言語モデル', 'voice.llm.sub': '速い応答と深い応答に使うモデルを選びます。',
      'voice.llm.role.fast': '速い応答', 'voice.llm.role.deep': '深い応答',
      'voice.llm.endpoint': '接続先', 'voice.llm.model': 'モデル', 'voice.llm.none': '（なし）',
      'voice.llm.empty': '接続先がまだありません。モデル画面で追加してください。',
      'voice.usage.title': '利用状況', 'voice.usage.sub': '通話の利用時間と発話数を、ユーザーごとに確認できます。',
      'voice.usage.days': '期間', 'voice.usage.d7': '過去 7 日', 'voice.usage.d30': '過去 30 日',
      'voice.usage.user': 'ユーザー', 'voice.usage.callMinutes': '通話時間(分)', 'voice.usage.turns': '発話数',
      'voice.usage.replyChars': '応答の文字数', 'voice.usage.dailyLimit': '1日の上限(分)',
      'voice.usage.defaultLimit': '既定の1日の上限(分)', 'voice.usage.unlimited': '上限なし',
      'voice.usage.quotaHint': '0 から 1440 までの整数で入力します。空欄なら上限なしです。',
      'voice.usage.quotaBad': '上限は 0 から 1440 までの整数で入力してください。',
      'voice.usage.noTokens': 'トークン数は取得できないため表示していません。',
      'voice.usage.empty': 'ユーザーがいません。',
      'voice.diag.title': '診断', 'voice.diag.sub': 'Aria と音声通話の設定を確認します。', 'voice.diag.run': '診断',
      'voice.diag.aria': 'Aria の状態', 'voice.diag.empty': '確認項目がありません。',
      'voice.placement.title': '音声認識の実行先', 'voice.placement.sub': '音声認識（Whisper）を動かすデバイスです。', 'voice.placement.device': 'デバイス'
    },
    en: {
      'voice.title': 'Voice call', 'voice.sub': 'Set up Aria, the voice engine, and the language models used in voice calls.',
      'voice.offNote': 'Voice calls are off. Choose an operating mode above to set up the rest.',
      'voice.errVoiceOff': 'Voice calls are off, so this section is unavailable.',
      'voice.errAriaUnreachable': 'Cannot reach Aria. Check that it is running.',
      'voice.errNotSupported': 'Not supported yet (waiting for Aria)',
      'voice.mode.title': 'Mode', 'voice.mode.sub': 'Choose where Aria runs.',
      'voice.mode.off': 'Off', 'voice.mode.offHint': 'Turns voice calls off.',
      'voice.mode.hosted': 'Run Aria on this PC', 'voice.mode.hostedHint': 'This server starts and supervises Aria.',
      'voice.mode.external': 'External Aria', 'voice.mode.externalHint': 'Connect to an Aria running elsewhere.',
      'voice.mode.winOnly': 'Hosting Aria is Windows only. On other systems, use an external Aria.',
      'voice.ext.baseUrl': 'Aria URL', 'voice.ext.baseUrlHint': 'An address starting with http:// or https://',
      'voice.ext.baseUrlBad': 'Enter a URL starting with http:// or https://.',
      'voice.ext.chatToken': 'Chat token', 'voice.ext.chatTokenHint': 'Token used to connect to Aria. Leave blank to keep the current one.',
      'voice.ext.adminToken': 'Admin token', 'voice.ext.adminTokenHint': 'Token for changing models and settings. Leave blank to keep the current one.',
      'voice.tokenSet': 'set', 'voice.tokenUnset': 'not set',
      'voice.host.title': 'Aria (this PC)', 'voice.host.sub': 'Start and stop Aria on this PC.',
      'voice.host.config': 'Settings', 'voice.host.ariaDir': 'Aria folder', 'voice.host.ariaDirHint': 'The folder where Aria is located',
      'voice.host.pythonPath': 'Python path', 'voice.host.pythonPathHint': 'Leave blank to use the default Python',
      'voice.host.aivisUrl': 'AivisSpeech URL', 'voice.host.aivisUrlHint': 'Where AivisSpeech Engine runs. It is a separate process from Aria.',
      'voice.host.aivisUrlBad': 'Enter a URL starting with http:// or https://.',
      'voice.host.port': 'Port', 'voice.host.portHint': '0 or blank picks a port automatically', 'voice.host.portBad': 'Enter a port number from 0 to 65535.',
      'voice.host.autostart': 'Start Aria with the server', 'voice.host.autostartHint': 'Aria starts when the server starts.',
      'voice.host.env': 'Environment variables', 'voice.host.envHint': 'Extra variables passed to Aria. Values are shown on screen.',
      'voice.host.envKey': 'Name', 'voice.host.envValue': 'Value', 'voice.host.envAdd': 'Add row',
      'voice.host.envBad': 'Names must start with a letter or underscore and use only letters, digits and underscores.',
      'voice.host.check': 'Check status',
      'voice.host.setupTokens': 'Issue connection tokens and set them up',
      'voice.host.setupTokensTitle': 'Issue connection tokens?',
      'voice.host.setupTokensBody': 'Tokens issued before will stop working. Tokens with the same names are overwritten.',
      'voice.host.tokensSet': 'Connection tokens are set up',
      'voice.host.degraded': 'degraded: partly unhealthy (still running)',
      'voice.ok': 'OK', 'voice.ng': 'Needs attention',
      'voice.status.stopped': 'Stopped', 'voice.status.starting': 'Starting', 'voice.status.running': 'Running', 'voice.status.failed': 'Failed',
      'voice.host.info': 'Port {port} · PID {pid} · restarts {restarts}',
      'voice.host.start': 'Start', 'voice.host.stop': 'Stop', 'voice.host.restart': 'Restart',
      'voice.host.logs': 'Log', 'voice.host.logsHint': 'Updates every 2 seconds.', 'voice.host.logsEmpty': 'No log lines yet.',
      'voice.models.title': 'Voice models', 'voice.models.sub': 'Voice models registered with Aria.',
      'voice.models.standard': 'Standard', 'voice.models.fast': 'Fast',
      'voice.models.name': 'Name', 'voice.models.owner': 'Owner', 'voice.models.rights': 'Rights', 'voice.models.state': 'Status',
      'voice.models.builtin': 'Built-in', 'voice.models.ready': 'Ready', 'voice.models.notReady': 'Not ready',
      'voice.models.empty': 'No voice models yet.',
      'voice.models.deleteTitle': 'Delete this voice model?', 'voice.models.deleteBody': 'Delete “{name}”? This cannot be undone.',
      'voice.models.deleted': 'Voice model deleted',
      'voice.llm.title': 'Call language models', 'voice.llm.sub': 'Choose the models for fast and deep responses in calls.',
      'voice.llm.role.fast': 'Fast responses', 'voice.llm.role.deep': 'Deep responses',
      'voice.llm.endpoint': 'Endpoint', 'voice.llm.model': 'Model', 'voice.llm.none': '(none)',
      'voice.llm.empty': 'No endpoints yet. Add one on the Models page.',
      'voice.usage.title': 'Usage', 'voice.usage.sub': 'Call time and turns per user.',
      'voice.usage.days': 'Period', 'voice.usage.d7': 'Last 7 days', 'voice.usage.d30': 'Last 30 days',
      'voice.usage.user': 'User', 'voice.usage.callMinutes': 'Call time (min)', 'voice.usage.turns': 'Turns',
      'voice.usage.replyChars': 'Reply characters', 'voice.usage.dailyLimit': 'Daily limit (min)',
      'voice.usage.defaultLimit': 'Default daily limit (min)', 'voice.usage.unlimited': 'No limit',
      'voice.usage.quotaHint': 'A whole number from 0 to 1440. Blank means no limit.',
      'voice.usage.quotaBad': 'Enter a whole number from 0 to 1440.',
      'voice.usage.noTokens': 'Token counts are not available, so they are not shown.',
      'voice.usage.empty': 'No users.',
      'voice.diag.title': 'Diagnostics', 'voice.diag.sub': 'Check Aria and the voice call setup.', 'voice.diag.run': 'Run diagnostics',
      'voice.diag.aria': 'Aria state', 'voice.diag.empty': 'No checks to show.',
      'voice.placement.title': 'Speech recognition device', 'voice.placement.sub': 'The device that runs speech recognition (Whisper).', 'voice.placement.device': 'Device'
    }
  });

  var LOG_TICK_MS = 2000;
  var ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var HTTP_URL_RE = /^https?:\/\/\S+$/i;

  function voice(method, path, body) {
    var args = { method: method, path: path };
    if (body !== undefined) args.body = body;
    return OC.invoke('voice_admin', args);
  }
  function errText(e) {
    var m = String((e && e.message) || e || '');
    if (m.indexOf('voice_off') >= 0) return t('voice.errVoiceOff');
    if (m.indexOf('aria_unreachable') >= 0) return t('voice.errAriaUnreachable');
    if (m.indexOf('not_supported_yet') >= 0 || /\b501\b/.test(m)) return t('voice.errNotSupported');
    return m;
  }
  function note(box, e) {
    OC.clear(box);
    box.appendChild(h('p', { cls: 'alert warn', attrs: { role: 'status' }, text: errText(e) }));
  }
  function loading(box) {
    OC.clear(box);
    box.appendChild(h('div', { cls: 'stack' }, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })]));
  }
  function ariaKey(r) {
    return JSON.stringify([r && r.supported, r && r.status, r && r.port, r && r.pid, r && r.restarts, r && r.error, r && r.health]);
  }
  // status chip (+ degraded chip when Aria reports health 'degraded')
  function ariaChips(a) {
    var st = (a && a.status) || 'stopped';
    var kind = st === 'running' ? 'ok' : st === 'failed' ? 'err' : st === 'starting' ? 'warn' : '';
    var out = [OC.chip(kind, t('voice.status.' + st))];
    if (a && a.health === 'degraded') out.push(OC.chip('warn', t('voice.host.degraded')));
    return out;
  }
  // '' or a whole number 0..1440 (blank = null). ok=false when invalid.
  function quotaParse(s) {
    var x = String(s == null ? '' : s).trim();
    if (x === '') return { ok: true, value: null };
    if (!/^\d+$/.test(x) || Number(x) > 1440) return { ok: false, value: null };
    return { ok: true, value: Number(x) };
  }
  function quotaText(v) { return v == null ? '' : String(v); }
  function fmtNum(n) { return n == null ? '-' : String(Math.round(Number(n) * 10) / 10); }
  // Layout goes through CSSOM properties: the page CSP forbids style attributes.
  function css(el, props) {
    Object.keys(props).forEach(function (k) { el.style[k] = props[k]; });
    return el;
  }
  function table(headers, rows) {
    var head = h('tr', null, headers.map(function (x) {
      return css(h('th', { cls: 'small muted', text: x }), { padding: '4px 6px', textAlign: 'left', fontWeight: '600' });
    }));
    var tbl = css(h('table', null, [h('thead', null, [head]), h('tbody', null, rows)]), { width: '100%', borderCollapse: 'collapse' });
    return css(h('div', null, [tbl]), { overflowX: 'auto' });
  }
  function tr(cells) {
    return h('tr', null, cells.map(function (c) {
      return css(h('td', null, [c]), { padding: '8px 6px', textAlign: 'left', verticalAlign: 'middle', borderTop: '1px solid var(--line)' });
    }));
  }

  OC.registerPage({ id: 'voice', order: 85, icon: 'voice', titleKey: 'nav.voice', render: render });

  function render(root) {
    root.classList.add('p-voice');
    var alive = true;
    var gen = 0;            // bumped whenever the mode-dependent sections are rebuilt; stale loads check it
    var cfg = null;         // GET config
    var aria = null;        // last aria_get / aria_* result, null when unavailable
    var ariaErr = null;
    var lastKey = '';
    var hostBusy = false;
    var selMode = 'off';    // the radio currently chosen
    var logTimer = null, logBusy = false, lastLogs = null;
    var usageSeq = 0;       // newest usage request wins
    var diagAuto = false;   // diagnostics run once automatically when the page opens in a non-off mode

    // ---------- section 1: mode ----------
    var modeBox = h('div', { cls: 'stack' });
    var modeCard = OC.card(t('voice.mode.title'), [modeBox], t('voice.mode.sub'));

    function buildMode() {
      OC.clear(modeBox);
      var sup = !(aria && aria.supported === false);
      var opts = [
        ['off', t('voice.mode.off'), t('voice.mode.offHint'), false],
        ['hosted', t('voice.mode.hosted'), t('voice.mode.hostedHint'), !sup],
        ['external', t('voice.mode.external'), t('voice.mode.externalHint'), false]
      ];
      var group = h('div', { cls: 'stack', attrs: { role: 'radiogroup', 'aria-label': t('voice.mode.title') } });
      opts.forEach(function (o) {
        var inp = h('input', { attrs: { type: 'radio', name: 'voice-mode', value: o[0] }, checked: selMode === o[0] });
        inp.disabled = o[3];
        inp.addEventListener('change', function () { pick(o[0]); });
        group.appendChild(h('label', { cls: 'list-item' }, [inp, h('span', { cls: 'stack' }, [h('strong', { text: o[1] }), h('span', { cls: 'hint', text: o[2] })])]));
      });
      modeBox.appendChild(group);
      if (!sup) modeBox.appendChild(h('p', { cls: 'alert warn', text: t('voice.mode.winOnly') }));
      modeBox.appendChild(buildExt());
    }

    function pick(v) {
      selMode = v;
      if (v === 'external') { showExt(); return; }
      saveConfig({ mode: v, baseUrl: (cfg && cfg.baseUrl) || '' });
    }

    var extBox = h('div', { cls: 'stack' });
    function showExt() { extBox.hidden = selMode !== 'external'; }

    function buildExt() {
      extBox.hidden = selMode !== 'external';
      var urlIn = h('input', { attrs: { type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'http://', id: 'voice-ext-url' }, value: (cfg && cfg.baseUrl) || '' });
      var chatIn = h('input', { attrs: { type: 'password', autocomplete: 'new-password', spellcheck: 'false', id: 'voice-ext-chat' } });
      var adminIn = h('input', { attrs: { type: 'password', autocomplete: 'new-password', spellcheck: 'false', id: 'voice-ext-admin' } });
      var err = h('p', { cls: 'alert', attrs: { role: 'alert' } });
      err.hidden = true;
      var saveBtn = OC.btn(t('common.save'), 'primary', function () {
        var url = urlIn.value.trim();
        if (!HTTP_URL_RE.test(url)) { err.textContent = t('voice.ext.baseUrlBad'); err.hidden = false; return; }
        err.hidden = true;
        var body = { mode: 'external', baseUrl: url };
        if (chatIn.value) body.chatToken = chatIn.value;
        if (adminIn.value) body.adminToken = adminIn.value;
        saveBtn.disabled = true;
        voice('PUT', '/local-admin/voice/config', body).then(function () {
          if (!alive) return;
          OC.toast(t('common.saved'));
          return loadConfig();
        }, function (e) {
          if (!alive) return;
          err.textContent = errText(e); err.hidden = false;
        }).then(function () { saveBtn.disabled = false; });
      });
      function tokenField(input, label, hint, isSet) {
        return h('div', { cls: 'field' }, [
          h('label', { text: label, attrs: { 'for': input.id } }),
          input,
          h('div', { cls: 'row' }, [OC.chip(isSet ? 'ok' : 'plain', isSet ? t('voice.tokenSet') : t('voice.tokenUnset'))]),
          h('p', { cls: 'hint', text: hint })
        ]);
      }
      OC.clear(extBox);
      extBox.appendChild(OC.field(t('voice.ext.baseUrl'), urlIn, t('voice.ext.baseUrlHint')));
      extBox.appendChild(tokenField(chatIn, t('voice.ext.chatToken'), t('voice.ext.chatTokenHint'), !!(cfg && cfg.chatTokenSet)));
      extBox.appendChild(tokenField(adminIn, t('voice.ext.adminToken'), t('voice.ext.adminTokenHint'), !!(cfg && cfg.adminTokenSet)));
      extBox.appendChild(err);
      extBox.appendChild(h('div', { cls: 'row' }, [saveBtn]));
      extBox.hidden = selMode !== 'external';
      return extBox;
    }

    function saveConfig(body) {
      voice('PUT', '/local-admin/voice/config', body).then(function () {
        if (!alive) return;
        OC.toast(t('common.saved'));
        return loadConfig();
      }, function (e) {
        if (!alive) return;
        OC.toast(errText(e), 'err');
        return loadConfig();
      });
    }

    function loadConfig() {
      return voice('GET', '/local-admin/voice/config').then(function (c) {
        if (!alive) return;
        cfg = c || {};
        selMode = cfg.mode || 'off';
        buildMode();
        applyMode();
      }, function (e) {
        if (!alive) return;
        OC.clear(modeBox);
        modeBox.appendChild(h('p', { cls: 'alert', attrs: { role: 'alert' }, text: errText(e) }));
      });
    }

    // ---------- section 2: Aria host (hosted mode only) ----------
    var hostStatus = h('div', { cls: 'stack' });
    var hostBtns = h('div', { cls: 'row' });
    var formBox = h('div', { cls: 'stack' });
    var checkBox = h('div', { cls: 'stack' });
    var logPre = h('pre', { cls: 'mono', attrs: { 'aria-label': t('voice.host.logs') } });
    logPre.style.maxHeight = '320px';
    logPre.style.overflow = 'auto';
    logPre.style.whiteSpace = 'pre-wrap';
    var checkBtn = OC.btn(t('voice.host.check'), 'sm', runCheck, 'restart');
    var setupBtn = OC.btn(t('voice.host.setupTokens'), 'sm', setupTokens, 'copy');
    var hostCard = OC.card(t('voice.host.title'), [
      hostStatus,
      hostBtns,
      h('h3', { text: t('voice.host.config') }),
      formBox,
      h('div', { cls: 'row' }, [checkBtn, setupBtn]),
      checkBox,
      h('h3', { text: t('voice.host.logs') }),
      h('p', { cls: 'hint', text: t('voice.host.logsHint') }),
      logPre
    ], t('voice.host.sub'));
    hostCard.hidden = true;

    function setAria(r) {
      aria = r || null;
      ariaErr = null;
      lastKey = ariaKey(aria);
      renderHost();
    }

    function renderHost() {
      OC.clear(hostStatus);
      OC.clear(hostBtns);
      if (!aria) {
        hostStatus.appendChild(h('p', { cls: 'alert warn', attrs: { role: 'status' }, text: ariaErr ? errText(ariaErr) : t('common.loading') }));
      }
      var sup = !!(aria && aria.supported);
      if (aria && !aria.supported) hostStatus.appendChild(h('p', { cls: 'alert warn', text: t('voice.mode.winOnly') }));
      var st = (aria && aria.status) || 'stopped';
      if (aria) {
        hostStatus.appendChild(h('div', { cls: 'row' }, ariaChips(aria).concat([
          h('span', { cls: 'small muted', text: t('voice.host.info', { port: aria.port || '-', pid: aria.pid || '-', restarts: aria.restarts || 0 }) })
        ])));
        if (aria.error) hostStatus.appendChild(h('p', { cls: 'alert', attrs: { role: 'alert' }, text: String(aria.error) }));
      }
      var canStart = sup && !hostBusy && (st === 'stopped' || st === 'failed');
      var canStop = sup && !hostBusy && (st === 'running' || st === 'starting');
      var canRestart = sup && !hostBusy && st === 'running';
      hostBtns.appendChild(OC.btn(t('voice.host.start'), 'sm primary', function () { ariaAction('aria_start'); }, 'play')).disabled = !canStart;
      hostBtns.appendChild(OC.btn(t('voice.host.stop'), 'sm danger', function () { ariaAction('aria_stop'); }, 'stop')).disabled = !canStop;
      hostBtns.appendChild(OC.btn(t('voice.host.restart'), 'sm', function () { ariaAction('aria_restart'); }, 'restart')).disabled = !canRestart;
      checkBtn.disabled = !sup || hostBusy;
      setupBtn.disabled = !sup;
    }

    function ariaAction(cmd) {
      if (hostBusy) return;
      hostBusy = true;
      renderHost();
      OC.invoke(cmd).then(function (r) {
        if (alive) setAria(r);
      }, function (e) {
        if (alive) OC.toast(errText(e), 'err');
      }).then(function () {
        hostBusy = false;
        if (alive) renderHost();
      });
    }

    function fillForm(c) {
      c = c || {};
      OC.clear(formBox);
      var dirIn = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', id: 'voice-aria-dir' }, value: c.ariaDir || '' });
      var pyIn = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', id: 'voice-aria-py' }, value: c.pythonPath || '' });
      var aivisIn = h('input', { attrs: { type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'http://127.0.0.1:10101', id: 'voice-aria-aivis' }, value: c.aivisUrl || '' });
      var portIn = h('input', { attrs: { type: 'number', min: '0', max: '65535', step: '1', inputmode: 'numeric', id: 'voice-aria-port' }, value: c.port ? String(c.port) : '' });
      var autoRow = OC.switchRow(t('voice.host.autostart'), t('voice.host.autostartHint'), !!c.autostart, function () { /* read on save */ });
      var autoIn = autoRow.querySelector('input');
      var envRows = [];
      var envBox = h('div', { cls: 'stack' });
      function addEnv(k, v) {
        var kIn = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: t('voice.host.envKey'), 'aria-label': t('voice.host.envKey') }, value: k || '' });
        var vIn = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: t('voice.host.envValue'), 'aria-label': t('voice.host.envValue') }, value: v || '' });
        var rec = { k: kIn, v: vIn };
        var item = h('div', { cls: 'list-item' }, [
          h('div', { cls: 'grow stack' }, [kIn, vIn]),
          OC.btn(t('common.delete'), 'sm danger', function () {
            var idx = envRows.indexOf(rec);
            if (idx >= 0) envRows.splice(idx, 1);
            if (item.parentNode) item.parentNode.removeChild(item);
          })
        ]);
        envRows.push(rec);
        envBox.appendChild(item);
      }
      var formErr = h('p', { cls: 'alert', attrs: { role: 'alert' } });
      formErr.hidden = true;
      function showErr(msg) { formErr.textContent = msg; formErr.hidden = false; }
      var saveBtn = OC.btn(t('common.save'), 'primary', function () {
        formErr.hidden = true;
        var port = portIn.value.trim() === '' ? 0 : Number(portIn.value);
        if (!(Math.floor(port) === port && port >= 0 && port <= 65535)) { showErr(t('voice.host.portBad')); return; }
        var aivis = aivisIn.value.trim();
        if (aivis && !HTTP_URL_RE.test(aivis)) { showErr(t('voice.host.aivisUrlBad')); return; }
        var env = [];
        for (var i = 0; i < envRows.length; i++) {
          var key = envRows[i].k.value.trim();
          if (!key && !envRows[i].v.value) continue;
          if (!ENV_KEY_RE.test(key)) { showErr(t('voice.host.envBad')); return; }
          env.push({ key: key, value: envRows[i].v.value });
        }
        var config = {
          ariaDir: dirIn.value.trim(), pythonPath: pyIn.value.trim(), aivisUrl: aivis,
          port: port, autostart: !!autoIn.checked, env: env
        };
        saveBtn.disabled = true;
        OC.invoke('aria_set_config', { config: config }).then(function (r) {
          if (!alive) return;
          setAria(r);
          fillForm(r && r.config);
          OC.toast(t('common.saved'));
        }, function (e) {
          if (alive) showErr(errText(e));
        }).then(function () { saveBtn.disabled = false; });
      });
      (c.env || []).forEach(function (kv) { addEnv(kv.key, kv.value); });
      formBox.appendChild(OC.field(t('voice.host.ariaDir'), dirIn, t('voice.host.ariaDirHint'), 'voice-aria-dir'));
      formBox.appendChild(OC.field(t('voice.host.pythonPath'), pyIn, t('voice.host.pythonPathHint'), 'voice-aria-py'));
      formBox.appendChild(OC.field(t('voice.host.aivisUrl'), aivisIn, t('voice.host.aivisUrlHint'), 'voice-aria-aivis'));
      formBox.appendChild(OC.field(t('voice.host.port'), portIn, t('voice.host.portHint'), 'voice-aria-port'));
      formBox.appendChild(autoRow);
      formBox.appendChild(OC.field(t('voice.host.env'), envBox, t('voice.host.envHint')));
      formBox.appendChild(h('div', { cls: 'row' }, [OC.btn(t('voice.host.envAdd'), 'sm', function () { addEnv('', ''); }, 'plugin'), saveBtn]));
      formBox.appendChild(formErr);
    }

    function runCheck() {
      checkBtn.disabled = true;
      OC.clear(checkBox);
      checkBox.appendChild(h('p', { cls: 'hint', text: t('common.loading') }));
      OC.invoke('aria_check').then(function (items) {
        if (!alive) return;
        OC.clear(checkBox);
        (items || []).forEach(function (it) {
          checkBox.appendChild(h('div', { cls: 'row' }, [
            OC.chip(it.ok ? 'ok' : 'err', it.ok ? t('voice.ok') : t('voice.ng')),
            h('span', { text: String(it.message || '') })
          ]));
        });
      }, function (e) {
        if (!alive) return;
        OC.clear(checkBox);
        checkBox.appendChild(h('p', { cls: 'alert', attrs: { role: 'alert' }, text: errText(e) }));
      }).then(function () { checkBtn.disabled = !(aria && aria.supported) || hostBusy; });
    }

    // Issues connection tokens on the Aria side and stores them. Tokens are never shown on screen.
    function setupTokens() {
      OC.confirm(t('voice.host.setupTokensTitle'), t('voice.host.setupTokensBody'), t('voice.host.setupTokens'), true).then(function (ok) {
        if (!ok || !alive) return;
        setupBtn.disabled = true;
        OC.invoke('aria_setup_tokens').then(function () {
          if (alive) OC.toast(t('voice.host.tokensSet'));
        }, function (e) {
          if (alive) OC.toast(errText(e), 'err');
        }).then(function () { setupBtn.disabled = !(aria && aria.supported); });
      });
    }

    function renderLogs(lines) {
      var text = (lines && lines.length) ? lines.join('\n') : t('voice.host.logsEmpty');
      if (text === lastLogs) return;
      lastLogs = text;
      var atBottom = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 8;
      logPre.textContent = text;
      if (atBottom) logPre.scrollTop = logPre.scrollHeight;
    }

    function tick() {
      if (!alive || logBusy) return;
      logBusy = true;
      Promise.all([
        OC.invoke('aria_logs', { tail: 200 }).catch(function () { return null; }),
        OC.invoke('aria_get').catch(function () { return null; })
      ]).then(function (r) {
        logBusy = false;
        if (!alive) return;
        if (r[0]) renderLogs(r[0]);
        if (r[1] && !hostBusy && ariaKey(r[1]) !== lastKey) setAria(r[1]);
      });
    }
    function startTimer() { if (logTimer || !alive) return; logTimer = setInterval(tick, LOG_TICK_MS); tick(); }
    function stopTimer() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

    // ---------- sections 3-7: only when mode !== off ----------
    var restBox = h('div', { cls: 'stack' });

    function applyMode() {
      var m = cfg ? cfg.mode : 'off';
      hostCard.hidden = m !== 'hosted';
      if (m === 'hosted') {
        renderHost();
        if (aria && aria.supported) startTimer(); else stopTimer();
      } else {
        stopTimer();
      }
      buildRest(m);
    }

    function section(title, sub) {
      var body = h('div', { cls: 'stack' });
      return { card: OC.card(title, [body], sub), body: body };
    }

    function buildRest(m) {
      gen++;
      OC.clear(restBox);
      if (m === 'off') {
        restBox.appendChild(OC.card(null, [h('p', { cls: 'hint', text: t('voice.offNote') })]));
        return;
      }
      var diag = section(t('voice.diag.title'), t('voice.diag.sub'));
      var models = section(t('voice.models.title'), t('voice.models.sub'));
      var llm = section(t('voice.llm.title'), t('voice.llm.sub'));
      var usage = section(t('voice.usage.title'), t('voice.usage.sub'));
      var place = section(t('voice.placement.title'), t('voice.placement.sub'));
      [diag, models, llm, usage, place].forEach(function (s) { restBox.appendChild(s.card); });
      var runDiag = buildDiag(diag.body);
      loadModels(models.body);
      loadLlm(llm.body);
      loadUsageSection(usage.body);
      loadPlacement(place.body);
      if (!diagAuto) { diagAuto = true; runDiag(); }
    }

    // Runs `draw(r)` into `body` when the request succeeds; shows a gentle note on failure. Stale results are dropped.
    function fill(body, p, draw) {
      var my = gen;
      loading(body);
      p.then(function (r) {
        if (!alive || my !== gen) return;
        OC.clear(body);
        try { draw(r); } catch (e) { note(body, e); }
      }, function (e) {
        if (!alive || my !== gen) return;
        note(body, e);
      });
    }

    // ---------- diagnostics (on demand, plus once when the page opens in a non-off mode) ----------
    function buildDiag(body) {
      var out = h('div', { cls: 'stack' });
      var btn = OC.btn(t('voice.diag.run'), 'sm primary', run);
      body.appendChild(h('div', { cls: 'row' }, [btn]));
      body.appendChild(out);
      function run() {
        btn.disabled = true;
        loading(out);
        Promise.all([
          voice('GET', '/local-admin/voice/diagnose'),
          OC.invoke('aria_get').catch(function () { return null; })
        ]).then(function (r) {
          if (!alive) return;
          OC.clear(out);
          var a = r[1];
          if (a && !hostBusy && ariaKey(a) !== lastKey) setAria(a);
          out.appendChild(h('div', { cls: 'row' }, [h('span', { cls: 'small muted', text: t('voice.diag.aria') })]
            .concat(a ? ariaChips(a) : [h('span', { cls: 'small muted', text: '-' })])));
          var items = Array.isArray(r[0]) ? r[0] : [];
          if (!items.length) { out.appendChild(OC.empty(null, t('voice.diag.empty'))); return; }
          var list = h('div', { cls: 'list' });
          items.forEach(function (it) {
            list.appendChild(h('div', { cls: 'list-item' }, [
              OC.chip(it.ok ? 'ok' : 'err', it.ok ? t('voice.ok') : t('voice.ng')),
              h('div', { cls: 'grow stack' }, [
                h('span', { text: String(it.message || '') }),
                it.hint ? h('span', { cls: 'hint', text: String(it.hint) }) : null
              ])
            ]));
          });
          out.appendChild(list);
        }, function (e) {
          if (!alive) return;
          note(out, e);
        }).then(function () { btn.disabled = false; });
      }
      return run;
    }

    // ---------- voice models: standard (aivmx) and fast (piper) ----------
    function loadModels(body) {
      fill(body, voice('GET', '/local-admin/voice/models'), function (r) {
        var list = Array.isArray(r) ? r : (r && Array.isArray(r.models) ? r.models : []);
        var std = list.filter(function (m) { return m.kind !== 'piper'; });
        var fast = list.filter(function (m) { return m.kind === 'piper'; });
        body.appendChild(modelGroup(t('voice.models.standard'), std, body));
        body.appendChild(modelGroup(t('voice.models.fast'), fast, body));
      });
    }

    function modelGroup(title, list, body) {
      var wrap = h('div', { cls: 'stack' }, [h('strong', { text: title })]);
      if (!list.length) { wrap.appendChild(h('p', { cls: 'hint', text: t('voice.models.empty') })); return wrap; }
      var rows = list.map(function (m) {
        var rights = Array.isArray(m.rights) ? m.rights.join(', ') : String(m.rights || '');
        var state = [];
        if (m.builtin) state.push(OC.chip('', t('voice.models.builtin'), true));
        if (m.kind === 'piper' && typeof m.ready === 'boolean') {
          state.push(OC.chip(m.ready ? 'ok' : 'warn', m.ready ? t('voice.models.ready') : t('voice.models.notReady')));
        }
        var action = m.builtin ? null : OC.btn(t('common.delete'), 'sm danger', function () { deleteModel(m, body); });
        return tr([
          String(m.name || m.uuid || ''),
          String(m.ownerName || m.ownerUserId || '-'),
          rights || '-',
          h('div', { cls: 'row' }, state),
          action
        ]);
      });
      wrap.appendChild(table([t('voice.models.name'), t('voice.models.owner'), t('voice.models.rights'), t('voice.models.state'), ''], rows));
      return wrap;
    }

    function deleteModel(m, body) {
      OC.confirm(t('voice.models.deleteTitle'), t('voice.models.deleteBody', { name: m.name || m.uuid }), t('common.delete'), true).then(function (ok) {
        if (!ok || !alive) return;
        voice('DELETE', '/local-admin/voice/models/' + encodeURIComponent(String(m.uuid))).then(function () {
          if (!alive) return;
          OC.toast(t('voice.models.deleted'));
          loadModels(body);
        }, function (e) {
          if (alive) OC.toast(errText(e), 'err');
        });
      });
    }

    // ---------- call LLM roles: fast and deep (endpoint + model) ----------
    function loadLlm(body) {
      fill(body, voice('GET', '/local-admin/voice/llm'), function (r) { drawLlm(body, r || {}); });
    }

    function drawLlm(body, r) {
      var eps = r.endpoints || [];
      var roles = r.roles || {};
      if (!eps.length) { body.appendChild(OC.empty(null, t('voice.llm.empty'))); return; }
      function epById(id) { for (var i = 0; i < eps.length; i++) if (eps[i].id === id) return eps[i]; return null; }

      ['fast', 'deep'].forEach(function (role) {
        var cur = roles[role] || {};
        var epOpts = [h('option', { attrs: { value: '' }, text: t('voice.llm.none') })].concat(eps.map(function (ep) {
          return h('option', { attrs: { value: ep.id }, text: ep.name || ep.id });
        }));
        var epSel = h('select', { attrs: { 'aria-label': t('voice.llm.role.' + role) + ' ' + t('voice.llm.endpoint') } }, epOpts);
        var mdSel = h('select', { attrs: { 'aria-label': t('voice.llm.role.' + role) + ' ' + t('voice.llm.model') } });
        function fillModels(epId, want) {
          OC.clear(mdSel);
          var ep = epById(epId);
          var models = (ep && ep.models) || [];
          if (!models.length) mdSel.appendChild(h('option', { attrs: { value: '' }, text: t('voice.llm.none') }));
          models.forEach(function (m) { mdSel.appendChild(h('option', { attrs: { value: m }, text: m })); });
          mdSel.value = models.indexOf(want) >= 0 ? want : (models[0] || '');
        }
        epSel.value = cur.endpoint || '';
        fillModels(epSel.value, cur.model);
        function save() {
          voice('PUT', '/local-admin/voice/llm/roles', { role: role, endpoint: epSel.value, model: mdSel.value }).then(function () {
            if (alive) OC.toast(t('common.saved'));
          }, function (e) {
            if (!alive) return;
            OC.toast(errText(e), 'err');
            loadLlm(body);
          });
        }
        epSel.addEventListener('change', function () { fillModels(epSel.value, ''); save(); });
        mdSel.addEventListener('change', save);
        body.appendChild(h('div', { cls: 'stack' }, [
          h('strong', { text: t('voice.llm.role.' + role) }),
          h('div', { cls: 'row' }, [OC.field(t('voice.llm.endpoint'), epSel), OC.field(t('voice.llm.model'), mdSel)])
        ]));
      });
    }

    // ---------- usage: call minutes, turns, reply chars, daily limits ----------
    function loadUsageSection(body) {
      var daysSel = h('select', { attrs: { id: 'voice-usage-days' } }, [
        h('option', { attrs: { value: '7' }, text: t('voice.usage.d7') }),
        h('option', { attrs: { value: '30' }, text: t('voice.usage.d30') })
      ]);
      var box = h('div', { cls: 'stack' });
      daysSel.addEventListener('change', function () { loadUsage(box, Number(daysSel.value)); });
      body.appendChild(OC.field(t('voice.usage.days'), daysSel, null, 'voice-usage-days'));
      body.appendChild(box);
      loadUsage(box, 7);
    }

    function loadUsage(box, days) {
      var my = ++usageSeq;
      loading(box);
      voice('GET', '/local-admin/voice/usage?days=' + days).then(function (r) {
        if (!alive || my !== usageSeq) return;
        OC.clear(box);
        try { drawUsage(box, r || {}); } catch (e) { note(box, e); }
      }, function (e) {
        if (!alive || my !== usageSeq) return;
        note(box, e);
      });
    }

    function drawUsage(box, r) {
      var users = Array.isArray(r.users) ? r.users : [];
      var defLast = r.defaultDailyMinutes == null ? null : r.defaultDailyMinutes;
      var userInputs = [];
      function placeholderFor(v) { return v == null ? t('voice.usage.unlimited') : String(v); }

      var defIn = h('input', {
        attrs: { type: 'number', min: '0', max: '1440', step: '1', inputmode: 'numeric', id: 'voice-quota-default', placeholder: t('voice.usage.unlimited') },
        value: quotaText(defLast)
      });
      defIn.addEventListener('change', function () {
        var p = quotaParse(defIn.value);
        if (!p.ok) { OC.toast(t('voice.usage.quotaBad'), 'err'); defIn.value = quotaText(defLast); return; }
        defIn.disabled = true;
        voice('PUT', '/local-admin/voice/quota', { dailyMinutes: p.value }).then(function () {
          if (!alive) return;
          defLast = p.value;
          userInputs.forEach(function (ui) { ui.placeholder = placeholderFor(p.value); });
          OC.toast(t('common.saved'));
        }, function (e) {
          if (!alive) return;
          OC.toast(errText(e), 'err');
          defIn.value = quotaText(defLast);
        }).then(function () { defIn.disabled = false; });
      });
      box.appendChild(OC.field(t('voice.usage.defaultLimit'), defIn, t('voice.usage.quotaHint'), 'voice-quota-default'));

      if (!users.length) { box.appendChild(OC.empty(null, t('voice.usage.empty'))); return; }
      var rows = users.map(function (u) {
        var name = u.username || String(u.id);
        var last = u.dailyMinutes == null ? null : u.dailyMinutes;
        var qIn = h('input', {
          attrs: { type: 'number', min: '0', max: '1440', step: '1', inputmode: 'numeric', 'aria-label': t('voice.usage.dailyLimit') + ' ' + name, placeholder: placeholderFor(defLast) },
          value: quotaText(last)
        });
        userInputs.push(qIn);
        qIn.addEventListener('change', function () {
          var p = quotaParse(qIn.value);
          if (!p.ok) { OC.toast(t('voice.usage.quotaBad'), 'err'); qIn.value = quotaText(last); return; }
          qIn.disabled = true;
          voice('PUT', '/local-admin/voice/quota', { userId: u.id, dailyMinutes: p.value }).then(function () {
            if (!alive) return;
            last = p.value;
            OC.toast(t('common.saved'));
          }, function (e) {
            if (!alive) return;
            OC.toast(errText(e), 'err');
            qIn.value = quotaText(last);
          }).then(function () { qIn.disabled = false; });
        });
        return tr([name, fmtNum(u.callMinutes), fmtNum(u.turns), fmtNum(u.replyChars), qIn]);
      });
      box.appendChild(table([t('voice.usage.user'), t('voice.usage.callMinutes'), t('voice.usage.turns'), t('voice.usage.replyChars'), t('voice.usage.dailyLimit')], rows));
      box.appendChild(h('p', { cls: 'hint', text: t('voice.usage.noTokens') }));
    }

    function loadPlacement(body) {
      fill(body, voice('GET', '/local-admin/voice/placement'), function (r) {
        var stt = (r && r.stt) || {};
        var opts = (stt.options || []).map(String);
        if (stt.device && opts.indexOf(stt.device) < 0) opts.push(stt.device);
        var sel = h('select', { attrs: { id: 'voice-stt-device' } }, opts.map(function (o) { return h('option', { attrs: { value: o }, text: o }); }));
        sel.value = stt.device || '';
        var last = sel.value;
        sel.addEventListener('change', function () {
          sel.disabled = true;
          voice('PUT', '/local-admin/voice/placement/stt', { device: sel.value }).then(function () {
            last = sel.value;
            if (alive) OC.toast(t('common.saved'));
          }, function (e) {
            if (!alive) return;
            OC.toast(errText(e), 'err');
            sel.value = last;
          }).then(function () { sel.disabled = false; });
        });
        body.appendChild(OC.field(t('voice.placement.device'), sel, null, 'voice-stt-device'));
      });
    }

    // ---------- page assembly and first load ----------
    root.appendChild(OC.pageHeader(t('voice.title'), t('voice.sub')));
    root.appendChild(h('div', { cls: 'stack' }, [modeCard, hostCard, restBox]));
    modeBox.appendChild(h('div', { cls: 'skeleton' }));

    OC.invoke('aria_get').then(function (r) { aria = r; ariaErr = null; }, function (e) { aria = null; ariaErr = e; })
      .then(function () {
        if (!alive) return;
        lastKey = ariaKey(aria);
        fillForm(aria && aria.config);
        renderHost();
        return loadConfig();
      });

    return {
      destroy: function () { alive = false; stopTimer(); }
    };
  }
})();
