// Boot: load state; no admin yet (or setup not done) -> wizard, else the shell.
(function () {
  'use strict';
  var OC = window.OC;
  document.documentElement.lang = OC.lang();
  var started = false;
  function boot() {
    OC.refreshState().then(function (s) {
      if (!s) { OC.toast('IPC error', 'err'); return; }
      OC.invoke('setup_done_get').catch(function () { return true; }).then(function (done) {
        var needWizard = !done;
        if (needWizard && window.OCWizard) window.OCWizard.show(); else OC.showShell();
        if (!started) { started = true; setInterval(OC.refreshState, 2000); }
      });
    });
  }
  OC.on('wizard-done', function () { OC.showShell(); });
  if (window.__TAURI__) boot(); else window.addEventListener('load', boot);
})();
