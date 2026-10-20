// Attachments page: server-wide limits for chat attachments (docs/design/ATTACHMENTS.md). Auto-deletion is shown with a warning.
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'nav.attachments': '添付', 'att.title': '添付', 'att.sub': 'チャットに添付できるファイルの上限と保存期間を決めます。',
      'att.limits': '上限', 'att.limitsSub': '0 は無制限(容量の上限のみ)。変更は次の要求から有効です。',
      'att.maxFileMB': '1 ファイルの上限 (MB)', 'att.quotaMB': '1 ユーザーの保存の合計 (MB, 0 = 無制限)',
      'att.maxPerMessage': '1 メッセージの添付数', 'att.extractMaxChars': 'AI に渡す文書テキストの上限 (文字)',
      'att.retention': '保存期間', 'att.retentionDays': '保存日数 (0 = 無期限)',
      'att.retentionWarn': '{n} 日たった添付は、自動で削除されます。元に戻せません。削除の前の予告はしません。',
      'att.retentionOff': '自動削除は行われません(無期限)。',
      'att.retentionConfirmTitle': '自動削除を設定しますか？',
      'att.retentionConfirm': '{n} 日たった添付は、ファイルごと自動で削除されます。削除されたファイルは元に戻せません。',
      'att.transcribe': '音声の文字起こしモデル', 'att.transcribeHint': '<providerId>::<model> の形式。空なら音声は AI に渡しません。',
      'att.transcribeClear': '文字起こしを off にする', 'att.save': '保存', 'att.saveErr': '値が正しくありません',
      'att.rangeErr': '{name} は {min} 〜 {max} の範囲で入力してください。', 'att.nothing': '変更はありません。'
    },
    en: {
      'nav.attachments': 'Attachments', 'att.title': 'Attachments', 'att.sub': 'Limits and retention for files that users attach to chats.',
      'att.limits': 'Limits', 'att.limitsSub': '0 means unlimited (quota only). Changes apply to the next request.',
      'att.maxFileMB': 'Per-file limit (MB)', 'att.quotaMB': 'Total storage per user (MB, 0 = unlimited)',
      'att.maxPerMessage': 'Attachments per message', 'att.extractMaxChars': 'Document text passed to the AI (characters)',
      'att.retention': 'Retention', 'att.retentionDays': 'Keep for (days, 0 = forever)',
      'att.retentionWarn': 'Attachments older than {n} days are deleted automatically. This cannot be undone. There is no advance notice.',
      'att.retentionOff': 'Nothing is deleted automatically (kept forever).',
      'att.retentionConfirmTitle': 'Turn on automatic deletion?',
      'att.retentionConfirm': 'Attachments older than {n} days will be deleted, files included. Deleted files cannot be restored.',
      'att.transcribe': 'Speech transcription model', 'att.transcribeHint': 'Format: <providerId>::<model>. When empty, audio is not passed to the AI.',
      'att.transcribeClear': 'Turn transcription off', 'att.save': 'Save', 'att.saveErr': 'A value is out of range',
      'att.rangeErr': '{name} must be between {min} and {max}.', 'att.nothing': 'Nothing to change.'
    }
  });

  // key, label key, min, max
  var NUMS = [
    ['maxFileMB', 'att.maxFileMB', 1, 500],
    ['quotaMB', 'att.quotaMB', 0, 1000000],
    ['maxPerMessage', 'att.maxPerMessage', 1, 50],
    ['extractMaxChars', 'att.extractMaxChars', 1000, 500000],
    ['retentionDays', 'att.retentionDays', 0, 3650]
  ];

  OC.registerPage({
    id: 'attachments',
    order: 66,
    icon: 'attachments',
    titleKey: 'nav.attachments',
    render: function (root) {
      var alive = true;
      var loaded = null;
      var inputs = {};
      var transcribeInput, clearBox;
      var content = h('div', { cls: 'stack' });
      root.appendChild(OC.pageHeader(t('att.title'), t('att.sub'), OC.btn(t('common.refresh'), 'sm', load, 'restart')));
      root.appendChild(content);

      function show(nodes) { OC.clear(content); nodes.forEach(function (n) { content.appendChild(n); }); }

      function load() {
        if (!alive) return;
        if (OC.state && !OC.state.running) { show([OC.card(t('att.title'), [OC.empty('∅', t('common.serverStopped'), t('common.startFirst'))])]); return; }
        show([OC.card(t('att.title'), [h('div', { cls: 'stack' }, [h('div', { cls: 'skeleton' }), h('div', { cls: 'skeleton' })])])]);
        OC.invoke('attachments_get').then(function (r) {
          if (!alive) return;
          loaded = (r && r.attachments) || {};
          draw();
        }, function (e) {
          if (!alive) return;
          show([OC.card(t('att.title'), [h('p', { cls: 'alert', text: e.message, attrs: { role: 'alert' } })])]);
        });
      }

      function numField(key, labelKey) {
        var inp = h('input', { attrs: { type: 'number', min: 0, step: 1, inputmode: 'numeric' }, value: loaded[key] });
        inputs[key] = inp;
        return OC.field(t(labelKey), inp, null, 'att-' + key);
      }

      function retentionWarning() {
        var box = h('p', { cls: 'alert warn', attrs: { role: 'note' } });
        function paint() {
          var n = Number(inputs.retentionDays.value);
          box.textContent = n > 0 ? t('att.retentionWarn', { n: n }) : t('att.retentionOff');
          box.className = n > 0 ? 'alert warn' : 'hint';
        }
        inputs.retentionDays.addEventListener('input', paint);
        paint();
        return box;
      }

      function draw() {
        inputs = {};
        var limits = NUMS.slice(0, 4).map(function (n) { return numField(n[0], n[1]); });
        var transcribe = loaded.transcribeModel || '';
        transcribeInput = h('input', { attrs: { type: 'text', maxlength: 200, autocomplete: 'off', spellcheck: 'false' }, value: transcribe });
        clearBox = h('input', { attrs: { type: 'checkbox' } });
        var clearLabel = h('label', { cls: 'row' }, [clearBox, h('span', { text: t('att.transcribeClear') })]);
        var save = OC.btn(t('att.save'), 'primary', function () { onSave(save); });
        var retention = [numField('retentionDays', 'att.retentionDays'), retentionWarning()];
        show([
          OC.card(t('att.limits'), limits, t('att.limitsSub')),
          OC.card(t('att.retention'), retention),
          OC.card(t('att.transcribe'), [
            OC.field(t('att.transcribe'), transcribeInput, t('att.transcribeHint'), 'att-transcribe'),
            clearLabel
          ]),
          h('div', { cls: 'row' }, [save])
        ]);
      }

      function onSave(btn) {
        var body = {}; var err = null;
        NUMS.forEach(function (n) {
          if (err) return;
          var raw = String(inputs[n[0]].value).trim();
          var v = Number(raw);
          if (raw === '' || !Number.isInteger(v) || v < n[2] || v > n[3]) {
            err = t('att.rangeErr', { name: t(n[1]), min: n[2], max: n[3] });
            return;
          }
          if (v !== Number(loaded[n[0]])) body[n[0]] = v;
        });
        if (err) { OC.toast(err, 'err'); return; }
        var clear = clearBox.checked;
        var model = transcribeInput.value.trim();
        if (clear && !(loaded.transcribeModel)) clear = false;
        if (clear) body.clearTranscribe = true;
        else if (model !== (loaded.transcribeModel || '')) {
          if (model && !/::/.test(model)) { OC.toast(t('att.transcribeHint'), 'err'); return; }
          if (model) body.transcribeModel = model;
        }
        if (!Object.keys(body).length && !clear) { OC.toast(t('att.nothing')); return; }
        var newDays = body.retentionDays;
        var needConfirm = newDays !== undefined && newDays > 0 && newDays !== Number(loaded.retentionDays);
        var go = needConfirm
          ? OC.confirm(t('att.retentionConfirmTitle'), t('att.retentionConfirm', { n: newDays }), t('common.save'), true)
          : Promise.resolve(true);
        go.then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          // only the changed fields are sent (the Rust side forwards the given ones)
          OC.invoke('attachments_set', {
            maxFileMb: body.maxFileMB, quotaMb: body.quotaMB, retentionDays: body.retentionDays,
            maxPerMessage: body.maxPerMessage, extractMaxChars: body.extractMaxChars,
            transcribeModel: body.transcribeModel, clearTranscribeModel: !!body.clearTranscribe
          }).then(function (r) {
            btn.disabled = false;
            loaded = (r && r.attachments) || loaded;
            OC.toast(t('common.saved'));
            if (alive) draw();
          }, function (e) { btn.disabled = false; OC.toast(e.message, 'err'); });
        });
      }

      load();
      return { onState: function (s) { if (s && !s.running) load(); }, destroy: function () { alive = false; } };
    }
  });
})();
