"use strict";
import { hydrateIcons } from '../icons.js';
import { escapeHTML } from '../utils.js';
import { summarizeProjectAlerts } from './session-alerts.js';
import { isServerLoggedIn } from './migration.js';

/* =========================================================
   DESPATCHES — the header button/panel formerly called "Alert Status", renamed (Australian English,
   deliberate) and expanded into a genuine personalized activity feed. Two sources merge on every
   render/poll tick:

   1. "Live conditions" — summarizeProjectAlerts() (session-alerts.js, unchanged) plus active
      announcements/disruptions — recomputed fresh every time, stamped with the current instant so
      they naturally sort to the top until a genuinely newer logged event arrives.
   2. "Logged activity" — despatchLog below, a capped-at-25, newest-first, in-memory-only list built
      in real time from the exact two places that already raise a toast for the logged-in user today:
      features/live-updates.js's handleTaskChangedEvent and features/chat.js's handleChatMessageEvent.
      Nothing new is broadcast/fetched for this — it just also logs what already arrives over this
      browser tab's own SSE stream, which the server already scopes to this user (project-membership
      for task changes, mention/mute-aware for chat, and this tab's own edits are excluded server-side
      via ClientSessionId) — see root CLAUDE.md's Despatches plan for why no new relevance filtering
      is needed here.

   Session-only by design (confirmed with the user): resets on logout/reload, same as chatState/
   announcementState. No backend/schema work — this is deliberately NOT a durable notification inbox.

   DI (setDespatchesDeps) breaks the circular-import risk of this module needing to open chat/tasks
   directly — same convention as features/chat.js's own setChatDeps. */

var DESPATCH_LOG_CAP = 25;
var POLL_INTERVAL_MS = 30000;

var despatchLog = []; // {id, icon, message, timestamp, taskKey, channelId} — newest first

var _onUpdate = function(){};
var _openChat = function(){}; // (channelId) => void — provided by app.js (openChatPanel() + openChannel())

export function setDespatchesDeps(deps){
  if(deps.onUpdate) _onUpdate = deps.onUpdate;
  if(deps.openChat) _openChat = deps.openChat;
}

function notify(){ _onUpdate(); }

/* icon: an ICON_PATHS name. message: plain text. taskKey/channelId: at most one should be set — the
   despatch's click target, if any (a pure informational despatch — e.g. none currently, but kept
   general — passes neither). */
export function pushDespatch(entry){
  despatchLog.unshift({
    id: 'despatch-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    icon: entry.icon,
    message: entry.message,
    timestamp: entry.timestamp || Date.now(),
    taskKey: entry.taskKey || null,
    channelId: entry.channelId || null
  });
  if(despatchLog.length > DESPATCH_LOG_CAP) despatchLog.length = DESPATCH_LOG_CAP;
  notify();
}

export function resetDespatchLog(){
  despatchLog = [];
  stopDespatchesPolling();
}

/* Merges the two sources described above, sorts newest-first, caps at 25. Alerts/announcements have
   no target link (matches their pre-existing behavior); logged activity rows carry whatever target
   they were pushed with. */
export function getMergedDespatches(){
  var now = Date.now();
  var liveRows = summarizeProjectAlerts().map(function(a){
    return {id: 'live-' + a.icon + '-' + a.message, icon: a.icon, message: a.message, timestamp: now, taskKey: null, channelId: null};
  });
  return liveRows.concat(despatchLog)
    .sort(function(a, b){ return b.timestamp - a.timestamp; })
    .slice(0, DESPATCH_LOG_CAP);
}

export function renderDespatchesPanel(){
  var panel = document.getElementById('despatchesPanel');
  var rows = getMergedDespatches();
  if(rows.length === 0){
    panel.innerHTML = '<div class="kf-despatch-empty">Nothing to report right now.</div>';
  } else {
    panel.innerHTML = rows.map(function(r){
      var iconHTML = '<span class="kf-icon" data-icon="' + r.icon + '" data-size="15"></span>';
      var textHTML = '<span>' + escapeHTML(r.message) + '</span>';
      if(r.taskKey){
        return '<a class="kf-despatch-row" href="#!/' + encodeURIComponent(r.taskKey) + '">' + iconHTML + textHTML + '</a>';
      }
      if(r.channelId){
        return '<div class="kf-despatch-row kf-despatch-row-clickable" data-channel-id="' + escapeHTML(r.channelId) + '">' + iconHTML + textHTML + '</div>';
      }
      return '<div class="kf-despatch-row">' + iconHTML + textHTML + '</div>';
    }).join('');

    panel.querySelectorAll('.kf-despatch-row-clickable').forEach(function(row){
      row.addEventListener('click', function(){ _openChat(row.getAttribute('data-channel-id')); });
    });
  }
  hydrateIcons(panel);
}

var _pollTimer = null;

/* Same PRESENCE_POLL_INTERVAL_MS/setInterval/stop shape as features/chat.js's own presence poll —
   runs for the whole logged-in session (not gated on the panel being open), so leaving the panel
   open stays fresh without a close/reopen. The task/chat half of the feed already updates instantly
   via SSE push; this poll's real value is re-evaluating the "live conditions" half (overdue/at-risk/
   backup, which can become newly true purely from time passing). */
export function initDespatches(){
  if(!isServerLoggedIn()) return;
  stopDespatchesPolling();
  _pollTimer = setInterval(function(){
    if(!document.getElementById('despatchesPanel').classList.contains('hidden')) renderDespatchesPanel();
  }, POLL_INTERVAL_MS);
}

export function stopDespatchesPolling(){
  if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
}
