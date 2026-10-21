/*
 * OmniChat webview theme runtime (docs/design/VSCODE-BRIDGE.md §5).
 * Plain classic script, no modules. Runs inside the webview only.
 *
 * - data-oc-mode on <html> and <body>: "light" or "dark", from body.vscode-light/dark.
 *   Kept in sync with a MutationObserver on body's class list.
 * - data-oc-narrow on <body>: present when the webview is narrower than 480px.
 * - data-oc-decor on <body>: "on" or "off". Starts from data-oc-decor-setting
 *   (auto|on|off, set by the host). High-contrast themes always turn it off.
 */
(function () {
  "use strict";

  var NARROW_PX = 480;
  var root = document.documentElement;
  var body = document.body;

  function safe(fn) {
    try {
      fn();
    } catch (err) {
      // Theme attributes are cosmetic; never let them break the page.
      if (window.console) window.console.warn("[omnichat theme]", err);
    }
  }

  function currentMode() {
    var cls = body.classList;
    if (cls.contains("vscode-light") || cls.contains("vscode-high-contrast-light")) return "light";
    return "dark";
  }

  function applyMode() {
    safe(function () {
      var mode = currentMode();
      root.setAttribute("data-oc-mode", mode);
      body.setAttribute("data-oc-mode", mode);
    });
  }

  function applyDecor() {
    safe(function () {
      var setting = body.getAttribute("data-oc-decor-setting") || "auto";
      var highContrast = body.classList.contains("vscode-high-contrast") ||
        body.classList.contains("vscode-high-contrast-light");
      var on = setting !== "off" && !highContrast;
      body.setAttribute("data-oc-decor", on ? "on" : "off");
    });
  }

  function applyNarrow(width) {
    safe(function () {
      if (width < NARROW_PX) {
        body.setAttribute("data-oc-narrow", "");
      } else {
        body.removeAttribute("data-oc-narrow");
      }
    });
  }

  function applyAll() {
    applyMode();
    applyDecor();
    applyNarrow(window.innerWidth || body.clientWidth || NARROW_PX);
  }

  applyAll();

  // VS Code swaps the body classes when the colour theme changes.
  if (typeof MutationObserver === "function") {
    safe(function () {
      var observer = new MutationObserver(function () {
        applyMode();
        applyDecor();
      });
      observer.observe(body, { attributes: true, attributeFilter: ["class"] });
    });
  }

  // Narrow detection follows the webview's own size, not the window's.
  if (typeof ResizeObserver === "function") {
    safe(function () {
      var resize = new ResizeObserver(function (entries) {
        var entry = entries[entries.length - 1];
        applyNarrow(entry ? entry.contentRect.width : window.innerWidth);
      });
      resize.observe(root);
    });
  } else {
    window.addEventListener("resize", function () {
      applyNarrow(window.innerWidth);
    });
  }
})();
