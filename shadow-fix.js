// shadow-fix.js — Force all shadow roots to mode:'open'
// Runs at document_start in MAIN world (before Gemini builds its DOM)
// Without this, deepQueryAll cannot pierce closed shadow DOMs to find images.

(function() {
  'use strict';
  const _attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
    if (init && init.mode === 'closed') {
      init = Object.assign({}, init, { mode: 'open' });
    }
    return _attachShadow.call(this, init);
  };
  console.log('[Claude Proxy] shadow-fix.js: all shadow roots forced to open');
})();
