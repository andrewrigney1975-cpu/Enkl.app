const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
if (!style) {
  console.error('CRASHED: could not find <style> block');
  process.exit(1);
}

// build.js minifies the inlined CSS (strips spaces around ':' and before '{'), so this can't be a
// literal substring search — match tolerantly instead.
const mediaStartMatch = style.match(/@media\s*\(\s*min-width:\s*2560px\s*\)/);
const mediaStart = mediaStartMatch ? mediaStartMatch.index : -1;
if (mediaStart === -1) {
  console.error('CRASHED: could not find the widescreen (min-width: 2560px) media query');
  process.exit(1);
}
const mediaOpenBrace = style.indexOf('{', mediaStart);
let depth = 0, mediaEnd = -1;
for (let i = mediaOpenBrace; i < style.length; i++) {
  if (style[i] === '{') depth++;
  else if (style[i] === '}') {
    depth--;
    if (depth === 0) { mediaEnd = i; break; }
  }
}
if (mediaEnd === -1) {
  console.error('CRASHED: could not find the end of the widescreen media query block');
  process.exit(1);
}
const mediaBlock = style.slice(mediaStart, mediaEnd + 1);

log('widescreen media query exists at exactly 2560px', mediaStart !== -1);

const overlayRuleMatch = mediaBlock.match(/#taskOverlay\s*\{([^}]*)\}/);
log('#taskOverlay rule present inside the widescreen media query', !!overlayRuleMatch);
if (overlayRuleMatch) {
  const overlayBody = overlayRuleMatch[1];
  log('overlay right-aligns its content (justify-content: flex-end)', /justify-content:\s*flex-end/.test(overlayBody), overlayBody.trim());
  log('overlay stretches content to full height (align-items: stretch)', /align-items:\s*stretch/.test(overlayBody), overlayBody.trim());
  log('overlay padding is removed so the modal sits flush against the edges', /padding:\s*0/.test(overlayBody), overlayBody.trim());
  // Reads as a persistent inspector pane, not a dialog: no dimming backdrop, and the overlay itself
  // stops intercepting clicks entirely so they pass through to the board underneath (only the modal
  // panel re-enables pointer-events below) — see app.js's "mousedown on #taskOverlay closes it"
  // handler, which this is what stops from ever firing over the backdrop area at this breakpoint.
  log('the dimming backdrop is removed (background: transparent)', /background:\s*transparent/.test(overlayBody), overlayBody.trim());
  log('the overlay stops intercepting clicks so the board stays clickable underneath (pointer-events: none)', /pointer-events:\s*none/.test(overlayBody), overlayBody.trim());
}

const modalRuleMatch = mediaBlock.match(/#taskOverlay \.kf-modal\s*\{([^}]*)\}/);
log('#taskOverlay .kf-modal rule present inside the widescreen media query', !!modalRuleMatch);
if (modalRuleMatch) {
  const modalBody = modalRuleMatch[1];
  log('modal is full viewport height (height: 100vh)', /height:\s*100vh/.test(modalBody), modalBody.trim());
  log('modal max-height matches (max-height: 100vh)', /max-height:\s*100vh/.test(modalBody), modalBody.trim());
  log('modal corners are squared off for the flush-docked look (border-radius: 0)', /border-radius:\s*0/.test(modalBody), modalBody.trim());
  log('the modal panel itself re-enables clicks (pointer-events: auto)', /pointer-events:\s*auto/.test(modalBody), modalBody.trim());
}

// This feature is scoped to the Task modal only — the sibling desktop-width rule (700px, >=1025px)
// must still exist unchanged elsewhere in the stylesheet, and no other overlay should have picked
// up a flex-end/stretch override from this change.
log('the existing desktop Task modal width rule (700px, >=1025px) is untouched', /#taskOverlay \.kf-modal\s*\{\s*width:\s*700px;?\s*\}/.test(style));
const otherOverlayFlexEnd = style.match(/#(?!taskOverlay)[\w-]+Overlay\s*\{[^}]*justify-content:\s*flex-end/);
log('no other overlay accidentally picked up the right-docked layout', !otherOverlayFlexEnd);
const otherOverlayNoPointerEvents = style.match(/#(?!taskOverlay)[\w-]+Overlay\s*\{[^}]*pointer-events:\s*none/);
log('no other overlay accidentally picked up the click-passthrough behavior', !otherOverlayNoPointerEvents);

// The width narrowing itself resizes instantly (no CSS transition) — an earlier animated version of
// this was deliberately removed as an annoying UX, so .kf-header/.kf-main-content should NOT carry
// any transition rule inside this breakpoint (or anywhere else).
const headerTransitionAnywhere = style.match(/\.kf-header\s*\{[^}]*transition/);
log('the header has no width transition (the resize is instant, not animated)', !headerTransitionAnywhere);
const mainContentTransitionAnywhere = style.match(/\.kf-main-content\s*\{[^}]*transition/);
log('the board area has no flex-basis transition (the resize is instant, not animated)', !mainContentTransitionAnywhere);

console.log('\nWidescreen Task modal test complete.');
