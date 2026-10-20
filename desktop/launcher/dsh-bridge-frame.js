/* Hidden frame of the desktop app, served from the app's own origin (tauri.localhost / tauri://localhost).
   The OmniChat page the app shows is served by the OmniChat server, so its Origin is the server's, which the DSH plugin does not know.
   The plugin does accept a pairing request from this frame, which is a Tauri shell origin, for the origin it names (hello.forOrigin).
   The page talks to this frame with postMessage; the frame opens the loopback WebSocket to the plugin and relays its events.
   Only ws://127.0.0.1 | localhost | [::1] :<port>/omnichat-bridge is opened. forOrigin is always the page's real origin (event.origin). */
(function () {
  'use strict';
  var URL_RE = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/omnichat-bridge$/;
  var socks = {};
  var pageOrigin = null;

  function post(msg) {
    if (pageOrigin) window.parent.postMessage(msg, pageOrigin);
  }

  function open(id, url) {
    if (typeof id !== 'string' || typeof url !== 'string' || !URL_RE.test(url) || socks[id]) {
      post({ t: 'ev', id: id, kind: 'error' });
      return;
    }
    var ws;
    try { ws = new WebSocket(url); } catch (e) { post({ t: 'ev', id: id, kind: 'error' }); return; }
    socks[id] = ws;
    ws.addEventListener('open', function () { post({ t: 'ev', id: id, kind: 'open' }); });
    ws.addEventListener('message', function (ev) { post({ t: 'ev', id: id, kind: 'message', data: typeof ev.data === 'string' ? ev.data : '' }); });
    ws.addEventListener('error', function () { post({ t: 'ev', id: id, kind: 'error' }); });
    ws.addEventListener('close', function (ev) { delete socks[id]; post({ t: 'ev', id: id, kind: 'close', code: ev.code }); });
  }

  function send(id, data) {
    var ws = socks[id];
    if (!ws || typeof data !== 'string') return;
    try {
      var hello = JSON.parse(data);
      if (hello && hello.type === 'hello' && hello.pairRequest === true) {
        hello.forOrigin = pageOrigin; // never taken from the page: this is the origin the browser reports for it
        data = JSON.stringify(hello);
      }
    } catch (e) { /* not JSON: sent as is */ }
    ws.send(data);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    if (pageOrigin === null) pageOrigin = ev.origin;
    else if (ev.origin !== pageOrigin) return;
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'open') open(m.id, m.url);
    else if (m.t === 'send') send(m.id, m.data);
    else if (m.t === 'close' && socks[m.id]) { try { socks[m.id].close(typeof m.code === 'number' ? m.code : 1000); } catch (e) { /* closed */ } }
  });
})();
