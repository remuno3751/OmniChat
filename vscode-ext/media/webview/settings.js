/*
 * OmniChat "Settings" view (docs/design/VSCODE-BRIDGE.md §5). Plain classic script, runs in the
 * webview only. Renders the state built by src/ui/settingsModel.ts; all wording comes from
 * state.strings and every string goes in with textContent. The token is never part of the state.
 *
 * Layout mirrors the app's Settings pages: section title, grouped card, rows with label and hint on
 * the left and the control on the right (stacked on narrow webviews).
 *
 * Host -> webview: {type:"state", state} | {type:"notice", key, ok, text}
 * Webview -> host: ready | set {key, value} | pair {code} | unpair | openLog
 */
(function () {
  "use strict";

  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  var root = document.getElementById("oc-root");
  var ui = null;
  var S = null;

  function send(msg) {
    if (vscode) vscode.postMessage(msg);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, cls, onClick) {
    var b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  var sectionSeq = 0;

  /** A titled section holding one grouped card. `foot` lines sit under the card. */
  function section(title) {
    var node = el("section", "oc-section");
    var h = el("h2", "oc-section__title", title);
    h.id = "oc-sec-" + (++sectionSeq);
    node.setAttribute("aria-labelledby", h.id);
    var group = el("div", "oc-group");
    node.appendChild(h);
    node.appendChild(group);
    return { node: node, group: group };
  }

  function foot(sec, text) {
    var p = el("p", "oc-section__foot", text);
    sec.node.appendChild(p);
    return p;
  }

  /** One row: label (and optional hint) on the left, control on the right. A note sits under it. */
  function item(label, hint, key, stacked) {
    var node = el("div", stacked ? "oc-item oc-item--stack" : "oc-item");
    var text = el("div", "oc-item__text");
    var lab = el("label", "oc-item__label", label);
    lab.id = "oc-l-" + key;
    text.appendChild(lab);
    if (hint) text.appendChild(el("p", "oc-item__hint", hint));
    var control = el("div", "oc-item__control");
    var note = el("div", "oc-note");
    note.setAttribute("role", "status");
    node.appendChild(text);
    node.appendChild(control);
    node.appendChild(note);
    return { node: node, label: lab, control: control, note: note };
  }

  /** A text field saved with its own button (or Enter), so a half-typed value is never written. */
  function textItem(label, hint, key, placeholder) {
    var it = item(label, hint, key, true);
    var input = el("input", "oc-input");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = placeholder || "";
    input.id = "oc-f-" + key;
    it.label.htmlFor = input.id;
    var save = function () { send({ type: "set", key: key, value: input.value }); };
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
    var row = el("div", "oc-inputrow");
    row.appendChild(input);
    row.appendChild(button(S.save, "oc-btn oc-btn--primary", save));
    it.control.appendChild(row);
    return { node: it.node, input: input, note: it.note, key: key };
  }

  /** A boolean row: a native checkbox styled as a switch (role=switch, Space toggles it). */
  function switchItem(label, hint, key) {
    var it = item(label, hint, key, false);
    var input = el("input", "oc-switch");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.id = "oc-s-" + key;
    it.label.htmlFor = input.id;
    input.addEventListener("change", function () { send({ type: "set", key: key, value: input.checked }); });
    it.control.appendChild(input);
    return { node: it.node, input: input, note: it.note, key: key };
  }

  /**
   * A small enum as a segmented control: role=radiogroup of role=radio buttons. Roving tabindex;
   * Arrow keys, Home and End move and select, as native radios do.
   */
  function segmented(label, hint, key, options) {
    var it = item(label, hint, key, false);
    var group = el("div", "oc-seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", it.label.id);
    var btns = options.map(function (o) {
      var b = el("button", "oc-seg__btn", o[1]);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", "false");
      b.tabIndex = -1;
      b.addEventListener("click", function () { pick(o[0]); });
      group.appendChild(b);
      return b;
    });
    function pick(value) {
      send({ type: "set", key: key, value: value });
    }
    group.addEventListener("keydown", function (e) {
      var i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      var next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % btns.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + btns.length) % btns.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = btns.length - 1;
      if (next < 0) return;
      e.preventDefault();
      btns[next].focus();
      pick(options[next][0]);
    });
    it.control.appendChild(group);
    return {
      node: it.node,
      note: it.note,
      key: key,
      el: group,
      set: function (value) {
        var any = options.some(function (o) { return o[0] === value; });
        options.forEach(function (o, idx) {
          var on = o[0] === value;
          btns[idx].setAttribute("aria-checked", on ? "true" : "false");
          btns[idx].tabIndex = on || (!any && idx === 0) ? 0 : -1;
        });
      },
    };
  }

  function build(strings, themeOptions) {
    S = strings;
    var u = { notes: {} };
    var header = el("header", "oc-header");
    var plate = el("span", "oc-plate");
    plate.appendChild(el("span", "oc-mark"));
    plate.appendChild(document.createTextNode("OmniChat VS"));
    header.appendChild(plate);
    u.status = el("span", "oc-chip");
    header.appendChild(u.status);
    var page = el("div", "oc-scroll");

    // Connection: where the bridge talks to, and the name the app shows for this window.
    var conn = section(S.server);
    u.server = textItem(S.serverUrl, "", "serverUrl", "https://omnichat.example.com");
    u.notes.serverUrl = u.server.note;
    u.name = textItem(S.deviceName, "", "deviceName", "");
    u.notes.deviceName = u.name.note;
    conn.group.appendChild(u.server.node);
    conn.group.appendChild(u.name.node);
    foot(conn, S.tokenNote);
    page.appendChild(conn.node);

    // Pairing: current state, pairing code entry, and unpair.
    var pair = section(S.pairing);
    var status = el("div", "oc-item");
    var stText = el("div", "oc-item__text");
    u.pairState = el("span", "oc-item__label");
    stText.appendChild(u.pairState);
    var stCtl = el("div", "oc-item__control");
    u.unpairBtn = button(S.unpair, "oc-btn", function () { send({ type: "unpair" }); });
    stCtl.appendChild(u.unpairBtn);
    status.appendChild(stText);
    status.appendChild(stCtl);
    pair.group.appendChild(status);

    var codeItem = item(S.pairCode, "", "pairCode", true);
    u.code = el("input", "oc-input");
    u.code.type = "password";
    u.code.autocomplete = "off";
    u.code.spellcheck = false;
    u.code.placeholder = S.pairCode;
    u.code.id = "oc-f-pairCode";
    codeItem.label.htmlFor = u.code.id;
    var doPair = function () {
      var code = u.code.value.trim();
      if (!code) return;
      u.notes.pair.textContent = "";
      send({ type: "pair", code: code });
      u.code.value = "";
    };
    u.code.addEventListener("keydown", function (e) { if (e.key === "Enter") doPair(); });
    var codeRow = el("div", "oc-inputrow");
    codeRow.appendChild(u.code);
    u.pairBtn = button(S.pairButton, "oc-btn oc-btn--primary", doPair);
    codeRow.appendChild(u.pairBtn);
    codeItem.control.appendChild(codeRow);
    u.notes.pair = codeItem.note;
    pair.group.appendChild(codeItem.node);
    u.pairState.id = "oc-pair-state";
    page.appendChild(pair.node);

    // Appearance: theme and decorations.
    var look = section(S.theme);
    u.theme = segmented(S.theme, "", "theme", (Array.isArray(themeOptions) && themeOptions.length ? themeOptions.map(function (o) { return [o.id, o.label]; }) : [["frontier", S.themeFrontier], ["simple", S.themeSimple], ["astral", S.themeAstral]]));
    u.decor = segmented(S.decorations, "", "decorations", [["auto", S.decorAuto], ["on", S.decorOn], ["off", S.decorOff]]);
    u.notes.theme = u.theme.note;
    u.notes.decorations = u.decor.note;
    look.group.appendChild(u.theme.node);
    look.group.appendChild(u.decor.node);
    page.appendChild(look.node);

    // Behaviour: save on edit, shell, and the trust state of this window.
    var behaviour = section(S.shell);
    u.autoSave = switchItem(S.autoSave, "", "autoSave");
    u.notes.autoSave = u.autoSave.note;
    u.shell = textItem(S.shell, S.shellHint, "shell", "");
    u.notes.shell = u.shell.note;
    behaviour.group.appendChild(u.autoSave.node);
    behaviour.group.appendChild(u.shell.node);
    u.trust = foot(behaviour, "");
    foot(behaviour, S.trustNote);
    page.appendChild(behaviour.node);

    // About: extension version and the log.
    var about = section(S.version);
    var verItem = el("div", "oc-item");
    var verText = el("div", "oc-item__text");
    verText.appendChild(el("span", "oc-item__label", S.version));
    var verCtl = el("div", "oc-item__control");
    u.version = el("span", "oc-item__value");
    verCtl.appendChild(u.version);
    verItem.appendChild(verText);
    verItem.appendChild(verCtl);
    about.group.appendChild(verItem);
    var logItem = el("div", "oc-item");
    logItem.appendChild(el("div", "oc-item__text"));
    var logCtl = el("div", "oc-item__control");
    logCtl.appendChild(button(S.openLog, "oc-btn", function () { send({ type: "openLog" }); }));
    logItem.appendChild(logCtl);
    about.group.appendChild(logItem);
    page.appendChild(about.node);

    root.appendChild(header);
    root.appendChild(page);
    return u;
  }

  function setValue(field, value) {
    if (document.activeElement !== field.input) field.input.value = value;
  }

  function render(state) {
    if (!ui) ui = build(state.strings, state.themeOptions);
    ui.status.textContent = S.status[state.status] || state.status;
    ui.status.className = "oc-chip " + (state.status === "online" ? "oc-chip--ok" : state.status === "connecting" ? "oc-chip--wait" : "oc-chip--err");
    setValue(ui.server, state.serverUrl);
    setValue(ui.name, state.deviceName);
    setValue(ui.shell, state.shell);
    if (!ui.theme.el.contains(document.activeElement)) ui.theme.set(state.theme);
    if (!ui.decor.el.contains(document.activeElement)) ui.decor.set(state.decorations);
    ui.autoSave.input.checked = state.autoSave === true;
    ui.pairState.textContent = state.paired ? S.paired : S.notPaired;
    ui.unpairBtn.hidden = !state.paired;
    ui.trust.textContent = state.trusted ? S.trusted : S.untrusted;
    ui.version.textContent = state.version;
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state" && msg.state) {
      render(msg.state);
    } else if (msg.type === "notice" && ui && typeof msg.text === "string") {
      var n = ui.notes[msg.key];
      if (!n) return;
      n.textContent = msg.text;
      n.className = "oc-note " + (msg.ok ? "oc-note--ok" : "oc-note--bad");
    }
  });

  send({ type: "ready" });
})();
