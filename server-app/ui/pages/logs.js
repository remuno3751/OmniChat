// Logs page: live view of the server's stdout/stderr lines with level filter, search, pause and export.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;
  var MAX_DOM = 2000;

  OC.addStrings({
    ja: {
      'logs.sub': 'サーバーの出力を 1 秒ごとに更新して表示します。',
      'logs.level': 'レベル',
      'logs.lvAll': 'すべて',
      'logs.lvInfo': '情報',
      'logs.lvWarn': '警告',
      'logs.lvError': 'エラー',
      'logs.search': 'ログを検索',
      'logs.searchPlaceholder': '検索…',
      'logs.pause': '一時停止',
      'logs.resume': '再開',
      'logs.live': 'ライブ',
      'logs.paused': '一時停止中',
      'logs.autoScroll': '自動スクロール',
      'logs.copyVisible': '表示中をコピー',
      'logs.save': 'ファイルに保存',
      'logs.clear': '表示をクリア',
      'logs.empty': 'まだログはありません。',
      'logs.noMatch': '条件に一致するログはありません。',
      'logs.loadFailed': 'ログを読み込めませんでした',
      'logs.nothing': '保存・コピーするログがありません。'
    },
    en: {
      'logs.sub': 'Server output, refreshed every second.',
      'logs.level': 'Level',
      'logs.lvAll': 'All',
      'logs.lvInfo': 'Info',
      'logs.lvWarn': 'Warn',
      'logs.lvError': 'Error',
      'logs.search': 'Search logs',
      'logs.searchPlaceholder': 'Search…',
      'logs.pause': 'Pause',
      'logs.resume': 'Resume',
      'logs.live': 'Live',
      'logs.paused': 'Paused',
      'logs.autoScroll': 'Auto-scroll',
      'logs.copyVisible': 'Copy visible',
      'logs.save': 'Save as file',
      'logs.clear': 'Clear view',
      'logs.empty': 'No logs yet.',
      'logs.noMatch': 'No log lines match the current filter.',
      'logs.loadFailed': 'Could not load logs',
      'logs.nothing': 'There are no log lines to copy or save.'
    }
  });

  // Level from a pino-style JSON "level" field (>=50 error, >=40 warn), else from the text.
  function levelOf(line) {
    var m = /"level"\s*:\s*(\d+)/.exec(line);
    if (m) { var n = Number(m[1]); return n >= 50 ? 'error' : n >= 40 ? 'warn' : 'info'; }
    if (/error|ERR|fatal|uncaught/i.test(line)) return 'error';
    if (/warn/i.test(line)) return 'warn';
    return 'info';
  }

  OC.registerPage({
    id: 'logs', order: 60, icon: 'logs', titleKey: 'nav.logs',
    render: function (root) {
      root.classList.add('p-logs');

      var st = {
        lines: [],          // latest buffer from get_logs (oldest first)
        hasAnchor: false,   // "Clear view" marker: lines up to `anchor` are hidden
        anchor: '',
        paused: false,
        level: 'all',
        q: '',              // lower-cased search text
        auto: true,
        stick: true,        // user is at the bottom (auto-scroll follows)
        lastSrc: null,      // last source line currently rendered (for incremental append)
        lastCount: -1,
        lastLast: null,
        busy: false,
        destroyed: false,
        ph: null,           // placeholder node when nothing is shown
        timer: null
      };

      var status = h('div', { cls: 'row' });
      var errBox = h('div', { cls: 'alert', attrs: { role: 'alert' } });
      errBox.hidden = true;

      var sel = h('select', {
        attrs: { 'aria-label': t('logs.level') },
        on: { change: function () { st.level = sel.value; rebuild(); } }
      }, [
        h('option', { text: t('logs.lvAll'), value: 'all' }),
        h('option', { text: t('logs.lvInfo'), value: 'info' }),
        h('option', { text: t('logs.lvWarn'), value: 'warn' }),
        h('option', { text: t('logs.lvError'), value: 'error' })
      ]);

      var search = h('input', {
        attrs: { type: 'search', placeholder: t('logs.searchPlaceholder'), 'aria-label': t('logs.search'), autocomplete: 'off' },
        on: { input: function () { st.q = search.value.trim().toLowerCase(); rebuild(); } }
      });

      var pauseBtn = OC.btn(t('logs.pause'), 'sm', togglePause);
      var autoSw = OC.switchRow(t('logs.autoScroll'), null, true, function (on) {
        st.auto = on;
        if (on) { st.stick = true; toBottom(); }
      });

      var tools = h('div', { cls: 'row log-tools' }, [
        sel,
        search,
        pauseBtn,
        autoSw,
        OC.btn(t('logs.copyVisible'), 'sm', copyVisible, 'copy'),
        OC.btn(t('logs.save'), 'sm', saveFile),
        OC.btn(t('logs.clear'), 'sm ghost', clearView)
      ]);

      var logbox = h('div', {
        cls: 'logbox',
        attrs: { role: 'log', 'aria-live': 'off', 'aria-label': t('nav.logs'), tabindex: '0' }
      });
      logbox.addEventListener('scroll', function () {
        st.stick = logbox.scrollHeight - logbox.scrollTop - logbox.clientHeight < 24;
      });

      root.appendChild(OC.pageHeader(t('nav.logs'), t('logs.sub'), status));
      root.appendChild(OC.card(null, [tools, h('div', { cls: 'stack' }, [errBox, logbox])]));

      function toBottom() { logbox.scrollTop = logbox.scrollHeight; }

      // Lines after the "Clear view" anchor (or all lines when there is no anchor).
      function visibleLines() {
        var L = st.lines;
        if (!st.hasAnchor) return L;
        for (var i = L.length - 1; i >= 0; i--) {
          if (L[i] === st.anchor) return L.slice(i + 1);
        }
        st.hasAnchor = false; // anchor has rolled out of the buffer: everything is new
        return L;
      }

      function matches(line, lvl) {
        if (st.level !== 'all' && lvl !== st.level) return false;
        if (st.q && line.toLowerCase().indexOf(st.q) < 0) return false;
        return true;
      }

      function lineEl(line, lvl) {
        var cls = lvl === 'error' ? 'l-error' : lvl === 'warn' ? 'l-warn' : '';
        var d = h('div', { cls: cls });
        if (!st.q) { d.textContent = line; return d; }
        var lo = line.toLowerCase();
        var pos = 0, idx;
        while ((idx = lo.indexOf(st.q, pos)) >= 0) {
          if (idx > pos) d.appendChild(document.createTextNode(line.slice(pos, idx)));
          d.appendChild(h('mark', { text: line.substr(idx, st.q.length) }));
          pos = idx + st.q.length;
        }
        if (pos < line.length) d.appendChild(document.createTextNode(line.slice(pos)));
        return d;
      }

      function setPlaceholder(vis) {
        var text = vis.length === 0
          ? (OC.state && !OC.state.running ? t('common.serverStopped') : t('logs.empty'))
          : t('logs.noMatch');
        OC.clear(logbox);
        st.ph = h('div', { cls: 'l-dim', text: text });
        logbox.appendChild(st.ph);
      }

      // Full re-render of the visible, filtered lines.
      function rebuild() {
        var vis = visibleLines();
        var out = [];
        for (var i = 0; i < vis.length; i++) {
          var lvl = levelOf(vis[i]);
          if (matches(vis[i], lvl)) out.push({ line: vis[i], lvl: lvl });
        }
        out = out.slice(-MAX_DOM);
        OC.clear(logbox);
        st.ph = null;
        if (!out.length) setPlaceholder(vis);
        else out.forEach(function (x) { logbox.appendChild(lineEl(x.line, x.lvl)); });
        st.lastSrc = vis.length ? vis[vis.length - 1] : null;
        syncKey();
        if (st.auto && st.stick) toBottom();
      }

      function syncKey() {
        st.lastCount = st.lines.length;
        st.lastLast = st.lines.length ? st.lines[st.lines.length - 1] : null;
      }

      // Called with each poll result. Re-renders only when the buffer changed; appends new lines incrementally.
      function update(lines) {
        st.lines = lines;
        var last = lines.length ? lines[lines.length - 1] : null;
        if (lines.length === st.lastCount && last === st.lastLast) return;
        if (st.lastSrc === null) { rebuild(); return; }
        var vis = visibleLines();
        var p = -1;
        for (var i = vis.length - 1; i >= 0; i--) { if (vis[i] === st.lastSrc) { p = i; break; } }
        if (p < 0) { rebuild(); return; }
        syncKey();
        var fresh = vis.slice(p + 1);
        if (!fresh.length) return;
        if (st.ph) { logbox.removeChild(st.ph); st.ph = null; }
        fresh.forEach(function (line) {
          var lvl = levelOf(line);
          if (matches(line, lvl)) logbox.appendChild(lineEl(line, lvl));
        });
        st.lastSrc = vis[vis.length - 1];
        while (logbox.childNodes.length > MAX_DOM) logbox.removeChild(logbox.firstChild);
        if (st.auto && st.stick) toBottom();
      }

      function showErr(msg) {
        errBox.textContent = msg ? t('logs.loadFailed') + ': ' + msg : '';
        errBox.hidden = !msg;
      }

      function poll() {
        if (st.paused || st.busy || st.destroyed) return;
        st.busy = true;
        OC.invoke('get_logs', { limit: 1000 }).then(function (arr) {
          st.busy = false;
          if (st.destroyed) return;
          showErr(null);
          update(Array.isArray(arr) ? arr : []);
        }, function (e) {
          st.busy = false;
          if (st.destroyed) return;
          // A stopped server is shown through the status chip and the empty state, not as an error.
          showErr(OC.state && !OC.state.running ? null : e.message);
        });
      }

      function updateStatus() {
        var running = !!(OC.state && OC.state.running);
        var chip = st.paused
          ? OC.chip('warn', t('logs.paused'))
          : running ? OC.chip('ok', t('logs.live')) : OC.chip('', t('state.stopped'));
        OC.clear(status).appendChild(chip);
      }

      function togglePause() {
        st.paused = !st.paused;
        pauseBtn.textContent = t(st.paused ? 'logs.resume' : 'logs.pause');
        updateStatus();
        if (!st.paused) poll();
      }

      function visibleText() {
        var out = [];
        visibleLines().forEach(function (line) { if (matches(line, levelOf(line))) out.push(line); });
        return out.join('\n');
      }

      function copyVisible() {
        var text = visibleText();
        if (!text) { OC.toast(t('logs.nothing')); return; }
        OC.copy(text);
      }

      function saveFile() {
        var text = visibleText();
        if (!text) { OC.toast(t('logs.nothing')); return; }
        OC.download('omnichat-server-log.txt', text + '\n');
      }

      // Hides everything shown so far; only lines that arrive later are displayed.
      function clearView() {
        st.hasAnchor = st.lines.length > 0;
        st.anchor = st.lines.length ? st.lines[st.lines.length - 1] : '';
        rebuild();
      }

      updateStatus();
      rebuild();
      poll();
      st.timer = setInterval(poll, 1000);

      return {
        onState: function () {
          updateStatus();
          if (!st.lines.length) rebuild();
        },
        destroy: function () {
          st.destroyed = true;
          if (st.timer) clearInterval(st.timer);
          st.timer = null;
        }
      };
    }
  });
})();
