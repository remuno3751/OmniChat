/*
 * OmniChat activity panel (docs/design/VSCODE-BRIDGE.md §5, THEMES-IMPL.md). Plain classic script,
 * runs in the webview only. Renders the state built by src/ui/activityModel.ts. Every string goes
 * in with textContent; no HTML strings are parsed.
 *
 * Host -> webview: {type:"state", state: ActivityState | null}
 * Webview -> host: {type:"ready"}
 * Motion plays once: a row animates when it is created, never on later updates.
 */
(function () {
  "use strict";

  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  var TRACK_MAX = 10;
  var EMPTY_TEXT = "まだツールの実行はありません。";
  var TIPS_TEXT = "ツールの実行中は状態バーに running と出ます。承認が必要な操作は承認パネルに出ます。";
  var RUN_TEXT = { running: "実行中", done: "完了", error: "エラー", cancelled: "中止" };
  var STEP_TEXT = { pending: "待機", running: "実行中", ok: "完了", error: "エラー" };
  var STEP_CHIP = { pending: "oc-chip--wait", running: "oc-chip--run", ok: "oc-chip--ok", error: "oc-chip--err" };

  var els = {
    cwd: document.getElementById("oc-cwd"),
    empty: document.getElementById("oc-empty"),
    emptyText: document.getElementById("oc-empty-text"),
    tips: document.getElementById("oc-tips"),
    run: document.getElementById("oc-run"),
    track: document.getElementById("oc-track"),
    count: document.getElementById("oc-count"),
    phase: document.getElementById("oc-phase"),
    await: document.getElementById("oc-await"),
    steps: document.getElementById("oc-steps"),
  };
  var rows = new Map(); // callId -> { el, chip, label, dur, note }
  var currentRun = null;

  function send(msg) {
    if (vscode) vscode.postMessage(msg);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + String(n);
  }

  function formatMs(ms) {
    return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  }

  /** One cell per step (up to TRACK_MAX). Cells past the cap map proportionally. */
  function trackCells(progress, running) {
    var total = progress.total;
    if (total <= 0) return [];
    var cells = Math.min(total, TRACK_MAX);
    var filled = total <= TRACK_MAX ? progress.done : Math.floor((progress.done * cells) / total);
    var out = [];
    for (var i = 0; i < cells; i += 1) {
      if (i < filled) out.push("done");
      else if (i === filled && running) out.push("current");
      else out.push("todo");
    }
    return out;
  }

  function renderTrack(progress, running) {
    els.track.textContent = "";
    trackCells(progress, running).forEach(function (kind) {
      var cls = "oc-track__seg";
      if (kind === "done") cls += " oc-track__seg--done";
      if (kind === "current") cls += " oc-track__seg--current";
      els.track.appendChild(el("span", cls));
    });
    els.count.textContent = pad(progress.done) + "/" + pad(progress.total);
  }

  function buildRow(step) {
    var item = el("li", "oc-tool oc-enter oc-activity__step");
    var chip = el("span", "oc-chip");
    var label = el("span", "oc-tool__name");
    var dur = el("span", "oc-activity__dur");
    var note = el("div", "oc-activity__note");
    note.hidden = true;
    item.appendChild(chip);
    item.appendChild(label);
    item.appendChild(dur);
    item.appendChild(note);
    return { el: item, chip: chip, label: label, dur: dur, note: note };
  }

  function updateRow(row, step) {
    row.chip.className = "oc-chip " + (STEP_CHIP[step.status] || "");
    row.chip.textContent = STEP_TEXT[step.status] || step.status;
    row.label.textContent = step.label;
    row.dur.textContent = typeof step.durationMs === "number" ? formatMs(step.durationMs) : "";
    row.note.textContent = step.note || "";
    row.note.hidden = !step.note;
  }

  function clearRows() {
    rows.forEach(function (row) {
      row.el.remove();
    });
    rows.clear();
  }

  function renderSteps(steps) {
    var keep = new Set(steps.map(function (s) { return s.callId; }));
    rows.forEach(function (row, callId) {
      if (!keep.has(callId)) {
        row.el.remove();
        rows.delete(callId);
      }
    });
    steps.forEach(function (step) {
      var row = rows.get(step.callId);
      if (!row) {
        row = buildRow(step);
        rows.set(step.callId, row);
        els.steps.appendChild(row.el);
      }
      updateRow(row, step);
    });
  }

  function render(state) {
    if (!state || !Array.isArray(state.steps)) state = null;
    var hasRun = state !== null;
    els.empty.hidden = hasRun;
    els.run.hidden = !hasRun;
    els.cwd.textContent = hasRun ? state.cwd : "";
    if (!hasRun) {
      clearRows();
      currentRun = null;
      return;
    }
    if (state.runId !== currentRun) {
      clearRows();
      currentRun = state.runId;
    }
    var running = state.status === "running";
    renderTrack(state.progress || { done: 0, total: 0 }, running);
    els.phase.textContent = RUN_TEXT[state.status] || state.status;
    els.await.hidden = !state.awaitingApproval;
    els.await.textContent = state.awaitingApproval ? "承認待ち" : "";
    renderSteps(state.steps);
  }

  els.emptyText.textContent = EMPTY_TEXT;
  els.tips.textContent = TIPS_TEXT;

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state") render(msg.state || null);
  });

  render(null);
  send({ type: "ready" });
})();
