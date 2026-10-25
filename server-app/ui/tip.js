// Hover hint for icon-only controls: shows the `data-tip` text of the hovered element after 2 s.
// Only with a fine hover pointer (mouse / trackpad). Hidden on leave, mousedown and scroll.
(function () {
  'use strict';
  var DELAY = 2000;
  var timer = 0, anchor = null;
  var el = document.createElement('div');
  el.className = 'oc-tip'; el.setAttribute('role', 'tooltip'); el.hidden = true;
  document.body.appendChild(el);

  function canHover() {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) { return false; }
  }
  function hide() { clearTimeout(timer); timer = 0; anchor = null; el.hidden = true; }
  function show() {
    timer = 0;
    var text = anchor && anchor.isConnected ? anchor.getAttribute('data-tip') : '';
    if (!text) return;
    el.textContent = text; el.hidden = false;
    var r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 6;
    if (top < 8) top = r.bottom + 6;
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }

  document.addEventListener('mouseover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (a === anchor) return;
    hide();
    if (!a || !canHover()) return;
    anchor = a; timer = setTimeout(show, DELAY);
  });
  document.addEventListener('mousedown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();
