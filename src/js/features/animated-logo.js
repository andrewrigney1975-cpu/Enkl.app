"use strict";

/* The "talking" 3-bar spectrum-analyser mark used on the Welcome Name modal (modals/welcome-name.js,
   an upside-down take on the header/About-modal static logo — see about.js's own logoSvgMarkup for
   the non-animated original). Pulled out into its own module so a second consumer (the AI Assistant
   bubble icon) can reuse the exact same animation instead of a second hand-copied timer loop —
   ordinary "duplication within one tier is bad" per root CLAUDE.md §1/§7's ProjectKeyResolver-style
   extraction precedent, just for frontend JS instead of a .NET service.

   Multiple independent instances can run at once (the Welcome modal and the AI Assistant bubble could
   in principle both be mounted, even if not simultaneously visible today) — every exported function
   takes an idPrefix so each instance's bar ids/timeouts never collide with another's. */

var BAR_MIN_HEIGHT = 3;
var BAR_MAX_HEIGHT = 13;
var BAR_COUNT = 3;

// idPrefix -> array of pending setTimeout ids, one per bar. Only ever one pending timeout per bar at
// a time, so clearing whatever's stored here per-instance is enough to stop that instance's chain.
var timeoutIdsByPrefix = {};

function barId(idPrefix, index){ return idPrefix + 'Bar' + index; }

export function animatedLogoSvgMarkup(size, idPrefix){
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="24" height="24" rx="5" fill="#0c66e4"/>' +
    '<rect id="' + barId(idPrefix, 0) + '" class="kf-animated-logo-bar" x="5" y="6" width="4" height="12" rx="1" fill="#fff"/>' +
    '<rect id="' + barId(idPrefix, 1) + '" class="kf-animated-logo-bar" x="10.5" y="6" width="4" height="7" rx="1" fill="#fff" opacity=".85"/>' +
    '<rect id="' + barId(idPrefix, 2) + '" class="kf-animated-logo-bar" x="16" y="6" width="4" height="10" rx="1" fill="#fff" opacity=".7"/>' +
  '</svg>';
}

function scheduleNextBarUpdate(idPrefix, index){
  var bar = document.getElementById(barId(idPrefix, index));
  if(bar){
    var newHeight = BAR_MIN_HEIGHT + Math.random() * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT);
    bar.setAttribute('height', newHeight.toFixed(1));
  }
  var nextDelayMs = 150 + Math.random() * 200;
  timeoutIdsByPrefix[idPrefix][index] = setTimeout(function(){ scheduleNextBarUpdate(idPrefix, index); }, nextDelayMs);
}

export function startAnimatedLogo(idPrefix){
  stopAnimatedLogo(idPrefix);
  timeoutIdsByPrefix[idPrefix] = [];
  for(var index = 0; index < BAR_COUNT; index++){
    // Staggered start (rather than all three beginning at once) so the very first few ticks already
    // look independent instead of briefly moving in lockstep.
    (function(index){
      timeoutIdsByPrefix[idPrefix][index] = setTimeout(function(){ scheduleNextBarUpdate(idPrefix, index); }, index * 70);
    })(index);
  }
}

export function stopAnimatedLogo(idPrefix){
  (timeoutIdsByPrefix[idPrefix] || []).forEach(function(id){ clearTimeout(id); });
  timeoutIdsByPrefix[idPrefix] = [];
}
