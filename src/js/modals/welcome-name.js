"use strict";
import { getCurrentProject } from '../store.js';
import { claimSeedProjectAsFirstUser } from '../mutations.js';
import { toast } from '../ui.js';

/* First-run "what's your name?" prompt — shown once, only right after storage.js's loadDB() just
   created a brand-new seed DB (see app.js's applyFirstRunExperience()), never on a returning visit.
   Skippable (X, outside-click, or the Skip button) exactly like the Opening Experience picker it
   sits alongside — nothing here is forced, a skip just leaves the seed project's tasks unassigned,
   same as before this feature existed. */

/* An upside-down-spectrum-analyser take on the header/About-modal logo (see modals/about.js's own
   logoSvgMarkup) — same 3-bar mark, same top anchor (y stays fixed at 6, only height changes, so
   each bar grows/shrinks downward from a fixed top edge), just with ids on the bars so the animation
   below can drive them and a size big enough to actually read as "talking" rather than decorative. */
function animatedLogoSvgMarkup(size){
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="24" height="24" rx="5" fill="#0c66e4"/>' +
    '<rect id="welcomeLogoBar0" class="kf-welcome-logo-bar" x="5" y="6" width="4" height="12" rx="1" fill="#fff"/>' +
    '<rect id="welcomeLogoBar1" class="kf-welcome-logo-bar" x="10.5" y="6" width="4" height="7" rx="1" fill="#fff" opacity=".85"/>' +
    '<rect id="welcomeLogoBar2" class="kf-welcome-logo-bar" x="16" y="6" width="4" height="10" rx="1" fill="#fff" opacity=".7"/>' +
  '</svg>';
}

var WELCOME_LOGO_BAR_IDS = ['welcomeLogoBar0', 'welcomeLogoBar1', 'welcomeLogoBar2'];
var WELCOME_LOGO_BAR_MIN_HEIGHT = 3;
var WELCOME_LOGO_BAR_MAX_HEIGHT = 13;
// One pending setTimeout id per bar — each bar reschedules itself independently (not one shared
// interval driving all three) so they drift out of sync with each other, which is what actually
// reads as "talking" rather than a uniform pulse. Only ever one pending timeout per bar at a time,
// so clearing whatever's currently stored here is enough to stop the whole chain — no separate
// "stopped" flag needed.
var logoAnimationTimeoutIds = [];

function scheduleNextBarUpdate(barId, index){
  var bar = document.getElementById(barId);
  if(bar){
    var newHeight = WELCOME_LOGO_BAR_MIN_HEIGHT + Math.random() * (WELCOME_LOGO_BAR_MAX_HEIGHT - WELCOME_LOGO_BAR_MIN_HEIGHT);
    bar.setAttribute('height', newHeight.toFixed(1));
  }
  var nextDelayMs = 150 + Math.random() * 200;
  logoAnimationTimeoutIds[index] = setTimeout(function(){ scheduleNextBarUpdate(barId, index); }, nextDelayMs);
}

function startWelcomeLogoAnimation(){
  stopWelcomeLogoAnimation();
  WELCOME_LOGO_BAR_IDS.forEach(function(barId, index){
    // Staggered start (rather than all three beginning at once) so the very first few ticks already
    // look independent instead of briefly moving in lockstep.
    logoAnimationTimeoutIds[index] = setTimeout(function(){ scheduleNextBarUpdate(barId, index); }, index * 70);
  });
}

function stopWelcomeLogoAnimation(){
  logoAnimationTimeoutIds.forEach(function(id){ clearTimeout(id); });
  logoAnimationTimeoutIds = [];
}

export function openWelcomeNameModal(){
  document.getElementById('welcomeNameInput').value = '';
  document.getElementById('welcomeNameLogoIcon').innerHTML = animatedLogoSvgMarkup(84);
  startWelcomeLogoAnimation();
  document.getElementById('welcomeNameOverlay').classList.remove('hidden');
  document.getElementById('welcomeNameInput').focus();
}
export function closeWelcomeNameModal(){
  stopWelcomeLogoAnimation();
  document.getElementById('welcomeNameOverlay').classList.add('hidden');
}
export function isWelcomeNameModalOpen(){
  return !document.getElementById('welcomeNameOverlay').classList.contains('hidden');
}

/* Returns true if a name was actually entered and applied (so app.js's caller knows whether to
   re-render the board/assignee chips) — false on an empty submit, in which case a toast asks for a
   name or Skip and the modal stays open. */
export function confirmWelcomeName(){
  var input = document.getElementById('welcomeNameInput');
  var name = input.value.trim();
  if(!name){
    toast('Please enter your name, or Skip.');
    return false;
  }
  var project = getCurrentProject();
  if(project) claimSeedProjectAsFirstUser(project, name);
  closeWelcomeNameModal();
  return true;
}

export function skipWelcomeName(){
  closeWelcomeNameModal();
}
