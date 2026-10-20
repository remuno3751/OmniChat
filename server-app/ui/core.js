// OmniChat Server UI core: DOM helper, i18n (ja/en), Tauri IPC wrapper, state polling, toast/modal, page registry.
// Plain JS, no framework. Rendering uses DOM APIs / textContent only (never innerHTML) because the CSP forbids inline scripts
// and we never insert untrusted markup.
(function () {
  'use strict';
  var OC = window.OC = {};

  // ---------- DOM ----------
  // h('div', {cls:'x', text:'..', attrs:{..}, on:{click:fn}, value:'..'}, [children | strings])
  OC.h = function (tag, o, kids) {
    var n = document.createElement(tag);
    o = o || {};
    if (o.cls) n.className = o.cls;
    if (o.text != null) n.textContent = String(o.text);
    if (o.attrs) Object.keys(o.attrs).forEach(function (k) { if (o.attrs[k] != null) n.setAttribute(k, o.attrs[k]); });
    if (o.on) Object.keys(o.on).forEach(function (k) { n.addEventListener(k, o.on[k]); });
    if (o.value != null) n.value = o.value;
    if (o.checked != null) n.checked = !!o.checked;
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
  var h = OC.h;
  OC.clear = function (n) { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  OC.$ = function (id) { return document.getElementById(id); };

  var ICONS = {
    dashboard: 'M3 12l9-8 9 8M5 10v10h14V10',
    connections: 'M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 12v.01M12 16v4',
    models: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
    users: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1a3.5 3.5 0 0 0-2.5-3.3M16 4.2a3.5 3.5 0 0 1 0 6.6',
    security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
    logs: 'M4 5h16M4 10h16M4 15h10M4 20h7',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
    backup: 'M12 3v12M7 10l5 5 5-5M4 19h16',
    about: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 8v.01',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    play: 'M7 4l13 8-13 8z', stop: 'M6 6h12v12H6z', restart: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
    plugin: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
    quota: 'M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6',
    attachments: 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 17a2 2 0 0 1-3-3l7.5-7.5'
  };
  OC.icon = function (name) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ICONS.about);
    s.appendChild(p); return s;
  };

  // ---------- i18n ----------
  var dict = { ja: {}, en: {} };
  var lang = 'ja';
  try { lang = localStorage.getItem('oc-lang') || ((navigator.language || 'ja').slice(0, 2) === 'ja' ? 'ja' : 'en'); } catch (e) { /* ignore */ }
  // OC.addStrings({ja:{'x.y':'..'}, en:{'x.y':'..'}}); t('x.y', {n: 3}) replaces {n}
  OC.addStrings = function (d) { ['ja', 'en'].forEach(function (l) { Object.assign(dict[l], d[l] || {}); }); };
  OC.t = function (key, vars) {
    var s = dict[lang][key]; if (s == null) s = dict.en[key]; if (s == null) s = key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  };
  // ---------- theme: frontier (default) | astral | simple; an unknown or missing stored value falls back to frontier ----------
  var THEMES = ['frontier', 'astral', 'simple'];
  var theme = 'frontier';
  try { var st = localStorage.getItem('oc-theme'); if (THEMES.indexOf(st) >= 0) theme = st; } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);
  OC.themes = THEMES.slice();
  OC.theme = function () { return theme; };
  OC.setTheme = function (n) {
    theme = THEMES.indexOf(n) >= 0 ? n : 'frontier';
    try { localStorage.setItem('oc-theme', theme); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', theme);
    OC.emit('theme');
  };
  OC.lang = function () { return lang; };
  OC.setLang = function (l) {
    lang = l === 'en' ? 'en' : 'ja';
    try { localStorage.setItem('oc-lang', lang); } catch (e) { /* ignore */ }
    document.documentElement.lang = lang;
    OC.emit('lang');
  };
  var t = OC.t;

  // ---------- events ----------
  var subs = {};
  OC.on = function (ev, fn) { (subs[ev] = subs[ev] || []).push(fn); return function () { subs[ev] = subs[ev].filter(function (f) { return f !== fn; }); }; };
  OC.emit = function (ev, d) { (subs[ev] || []).slice().forEach(function (f) { try { f(d); } catch (e) { console.error(e); } }); };

  // ---------- IPC ----------
  // invoke(cmd, args) -> Promise. Errors are normalised to Error(message).
  OC.invoke = function (cmd, args) {
    var g = window.__TAURI__;
    var f = g && g.core && g.core.invoke;
    if (!f) return Promise.reject(new Error('Tauri IPC unavailable'));
    return f(cmd, args || {}).catch(function (e) { throw new Error(typeof e === 'string' ? e : (e && (e.message || e.error)) || 'error'); });
  };
  // run(fn): shows a toast on failure, resolves undefined on error
  OC.safe = function (p, okMsg) {
    return p.then(function (v) { if (okMsg) OC.toast(okMsg); return v; }, function (e) { OC.toast(e.message, 'err'); });
  };

  // ---------- state ----------
  // OC.state = last get_state: {running,pid,port,host,dataDir,configPath,version,userCount,autostart,lanUrls[],error}
  OC.state = null;
  var inflight = false;
  OC.refreshState = function () {
    if (inflight) return Promise.resolve(OC.state);
    inflight = true;
    return OC.invoke('get_state').then(function (s) { OC.state = s; OC.emit('state', s); return s; }, function (e) { OC.emit('state-error', e); })
      .then(function (s) { inflight = false; return s; }, function () { inflight = false; });
  };
  OC.setState = function (s) { if (s) { OC.state = s; OC.emit('state', s); } };
  // server control; each returns the new state
  OC.serverAction = function (cmd) {
    OC.busy(true);
    return OC.invoke(cmd).then(function (s) { OC.setState(s); return s; }, function (e) { OC.toast(e.message, 'err'); }).then(function (s) { OC.busy(false); return s; });
  };
  var busyN = 0;
  OC.busy = function (on) { busyN = Math.max(0, busyN + (on ? 1 : -1)); document.body.classList.toggle('busy', busyN > 0); OC.emit('busy', busyN > 0); };
  OC.isBusy = function () { return busyN > 0; };

  // ---------- helpers ----------
  OC.chip = function (kind, text, plain) { return h('span', { cls: 'chip ' + (kind || '') + (plain ? ' plain' : ''), text: text }); };
  OC.card = function (title, kids, sub) {
    return h('section', { cls: 'card' }, [title ? h('h2', { text: title }) : null, sub ? h('p', { cls: 'card-sub', text: sub }) : null].concat(kids || []));
  };
  OC.btn = function (text, cls, onClick, iconName) {
    return h('button', { cls: 'btn ' + (cls || ''), attrs: { type: 'button' }, on: { click: onClick } }, [iconName ? OC.icon(iconName) : null, text].filter(Boolean).map(function (x) { return x; }));
  };
  OC.empty = function (icon, text, sub) { return h('div', { cls: 'empty' }, [h('div', { cls: 'big', text: icon || '∅' }), h('p', { text: text }), sub ? h('p', { cls: 'small', text: sub }) : null]); };
  OC.field = function (label, input, hint, id) {
    if (id) input.id = id;
    return h('div', { cls: 'field' }, [h('label', { text: label, attrs: id ? { 'for': id } : null }), input, hint ? h('p', { cls: 'hint', text: hint }) : null]);
  };
  OC.switchRow = function (label, hint, checked, onChange) {
    var inp = h('input', { attrs: { type: 'checkbox', role: 'switch' }, checked: checked, on: { change: function () { onChange(inp.checked, inp); } } });
    return h('label', { cls: 'switch' }, [inp, h('span', { cls: 'sw-text' }, [h('span', { text: label }), hint ? h('span', { cls: 'hint', text: hint }) : null])]);
  };
  OC.fmtBytes = function (n) { var u = ['B', 'KB', 'MB', 'GB']; var i = 0; n = Number(n) || 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; };
  OC.fmtDuration = function (sec) {
    sec = Math.max(0, Math.round(sec)); var d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return t('time.dh', { d: d, h: hh }); if (hh) return t('time.hm', { h: hh, m: m }); if (m) return t('time.m', { m: m }); return t('time.s', { s: sec });
  };
  OC.fmtDate = function (ms) { try { return new Date(ms).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US'); } catch (e) { return String(ms); } };

  OC.copy = function (text) {
    function ok() { OC.toast(t('common.copied')); }
    function fallback() {
      var ta = h('textarea', { value: text, attrs: { 'aria-hidden': 'true' } }); ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) { OC.toast(t('common.copyFailed'), 'err'); } ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  };
  // text file download (webview-safe: blob + anchor)
  OC.download = function (name, text) {
    var a = h('a', { attrs: { download: name, href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })) } });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  // QR code as an inline <svg> element (dark modules as one path)
  OC.qr = function (text) {
    var q = window.qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), d = '', ns = 'http://www.w3.org/2000/svg';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
    var s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '-2 -2 ' + (n + 4) + ' ' + (n + 4)); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'QR');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#000'); s.appendChild(p);
    return h('div', { cls: 'qr' }, [s]);
  };

  OC.toast = function (msg, kind) {
    var el = h('div', { cls: 'toast' + (kind === 'err' ? ' err' : ''), text: msg });
    OC.$('toasts').appendChild(el); setTimeout(function () { el.remove(); }, kind === 'err' ? 6000 : 2600);
  };
  // OC.modal({title, body:[nodes], actions:[{text, cls, onClick -> true to keep open?}]}) ; returns close()
  OC.modal = function (o) {
    var wrap = OC.$('modal'), prev = document.activeElement;
    function close() { wrap.hidden = true; OC.clear(wrap); document.removeEventListener('keydown', key); if (prev && prev.focus) prev.focus(); }
    function key(e) { if (e.key === 'Escape') close(); }
    var acts = (o.actions || []).map(function (a) {
      return OC.btn(a.text, a.cls, function () { var r = a.onClick ? a.onClick() : null; if (r !== true) close(); });
    });
    var box = h('div', { cls: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title } }, [h('h2', { text: o.title })].concat(o.body || [], [h('div', { cls: 'actions' }, acts)]));
    OC.clear(wrap); wrap.appendChild(box); wrap.hidden = false; document.addEventListener('keydown', key);
    var first = box.querySelector('input,select,textarea') || box.querySelector('.btn.primary,.btn'); if (first) first.focus();
    return close;
  };
  OC.confirm = function (title, text, okText, danger) {
    return new Promise(function (res) {
      OC.modal({ title: title, body: [h('p', { text: text })], actions: [
        { text: t('common.cancel'), onClick: function () { res(false); } },
        { text: okText || 'OK', cls: danger ? 'danger' : 'primary', onClick: function () { res(true); } }] });
    });
  };

  // ---------- pages / router ----------
  // OC.registerPage({id, order, icon, titleKey, render(root) -> {onState?(s), destroy?()} | void})
  var pages = [], current = null, currentInst = null;
  OC.registerPage = function (p) { pages.push(p); pages.sort(function (a, b) { return a.order - b.order; }); };
  OC.pageHeader = function (title, sub, right) {
    return h('div', { cls: 'page-head' }, [h('div', {}, [h('h1', { text: title }), sub ? h('p', { text: sub }) : null]), right || null]);
  };
  function renderRail() {
    var rail = OC.clear(OC.$('rail'));
    rail.appendChild(h('div', { cls: 'brand' }, [h('div', { cls: 'brand-logo', text: 'O' }), h('span', { text: 'OmniChat Server' })]));
    pages.forEach(function (p) {
      var b = h('button', { cls: 'rail-item', attrs: { type: 'button', 'data-page': p.id, title: t(p.titleKey) }, on: { click: function () { OC.go(p.id); } } }, [OC.icon(p.icon), h('span', { text: t(p.titleKey) })]);
      if (p.id === current) b.setAttribute('aria-current', 'page');
      rail.appendChild(b);
    });
    rail.appendChild(h('div', { cls: 'rail-spacer' }));
    var st = h('div', { cls: 'rail-status', attrs: { id: 'rail-status' } });
    rail.appendChild(st); updateRailStatus();
  }
  function updateRailStatus() {
    var st = OC.$('rail-status'); if (!st) return; OC.clear(st);
    var s = OC.state;
    st.appendChild(h('span', { cls: 'dot ' + (!s ? '' : s.running ? 'ok' : 'err') }));
    st.appendChild(h('span', { text: !s ? '…' : s.running ? t('state.running') : t('state.stopped') }));
  }
  OC.go = function (id) {
    if (currentInst && currentInst.destroy) { try { currentInst.destroy(); } catch (e) { console.error(e); } }
    currentInst = null; current = id;
    var p = pages.filter(function (x) { return x.id === id; })[0] || pages[0];
    current = p.id;
    try { location.hash = p.id; } catch (e) { /* ignore */ }
    var view = OC.clear(OC.$('view'));
    var root = h('div', { cls: 'page' }); view.appendChild(root); view.scrollTop = 0;
    try { currentInst = p.render(root) || null; } catch (e) { console.error(e); root.appendChild(h('p', { cls: 'alert', text: e.message })); }
    if (currentInst && currentInst.onState && OC.state) currentInst.onState(OC.state);
    document.title = t(p.titleKey) + ' – OmniChat Server';
    Array.prototype.forEach.call(document.querySelectorAll('.rail-item'), function (b) { if (b.getAttribute('data-page') === p.id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  };
  OC.on('state', function (s) { updateRailStatus(); if (currentInst && currentInst.onState) currentInst.onState(s); });
  OC.on('lang', function () { if (!OC.$('shell').hidden) { renderRail(); OC.go(current); } });
  OC.showShell = function () { OC.$('wizard').hidden = true; OC.$('shell').hidden = false; renderRail(); OC.go((location.hash || '').slice(1) || 'dashboard'); };
  OC.pages = function () { return pages; };

  OC.addStrings({
    ja: { 'common.copy': 'コピー', 'common.copied': 'コピーしました', 'common.copyFailed': 'コピーできませんでした', 'common.cancel': 'キャンセル', 'common.save': '保存', 'common.saved': '保存しました', 'common.back': '戻る', 'common.next': '次へ', 'common.done': '完了', 'common.refresh': '更新', 'common.delete': '削除', 'common.loading': '読み込み中…', 'common.serverStopped': 'サーバーが停止しています', 'common.startFirst': '起動すると表示されます。', 'state.running': '稼働中', 'state.stopped': '停止中', 'time.dh': '{d}日 {h}時間', 'time.hm': '{h}時間 {m}分', 'time.m': '{m}分', 'time.s': '{s}秒',
      'nav.dashboard': 'ダッシュボード', 'nav.connections': '接続', 'nav.models': 'モデル', 'nav.users': 'ユーザー', 'nav.security': 'セキュリティ', 'nav.logs': 'ログ', 'nav.settings': '設定', 'nav.backup': 'バックアップ', 'nav.about': 'このアプリについて' },
    en: { 'common.copy': 'Copy', 'common.copied': 'Copied', 'common.copyFailed': 'Could not copy', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.saved': 'Saved', 'common.back': 'Back', 'common.next': 'Next', 'common.done': 'Done', 'common.refresh': 'Refresh', 'common.delete': 'Delete', 'common.loading': 'Loading…', 'common.serverStopped': 'The server is stopped', 'common.startFirst': 'Start the server to see this.', 'state.running': 'Running', 'state.stopped': 'Stopped', 'time.dh': '{d}d {h}h', 'time.hm': '{h}h {m}m', 'time.m': '{m} min', 'time.s': '{s} s',
      'nav.dashboard': 'Dashboard', 'nav.connections': 'Connections', 'nav.models': 'Models', 'nav.users': 'Users', 'nav.security': 'Security', 'nav.logs': 'Logs', 'nav.settings': 'Settings', 'nav.backup': 'Backup', 'nav.about': 'About' }
  });
})();
