"use strict";
import { getToken, getClientSessionId, isLoggedIn, clearToken, notifyAuthExpired } from '../api.js';
import { getCurrentProject } from '../store.js';
import { refreshProjectFromServer } from './migration.js';
import { renderBoard } from '../views/board.js';
import { toastWithAction } from '../ui.js';
import { handleChatMessageEvent } from './chat.js';

/* Server-Sent Events client for Controllers/EventsController.cs's /api/events/stream — deliberately
   NOT the native EventSource API, since EventSource can't send an Authorization header and this app's
   auth is a bearer JWT in localStorage, not a cookie. fetch()'s streaming body reader gives the same
   effect with normal header-based auth, at the cost of having to hand-roll SSE framing and reconnect
   logic ourselves below. */

var RECONNECT_MIN_DELAY_MS = 2000;
var RECONNECT_MAX_DELAY_MS = 30000;

var _active = false; // true from connectEventStream() until disconnectEventStream()
var _abortController = null;
var _reconnectTimer = null;
var _reconnectDelay = RECONNECT_MIN_DELAY_MS;

function verbFor(changeType){
  if(changeType === 'created') return 'created';
  if(changeType === 'deleted') return 'deleted';
  return 'updated';
}

function handleTaskChangedEvent(payload){
  var message = payload.title + ' (' + payload.taskKey + ') was ' + verbFor(payload.changeType) +
    ' by ' + (payload.changedByDisplayName || 'someone') + '.';
  var project = getCurrentProject();
  var isOpenProject = !!(project && project.serverProjectId && project.serverProjectId === payload.projectId);

  if(isOpenProject){
    toastWithAction(message, 'Reload', function(){
      refreshProjectFromServer(project.id).then(renderBoard);
    });
  } else {
    // Still worth knowing about (it's a project this user is a member of — see
    // SseBroadcaster.BroadcastTaskChanged), just nothing to reload since it's not the open project.
    toastWithAction(message, null, null);
  }
}

function dispatchEvent(eventName, data){
  if(eventName !== 'task-changed' && eventName !== 'chat-message') return;
  try {
    if(eventName === 'task-changed') handleTaskChangedEvent(JSON.parse(data));
    else handleChatMessageEvent(JSON.parse(data));
  } catch(e){ /* malformed event payload — ignore rather than break the stream */ }
}

/* Turns a stream of decoded text chunks into individual SSE frames (blank-line separated, each made
   of "field: value" lines) and calls onEvent(eventName, data) per frame. Comment lines (starting with
   ":" — the server's heartbeat pings) and frames with no "data:" line are ignored. Buffers a trailing
   partial frame across chunk boundaries, since a chunk can end mid-frame. */
function makeSseFrameFeeder(onEvent){
  var buffer = '';
  return function(chunkText){
    buffer += chunkText;
    var frames = buffer.split('\n\n');
    buffer = frames.pop();
    frames.forEach(function(frame){
      var eventName = 'message';
      var dataLines = [];
      frame.split('\n').forEach(function(line){
        if(!line || line.charAt(0) === ':') return;
        var idx = line.indexOf(':');
        if(idx === -1) return;
        var field = line.slice(0, idx);
        var value = line.slice(idx + 1).replace(/^ /, '');
        if(field === 'event') eventName = value;
        else if(field === 'data') dataLines.push(value);
      });
      if(dataLines.length) onEvent(eventName, dataLines.join('\n'));
    });
  };
}

async function streamOnce(signal){
  var res = await fetch('/api/events/stream', {
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'X-Client-Session-Id': getClientSessionId(),
      'Accept': 'text/event-stream'
    },
    signal: signal
  });

  if(res.status === 401 || res.status === 403){
    // Session expired/revoked — matches apiFetch's handling in api.js, including surfacing the login
    // modal (see setOnAuthExpired in app.js): this long-lived stream can be the first thing to notice
    // an expired token during an otherwise idle session, well before any other request would. Stop
    // entirely rather than hammering the server with a reconnect loop that will just keep getting 401s.
    clearToken();
    notifyAuthExpired();
    disconnectEventStream();
    return;
  }
  if(!res.ok || !res.body){
    throw new Error('Event stream request failed with status ' + res.status);
  }

  _reconnectDelay = RECONNECT_MIN_DELAY_MS; // connected successfully — reset backoff for next time

  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var feed = makeSseFrameFeeder(dispatchEvent);
  while(true){
    var chunk = await reader.read();
    if(chunk.done) return;
    feed(decoder.decode(chunk.value, {stream: true}));
  }
}

function scheduleReconnect(){
  if(!_active) return;
  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(connectLoop, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
}

function connectLoop(){
  if(!_active || !isLoggedIn()) return;
  _abortController = new AbortController();
  streamOnce(_abortController.signal).then(
    function(){ scheduleReconnect(); }, // server closed the stream (or we did) — reconnect if still active
    function(err){
      if(err && err.name === 'AbortError') return; // disconnectEventStream() called this — don't reconnect
      scheduleReconnect();
    }
  );
}

export function connectEventStream(){
  if(_active || !isLoggedIn()) return; // already running, or nothing to authenticate the stream with
  _active = true;
  _reconnectDelay = RECONNECT_MIN_DELAY_MS;
  connectLoop();
}

export function disconnectEventStream(){
  _active = false;
  clearTimeout(_reconnectTimer);
  if(_abortController){ _abortController.abort(); _abortController = null; }
}
