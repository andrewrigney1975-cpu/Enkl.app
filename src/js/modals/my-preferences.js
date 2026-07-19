"use strict";
import { getBoardBackground, setBoardBackground, clearBoardBackground, getHeaderColor, setHeaderColor, clearHeaderColor, getOpeningExperience } from '../storage.js';
import { toast } from '../ui.js';
import { contrastTextColor, shadeHexColor } from '../date-utils.js';
import { openOpeningExperienceModal } from './opening-experience.js';

var MAX_IMAGE_BYTES = 3 * 1024 * 1024; // localStorage is typically 5-10MB total; leave headroom for the rest of state.db.
var IMAGE_DISPLAY_SIZE = {fill: 'cover', stretch: '100% 100%', tile: 'auto'};
var IMAGE_DISPLAY_REPEAT = {fill: 'no-repeat', stretch: 'no-repeat', tile: 'repeat'};
var DEFAULT_HEADER_COLOR = '#0c2a52'; // matches --kf-navy, the un-customized default

/* Applies the persisted header colour preference to .kf-header. Exported for the same reasons as
   applyBoardBackground below (called once at init(), then live on every change in the modal).
   Everything under .kf-header reads its color/border/background through a --kf-header-* custom
   property (see styles.css) that falls back to the normal navy theme when unset, so re-theming the
   whole header — buttons, logo, divider — only needs a handful of properties set here, EXCEPT
   #projectSelect (.kf-select-dark), which reads as its own slightly-offset panel (like
   --kf-navy-light against --kf-navy today) rather than "header text/border on transparent" — its
   background/foreground/border are computed from the custom colour via shadeHexColor, not copied
   from the header's own values, so it keeps that same "distinct panel" relationship at any custom
   colour instead of blending flush into the header or losing contrast against it. */
export function applyHeaderColor(){
  var header = document.querySelector('.kf-header');
  if(!header) return;
  ['--kf-header-bg', '--kf-header-fg', '--kf-header-divider', '--kf-header-btn-border', '--kf-header-btn-hover',
   '--kf-header-select-bg', '--kf-header-select-fg', '--kf-header-select-border'].forEach(function(p){
    header.style.removeProperty(p);
  });

  var hex = getHeaderColor();
  if(!hex) return;

  var fg = contrastTextColor(hex);
  var dark = fg === '#ffffff'; // true => header bg is dark enough that the existing translucent-white accents still read; false => they need to flip to translucent-black instead.
  header.style.setProperty('--kf-header-bg', hex);
  header.style.setProperty('--kf-header-fg', fg);
  header.style.setProperty('--kf-header-divider', dark ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.2)');
  header.style.setProperty('--kf-header-btn-border', dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.3)');
  header.style.setProperty('--kf-header-btn-hover', dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)');

  var selectBg = shadeHexColor(hex, dark ? 0.12 : -0.1);
  header.style.setProperty('--kf-header-select-bg', selectBg);
  header.style.setProperty('--kf-header-select-fg', contrastTextColor(selectBg));
  header.style.setProperty('--kf-header-select-border', dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)');
}

/* Applies the persisted board background preference to .kf-board-wrap. Exported so app.js's
   init() can call it once at startup (alongside applyOpeningExperience()) and so this modal can
   re-apply live as the user changes settings, without waiting for a separate "Save" step. The
   image layer is a ::before pseudo-element (see styles.css) rather than a background-image
   directly on .kf-board-wrap, so the "faded" CSS filter can be scoped to just the image — a
   filter on .kf-board-wrap itself would wash out every column/card sitting on top of it too. The
   gradient case needs no such isolation (no filter involved) so it's just a plain
   background-image linear-gradient on .kf-board-wrap itself. */
export function applyBoardBackground(){
  var wrap = document.querySelector('.kf-board-wrap');
  if(!wrap) return;
  wrap.classList.remove('kf-board-bg-image', 'kf-board-bg-faded');
  wrap.style.backgroundColor = '';
  wrap.style.backgroundImage = '';
  wrap.style.removeProperty('--kf-board-bg-image-url');
  wrap.style.removeProperty('--kf-board-bg-image-size');
  wrap.style.removeProperty('--kf-board-bg-image-repeat');

  var pref = getBoardBackground();
  if(!pref) return;
  if(pref.type === 'color'){
    wrap.style.backgroundColor = pref.color;
  } else if(pref.type === 'gradient'){
    var dir = pref.gradientDirection === 'horizontal' ? 'to right' : 'to bottom';
    wrap.style.backgroundImage = 'linear-gradient(' + dir + ', ' + pref.gradientStart + ', ' + pref.gradientEnd + ')';
  } else if(pref.type === 'image'){
    wrap.classList.add('kf-board-bg-image');
    wrap.style.setProperty('--kf-board-bg-image-url', 'url("' + pref.imageData + '")');
    wrap.style.setProperty('--kf-board-bg-image-size', IMAGE_DISPLAY_SIZE[pref.display]);
    wrap.style.setProperty('--kf-board-bg-image-repeat', IMAGE_DISPLAY_REPEAT[pref.display]);
    if(pref.faded) wrap.classList.add('kf-board-bg-faded');
  }
}

