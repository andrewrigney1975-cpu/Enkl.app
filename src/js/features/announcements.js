"use strict";
import { announcementApi } from '../api.js';
import { isServerLoggedIn } from './migration.js';

/* Org-wide announcements/disruption notices — state + API orchestration only, no DOM here
   (session-alerts.js/app.js own rendering), same one-directional shape as features/chat.js's own
   state-module convention. Only ever populated for a server-authoritative, logged-in session — every
   function here assumes isServerLoggedIn() is already true, callers (app.js) gate on that before
   ever invoking initAnnouncements(). */

export var announcementState = {
  active: [], // [{id, title, body, kind, startAt, endAt, acknowledged}]
  loaded: false
};

var _onUpdate = function(){};

/* Dependency injection (same convention as chat.js's setChatDeps) — session-alerts.js/app.js wire in
   their own render function as onUpdate, called after every state change so the disruption banner
   (if any) and Alert Status panel (if open) reflect it immediately. */
export function setAnnouncementDeps(deps){
  if(deps.onUpdate) _onUpdate = deps.onUpdate;
}

function notify(){ _onUpdate(); }

export function refreshAnnouncementData(){
  if(!isServerLoggedIn()) return Promise.resolve();
  return announcementApi.active().then(function(list){
    announcementState.active = list;
    announcementState.loaded = true;
    notify();
  }).catch(function(){ /* best-effort — announcements are a convenience feature, not core app function */ });
}

export function initAnnouncements(){
  if(!isServerLoggedIn()) return;
  refreshAnnouncementData();
}

/* Called on logout (app.js) — clears everything so a subsequent different user's login never briefly
   shows the previous session's announcements/disruption banner. */
export function resetAnnouncementState(){
  announcementState.active = [];
  announcementState.loaded = false;
}

export function getActiveDisruptions(){
  return announcementState.active.filter(function(a){ return a.kind === 'disruption'; });
}

export function getUnacknowledgedAnnouncements(){
  return announcementState.active.filter(function(a){ return a.kind === 'announcement' && !a.acknowledged; });
}

/* Optimistic — flips the local acknowledged flag immediately (so the digest modal/Alert Status panel
   never re-shows an item the user just dismissed within the same session even if the network call is
   still in flight) and fires the request best-effort; a failure here just means the item may
   reappear next session, not a broken UI. */
export function acknowledgeAnnouncement(announcementId){
  var item = announcementState.active.find(function(a){ return a.id === announcementId; });
  if(item) item.acknowledged = true;
  notify();
  return announcementApi.acknowledge(announcementId).catch(function(){ /* best-effort */ });
}
