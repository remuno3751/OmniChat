// OmniChat launcher: plain JS, no framework. Talks to Rust commands via window.__TAURI__.
(function () {
  'use strict';

  var T = {
    ja: {
      lead: 'OmniChat サーバーの URL を入力してください。',
      lbl: 'サーバー URL',
      hint: '例: http://192.168.1.10:8787 / https://name.tailnet.ts.net',
      go: '接続',
      checking: 'サーバーを確認しています…',
      connecting: '接続中: ',
      retrying: 'サーバーに再接続しています…',
      retry: '再試行',
      change: 'サーバーを変更',
      cancel: 'サーバーを変更',
      okv: 'サーバーが見つかりました (バージョン ',
      e_invalid_url: ['URL が正しくありません', 'http:// または https:// で始まる URL を入力してください。'],
      e_unreachable: ['サーバーに接続できません', 'サーバーが起動しているか、同じネットワーク/Tailscale に接続しているか、URL とポートを確認してください。'],
      e_tls: ['証明書(HTTPS)の検証に失敗しました', '証明書が期限切れ、自己署名、または名前が一致しません。信頼された証明書(Tailscale serve 等)を使うか、OS に CA を登録してください。'],
      e_wrong_server: ['OmniChat サーバーではありません', 'この URL は /version に OmniChat サーバーとして応答しませんでした。ポート番号や URL を確認してください。'],
      e_mixed_content: ['HTTPS から HTTP へリダイレクトされました', '安全でない接続に切り替わるため接続を中止しました。サーバー側の HTTPS/リバースプロキシ設定を確認してください。'],
      e_http: ['サーバーがエラーを返しました', 'ステータス: '],
      e_stuck: ['サーバーは見つかりましたが、画面を開けませんでした', 'macOS / Windows のセキュリティ設定や、HTTP(暗号化なし)の接続が原因のことがあります。アプリを再起動して「再試行」するか、サーバー側で HTTPS(Tailscale serve など)を使ってください。'],
      e_tauri: ['アプリ内部エラー', 'デスクトップアプリとして起動していません。']
    },
    en: {
      lead: 'Enter the URL of your OmniChat server.',
      lbl: 'Server URL',
      hint: 'e.g. http://192.168.1.10:8787 or https://name.tailnet.ts.net',
      go: 'Connect',
      checking: 'Checking server…',
      connecting: 'Connecting to ',
      retrying: 'Reconnecting to the server…',
      retry: 'Retry',
      change: 'Change server',
      cancel: 'Change server',
      okv: 'Server found (version ',
      e_invalid_url: ['Invalid URL', 'Enter a URL starting with http:// or https://.'],
      e_unreachable: ['Cannot reach the server', 'Check that the server is running, that you are on the same network / Tailscale, and that the URL and port are right.'],
      e_tls: ['HTTPS certificate check failed', 'The certificate is expired, self-signed or does not match the name. Use a trusted certificate (e.g. Tailscale serve) or install your CA in the OS.'],
      e_wrong_server: ['Not an OmniChat server', 'This URL did not answer /version as an OmniChat server. Check the URL and port.'],
      e_mixed_content: ['Redirected from HTTPS to HTTP', 'Connection aborted to avoid an insecure downgrade. Check the HTTPS / reverse proxy settings of the server.'],
      e_http: ['The server returned an error', 'Status: '],
      e_stuck: ['Server found, but its page did not open', 'macOS / Windows security settings or a plain HTTP connection may be the cause. Restart the app and retry, or serve the server over HTTPS (e.g. Tailscale serve).'],
      e_tauri: ['Internal error', 'Not running as the desktop app.']
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var lang = 'en';
  try { lang = localStorage.getItem('lang') || ((navigator.language || '').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en'); } catch (e) { /* storage unavailable */ }
  var params = new URLSearchParams(location.search);
  var retryMode = params.get('retry') === '1';
  var changeMode = params.get('change') === '1';
  var retryUrl = params.get('url') || '';
  var busy = false;
  var autoTimer = 0;

  function invoke(cmd, args) {
    var g = window.__TAURI__;
    if (!g || !g.core) return Promise.reject({ code: 'tauri', detail: '' });
    return g.core.invoke(cmd, args);
  }

  function apply() {
    var t = T[lang];
    document.documentElement.lang = lang;
    $('lead').textContent = t.lead;
    $('lbl').textContent = t.lbl;
    $('hint').textContent = t.hint;
    $('go').textContent = t.go;
    $('retry').textContent = t.retry;
    $('change').textContent = t.change;
  }

  function setBusy(b) {
    busy = b;
    $('go').disabled = b;
    $('retry').disabled = b;
  }

  function showStatus(text) {
    $('error').hidden = true;
    var s = $('status');
    s.textContent = text || '';
    s.hidden = !text;
  }

  function showError(e) {
    var t = T[lang];
    var code = (e && e.code) || 'unreachable';
    var key = code.indexOf('http_') === 0 ? 'e_http' : 'e_' + code;
    var pair = t[key] || t.e_unreachable;
    var body = pair[1] + (key === 'e_http' ? code.slice(5) : '');
    $('status').hidden = true;
    $('err-title').textContent = pair[0];
    $('err-body').textContent = body;
    $('error').hidden = false;
  }

  function connect(url) {
    if (busy) return Promise.resolve();
    clearTimeout(autoTimer);
    setBusy(true);
    showStatus(T[lang].checking);
    return invoke('connect', { url: url }).then(function (ok) {
      // The native side navigates this webview to the server; show a hint until it does.
      showStatus(T[lang].okv + (ok.version || '?') + ')');
      // if this page is still showing after a while the navigation was blocked: say so instead of hanging
      setTimeout(function () { setBusy(false); showError({ code: 'stuck' }); }, 10000);
    }).catch(function (e) {
      setBusy(false);
      showError(e);
      return Promise.reject(e);
    });
  }

  function showForm(prefill) {
    $('form').hidden = false;
    $('retry-actions').hidden = true;
    if (prefill) $('url').value = prefill;
    $('url').focus();
  }

  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    connect($('url').value).catch(function () { /* shown */ });
  });

  $('lang').addEventListener('click', function () {
    lang = lang === 'ja' ? 'en' : 'ja';
    try { localStorage.setItem('lang', lang); } catch (e) { /* ignore */ }
    apply();
  });

  $('change').addEventListener('click', function () {
    clearTimeout(autoTimer);
    showStatus('');
    $('error').hidden = true;
    setBusy(false);
    showForm(retryUrl);
  });

  $('retry').addEventListener('click', function () { tryRetry(); });

  function tryRetry() {
    connect(retryUrl).catch(function () {
      // keep retrying in the background while the retry page is visible
      autoTimer = setTimeout(tryRetry, 6000);
    });
  }

  apply();

  if (retryMode && retryUrl) {
    $('form').hidden = true;
    $('retry-actions').hidden = false;
    tryRetry();
  } else if (changeMode) {
    invoke('get_saved_server').then(function (s) { showForm(s || ''); }, function () { showForm(''); });
  } else {
    invoke('get_saved_server').then(function (s) {
      if (!s) { showForm(''); return; }
      $('url').value = s;
      $('form').hidden = true;
      // auto-connect with a way out
      $('retry-actions').hidden = false;
      $('retry').hidden = true;
      retryUrl = s;
      connect(s).catch(function () { $('retry').hidden = false; });
    }, function (e) { showForm(''); showError(e); });
  }
})();