export function openMyPreferencesModal(){
  populateMyPreferencesModal();
  document.getElementById('myPreferencesOverlay').classList.remove('hidden');
}
export function closeMyPreferencesModal(){
  document.getElementById('myPreferencesOverlay').classList.add('hidden');
}
export function isMyPreferencesModalOpen(){
  return !document.getElementById('myPreferencesOverlay').classList.contains('hidden');
}

function updateBoardBackgroundFieldVisibility(type){
  document.getElementById('boardBackgroundColorField').classList.toggle('kf-vis-hidden', type !== 'color');
  document.getElementById('boardBackgroundGradientField').classList.toggle('kf-vis-hidden', type !== 'gradient');
  document.getElementById('boardBackgroundImageField').classList.toggle('kf-vis-hidden', type !== 'image');
}

function populateMyPreferencesModal(){
  var headerColor = getHeaderColor();
  document.getElementById('headerColorInput').value = headerColor || DEFAULT_HEADER_COLOR;
  document.getElementById('headerColorResetBtn').classList.toggle('kf-vis-hidden', !headerColor);

  var pref = getBoardBackground();
  var type = pref ? pref.type : 'none';
  document.getElementById('boardBackgroundTypeSelect').value = type;
  document.getElementById('boardBackgroundColorInput').value = (pref && pref.type === 'color') ? pref.color : '#f4f5f7';

  document.getElementById('boardBackgroundGradientStartInput').value = (pref && pref.type === 'gradient') ? pref.gradientStart : '#4f46e5';
  document.getElementById('boardBackgroundGradientEndInput').value = (pref && pref.type === 'gradient') ? pref.gradientEnd : '#f4f5f7';
  document.getElementById('boardBackgroundGradientDirectionSelect').value = (pref && pref.type === 'gradient') ? pref.gradientDirection : 'vertical';

  var hasImage = !!(pref && pref.type === 'image');
  var previewImg = document.getElementById('boardBackgroundPreviewImg');
  previewImg.src = hasImage ? pref.imageData : '';
  previewImg.classList.toggle('kf-vis-hidden', !hasImage);
  document.getElementById('boardBackgroundRemoveImageBtn').classList.toggle('kf-vis-hidden', !hasImage);
  document.getElementById('boardBackgroundDisplaySelect').value = hasImage ? pref.display : 'fill';
  document.getElementById('boardBackgroundDisplaySelect').disabled = !hasImage;
  document.getElementById('boardBackgroundFadedCheckbox').checked = hasImage && !!pref.faded;
  document.getElementById('boardBackgroundFadedCheckbox').disabled = !hasImage;

  updateBoardBackgroundFieldVisibility(type);

  // Only meaningful for the same anonymous-mobile-first-run audience the Opening Experience
  // picker itself targets (see modals/opening-experience.js/board.js's prior myPreferencesBtn
  // gating) — a browser with nothing stored yet has no "default view" to revisit here.
  document.getElementById('myPreferencesOpeningExperienceSection').classList.toggle('kf-vis-hidden', !getOpeningExperience());
}

export function onBoardBackgroundTypeChange(){
  var type = document.getElementById('boardBackgroundTypeSelect').value;
  updateBoardBackgroundFieldVisibility(type);
  if(type === 'none'){
    clearBoardBackground();
  } else if(type === 'color'){
    setBoardBackground({type: 'color', color: document.getElementById('boardBackgroundColorInput').value});
  } else if(type === 'gradient'){
    setBoardBackground({
      type: 'gradient',
      gradientStart: document.getElementById('boardBackgroundGradientStartInput').value,
      gradientEnd: document.getElementById('boardBackgroundGradientEndInput').value,
      gradientDirection: document.getElementById('boardBackgroundGradientDirectionSelect').value
    });
  } else if(type === 'image'){
    var pref = getBoardBackground();
    if(!pref || pref.type !== 'image'){
      // Switching to "Image" with nothing uploaded yet — nothing to persist until a file is chosen.
      applyBoardBackground();
      return;
    }
  }
  applyBoardBackground();
}

