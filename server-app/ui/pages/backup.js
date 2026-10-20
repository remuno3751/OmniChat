// Backup page: list, create, restore (a safety backup is taken first), delete, open folder.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'backup.sub': 'データベースのバックアップを作成・復元します',
      'backup.create': '今すぐバックアップを作成',
      'backup.openFolder': 'バックアップフォルダを開く',
      'backup.listTitle': 'バックアップ一覧',
      'backup.schedule': '自動バックアップ: {h} 時間ごと・最新 {k} 件を保持',
      'backup.scheduleOff': '自動バックアップは無効です（設定で変更できます）',
      'backup.stoppedInfo': 'サーバーが停止中です。バックアップの作成と復元は、サーバーの起動後に行えます。',
      'backup.empty': 'バックアップはまだありません',
      'backup.emptySub': '「今すぐバックアップを作成」で最初のバックアップを作れます。',
      'backup.loadError': 'バックアップ一覧を読み込めませんでした',
      'backup.restore': '復元',
      'backup.deleteTitle': 'バックアップを削除しますか？',
      'backup.deleteText': '「{name}」を削除します。この操作は取り消せません。',
      'backup.restoreTitle': 'バックアップから復元',
      'backup.restoreBody': '「{name}」の内容で、現在のデータベースを置き換えます。',
      'backup.restoreStep1': 'サーバーが停止します。',
      'backup.restoreStep2': '現在のデータベースは、復元の前に自動でバックアップされます。',
      'backup.restoreStep3': '復元が終わると、サーバーは自動的に再起動します。',
      'backup.restoreWarn': '復元後、そのバックアップ以降の変更は見えなくなります。復元前に作成した安全用バックアップから戻すこともできます。',
      'backup.restoreConfirm': '復元する',
      'backup.restoring': '復元中…',
      'backup.safetyDone': '復元前のバックアップを作成しました: {name}',
      'backup.created': 'バックアップを作成しました',
      'backup.deleted': 'バックアップを削除しました',
      'backup.restored': 'バックアップから復元しました'
    },
    en: {
      'backup.sub': 'Create and restore database backups.',
      'backup.create': 'Create backup now',
      'backup.openFolder': 'Open backups folder',
      'backup.listTitle': 'Backups',
      'backup.schedule': 'Automatic: every {h} hours, keeping the latest {k}.',
      'backup.scheduleOff': 'Automatic backups are off (change this in Settings).',
      'backup.stoppedInfo': 'The server is stopped. Start it to create or restore backups.',
      'backup.empty': 'No backups yet',
      'backup.emptySub': 'Use “Create backup now” to make the first one.',
      'backup.loadError': 'Could not load the backup list',
      'backup.restore': 'Restore',
      'backup.deleteTitle': 'Delete this backup?',
      'backup.deleteText': 'Delete “{name}”? This cannot be undone.',
      'backup.restoreTitle': 'Restore from backup',
      'backup.restoreBody': 'This replaces the current database with “{name}”.',
      'backup.restoreStep1': 'The server will stop.',
      'backup.restoreStep2': 'The current database is backed up automatically first.',
      'backup.restoreStep3': 'The server restarts automatically when the restore finishes.',
      'backup.restoreWarn': 'After restoring, changes made after this backup are no longer visible. The safety backup taken just before can bring them back.',
      'backup.restoreConfirm': 'Restore',
      'backup.restoring': 'Restoring…',
      'backup.safetyDone': 'Safety backup created: {name}',
      'backup.created': 'Backup created',
      'backup.deleted': 'Backup deleted',
      'backup.restored': 'Restored from backup'
    }
  });

  function running() { return !!(OC.state && OC.state.running); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function scheduleText(e) {
    if (!e) return '';
    var hrs = num(e.backupIntervalHours, 24), keep = num(e.backupKeep, 10);
    return hrs ? t('backup.schedule', { h: hrs, k: keep }) : t('backup.scheduleOff');
  }

  OC.registerPage({ id: 'backup', order: 80, icon: 'backup', titleKey: 'nav.backup', render: render });

  function render(root) {
    root.classList.add('p-backup');
    var alive = true, creating = false;

    var createBtn = OC.btn(t('backup.create'), 'primary', createBackup, 'backup');
    createBtn.disabled = !running();
    var folderBtn = OC.btn(t('backup.openFolder'), '', function () { OC.safe(OC.invoke('open_folder', { which: 'backups' })); }, 'external');
    root.appendChild(OC.pageHeader(t('nav.backup'), t('backup.sub'), h('div', { cls: 'row' }, [createBtn, folderBtn])));

    var schedule = h('p', { cls: 'hint' });
    var stopNote = h('div', { cls: 'alert warn', text: t('backup.stoppedInfo') });
    stopNote.hidden = running();
    var listArea = h('div', { cls: 'stack' });
    root.appendChild(h('section', { cls: 'card' }, [
      h('h2', { text: t('backup.listTitle') }),
      schedule,
      stopNote,
      listArea
    ]));

    function load() {
      OC.clear(listArea);
      listArea.appendChild(h('div', { cls: 'stack' }, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })]));
      Promise.all([
        OC.invoke('backups_list'),
        OC.invoke('get_extra').catch(function () { return null; })
      ]).then(function (r) {
        if (!alive) return;
        var list = ((r[0] && r[0].backups) || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        schedule.textContent = scheduleText(r[1]);
        renderList(list);
      }, function (e) {
        if (!alive) return;
        OC.clear(listArea);
        listArea.appendChild(h('p', { cls: 'alert', text: t('backup.loadError') + ': ' + e.message }));
      });
    }

    function renderList(list) {
      OC.clear(listArea);
      if (!list.length) {
        listArea.appendChild(OC.empty(null, t('backup.empty'), t('backup.emptySub')));
        return;
      }
      var box = h('div', { cls: 'list' });
      list.forEach(function (b) {
        var restore = OC.btn(t('backup.restore'), 'sm', function () { confirmRestore(b.name); });
        restore.setAttribute('data-restore', '1');
        restore.disabled = !running();
        var meta = [OC.fmtBytes(b.size), b.createdAt ? OC.fmtDate(b.createdAt) : ''].filter(Boolean).join('  ·  ');
        box.appendChild(h('div', { cls: 'list-item' }, [
          h('div', { cls: 'grow' }, [
            h('div', { cls: 'mono', text: String(b.name) }),
            h('div', { cls: 'hint', text: meta })
          ]),
          restore,
          OC.btn(t('common.delete'), 'sm danger', function () { confirmDelete(b.name); })
        ]));
      });
      listArea.appendChild(box);
    }

    function confirmDelete(name) {
      OC.confirm(t('backup.deleteTitle'), t('backup.deleteText', { name: name }), t('common.delete'), true).then(function (ok) {
        if (!ok || !alive) return;
        OC.invoke('backup_delete', { name: name }).then(function () {
          OC.toast(t('backup.deleted'));
          if (alive) load();
        }, function (e) { OC.toast(e.message, 'err'); });
      });
    }

    // Restore: the current DB is backed up first (backup_create), then backup_restore runs.
    function confirmRestore(name) {
      if (!running()) return;
      var working = false, close = null;
      close = OC.modal({
        title: t('backup.restoreTitle'),
        body: [
          h('p', { text: t('backup.restoreBody', { name: name }) }),
          h('ul', { cls: 'stack small' }, [
            h('li', { text: t('backup.restoreStep1') }),
            h('li', { text: t('backup.restoreStep2') }),
            h('li', { text: t('backup.restoreStep3') })
          ]),
          h('p', { cls: 'alert warn', text: t('backup.restoreWarn') })
        ],
        actions: [
          { text: t('common.cancel'), onClick: function () { return working; } },
          { text: t('backup.restoreConfirm'), cls: 'danger', onClick: function () {
            if (working) return true;
            working = true;
            var okBtn = OC.$('modal').querySelector('.btn.danger');
            if (okBtn) { okBtn.disabled = true; okBtn.textContent = t('backup.restoring'); }
            OC.invoke('backup_create').then(function (b) {
              OC.toast(t('backup.safetyDone', { name: b && b.name ? b.name : '' }));
              return OC.invoke('backup_restore', { name: name });
            }).then(function (s) {
              working = false;
              close();
              OC.setState(s);
              OC.toast(t('backup.restored'));
              if (alive) load();
            }, function (e) {
              working = false;
              close();
              OC.toast(e.message, 'err');
              if (alive) load();
            });
            return true;
          } }
        ]
      });
    }

    function createBackup() {
      if (!running() || creating) return;
      creating = true;
      createBtn.disabled = true;
      OC.invoke('backup_create').then(function () {
        OC.toast(t('backup.created'));
      }, function (e) {
        OC.toast(e.message, 'err');
      }).then(function () {
        creating = false;
        if (!alive) return;
        createBtn.disabled = !running();
        load();
      });
    }

    load();

    return {
      onState: function (s) {
        if (!alive) return;
        var on = !!s.running;
        createBtn.disabled = !on || creating;
        stopNote.hidden = on;
        Array.prototype.forEach.call(listArea.querySelectorAll('[data-restore]'), function (b) { b.disabled = !on; });
      },
      destroy: function () { alive = false; }
    };
  }
})();
