// Plugins page: installed plugins (enable switch, remove, check for updates) and install from GitHub
// (inspect -> security review -> type the plugin id -> installed DISABLED). Contract: docs/PROTOCOL-v7-plugins.md.
// Wording and rules follow app/src/components/PluginsAdmin.tsx and app/src/pluginsAdminLogic.ts.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'nav.plugins': 'プラグイン', 'plugins.title': 'プラグイン', 'plugins.sub': 'プラグインはサーバーにツールを追加します。作者を信頼できるものだけ入れてください。',
      'plugins.installed': '導入済み', 'plugins.empty': '導入されているプラグインはありません。', 'plugins.install': 'GitHub から導入',
      'plugins.source.github': 'github', 'plugins.source.local': 'local', 'plugins.localNote': 'フォルダに手動で置かれたプラグインです。ここからは無効化も削除もできません。',
      'plugins.enabled': '有効', 'plugins.tools': 'ツール', 'plugins.modified': '導入後にファイルが変更されています。コードを確認するか、入れ直してください。',
      'plugins.scan': '静的スキャン: 高 {high} · 中 {medium} · 情報 {info}', 'plugins.checkUpdate': '更新を確認', 'plugins.remove': '削除',
      'plugins.removeTitle': 'プラグインを削除しますか？', 'plugins.removeBody': '{name} を削除します。ファイルが消え、「常に許可」の設定も消えます。元に戻せません。',
      'plugins.removed': 'プラグインを削除しました。', 'plugins.upToDate': '{name} は最新です。', 'plugins.working': '処理中...',
      'plugins.form.repo': 'リポジトリ（owner/name または GitHub の URL）', 'plugins.form.ref': 'タグ・ブランチ・コミット（省略可）',
      'plugins.form.subdir': 'サブフォルダ（省略可）', 'plugins.form.repoEmpty': 'リポジトリを入力してください。',
      'plugins.form.repoBad': 'owner/name または github.com の URL を入力してください。', 'plugins.form.subdirBad': 'サブフォルダに「..」は使えません。',
      'plugins.form.inspect': '検査する', 'plugins.form.inspecting': '検査中...', 'plugins.form.cancel': '閉じる',
      'plugins.review.warnTitle': 'セキュリティ確認', 'plugins.review.warn': 'プラグインは、このサーバーの権限で動きます。ファイル、環境変数(API キーを含む)、ネットワークのすべてに触れます。作者を信頼できないコードは入れないでください。',
      'plugins.review.titleInstall': '{name} {version} を導入しますか？', 'plugins.review.titleUpdate': '{name} を {version} に更新しますか？',
      'plugins.review.source': '取得元', 'plugins.review.commit': 'コミット', 'plugins.review.subdir': 'サブフォルダ: {subdir}',
      'plugins.review.alreadyInstalled': 'この id のプラグインは導入済みです。導入すると置き換わり、有効/無効の状態は保たれます。',
      'plugins.review.tools': 'ツールと宣言された権限', 'plugins.review.noPerms': '権限なし',
      'plugins.review.mismatchTitle': '権限の不一致', 'plugins.review.mismatch': '{tool} は {used} を使っていますが、宣言は {declared} です。', 'plugins.review.none': 'なし',
      'plugins.review.findings': '静的スキャンの結果', 'plugins.review.noFindings': '指摘はありません。',
      'plugins.review.scanNote': 'スキャンは目安であり、安全の保証ではありません。見落としも誤検出もあります。',
      'plugins.review.severity.high': '高', 'plugins.review.severity.medium': '中', 'plugins.review.severity.info': '情報',
      'plugins.review.files': 'ファイル（{n} 個、合計 {size}）', 'plugins.review.notes': '注意', 'plugins.review.diff': '導入済み版からの変更',
      'plugins.review.added': '追加', 'plugins.review.removed': '削除', 'plugins.review.changed': '変更',
      'plugins.review.toolsAdded': '新しいツール: {list}', 'plugins.review.toolsRemoved': '削除されたツール: {list}',
      'plugins.review.permissionsAdded': '新しい権限: {list}', 'plugins.review.noChanges': 'ファイルの変更はありません。',
      'plugins.review.confirmLabel': '確認のため、プラグインの id を入力してください: {id}', 'plugins.review.confirmHint': '表示どおりに入力してください。',
      'plugins.review.install': '導入する', 'plugins.review.installUpdate': '更新を導入する',
      'plugins.installedNotice': '{name} は無効の状態で入りました。有効にするには、一覧の「有効」スイッチをオンにしてください。',
      'plugins.updatedNotice': '{name} を更新しました。',
      'plugins.rule.child_process': '他のプログラムを実行', 'plugins.rule.fs_write': 'ファイルを書く・移動する・削除する',
      'plugins.rule.env_access': '環境変数を読む（API キーを含むことがある）', 'plugins.rule.eval': '実行時に作られたコードを実行(eval)',
      'plugins.rule.dynamic_import': '計算された名前でモジュールを読み込む', 'plugins.rule.raw_network': '低レベルのネットワーク通信',
      'plugins.rule.fs_read': 'ファイルを読む', 'plugins.rule.obfuscation': '難読化されたコードの疑い',
      'plugins.rule.undeclared_network': 'network を宣言せずに通信している',
      'plugins.perm.shell': 'シェル', 'plugins.perm.filesystem-read': 'ファイル読み取り', 'plugins.perm.filesystem-write': 'ファイル書き込み', 'plugins.perm.network': 'ネットワーク'
    },
    en: {
      'nav.plugins': 'Plugins', 'plugins.title': 'Plugins', 'plugins.sub': 'Plugins add tools to the server. Install only code from authors you trust.',
      'plugins.installed': 'Installed', 'plugins.empty': 'No plugins installed.', 'plugins.install': 'Install from GitHub',
      'plugins.source.github': 'github', 'plugins.source.local': 'local', 'plugins.localNote': 'Placed by hand in the plugins folder. It cannot be disabled or removed here.',
      'plugins.enabled': 'Enabled', 'plugins.tools': 'Tools', 'plugins.modified': 'Files changed since install. Review the code, or install again.',
      'plugins.scan': 'Scan: high {high} · medium {medium} · info {info}', 'plugins.checkUpdate': 'Check for updates', 'plugins.remove': 'Remove',
      'plugins.removeTitle': 'Remove plugin?', 'plugins.removeBody': 'Remove {name}? Its files are deleted and its "always allow" grants are cleared. This cannot be undone.',
      'plugins.removed': 'Plugin removed.', 'plugins.upToDate': '{name} is up to date.', 'plugins.working': 'Working...',
      'plugins.form.repo': 'Repository (owner/name or GitHub URL)', 'plugins.form.ref': 'Tag, branch or commit (optional)',
      'plugins.form.subdir': 'Subfolder (optional)', 'plugins.form.repoEmpty': 'Enter a repository.',
      'plugins.form.repoBad': 'Use owner/name or a github.com URL.', 'plugins.form.subdirBad': 'The subfolder must not contain "..".',
      'plugins.form.inspect': 'Inspect', 'plugins.form.inspecting': 'Checking...', 'plugins.form.cancel': 'Close',
      'plugins.review.warnTitle': 'Security review', 'plugins.review.warn': 'Plugins run with this server\'s permissions. They can touch files, environment variables (including API keys) and the network. Do not install code from authors you do not trust.',
      'plugins.review.titleInstall': 'Install {name} {version}?', 'plugins.review.titleUpdate': 'Update {name} to {version}?',
      'plugins.review.source': 'Source', 'plugins.review.commit': 'Commit', 'plugins.review.subdir': 'Subfolder: {subdir}',
      'plugins.review.alreadyInstalled': 'A plugin with this id is already installed. Installing replaces it and keeps its enabled state.',
      'plugins.review.tools': 'Tools and declared permissions', 'plugins.review.noPerms': 'no permissions',
      'plugins.review.mismatchTitle': 'Permission mismatch', 'plugins.review.mismatch': '{tool} uses {used}, but declares {declared}.', 'plugins.review.none': 'none',
      'plugins.review.findings': 'Scan findings', 'plugins.review.noFindings': 'No findings.',
      'plugins.review.scanNote': 'The scan is a hint, not a guarantee. It can miss things and flag harmless code.',
      'plugins.review.severity.high': 'High', 'plugins.review.severity.medium': 'Medium', 'plugins.review.severity.info': 'Info',
      'plugins.review.files': 'Files ({n}, {size} in total)', 'plugins.review.notes': 'Notes', 'plugins.review.diff': 'Changes since the installed version',
      'plugins.review.added': 'Added', 'plugins.review.removed': 'Removed', 'plugins.review.changed': 'Changed',
      'plugins.review.toolsAdded': 'New tools: {list}', 'plugins.review.toolsRemoved': 'Removed tools: {list}',
      'plugins.review.permissionsAdded': 'New permissions: {list}', 'plugins.review.noChanges': 'No file changes.',
      'plugins.review.confirmLabel': 'Type the plugin id to confirm: {id}', 'plugins.review.confirmHint': 'Type it exactly as shown.',
      'plugins.review.install': 'Install', 'plugins.review.installUpdate': 'Install update',
      'plugins.installedNotice': '{name} was installed in the disabled state. To enable it, turn on its Enabled switch in the list.',
      'plugins.updatedNotice': '{name} was updated.',
      'plugins.rule.child_process': 'Runs other programs', 'plugins.rule.fs_write': 'Writes, moves or deletes files',
      'plugins.rule.env_access': 'Reads environment variables (may include API keys)', 'plugins.rule.eval': 'Runs code built at run time (eval)',
      'plugins.rule.dynamic_import': 'Imports a module by a computed name', 'plugins.rule.raw_network': 'Uses low-level network access',
      'plugins.rule.fs_read': 'Reads files', 'plugins.rule.obfuscation': 'Possibly obfuscated code',
      'plugins.rule.undeclared_network': 'Uses the network without declaring it',
      'plugins.perm.shell': 'Shell', 'plugins.perm.filesystem-read': 'Read files', 'plugins.perm.filesystem-write': 'Write files', 'plugins.perm.network': 'Network'
    }
  });

  var SEVERITIES = ['high', 'medium', 'info'];

  // "owner/name", "github.com/owner/name" or "https://github.com/owner/name" (optional .git and trailing slashes)
  function normalizeRepo(input) {
    var s = String(input || '').trim();
    if (!s) return null;
    s = s.replace(/^https:\/\/(www\.)?github\.com\//i, '').replace(/^(www\.)?github\.com\//i, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
    s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return null;
    if (s.split('/').some(function (g) { return g === '.' || g === '..'; })) return null;
    return s;
  }
  function normalizeSubdir(input) {
    var s = String(input || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (s.split('/').some(function (g) { return g === '..'; })) return null;
    return s;
  }
  function countFindings(findings) {
    var out = { high: 0, medium: 0, info: 0 };
    (findings || []).forEach(function (f) { out[SEVERITIES.indexOf(f.severity) >= 0 ? f.severity : 'info']++; });
    return out;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function permLabel(p) { var k = 'plugins.perm.' + p; var s = t(k); return s === k ? p : s; }
  function ruleLabel(r) { var k = 'plugins.rule.' + r; var s = t(k); return s === k ? r : s; }
  function list(arr) { return (arr && arr.length) ? arr.join(', ') : t('plugins.review.none'); }

  OC.registerPage({
    id: 'plugins',
    order: 45,
    icon: 'plugin',
    titleKey: 'nav.plugins',
    render: function (root) {
      var alive = true;
      var seq = 0;
      var formOpen = false;
      var repoInput, refInput, subdirInput, inspectBtn;
      var area = h('div', { cls: 'stack' }); // the install form or the security review
      var listBox = h('div', { cls: 'stack' });
      var installBtn = OC.btn(t('plugins.install'), 'primary sm', function () { formOpen = !formOpen; renderArea(); }, 'plugin');
      root.appendChild(OC.pageHeader(t('plugins.title'), t('plugins.sub'), h('div', { cls: 'row' }, [OC.btn(t('common.refresh'), 'sm', load, 'restart'), installBtn])));
      root.appendChild(h('div', { cls: 'stack' }, [area, listBox]));

      function renderArea(review) {
        OC.clear(area);
        if (review) { area.appendChild(review); return; }
        if (formOpen) area.appendChild(installForm());
      }

      function installForm() {
        var err = h('p', { cls: 'alert', attrs: { role: 'alert' }, text: '' });
        err.hidden = true;
        repoInput = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'owner/name' } });
        refInput = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' } });
        subdirInput = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false' } });
        inspectBtn = OC.btn(t('plugins.form.inspect'), 'primary', function () {
          var repo = normalizeRepo(repoInput.value);
          var subdir = normalizeSubdir(subdirInput.value);
          var msg = !repoInput.value.trim() ? t('plugins.form.repoEmpty') : !repo ? t('plugins.form.repoBad') : subdir === null ? t('plugins.form.subdirBad') : null;
          if (msg) { err.textContent = msg; err.hidden = false; return; }
          err.hidden = true;
          inspectBtn.disabled = true; inspectBtn.textContent = t('plugins.form.inspecting');
          OC.invoke('plugin_inspect', { repo: repo, gitRef: refInput.value.trim() || null, subdir: subdir || null }).then(function (ins) {
            if (!alive) return;
            inspectBtn.disabled = false;
            renderArea(reviewCard(ins, null));
          }, function (e) {
            inspectBtn.disabled = false; inspectBtn.textContent = t('plugins.form.inspect');
            err.textContent = e.message; err.hidden = false;
          });
        });
        var close = OC.btn(t('plugins.form.cancel'), 'ghost', function () { formOpen = false; renderArea(); });
        return OC.card(t('plugins.install'), [
          OC.field(t('plugins.form.repo'), repoInput, null, 'pl-repo'),
          OC.field(t('plugins.form.ref'), refInput, null, 'pl-ref'),
          OC.field(t('plugins.form.subdir'), subdirInput, null, 'pl-subdir'),
          err,
          h('div', { cls: 'row' }, [inspectBtn, close])
        ]);
      }

      // Security review for a fresh install (ins from plugin_inspect) or an update (ins from plugin_check_update, with diff).
      function reviewCard(ins, diff) {
        var m = ins.manifest || {};
        var src = ins.source || {};
        var isUpdate = !!diff;
        var counts = countFindings(ins.scan && ins.scan.findings);
        var findings = (ins.scan && ins.scan.findings) || [];
        var mismatch = (ins.scan && ins.scan.permissionMismatch) || [];
        var typed = h('input', { attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('plugins.review.confirmHint') } });
        var go = OC.btn(isUpdate ? t('plugins.review.installUpdate') : t('plugins.review.install'), 'primary', null);
        go.disabled = true;
        typed.addEventListener('input', function () { go.disabled = typed.value !== m.id || !m.id; });
        go.addEventListener('click', function () {
          go.disabled = true;
          OC.invoke('plugin_install', { inspectionId: ins.inspectionId, confirmId: m.id }).then(function (r) {
            if (!alive) return;
            OC.toast(t(isUpdate ? 'plugins.updatedNotice' : 'plugins.installedNotice', { name: m.name || m.id }));
            formOpen = false; renderArea(); load();
          }, function (e) { go.disabled = typed.value !== m.id; OC.toast(e.message, 'err'); });
        });
        var title = (isUpdate ? t('plugins.review.titleUpdate') : t('plugins.review.titleInstall')).replace('{name}', m.name || m.id || '').replace('{version}', m.version || '');
        var kids = [
          h('div', { cls: 'alert', attrs: { role: 'alert' } }, [h('strong', { text: t('plugins.review.warnTitle') + ': ' }), t('plugins.review.warn')]),
          h('dl', { cls: 'kv' }, [
            h('dt', { text: t('plugins.review.source') }), h('dd', { text: (src.repo || '') + (src.ref ? ' @ ' + src.ref : '') }),
            h('dt', { text: t('plugins.review.commit') }), h('dd', { text: (src.commitSha || '').slice(0, 12) }),
            src.subdir ? h('dt', { text: t('plugins.form.subdir') }) : null,
            src.subdir ? h('dd', { text: src.subdir }) : null
          ].filter(Boolean)),
          ins.alreadyInstalled ? h('p', { cls: 'alert warn', text: t('plugins.review.alreadyInstalled') }) : null,
          h('h3', { text: t('plugins.review.tools') }),
          h('ul', {}, (m.tools || []).map(function (tool) {
            return h('li', {}, [h('strong', { text: tool.name }), ' ', h('span', { cls: 'small muted', text: (tool.permissions || []).map(permLabel).join(', ') || t('plugins.review.noPerms') }), tool.description ? h('div', { cls: 'hint', text: tool.description }) : null]);
          })),
          mismatch.length ? h('div', { cls: 'alert warn' }, [h('strong', { text: t('plugins.review.mismatchTitle') })].concat(mismatch.map(function (x) {
            return h('div', { text: t('plugins.review.mismatch', { tool: x.tool, used: list(x.used), declared: list(x.declared) }) });
          }))) : null,
          h('h3', { text: t('plugins.review.findings') }),
          h('p', { cls: 'hint', text: t('plugins.review.scanNote') }),
          findings.length ? h('div', { cls: 'stack' }, SEVERITIES.map(function (sev) {
            var rows = findings.filter(function (f) { return (SEVERITIES.indexOf(f.severity) >= 0 ? f.severity : 'info') === sev; });
            if (!rows.length) return null;
            return h('div', { cls: 'stack' }, [h('strong', { text: t('plugins.review.severity.' + sev) + ' (' + counts[sev] + ')' })].concat(rows.map(function (f) {
              return h('div', { cls: 'list-item' }, [h('div', { cls: 'grow' }, [
                h('div', { text: ruleLabel(f.rule) }),
                h('div', { cls: 'small muted', text: f.file + (f.line ? ':' + f.line : '') }),
                f.snippet ? h('pre', { cls: 'mono', text: String(f.snippet).slice(0, 300) }) : null
              ])]);
            })));
          }).filter(Boolean)) : h('p', { cls: 'hint', text: t('plugins.review.noFindings') }),
          (ins.warnings && ins.warnings.length) ? h('div', {}, [h('strong', { text: t('plugins.review.notes') })].concat(ins.warnings.map(function (w) { return h('p', { cls: 'hint', text: w }); }))) : null,
          isUpdate ? h('div', {}, [h('h3', { text: t('plugins.review.diff') }), diffView(diff)]) : null,
          h('details', {}, [
            h('summary', { text: t('plugins.review.files', { n: (ins.files || []).length, size: formatBytes(ins.totalBytes || 0) }) }),
            h('ul', { cls: 'small' }, (ins.files || []).map(function (f) { return h('li', { text: f.path + '  (' + formatBytes(f.size) + ')' }); }))
          ]),
          h('div', { cls: 'field' }, [h('label', { text: t('plugins.review.confirmLabel', { id: m.id || '' }) }), typed, h('p', { cls: 'hint', text: t('plugins.review.confirmHint') })]),
          h('div', { cls: 'row' }, [go, OC.btn(t('plugins.form.cancel'), 'ghost', function () { renderArea(); })])
        ];
        return OC.card(title, kids);
      }

      function diffView(d) {
        if (!d || (!d.added.length && !d.removed.length && !d.changed.length && !d.toolsAdded.length && !d.toolsRemoved.length && !(d.permissionsAdded || []).length)) {
          return h('p', { cls: 'hint', text: t('plugins.review.noChanges') });
        }
        var lines = [];
        if (d.added.length) lines.push(t('plugins.review.added') + ': ' + d.added.join(', '));
        if (d.removed.length) lines.push(t('plugins.review.removed') + ': ' + d.removed.join(', '));
        if (d.changed.length) lines.push(t('plugins.review.changed') + ': ' + d.changed.join(', '));
        if (d.toolsAdded.length) lines.push(t('plugins.review.toolsAdded', { list: d.toolsAdded.join(', ') }));
        if (d.toolsRemoved.length) lines.push(t('plugins.review.toolsRemoved', { list: d.toolsRemoved.join(', ') }));
        if ((d.permissionsAdded || []).length) lines.push(t('plugins.review.permissionsAdded', { list: d.permissionsAdded.map(function (p) { return p.tool + ': ' + permLabel(p.permission); }).join(', ') }));
        return h('div', { cls: 'stack small' }, lines.map(function (l) { return h('p', { text: l }); }));
      }

      function checkUpdate(p, btn) {
        btn.disabled = true;
        OC.invoke('plugin_check_update', { id: p.id }).then(function (r) {
          btn.disabled = false;
          if (!alive) return;
          if (!r.updateAvailable) { OC.toast(t('plugins.upToDate', { name: p.name || p.id })); return; }
          formOpen = false;
          renderArea(reviewCard(r, r.diff || { added: [], removed: [], changed: [], toolsAdded: [], toolsRemoved: [], permissionsAdded: [] }));
          area.scrollIntoView && area.scrollIntoView({ block: 'start' });
        }, function (e) { btn.disabled = false; OC.toast(e.message, 'err'); });
      }

      function pluginRow(p) {
        var managed = p.source === 'github';
        var sw = OC.switchRow(t('plugins.enabled'), null, !!p.enabled, function (on, inp) {
          inp.disabled = true;
          OC.invoke('plugin_set_enabled', { id: p.id, enabled: on }).then(function () { inp.disabled = false; load(); }, function (e) {
            inp.disabled = false; inp.checked = !on; OC.toast(e.message, 'err');
          });
        });
        var swInput = sw.querySelector('input');
        if (!managed) swInput.disabled = true;
        var scan = p.scan ? t('plugins.scan', { high: p.scan.high || 0, medium: p.scan.medium || 0, info: p.scan.info || 0 }) : null;
        var actions = managed ? [
          OC.btn(t('plugins.checkUpdate'), 'sm', function (e) { checkUpdate(p, e && e.currentTarget ? e.currentTarget : this); }, 'restart'),
          OC.btn(t('plugins.remove'), 'sm danger', function () { removePlugin(p); })
        ] : [];
        return h('div', { cls: 'list-item' }, [
          h('div', { cls: 'grow' }, [
            h('div', { cls: 'row' }, [h('strong', { text: (p.name || p.id) + (p.version ? ' ' + p.version : '') }), OC.chip(managed ? 'ok' : 'plain', t('plugins.source.' + (managed ? 'github' : 'local')), true)]),
            h('div', { cls: 'small muted', text: p.id + (p.repo ? ' · ' + p.repo : '') }),
            p.description ? h('div', { cls: 'hint', text: p.description }) : null,
            h('div', { cls: 'row' }, (p.tools || []).map(function (tool) {
              return OC.chip(tool.available === false ? 'err' : 'plain', tool.name + (tool.available === false && tool.error ? ' (' + tool.error + ')' : ''), tool.available !== false);
            })),
            scan ? h('div', { cls: 'small muted', text: scan }) : null,
            p.modified ? h('p', { cls: 'alert warn', text: t('plugins.modified') }) : null,
            !managed ? h('p', { cls: 'hint', text: t('plugins.localNote') }) : null
          ]),
          h('div', { cls: 'stack' }, [h('label', { cls: 'row' }, [sw]), h('div', { cls: 'row' }, actions)])
        ]);
      }

      function removePlugin(p) {
        OC.confirm(t('plugins.removeTitle'), t('plugins.removeBody', { name: p.name || p.id }), t('plugins.remove'), true).then(function (ok) {
          if (!ok) return;
          OC.invoke('plugin_delete', { id: p.id }).then(function () { OC.toast(t('plugins.removed')); load(); }, function (e) { OC.toast(e.message, 'err'); });
        });
      }

      function load() {
        if (!alive) return;
        if (OC.state && !OC.state.running) { OC.clear(listBox); listBox.appendChild(OC.card(t('plugins.installed'), [OC.empty('∅', t('common.serverStopped'), t('common.startFirst'))])); return; }
        var my = ++seq;
        OC.invoke('plugins_get').then(function (r) {
          if (!alive || my !== seq) return;
          var plugins = (r && r.plugins) || [];
          OC.clear(listBox);
          listBox.appendChild(OC.card(t('plugins.installed'), plugins.length ? plugins.map(pluginRow) : [OC.empty('∅', t('plugins.empty'))]));
        }, function (e) {
          if (!alive || my !== seq) return;
          OC.clear(listBox);
          listBox.appendChild(OC.card(t('plugins.installed'), [h('p', { cls: 'alert', text: e.message, attrs: { role: 'alert' } })]));
        });
      }

      load();
      return { onState: function (s) { if (s && !s.running) load(); }, destroy: function () { alive = false; } };
    }
  });
})();
