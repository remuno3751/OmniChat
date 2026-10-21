// Statistics page: tokens, active time and last activity per user, plus the total of all users (GET /usage/users through the local admin API).
(function () {
  'use strict';
  var OC = window.OC;
  var h = OC.h;
  var t = OC.t;

  OC.addStrings({
    ja: {
      'nav.stats': '統計', 'stats.title': '利用統計', 'stats.sub': 'ユーザーごと・全体のトークン使用量とアクティブな時間です。「消えるチャット」は数えません。',
      'stats.p.1': '今日', 'stats.p.7': '7 日', 'stats.p.30': '30 日', 'stats.p.0': '全期間',
      'stats.total': '合計トークン', 'stats.prompt': '入力', 'stats.completion': '出力', 'stats.reasoning': 'うち思考',
      'stats.messages': '回答数', 'stats.chats': 'チャット数', 'stats.activeUsers': '利用したユーザー', 'stats.activeTime': 'アクティブ時間',
      'stats.activeDays': '利用日数', 'stats.last': '最後の利用', 'stats.generation': '生成時間', 'stats.never': '—',
      'stats.all': '全ユーザーの合計', 'stats.users': 'ユーザーごと', 'stats.empty': 'この期間の利用はまだありません。',
      'stats.noUsers': 'ユーザーがいません。', 'stats.estimated': '一部のトークン数は推定値です。',
      'stats.note': 'アクティブ時間は、回答があった 5 分ごとの枠を数えた下限の目安です(返答待ちや読んでいる時間は含みません)。',
      'stats.disabled': '無効', 'stats.loadError': '読み込めませんでした。', 'stats.of': '全体の {p}%',
      'stats.charts': '日ごとの推移', 'stats.daily': '日ごとのトークン使用量', 'stats.dailyAnswers': '日ごとの回答数', 'stats.byUserLines': 'ユーザー別の推移', 'stats.kindBar': '棒グラフ', 'stats.kindLine': '折れ線', 'stats.metricTokens': 'トークン', 'stats.metricAnswers': '回答数', 'stats.d14': '14 日', 'stats.d30': '30 日', 'stats.d90': '90 日', 'stats.heat': '利用の濃さ(過去 26 週)', 'stats.heatHint': '色が濃い日ほど、トークンを多く使っています。日付にカーソルを合わせると数が出ます。',
      'stats.detail': '詳細', 'stats.back': '← 全員の統計に戻る', 'stats.userTitle': '{name} の統計', 'stats.dayTip': '{day}: {n} トークン / {m} 回答',
      'stats.less': '少', 'stats.more': '多', 'stats.legendIO': '入力', 'stats.legendOut': '出力', 'stats.noDaily': 'まだ利用がありません。', 'stats.periodNote': '上の表と数字は、選んだ期間の値です。グラフは、グラフの上のボタンで日数を選びます(ヒートマップは常に過去 26 週)。'
    },
    en: {
      'nav.stats': 'Statistics', 'stats.title': 'Usage statistics', 'stats.sub': 'Tokens and active time per user and for everyone. Ephemeral chats are not counted.',
      'stats.p.1': 'Today', 'stats.p.7': '7 days', 'stats.p.30': '30 days', 'stats.p.0': 'All time',
      'stats.total': 'Total tokens', 'stats.prompt': 'Input', 'stats.completion': 'Output', 'stats.reasoning': 'thinking',
      'stats.messages': 'Answers', 'stats.chats': 'Chats', 'stats.activeUsers': 'Active users', 'stats.activeTime': 'Active time',
      'stats.activeDays': 'Active days', 'stats.last': 'Last active', 'stats.generation': 'Generation time', 'stats.never': '—',
      'stats.all': 'All users combined', 'stats.users': 'Per user', 'stats.empty': 'No usage in this period yet.',
      'stats.noUsers': 'No users.', 'stats.estimated': 'Some token counts are estimates.',
      'stats.note': 'Active time counts the 5-minute slots that contain an answer: a lower bound that leaves out reading and waiting time.',
      'stats.disabled': 'disabled', 'stats.loadError': 'Could not load.', 'stats.of': '{p}% of all',
      'stats.charts': 'Day by day', 'stats.daily': 'Tokens per day', 'stats.dailyAnswers': 'Answers per day', 'stats.byUserLines': 'Per user', 'stats.kindBar': 'Bars', 'stats.kindLine': 'Lines', 'stats.metricTokens': 'Tokens', 'stats.metricAnswers': 'Answers', 'stats.d14': '14 days', 'stats.d30': '30 days', 'stats.d90': '90 days', 'stats.heat': 'Activity (last 26 weeks)', 'stats.heatHint': 'Darker days used more tokens. Hover a day for the number.',
      'stats.detail': 'Details', 'stats.back': '← Back to everyone', 'stats.userTitle': 'Statistics of {name}', 'stats.dayTip': '{day}: {n} tokens / {m} answers',
      'stats.less': 'Less', 'stats.more': 'More', 'stats.legendIO': 'Input', 'stats.legendOut': 'Output', 'stats.noDaily': 'No usage yet.', 'stats.periodNote': 'The cards and table follow the chosen period. The graphs have their own day buttons (the heat map always shows 26 weeks).'
    }
  });

  var PERIODS = [1, 7, 30, 0];

  function n(v) { return Number(v || 0).toLocaleString(); }
  // 1,234 / 12.3K / 4.56M for the big cards
  function compact(v) {
    v = Number(v || 0);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'G';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M';
    if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return n(v);
  }
  function mins(m) { return Number(m) > 0 ? OC.fmtDuration(Number(m) * 60) : '0'; }
  function stat(label, value, sub) {
    return h('section', { cls: 'card' }, [h('div', { cls: 'stat' }, [h('h3', { text: label }), h('span', { cls: 'num', text: value }), sub ? h('span', { cls: 'hint', text: sub }) : null])]);
  }

  // ---- charts (plain DOM / SVG; colors come from CSS variables, sizes by CSSOM or SVG attributes because the CSP blocks style attributes) ----
  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, kids) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function dayTip(d) { return t('stats.dayTip', { day: d.day, n: n(d.totalTokens), m: n(d.messages) }); }
  function outTok(d) { return Math.max(0, (d.completionTokens || 0) - (d.reasoningTokens || 0)); }

  // Chart settings shared by the overview and the user pages (kept while the page lives)
  var chartOpt = { kind: 'bar', metric: 'tokens', days: 30 };

  // stacked bars: input (black), output (yellow), thinking (orange); or answers per day
  function barChart(list, metric) {
    var val = metric === 'answers' ? function (d) { return d.messages || 0; } : function (d) { return d.totalTokens; };
    var max = Math.max.apply(null, list.map(val).concat([1]));
    var cols = list.map(function (d, i) {
      var stack = h('div', { cls: 'bc-stack' });
      if (metric === 'answers') {
        var a = h('div', { cls: 'bc-out' }); a.style.height = Math.round(val(d) * 100 / max) + '%'; stack.appendChild(a);
      } else {
        var th = h('div', { cls: 'bc-think' }); th.style.height = Math.round((d.reasoningTokens || 0) * 100 / max) + '%';
        var ou = h('div', { cls: 'bc-out' }); ou.style.height = Math.round(outTok(d) * 100 / max) + '%';
        var inn = h('div', { cls: 'bc-in' }); inn.style.height = Math.round((d.promptTokens || 0) * 100 / max) + '%';
        stack.appendChild(th); stack.appendChild(ou); stack.appendChild(inn);
      }
      var step = list.length > 40 ? 10 : list.length > 16 ? 5 : 2;
      var lab = h('span', { cls: 'bc-lab', text: ((list.length - 1 - i) % step === 0) ? d.day.slice(5) : '' });
      return h('div', { cls: 'bc-col', attrs: { title: dayTip(d) } }, [stack, lab]);
    });
    return h('div', { cls: 'bc' }, [h('div', { cls: 'bc-bars' }, cols), legend(metric), h('span', { cls: 'hint', text: 'max ' + compact(max) })]);
  }

  function legend(metric) {
    var items = metric === 'answers' ? [['lg-out', t('stats.messages')]] : [['lg-in', t('stats.legendIO')], ['lg-out', t('stats.legendOut')], ['lg-think', t('stats.reasoning')]];
    var kids = [];
    items.forEach(function (x) { kids.push(h('span', { cls: 'lg-sw ' + x[0] })); kids.push(h('span', { cls: 'hint', text: x[1] })); });
    return h('div', { cls: 'row chart-legend' }, kids);
  }

  // line chart: series = [{ cls, points: [number], dash }]; x = day index, shared y axis
  function lineChart(list, series, fmt) {
    var W = 720, H = 190, PL = 8, PR = 8, PT = 10, PB = 22;
    var max = 1;
    series.forEach(function (s) { s.points.forEach(function (v) { if (v > max) max = v; }); });
    var nn = list.length;
    var X = function (i) { return PL + (nn <= 1 ? (W - PL - PR) / 2 : i * (W - PL - PR) / (nn - 1)); };
    var Y = function (v) { return PT + (H - PT - PB) * (1 - v / max); };
    var kids = [];
    [0, 0.5, 1].forEach(function (f) { kids.push(sv('line', { x1: PL, x2: W - PR, y1: Y(max * f), y2: Y(max * f), 'class': 'lc-grid' })); });
    series.forEach(function (s, si) {
      var pts = s.points.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
      if (s.area) kids.push(sv('polygon', { points: X(0).toFixed(1) + ',' + Y(0).toFixed(1) + ' ' + pts + ' ' + X(nn - 1).toFixed(1) + ',' + Y(0).toFixed(1), 'class': 'lc-area ' + s.cls }));
      kids.push(sv('polyline', { points: pts, fill: 'none', 'class': 'lc-line ' + s.cls + (s.dash ? ' lc-dash' : ''), 'stroke-linejoin': 'round' }));
    });
    // hover targets with a tooltip per day (the first series carries the text)
    var main = series[0];
    list.forEach(function (d, i) {
      var tip = fmt ? fmt(d, i) : dayTip(d);
      kids.push(sv('circle', { cx: X(i).toFixed(1), cy: Y(main.points[i]).toFixed(1), r: 5, 'class': 'lc-dot ' + main.cls }, [sv('title', {}, [document.createTextNode(tip)])]));
    });
    var step = nn > 40 ? 10 : nn > 16 ? 5 : 2;
    list.forEach(function (d, i) {
      if ((nn - 1 - i) % step !== 0) return;
      var tx = sv('text', { x: X(i).toFixed(1), y: H - 6, 'text-anchor': i === nn - 1 ? 'end' : 'middle', 'class': 'lc-lab' }); tx.textContent = d.day.slice(5); kids.push(tx);
    });
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'class': 'lc', role: 'img' }, kids);
    return svg;
  }

  // GitHub-style calendar: one column per week (Sunday first), seven rows; yellow ramp up to black
  function heatmap(daysList) {
    var max = Math.max.apply(null, daysList.map(function (d) { return d.totalTokens; }).concat([1]));
    function level(v) { if (v <= 0) return 0; var r = v / max; return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4; }
    var weeks = [];
    var week = [];
    if (daysList.length) {
      var first = new Date(daysList[0].day + 'T00:00:00Z').getUTCDay();
      for (var k = 0; k < first; k++) week.push(null);
    }
    daysList.forEach(function (d) { week.push(d); if (week.length === 7) { weeks.push(week); week = []; } });
    if (week.length) weeks.push(week);
    var cols = weeks.map(function (w) {
      var cells = [];
      for (var i = 0; i < 7; i++) {
        var d = w[i];
        cells.push(d ? h('span', { cls: 'hm-cell l' + level(d.totalTokens), attrs: { title: dayTip(d) } }) : h('span', { cls: 'hm-cell hm-empty' }));
      }
      return h('div', { cls: 'hm-col' }, cells);
    });
    var legendKids = [h('span', { cls: 'hint', text: t('stats.less') })].concat([0, 1, 2, 3, 4].map(function (l) { return h('span', { cls: 'hm-cell l' + l }); }), [h('span', { cls: 'hint', text: t('stats.more') })]);
    return h('div', { cls: 'hm' }, [h('div', { cls: 'hm-grid' }, cols), h('div', { cls: 'row chart-legend' }, legendKids)]);
  }

  // a card whose title holds a user name: the theme must not upper-case it
  function keepCase(card) { card.classList.add('keep-case'); return card; }

  function optRow(rerender) {
    function group(key, opts) {
      return h('span', { cls: 'opt-group' }, opts.map(function (o) {
        return OC.btn(o[1], chartOpt[key] === o[0] ? 'sm primary' : 'sm', function () { chartOpt[key] = o[0]; rerender(); });
      }));
    }
    return h('div', { cls: 'row chart-opts' }, [
      group('kind', [['bar', t('stats.kindBar')], ['line', t('stats.kindLine')]]),
      group('metric', [['tokens', t('stats.metricTokens')], ['answers', t('stats.metricAnswers')]]),
      group('days', [[14, t('stats.d14')], [30, t('stats.d30')], [90, t('stats.d90')]])
    ]);
  }

  // The chart card of one scope (all users or one user). extraLines: [{ name, cls, points }] for the per-user lines of the overview.
  function chartsCard(daily, title, userLines) {
    var all = (daily && daily.days) || [];
    var any = all.some(function (d) { return d.totalTokens > 0; });
    if (!any) return OC.card(title, [h('p', { cls: 'hint', text: t('stats.noDaily') })]);
    var body = h('div', {});
    var opts = h('div', {});
    function draw() {
      OC.clear(opts); opts.appendChild(optRow(draw));
      OC.clear(body);
      var list = all.slice(-chartOpt.days);
      body.appendChild(h('h3', { text: chartOpt.metric === 'answers' ? t('stats.dailyAnswers') : t('stats.daily') }));
      if (chartOpt.kind === 'bar') {
        body.appendChild(barChart(list, chartOpt.metric));
      } else if (chartOpt.metric === 'answers') {
        body.appendChild(h('div', { cls: 'bc' }, [lineChart(list, [{ cls: 'ls-in', area: true, points: list.map(function (d) { return d.messages || 0; }) }], function (d) { return d.day + ': ' + n(d.messages) + ' ' + t('stats.messages'); }), legend('answers')]));
      } else {
        body.appendChild(h('div', { cls: 'bc' }, [lineChart(list, [
          { cls: 'ls-out', area: true, points: list.map(function (d) { return d.totalTokens; }) },
          { cls: 'ls-in', points: list.map(function (d) { return d.promptTokens || 0; }) },
          { cls: 'ls-think', dash: true, points: list.map(function (d) { return d.reasoningTokens || 0; }) }
        ], dayTip), h('div', { cls: 'row chart-legend' }, [h('span', { cls: 'lg-sw lg-out' }), h('span', { cls: 'hint', text: t('stats.total') }), h('span', { cls: 'lg-sw lg-in' }), h('span', { cls: 'hint', text: t('stats.legendIO') }), h('span', { cls: 'lg-sw lg-think' }), h('span', { cls: 'hint', text: t('stats.reasoning') })])]));
      }
      if (userLines && userLines.length > 1) {
        body.appendChild(h('h3', { cls: 'chart-gap', text: t('stats.byUserLines') }));
        var us = userLines.map(function (u, i) { return { cls: 'lu' + (i % 6), dash: i >= 3, points: u.days.slice(-chartOpt.days).map(function (d) { return chartOpt.metric === 'answers' ? (d.messages || 0) : d.totalTokens; }) }; });
        var l2 = userLines[0].days.slice(-chartOpt.days);
        body.appendChild(h('div', { cls: 'bc' }, [lineChart(l2, us, function (d, i) { return d.day; }),
          h('div', { cls: 'row chart-legend' }, userLines.reduce(function (acc, u, i) { acc.push(h('span', { cls: 'lg-sw lgu' + (i % 6) })); acc.push(h('span', { cls: 'hint', text: u.name })); return acc; }, []))]));
      }
      body.appendChild(h('h3', { cls: 'chart-gap', text: t('stats.heat') }));
      body.appendChild(heatmap(all));
      body.appendChild(h('p', { cls: 'hint', text: t('stats.heatHint') }));
    }
    draw();
    return OC.card(title, [opts, body]);
  }

  OC.registerPage({
    id: 'stats',
    order: 41,
    icon: 'quota',
    titleKey: 'nav.stats',
    render: function (root) {
      var alive = true;
      var seq = 0;
      var days = 7;
      var detail = null; // { id, name } while one user's page is open
      var timer = null;
      var content = h('div', { cls: 'stack' });
      var periodBox = h('div', { cls: 'row stats-period' });
      root.appendChild(OC.pageHeader(t('stats.title'), t('stats.sub'), OC.btn(t('common.refresh'), 'sm', load, 'restart')));
      root.appendChild(periodBox);
      root.appendChild(content);

      function drawPeriods() {
        OC.clear(periodBox);
        PERIODS.forEach(function (p) {
          periodBox.appendChild(OC.btn(t('stats.p.' + p), p === days ? 'sm primary' : 'sm', function () { days = p; drawPeriods(); load(); }));
        });
      }
      function show(nodes) { OC.clear(content); nodes.forEach(function (x) { content.appendChild(x); }); }

      function load() {
        if (!alive) return;
        if (OC.state && !OC.state.running) { show([OC.card(t('stats.title'), [OC.empty('∅', t('common.serverStopped'), t('common.startFirst'))])]); return; }
        var my = ++seq;
        var tz = -new Date().getTimezoneOffset();
        OC.invoke('usage_users_get', { days: days, tz: tz }).then(function (res) {
          res = res || {};
          var daily = OC.invoke('usage_daily_get', { userId: detail ? detail.id : null, days: 182, tz: tz }).then(null, function () { return null; });
          var active = detail ? [] : (res.users || []).filter(function (u) { return u.messages > 0; }).sort(function (a, b) { return b.totalTokens - a.totalTokens; }).slice(0, 6);
          var lines = Promise.all(active.map(function (u) {
            return OC.invoke('usage_daily_get', { userId: u.userId, days: 182, tz: tz }).then(function (d) { return { name: u.username || '?', days: (d && d.days) || [] }; }, function () { return null; });
          })).then(function (a) { return a.filter(function (x) { return x && x.days.length; }); });
          return Promise.all([daily, lines]).then(function (r) { return [res, r[0], r[1]]; });
        }).then(function (all) {
          if (!alive || my !== seq) return;
          draw(all[0] || {}, all[1], all[2]);
        }, function (e) {
          if (!alive || my !== seq) return;
          show([OC.card(t('stats.title'), [h('p', { cls: 'alert', text: (e && e.message) || t('stats.loadError'), attrs: { role: 'alert' } })])]);
        });
      }

      function draw(res, daily, lines) {
        var tot = res.totals || {};
        var users = res.users || [];
        var nodes = [];
        if (detail) {
          var u1 = users.filter(function (x) { return x.userId === detail.id; })[0];
          if (!u1) { detail = null; } else { drawDetail(u1, daily); return; }
        }
        var cards = [
          stat(t('stats.total'), compact(tot.totalTokens), n(tot.totalTokens)),
          stat(t('stats.prompt') + ' / ' + t('stats.completion'), compact(tot.promptTokens) + ' / ' + compact(tot.completionTokens), t('stats.reasoning') + ' ' + n(tot.reasoningTokens)),
          stat(t('stats.messages'), n(tot.messages), t('stats.chats') + ' ' + n(tot.chats)),
          stat(t('stats.activeUsers'), n(tot.activeUsers) + ' / ' + n(tot.users)),
          stat(t('stats.activeTime'), mins(tot.activeMinutes), t('stats.generation') + ' ' + OC.fmtDuration((tot.generationMs || 0) / 1000))
        ];
        nodes.push(OC.card(t('stats.all'), [h('div', { cls: 'stats-grid' }, cards), res.estimated ? h('p', { cls: 'hint', text: t('stats.estimated') }) : null]));
        nodes.push(chartsCard(daily, t('stats.charts'), lines));

        if (!users.length) {
          nodes.push(OC.card(t('stats.users'), [h('p', { cls: 'hint', text: t('stats.noUsers') })]));
        } else {
          var sorted = users.slice().sort(function (a, b) { return (b.totalTokens - a.totalTokens) || (b.messages - a.messages); });
          var max = Math.max.apply(null, sorted.map(function (u) { return u.totalTokens; }).concat([1]));
          var head = h('div', { cls: 'ut-row ut-head' }, [
            h('span', { text: '' }), h('span', { text: t('stats.total') }), h('span', { cls: 'num-col', text: t('stats.prompt') }), h('span', { cls: 'num-col', text: t('stats.completion') }),
            h('span', { cls: 'num-col', text: t('stats.messages') }), h('span', { cls: 'num-col', text: t('stats.activeTime') }), h('span', { cls: 'num-col', text: t('stats.activeDays') }), h('span', { cls: 'num-col', text: t('stats.last') })
          ]);
          var rows = sorted.map(function (u) {
            var share = tot.totalTokens > 0 ? Math.round(u.totalTokens * 100 / tot.totalTokens) : 0;
            var fill = h('div', { cls: 'bar-fill' });
            fill.style.width = Math.max(u.totalTokens > 0 ? 2 : 0, Math.round(u.totalTokens * 100 / max)) + '%'; // CSSOM: the CSP blocks style attributes
            var bar = h('div', { cls: 'bar' }, [fill]);
            return h('div', { cls: 'ut-row' }, [
              h('div', { cls: 'ut-name' }, [h('strong', { text: u.username || '?' }), u.disabled ? OC.chip('err', t('stats.disabled')) : null, OC.btn(t('stats.detail'), 'sm', function () { detail = { id: u.userId, name: u.username || '?' }; load(); })]),
              h('div', { cls: 'ut-tokens' }, [h('div', { cls: 'ut-tok-line' }, [h('strong', { text: n(u.totalTokens) }), h('span', { cls: 'hint', text: u.totalTokens > 0 ? t('stats.of', { p: share }) : '' })]), bar]),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.prompt') }, text: n(u.promptTokens) }),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.completion') }, text: n(u.completionTokens) + (u.reasoningTokens ? ' (' + n(u.reasoningTokens) + ')' : '') }),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.messages') }, text: n(u.messages) }),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.activeTime') }, text: mins(u.activeMinutes) }),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.activeDays') }, text: n(u.activeDays) }),
              h('span', { cls: 'num-col', attrs: { 'data-label': t('stats.last') }, text: u.lastActivity ? OC.fmtDate(u.lastActivity) : t('stats.never') })
            ]);
          });
          var kids = [h('div', { cls: 'ut' }, [head].concat(rows)), h('p', { cls: 'hint', text: t('stats.note') })];
          if (!tot.messages) kids.unshift(h('p', { cls: 'hint', text: t('stats.empty') }));
          nodes.push(OC.card(t('stats.users'), kids));
        }
        show(nodes);
      }

      function drawDetail(u, daily) {
        var cards = [
          stat(t('stats.total'), compact(u.totalTokens), n(u.totalTokens)),
          stat(t('stats.prompt') + ' / ' + t('stats.completion'), compact(u.promptTokens) + ' / ' + compact(u.completionTokens), t('stats.reasoning') + ' ' + n(u.reasoningTokens)),
          stat(t('stats.messages'), n(u.messages), t('stats.chats') + ' ' + n(u.chats)),
          stat(t('stats.activeTime'), mins(u.activeMinutes), t('stats.generation') + ' ' + OC.fmtDuration((u.generationMs || 0) / 1000)),
          stat(t('stats.activeDays'), n(u.activeDays), t('stats.last') + ': ' + (u.lastActivity ? OC.fmtDate(u.lastActivity) : t('stats.never')))
        ];
        var back = OC.btn(t('stats.back'), 'sm', function () { detail = null; load(); });
        show([
          h('div', { cls: 'row' }, [back]),
          keepCase(OC.card(t('stats.userTitle', { name: u.username || '?' }), [h('div', { cls: 'stats-grid' }, cards), h('p', { cls: 'hint', text: t('stats.periodNote') })])),
          chartsCard(daily, t('stats.charts'))
        ]);
      }

      drawPeriods();
      load();
      timer = setInterval(load, 30000);
      return { onState: function (s) { if (s && !s.running) load(); }, destroy: function () { alive = false; if (timer) clearInterval(timer); } };
    }
  });
})();