export function onBoardBackgroundColorChange(){
  setBoardBackground({type: 'color', color: document.getElementById('boardBackgroundColorInput').value});
  applyBoardBackground();
}

export function onBoardBackgroundGradientChange(){
  setBoardBackground({
    type: 'gradient',
    gradientStart: document.getElementById('boardBackgroundGradientStartInput').value,
    gradientEnd: document.getElementById('boardBackgroundGradientEndInput').value,
    gradientDirection: document.getElementById('boardBackgroundGradientDirectionSelect').value
  });
  applyBoardBackground();
}

export function onBoardBackgroundDisplayChange(){
  var pref = getBoardBackground();
  if(!pref || pref.type !== 'image') return;
  setBoardBackground({type: 'image', imageData: pref.imageData, faded: pref.faded, display: document.getElementById('boardBackgroundDisplaySelect').value});
  applyBoardBackground();
}

export function onBoardBackgroundFadedChange(){
  var pref = getBoardBackground();
  if(!pref || pref.type !== 'image') return;
  setBoardBackground({type: 'image', imageData: pref.imageData, faded: document.getElementById('boardBackgroundFadedCheckbox').checked, display: pref.display});
  applyBoardBackground();
}

export function onBoardBackgroundFileChange(e){
  var file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  if(file.type.indexOf('image/') !== 0){
    toast('Please choose an image file.');
    return;
  }
  if(file.size > MAX_IMAGE_BYTES){
    toast('That image is too large (max 3MB) — try a smaller file.');
    return;
  }
  var reader = new FileReader();
  reader.onerror = function(){
    toast('Could not read that image file.');
  };
  reader.onload = function(){
    var faded = document.getElementById('boardBackgroundFadedCheckbox').checked;
    var display = document.getElementById('boardBackgroundDisplaySelect').value || 'fill';
    if(!setBoardBackground({type: 'image', imageData: reader.result, faded: faded, display: display})){
      toast('Could not save that image — it may be too large for local storage.');
      return;
    }
    document.getElementById('boardBackgroundTypeSelect').value = 'image';
    updateBoardBackgroundFieldVisibility('image');
    var previewImg = document.getElementById('boardBackgroundPreviewImg');
    previewImg.src = reader.result;
    previewImg.classList.remove('kf-vis-hidden');
    document.getElementById('boardBackgroundRemoveImageBtn').classList.remove('kf-vis-hidden');
    document.getElementById('boardBackgroundDisplaySelect').value = display;
    document.getElementById('boardBackgroundDisplaySelect').disabled = false;
    document.getElementById('boardBackgroundFadedCheckbox').disabled = false;
    applyBoardBackground();
  };
  reader.readAsDataURL(file);
}

export function removeBoardBackgroundImage(){
  clearBoardBackground();
  document.getElementById('boardBackgroundTypeSelect').value = 'none';
  updateBoardBackgroundFieldVisibility('none');
  var previewImg = document.getElementById('boardBackgroundPreviewImg');
  previewImg.src = '';
  previewImg.classList.add('kf-vis-hidden');
  document.getElementById('boardBackgroundRemoveImageBtn').classList.add('kf-vis-hidden');
  document.getElementById('boardBackgroundDisplaySelect').value = 'fill';
  document.getElementById('boardBackgroundDisplaySelect').disabled = true;
  document.getElementById('boardBackgroundFadedCheckbox').checked = false;
  document.getElementById('boardBackgroundFadedCheckbox').disabled = true;
  applyBoardBackground();
}

export function onHeaderColorChange(){
  setHeaderColor(document.getElementById('headerColorInput').value);
  document.getElementById('headerColorResetBtn').classList.remove('kf-vis-hidden');
  applyHeaderColor();
}

export function resetHeaderColor(){
  clearHeaderColor();
  document.getElementById('headerColorInput').value = DEFAULT_HEADER_COLOR;
  document.getElementById('headerColorResetBtn').classList.add('kf-vis-hidden');
  applyHeaderColor();
}

export function changeDefaultViewFromPreferences(){
  closeMyPreferencesModal();
  openOpeningExperienceModal();
}
