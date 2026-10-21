// OmniChat update popup: plain JS, no framework. Talks to the update_* Rust commands via
// window.__TAURI__ (withGlobalTauri). Remote pages never reach this window.
(function () {
  'use strict';

  var T = {
    ja: {
      title: '新しいバージョンがあります',
      versions: '現在 {cur} → 最新 {ver}',
      channel: 'チャンネル: {ch}',
      chStable: '安定版',
      chPre: 'プレリリース',
      prerelease: 'これはプレリリース(試験版)です',
      notes: '変更点',
      install: '今すぐ更新',
      openPage: 'リリースページを開く',
      skip: 'このバージョンをスキップ',
      later: '後で',
      working: 'ダウンロードと検証を行っています…',
      started: 'インストーラーを起動しました。更新後に OmniChat が再起動します。',
      opened: 'リリースページを開きました。',
      errTitle: '更新できませんでした',
      e_network: 'GitHub に接続できませんでした。ネットワークを確認してください。',
      e_not_found: 'リリースが見つかりません。リポジトリが非公開の場合はトークンが必要です。',
      e_forbidden: 'GitHub がアクセスを拒否しました。',
      e_unauthorized: 'GitHub のトークンが無効です。',
      e_rate_limited: 'GitHub の API 制限に達しました。しばらく待ってから再試行してください。',
      e_bad_response: 'GitHub の応答を読み取れませんでした。',
      e_checksum_missing: 'このリリースにはインストーラーのチェックサムがないため、更新を中止しました。',
      e_checksum_mismatch: 'ダウンロードしたファイルのチェックサムが一致しないため、更新を中止しました。',
      e_download: 'インストーラーのダウンロードに失敗しました。',
      e_unsupported: 'この環境では自動更新できません。',
      e_busy: '更新は既に進行中です。',
      e_launch: 'インストーラーを起動できませんでした。',
      e_no_offer: '更新情報がありません。',
      e_other: '予期しないエラーが発生しました。'
    },
    en: {
      title: 'A new version is available',
      versions: 'Current {cur} → Latest {ver}',
      channel: 'Channel: {ch}',
      chStable: 'Stable',
      chPre: 'Pre-release',
      prerelease: 'This is a pre-release (test version)',
      notes: 'Release notes',
      install: 'Update now',
      openPage: 'Open release page',
      skip: 'Skip this version',
      later: 'Later',
      working: 'Downloading and verifying…',
      started: 'The installer has started. OmniChat will restart after the update.',
      opened: 'The release page was opened.',
      errTitle: 'The update could not be applied',
      e_network: 'Could not reach GitHub. Check your network connection.',
      e_not_found: 'Release not found. A private repository needs a token.',
      e_forbidden: 'GitHub refused the request.',
      e_unauthorized: 'The GitHub token is invalid.',
      e_rate_limited: 'GitHub API rate limit reached. Try again later.',
      e_bad_response: 'Could not read the GitHub response.',
      e_checksum_missing: 'This release has no checksum for the installer, so the update was refused.',
      e_checksum_mismatch: 'The downloaded file does not match its checksum, so the update was refused.',
      e_download: 'The installer download failed.',
      e_unsupported: 'Automatic update is not available here.',
      e_busy: 'An update is already in progress.',
      e_launch: 'The installer could not be started.',
      e_no_offer: 'No update information is available.',
      e_other: 'An unexpected error occurred.'
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var lang = 'en';
  try {
    lang = (navigator.language || '').toLowerCase().indexOf('ja') === 0 ? 'ja' : 'en';
  } catch (e) { /* navigator unavailable */ }
  var S = T[lang];
  var info = null;
  var busy = false;

  function invoke(cmd) {
    var g = window.__TAURI__;
    if (!g || !g.core) return Promise.reject('unsupported');
    return g.core.invoke(cmd);
  }

  // Tauri rejects with the Rust error string ("code" or "code: detail").
  function codeOf(e) {
    var s = typeof e === 'string' ? e : (e && e.message) || (e && e.code) || '';
    s = String(s).split(':')[0].trim().replace(/-/g, '_');
    return s || 'other';
  }

  function showError(e) {
    var code = codeOf(e);
    var msg = S['e_' + code] || S.e_other;
    $('err-title').textContent = S.errTitle;
    $('err-body').textContent = msg;
    $('error').hidden = false;
  }

  function setBusy(on) {
    busy = on;
    ['install', 'skip', 'later'].forEach(function (id) { $(id).disabled = on; });
  }

  function fill(i) {
    info = i;
    $('title').textContent = S.title;
    $('versions').textContent = S.versions.replace('{cur}', i.current).replace('{ver}', i.version);
    var parts = [];
    if (i.channel) parts.push(S.channel.replace('{ch}', i.channel === 'prerelease' ? S.chPre : S.chStable));
    // a hyphen in the version marks a prerelease (semver)
    if (i.prerelease || String(i.version).indexOf('-') !== -1) parts.push(S.prerelease);
    $('meta').textContent = parts.join(' / ');
    $('meta').hidden = parts.length === 0;
    if (i.notes) {
      $('notes-label').textContent = S.notes;
      $('notes').textContent = i.notes;
      $('notes-wrap').hidden = false;
    }
    $('install').textContent = i.canInstall ? S.install : S.openPage;
    $('skip').textContent = S.skip;
    $('later').textContent = S.later;
  }

  $('install').addEventListener('click', function () {
    if (busy || !info) return;
    $('error').hidden = true;
    setBusy(true);
    var status = $('status');
    status.textContent = info.canInstall ? S.working : '';
    status.hidden = !info.canInstall;
    invoke('update_install').then(function () {
      setBusy(false);
      if (info.canInstall) {
        status.textContent = S.started;
        status.hidden = false;
      } else {
        status.textContent = S.opened;
        status.hidden = false;
      }
    }, function (e) {
      setBusy(false);
      status.hidden = true;
      showError(e);
    });
  });

  $('skip').addEventListener('click', function () {
    if (busy) return;
    setBusy(true);
    invoke('update_skip').catch(function (e) { setBusy(false); showError(e); });
  });

  $('later').addEventListener('click', function () {
    if (busy) return;
    setBusy(true);
    invoke('update_later').catch(function (e) { setBusy(false); showError(e); });
  });

  invoke('update_info').then(fill, function (e) {
    showError(e);
    $('title').textContent = S.title;
    $('install').disabled = true;
    $('skip').textContent = S.skip;
    $('later').textContent = S.later;
  });
})();
