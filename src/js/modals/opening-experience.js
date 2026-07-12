"use strict";
import { getDeviceType, setDeviceType, setOpeningExperience } from '../storage.js';
import { MOBILE_BREAKPOINT } from '../config.js';

export function openOpeningExperienceModal(){
  document.getElementById('openingExperienceOverlay').classList.remove('hidden');
}
export function closeOpeningExperienceModal(){
  document.getElementById('openingExperienceOverlay').classList.add('hidden');
}
export function isOpeningExperienceModalOpen(){
  return !document.getElementById('openingExperienceOverlay').classList.contains('hidden');
}

export function chooseOpeningExperience(value){
  setOpeningExperience(value);
  closeOpeningExperienceModal();
}

/* Called once at startup (see app.js's init(), gated there behind "not signed in" — signed-in users
   skip this whole feature and always land on the Board). Records this browser's first-ever device
   type (mobile vs desktop, by screen width, same MOBILE_BREAKPOINT the rest of the app already uses
   for responsive layout) the very first time the app runs here — this never happens again on any
   later visit, regardless of what width the browser happens to be at the time. Only a first-time
   MOBILE visitor also gets the Opening Experience picker (To-Do List vs Board) shown; a first-time
   desktop visitor is left to the normal default (the Board) with no picker at all.
   Returns true if the picker was shown, so the caller doesn't ALSO try to auto-open the To-Do list
   this same run — nothing's been chosen yet at that point. */
export function recordDeviceTypeAndMaybeShowPicker(){
  if(getDeviceType()) return false;
  var isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  setDeviceType(isMobile ? 'mobile' : 'desktop');
  if(isMobile){
    openOpeningExperienceModal();
    return true;
  }
  return false;
}
