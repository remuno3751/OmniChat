// Dev-only mock of the Tauri IPC bridge, for browser testing (Playwright addInitScript, or a plain static server in ui/).
// Defines window.__TAURI__.core.invoke(cmd, args) with in-memory data that follows the IPC contract. Never ship this.
// Query flags: ?wizard=1 forces the setup wizard, ?stopped=1 starts with the server stopped,
// ?empty=1 starts with no users, ?noautostart=1 reports autostart as unsupported.
// Setup-done flag lives in localStorage 'mock-setup-done' ('1' = done).
(function () {
  'use strict';

  var q = {};
  try {
    var sp = new URLSearchParams(location.search || '');
    sp.forEach(function (v, k) { q[k] = v; });
  } catch (e) { /* no URLSearchParams: keep defaults */ }

  var SOURCE_URL = 'https://github.com/remuno3751/omnichat';
  var DAY = 86400000;
  var now = Date.now();

  var M = {
    running: q.stopped !== '1',
    startedAt: now - (3 * 3600 + 12 * 60) * 1000,
    pid: 4242,
    version: '0.9.2',
    dataDir: '/home/user/.local/share/omnichat-server',
    configPath: '/home/user/.config/omnichat-server/config.json',
    config: { port: 8787, host: '0.0.0.0', allowRegistration: false, searxngUrl: 'http://127.0.0.1:8888' },
    activePort: 8787,
    extra: { publicUrl: '', backupIntervalHours: 24, backupKeep: 7 },
    autostart: { supported: q.noautostart !== '1', enabled: false, delaySecs: 30, mechanism: 'systemd (user unit)', waitNetwork: true },
    background: { startInBackground: true, alwaysHidden: false },
    search: { enabled: true, provider: 'searxng', baseUrl: 'http://127.0.0.1:8888', language: 'ja', safesearch: 1, maxResults: 5, timeoutSec: 10 },
    users: q.empty === '1' ? [] : [
      { id: 1, username: 'admin', role: 'admin', disabled: false, createdAt: now - 40 * DAY },
      { id: 2, username: 'mika', role: 'user', disabled: false, createdAt: now - 21 * DAY },
      { id: 3, username: 'takeshi', role: 'user', disabled: true, createdAt: now - 5 * DAY }
    ],
    nextUserId: 4,
    localServers: [
      { name: 'LM Studio', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: ['qwen2.5-7b-instruct', 'llama-3.1-8b-instruct'] },
      { name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['gemma3:4b', 'nomic-embed-text'] }
    ],
    maintenance: { enabled: false, message: '', eta: null, updatedAt: 0 },
    sharedSettings: { defaultSharedAccess: 'none', allowOwnProviders: true },
    grants: [],
    providers: [
      { id: 'p-example', owner: 'admin', name: 'Example cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', shared: false, adminOwned: true, ownerId: 1 },
      { id: 'p-dsh', owner: 'admin', name: 'DSH', kind: 'dsh-bridge', baseUrl: 'dsh://local', shared: false, adminOwned: true, ownerId: 1 }
    ],
    bridges: [
      { owner: 'mika', name: 'DSH bridge', cwd: '/home/mika/dsh' }
    ],
    backups: [
      { name: 'omnichat-2026-10-16-0300.db', size: 2411520, createdAt: now - 31 * 3600 * 1000 },
      { name: 'omnichat-2026-10-15-0300.db', size: 2398208, createdAt: now - 55 * 3600 * 1000 },
      { name: 'omnichat-manual-2026-10-10.db', size: 2254336, createdAt: now - 7 * DAY }
    ],
    network: {
      lan: [{ name: 'wlp3s0', ip: '192.168.1.23' }],
      tailscale: [{ ip: '100.101.102.103' }]
    },
    logs: []
  };

  // ---------- logs: 120 mixed lines spread over the past, then one line every few seconds while running ----------
  var LEVELS = ['INFO', 'INFO', 'INFO', 'DEBUG', 'INFO', 'WARN', 'INFO', 'INFO', 'ERROR', 'INFO', 'INFO', 'DEBUG', 'WARN', 'INFO'];
  var MSGS = {
    INFO: ['client connected user=mika', 'chat created id=c_42', 'model list refreshed (lmstudio: 2 models)',
      'bridge registered owner=mika name=DSH bridge', 'stream finished tokens=812 ms=2140', 'connection closed user=admin'],
    DEBUG: ['ws ping ok rtt=12ms', 'cache hit key=models', 'session token refreshed user=mika'],
    WARN: ['ollama slow response 3.2s', 'rate limit near threshold user=takeshi', 'search fallback to cache'],
    ERROR: ['upstream 502 from provider example-cloud', 'bridge timeout owner=mika', 'failed to parse webhook payload']
  };
  var logSeq = 0;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function logLine(ts, level, msg) {
    var d = new Date(ts);
    var stamp = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z';
    return stamp + ' ' + (level + '     ').slice(0, 5) + ' ' + msg;
  }
  function nextEntry() {
    var lvl = LEVELS[logSeq % LEVELS.length];
    var list = MSGS[lvl];
    var msg = list[(logSeq * 7) % list.length];
    logSeq++;
    return { level: lvl, msg: msg };
  }
  (function seedLogs() {
    var t0 = now - 120 * 45000;
    M.logs.push(logLine(t0, 'INFO', 'omnichat-server ' + M.version + ' starting'));
    M.logs.push(logLine(t0 + 500, 'INFO', 'listening on 0.0.0.0:8787'));
    for (var i = 2; i < 120; i++) {
      var e = nextEntry();
      M.logs.push(logLine(t0 + i * 45000, e.level, e.msg));
    }
  })();
  function log(level, msg) {
    M.logs.push(logLine(Date.now(), level, msg));
    if (M.logs.length > 2000) M.logs.splice(0, M.logs.length - 2000);
  }
  setInterval(function () {
    if (!M.running) return;
    var e = nextEntry();
    log(e.level, e.msg);
  }, 4000);

  // ---------- helpers ----------
  function later(ms, fn) {
    return new Promise(function (res, rej) {
      setTimeout(function () { try { res(fn()); } catch (e) { rej(String(e && e.message || e)); } }, ms);
    });
  }
  function reject(msg, ms) {
    return new Promise(function (_, rej) { setTimeout(function () { rej(msg); }, ms == null ? 60 : ms); });
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function userCount() { return M.running ? M.users.length : null; }
  function getState() {
    return {
      running: M.running,
      pid: M.running ? M.pid : null,
      port: M.running ? M.activePort : M.config.port,
      host: M.config.host,
      dataDir: M.dataDir,
      configPath: M.configPath,
      version: M.version,
      userCount: userCount(),
      autostart: !!M.autostart.enabled,
      lanUrls: M.running ? ['http://' + M.network.lan[0].ip + ':' + M.activePort + '/'] : [],
      error: null
    };
  }
  function uptimeSec() { return Math.floor((Date.now() - M.startedAt) / 1000); }
  function activeAdmins() { return M.users.filter(function (u) { return u.role === 'admin' && !u.disabled; }); }
  function findUser(id) {
    for (var i = 0; i < M.users.length; i++) if (M.users[i].id === Number(id)) return M.users[i];
    return null;
  }
  function setupDone() {
    if (q.wizard === '1') return false;
    try { var v = localStorage.getItem('mock-setup-done'); return v === '1' || v === 'true'; } catch (e) { return false; }
  }
  function startServer() {
    M.running = true; M.activePort = M.config.port; M.pid = M.pid + 1; M.startedAt = Date.now();
    log('INFO', 'listening on ' + M.config.host + ':' + M.activePort);
  }
  function stopServer() {
    if (M.running) log('INFO', 'server stopped');
    M.running = false;
  }
  function requireRunning(what) {
    if (!M.running) return reject(what + ': server is not running', 40);
    return null;
  }
  function validPort(p) { return typeof p === 'number' && p >= 1 && p <= 65535 && Math.floor(p) === p; }

  function updStatus() {
    var newer = q.upd === '1' && M.version === '0.9.2';
    return {
      current: M.version, installType: 'server-app', selfUpdate: true, selfUpdateReason: null, dockerCommand: null, channel: 'stable', checkHours: 0, tokenSet: false,
      latest: M.updChecked || newer ? { tag: 'v0.9.3', version: newer ? '0.9.3' : M.version, name: 'test', notes: '', prerelease: false, publishedAt: '', htmlUrl: SOURCE_URL + '/releases/tag/v0.9.3', assets: [] } : null,
      updateAvailable: newer && !!M.updChecked, skipped: false, skippedVersions: [], bundleAssetFound: true, lastCheckedAt: M.updChecked || null, lastError: null,
      phase: M.updPhase || 'idle', progress: M.updPhase === 'downloading' ? 0.4 : null, lastApply: null, plugin: null, isAdmin: true
    };
  }

  // ---------- commands ----------
  var CMDS = {
    get_state: function () { return later(40, getState); },
    // manual server update (mock: ?upd=1 offers a newer version)
    update_status: function () { return later(60, function () { return updStatus(); }); },
    update_check: function () { return later(500, function () { M.updChecked = Date.now(); return updStatus(); }); },
    update_apply: function () { return later(300, function () { M.updPhase = 'downloading'; setTimeout(function () { M.updPhase = 'restarting'; setTimeout(function () { M.version = '0.9.3'; M.updPhase = 'idle'; }, 2500); }, 2000); return { ok: true, phase: 'downloading' }; }); },
    start_server: function () {
      if (M.running) return later(40, getState);
      return later(600, function () { startServer(); return getState(); });
    },
    stop_server: function () {
      return later(400, function () { stopServer(); return getState(); });
    },
    restart_server: function () {
      stopServer();
      return later(900, function () { startServer(); return getState(); });
    },
    get_logs: function (a) {
      var limit = Math.min(2000, Math.max(1, Number(a.limit) || 500));
      return later(30, function () { return M.logs.slice(-limit); });
    },
    get_config: function () {
      return later(30, function () { return copy(M.config); });
    },
    set_config: function (a) {
      var c = a || {};
      if (!validPort(c.port)) return reject('port must be 1-65535', 40);
      var changed = c.port !== M.config.port || c.host !== M.config.host || !!c.allowRegistration !== !!M.config.allowRegistration;
      M.config = { port: c.port, host: c.host || M.config.host, allowRegistration: !!c.allowRegistration, searxngUrl: c.searxngUrl || '' };
      return later(60, function () { return { restartRequired: M.running && changed }; });
    },
    get_extra: function () { return later(30, function () { return copy(M.extra); }); },
    set_extra: function (a) {
      M.extra = { publicUrl: a.publicUrl || '', backupIntervalHours: Number(a.backupIntervalHours) || 0, backupKeep: Number(a.backupKeep) || 0 };
      return later(60, function () { return { restartRequired: M.running }; });
    },
    list_users: function () { return later(60, function () { return { users: copy(M.users) }; }); },
    create_user: function (a) {
      var r = requireRunning('create_user'); if (r) return r;
      var name = String(a.username || '').trim();
      if (name.length < 3 || name.length > 32) return reject('username must be 3-32 characters', 60);
      if (String(a.password || '').length < 8) return reject('password must be at least 8 characters', 60);
      if (a.role !== 'admin' && a.role !== 'user') return reject('invalid role', 60);
      for (var i = 0; i < M.users.length; i++) if (M.users[i].username === name) return reject('username already exists', 60);
      M.users.push({ id: M.nextUserId++, username: name, role: a.role, disabled: false, createdAt: Date.now() });
      log('INFO', 'user created ' + name + ' role=' + a.role);
      return later(120, function () { return undefined; });
    },
    set_role: function (a) {
      var u = findUser(a.id);
      if (!u) return reject('user not found', 60);
      if (u.role === 'admin' && a.role !== 'admin' && activeAdmins().length <= 1 && !u.disabled) {
        return reject('cannot demote the last active admin', 60);
      }
      u.role = a.role;
      return later(60, function () { return undefined; });
    },
    set_disabled: function (a) {
      var u = findUser(a.id);
      if (!u) return reject('user not found', 60);
      if (a.disabled && u.role === 'admin' && activeAdmins().length <= 1 && !u.disabled) {
        return reject('cannot disable the last active admin', 60);
      }
      u.disabled = !!a.disabled;
      return later(60, function () { return undefined; });
    },
    set_password: function (a) {
      var u = findUser(a.id);
      if (!u) return reject('user not found', 60);
      if (String(a.password || '').length < 8) return reject('password must be at least 8 characters', 60);
      return later(60, function () { return undefined; });
    },
    get_search_config: function () { return later(40, function () { return copy(M.search); }); },
    set_search_config: function (a) {
      M.search = copy(a.config || {});
      return later(60, function () { return undefined; });
    },
    search_test: function (a) {
      return later(700, function () {
        return {
          ok: true,
          mode: a.mode || 'general',
          elapsedMs: 412,
          results: [
            { title: 'OmniChat Server (example result 1)', url: 'https://example.com/result/1' },
            { title: 'Search result 2', url: 'https://example.com/result/2' },
            { title: 'Search result 3', url: 'https://example.com/result/3' }
          ].slice(0, M.search.maxResults || 5),
          query: a.query || ''
        };
      });
    },
    provider_add: function (a) {
      var r = requireRunning('provider_add'); if (r) return r;
      return later(200, function () {
        if (!/^https?:\/\//.test(a.baseUrl || '')) throw new Error('baseUrl: http(s) URL required');
        var p = { id: 'mock-' + Date.now(), owner: a.owner || 'admin', name: a.name, kind: 'openai-compatible', baseUrl: a.baseUrl, model: a.model || '', shared: false, adminOwned: !a.owner || a.owner === 'admin', ownerId: 1 };
        M.providers.push(p);
        log('INFO', 'provider added ' + a.name);
        return copy(p);
      });
    },
    provider_delete: function (a) {
      M.providers = M.providers.filter(function (p) { return p.id !== a.id; });
      return later(100, function () { return null; });
    },
    maintenance_get: function () {
      var r = requireRunning('maintenance_get'); if (r) return r;
      return later(40, function () { return { maintenance: copy(M.maintenance) }; });
    },
    maintenance_set: function (a) {
      var r = requireRunning('maintenance_set'); if (r) return r;
      // same rules as PUT /local-admin/maintenance (eta and clearEta are sent as the server expects)
      var next = copy(M.maintenance);
      if (a.enabled !== undefined && a.enabled !== null) next.enabled = !!a.enabled;
      if (a.message !== undefined && a.message !== null) {
        if (typeof a.message !== 'string' || Array.from(a.message).length > 500) return reject('message must be a string of at most 500 characters', 40);
        next.message = a.message;
      }
      if (a.clearEta) next.eta = null;
      else if (a.eta !== undefined && a.eta !== null) {
        if (!(Number.isSafeInteger(a.eta) && a.eta > 0)) return reject('eta must be null or a positive integer (epoch ms)', 40);
        next.eta = a.eta;
      }
      var changed = next.enabled !== M.maintenance.enabled || next.message !== M.maintenance.message || next.eta !== M.maintenance.eta;
      if (changed) { next.updatedAt = Date.now(); M.maintenance = next; log('INFO', 'maintenance ' + (next.enabled ? 'on' : 'off')); }
      return later(120, function () { return { maintenance: copy(M.maintenance) }; });
    },
    // ---- shared providers and per-user model grants (same rules as the /local-admin/... routes; state is in memory)
    shared_provider_set: function (a) {
      var r = requireRunning('shared_provider_set'); if (r) return r;
      var p = M.providers.filter(function (x) { return x.id === a.id; })[0];
      if (!p || !p.adminOwned) return reject('Provider not found', 60);
      if (p.kind === 'dsh-bridge') return reject('A dsh-bridge provider cannot be shared', 60);
      p.shared = !!a.shared;
      if (!p.shared) M.grants = M.grants.filter(function (g) { return g.providerId !== p.id; });
      log('INFO', 'provider ' + p.name + (p.shared ? ' shared' : ' unshared'));
      return later(80, function () { return { id: p.id, shared: p.shared }; });
    },
    shared_providers_get: function () {
      var r = requireRunning('shared_providers_get'); if (r) return r;
      return later(50, function () {
        return { providers: M.providers.filter(function (p) { return p.shared; }).map(function (p) { return { id: p.id, name: p.name, kind: p.kind, ownerUserId: String(p.ownerId) }; }) };
      });
    },
    provider_models_get: function (a) {
      var r = requireRunning('provider_models_get'); if (r) return r;
      var p = M.providers.filter(function (x) { return x.id === a.id; })[0];
      if (!p) return reject('Provider not found', 60);
      return later(300, function () {
        return { models: ['qwen2.5-7b-instruct', 'llama-3.1-8b-instruct', 'gemma3:4b'].map(function (id) { return { id: id, name: id }; }), fetchedAt: Date.now() };
      });
    },
    user_grants_get: function (a) {
      var r = requireRunning('user_grants_get'); if (r) return r;
      var uid = String(a.userId);
      return later(50, function () {
        return {
          defaultSharedAccess: M.sharedSettings.defaultSharedAccess,
          grants: M.grants.filter(function (g) { return g.userId === uid; }).map(function (g) { return { providerId: g.providerId, mode: g.mode, models: g.models.slice() }; })
        };
      });
    },
    user_grant_set: function (a) {
      var r = requireRunning('user_grant_set'); if (r) return r;
      var uid = String(a.userId);
      var models = a.mode === 'list' ? (a.models || []) : [];
      if (a.mode === 'list' && !models.length) return reject('models must not be empty when mode is list', 60);
      var p = M.providers.filter(function (x) { return x.id === a.providerId; })[0];
      if (!p || !p.shared) return reject('Shared provider not found', 60);
      M.grants = M.grants.filter(function (g) { return !(g.userId === uid && g.providerId === a.providerId); });
      M.grants.push({ userId: uid, providerId: a.providerId, mode: a.mode, models: models });
      return later(60, function () { return { providerId: a.providerId, mode: a.mode, models: models.slice() }; });
    },
    user_grant_delete: function (a) {
      var r = requireRunning('user_grant_delete'); if (r) return r;
      var uid = String(a.userId);
      var before = M.grants.length;
      M.grants = M.grants.filter(function (g) { return !(g.userId === uid && g.providerId === a.providerId); });
      return later(60, function () { return { ok: true, removed: M.grants.length !== before }; });
    },
    shared_settings_get: function () {
      var r = requireRunning('shared_settings_get'); if (r) return r;
      return later(40, function () { return copy(M.sharedSettings); });
    },
    shared_settings_set: function (a) {
      var r = requireRunning('shared_settings_set'); if (r) return r;
      if (a.defaultSharedAccess !== undefined && a.defaultSharedAccess !== 'none' && a.defaultSharedAccess !== 'all') return reject('defaultSharedAccess must be none or all', 60);
      if (a.defaultSharedAccess !== undefined) M.sharedSettings.defaultSharedAccess = a.defaultSharedAccess;
      if (a.allowOwnProviders !== undefined) M.sharedSettings.allowOwnProviders = !!a.allowOwnProviders;
      log('INFO', 'shared defaults: ' + M.sharedSettings.defaultSharedAccess + ', own providers ' + (M.sharedSettings.allowOwnProviders ? 'on' : 'off'));
      return later(80, function () { return copy(M.sharedSettings); });
    },
    server_overview: function () {
      var r = requireRunning('server_overview'); if (r) return r;
      return later(60, function () {
        return {
          uptimeSec: uptimeSec(),
          users: M.users.length,
          allowRegistration: !!M.config.allowRegistration,
          connections: { sockets: 2, users: ['mika', 'admin'] },
          bridges: copy(M.bridges),
          activeChats: 3,
          localServers: copy(M.localServers),
          providers: copy(M.providers)
        };
      });
    },
    backups_list: function () { return later(60, function () { return { backups: copy(M.backups) }; }); },
    backup_create: function () {
      return later(900, function () {
        var b = { name: 'omnichat-manual-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.db', size: 2440000 + Math.floor(Math.random() * 40000), createdAt: Date.now() };
        M.backups.unshift(b);
        log('INFO', 'backup created ' + b.name);
        return copy(b);
      });
    },
    backup_delete: function (a) {
      var before = M.backups.length;
      M.backups = M.backups.filter(function (b) { return b.name !== a.name; });
      if (M.backups.length === before) return reject('backup not found', 60);
      return later(60, function () { return undefined; });
    },
    backup_restore: function (a) {
      if (!M.backups.some(function (b) { return b.name === a.name; })) return reject('backup not found', 60);
      stopServer();
      return later(1500, function () { startServer(); log('INFO', 'restored from ' + a.name); return getState(); });
    },
    open_folder: function (a) {
      console.info('[mock] open_folder', a && a.which);
      return later(40, function () { return undefined; });
    },
    open_web_ui: function () {
      var r = requireRunning('open_web_ui'); if (r) return r;
      console.info('[mock] open_web_ui http://127.0.0.1:' + M.activePort + '/');
      return later(40, function () { return undefined; });
    },
    open_url: function (a) {
      if (!a || a.url !== SOURCE_URL) return reject('url not allowed', 40);
      console.info('[mock] open_url', a.url);
      return later(40, function () { return undefined; });
    },
    network_info: function () { return later(120, function () { return copy(M.network); }); },
    autostart_get: function () { return later(60, function () { return copy(M.autostart); }); },
    autostart_set: function (a) {
      if (!M.autostart.supported) return reject('autostart is not supported on this system', 60);
      var secs = Number(a.delaySecs);
      if (!(secs >= 0 && secs <= 300) || Math.floor(secs) !== secs) return reject('delaySecs must be 0-300', 60);
      M.autostart.enabled = !!a.enabled;
      M.autostart.delaySecs = secs;
      return later(200, function () { return copy(M.autostart); });
    },
    background_get: function () { return later(60, function () { return copy(M.background); }); },
    background_set: function (a) {
      M.background = { startInBackground: !!a.startInBackground, alwaysHidden: !!a.alwaysHidden };
      return later(120, function () { return copy(M.background); });
    },
    setup_done_get: function () { return later(30, setupDone); },
    setup_done_set: function (a) {
      try { localStorage.setItem('mock-setup-done', a && a.done ? '1' : '0'); } catch (e) { /* ignore */ }
      return later(30, function () { return undefined; });
    }
  };

  function invoke(cmd, args) {
    var fn = CMDS[cmd];
    if (!fn) {
      console.warn('[mock] unknown command', cmd);
      return reject('unknown command: ' + cmd, 0);
    }
    try { return fn(args || {}); } catch (e) { return reject(String(e && e.message || e), 0); }
  }

  window.__TAURI__ = { __mock: true, core: { invoke: invoke } };
})();
