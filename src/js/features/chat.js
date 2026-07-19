"use strict";
import { chatApi, getCurrentUserId, isOrgAdmin } from '../api.js';
import { isServerLoggedIn } from './migration.js';
import { toast, toastWithAction } from '../ui.js';

/* Org-wide chat — state + API orchestration only, no DOM here (views/chat.js owns rendering,
   importing everything it needs from this module) — same one-directional-import shape as every
   other "state module" + "view module" pair in this app (e.g. depMapState/computeDepGraphLayout in
   views/dependency-map.js vs. its own render functions). Kept entirely separate from any project's
   local/offline state: chat only exists for a server-authoritative, logged-in session (colleagues in
   the same org), so every function here assumes isServerLoggedIn() is already true — callers (app.js)
   gate on that before ever invoking initChat(). */

var PRESENCE_POLL_INTERVAL_MS = 30000;

export var chatState = {
  isOpen: false,
  loaded: false,
  channels: [],
  adminVisibleChannels: [],
  orgUsers: [],
  activeChannelId: null,
  newChatPickerOpen: false,
  messagesByChannel: {}, // channelId -> {messages: [...], nextCursor, loading}
  unreadByChannel: {}, // channelId -> count
  revealDeletedForAdmin: false // Org-Admin-only toggle: show real text instead of the placeholder
};

var _presenceTimer = null;
var _onUpdate = function(){};

/* Dependency injection (break the features/chat.js <-> views/chat.js circular import — same
   convention as app.js's other setXDeps() calls) — views/chat.js's own render function is wired in
   as onUpdate, called after every state change so the panel (if open) reflects it immediately. */
export function setChatDeps(deps){
  if(deps.onUpdate) _onUpdate = deps.onUpdate;
}

function notify(){ _onUpdate(); }

export function isChatPanelOpen(){ return chatState.isOpen; }

export function openChatPanel(){
  chatState.isOpen = true;
  if(!chatState.loaded) refreshChatData();
  notify();
}
export function closeChatPanel(){
  chatState.isOpen = false;
  notify();
}

export function totalUnreadCount(){
  return Object.keys(chatState.unreadByChannel).reduce(function(sum, id){ return sum + chatState.unreadByChannel[id]; }, 0);
}

/* Called once at app init (gated behind isServerLoggedIn() by the caller) and again on demand
   (opening the panel for the first time). Loads the channel list + org roster (which doubles as the
   presence snapshot — see PRESENCE_POLL_INTERVAL_MS below) together. */
export function refreshChatData(){
  if(!isServerLoggedIn()) return Promise.resolve();
  return Promise.all([
    chatApi.listChannels().then(function(result){
      chatState.channels = result.channels;
      chatState.adminVisibleChannels = result.adminVisibleChannels;
    }),
    chatApi.orgUsers().then(function(users){
      chatState.orgUsers = users;
    })
  ]).then(function(){
    chatState.loaded = true;
    notify();
  }).catch(function(){ /* best-effort — chat is a convenience feature, not core app function */ });
}

export function initChat(){
  if(!isServerLoggedIn()) return;
  refreshChatData();
  stopPresencePolling();
  _presenceTimer = setInterval(function(){
    // Presence-only refresh — re-fetching org-users is cheap and already carries isOnline, so no
    // separate presence endpoint/poll loop is needed (see plan's "periodic polling" decision).
    chatApi.orgUsers().then(function(users){
      chatState.orgUsers = users;
      notify();
    }).catch(function(){ /* best-effort */ });
  }, PRESENCE_POLL_INTERVAL_MS);
}

export function stopPresencePolling(){
  if(_presenceTimer){ clearInterval(_presenceTimer); _presenceTimer = null; }
}

/* Called on logout (app.js) — clears everything so a subsequent different user's login never briefly
   shows the previous session's channels/messages. */
export function resetChatState(){
  stopPresencePolling();
  chatState.isOpen = false;
  chatState.loaded = false;
  chatState.channels = [];
  chatState.adminVisibleChannels = [];
  chatState.orgUsers = [];
  chatState.activeChannelId = null;
  chatState.newChatPickerOpen = false;
  chatState.messagesByChannel = {};
  chatState.unreadByChannel = {};
}

function findChannel(channelId){
  return chatState.channels.concat(chatState.adminVisibleChannels).find(function(c){ return c.id === channelId; });
}

export function openChannel(channelId){
  chatState.activeChannelId = channelId;
  chatState.newChatPickerOpen = false;
  chatState.unreadByChannel[channelId] = 0;
  if(!chatState.messagesByChannel[channelId]){
    chatState.messagesByChannel[channelId] = {messages: [], nextCursor: null, loading: true};
    notify();
    chatApi.getMessages(channelId, null, 50).then(function(page){
      chatState.messagesByChannel[channelId] = {messages: page.messages, nextCursor: page.nextCursor, loading: false};
      notify();
    }).catch(function(){
      chatState.messagesByChannel[channelId].loading = false;
      toast('Could not load messages for this channel.');
      notify();
    });
  } else {
    notify();
  }
}

export function loadOlderMessages(channelId){
  var entry = chatState.messagesByChannel[channelId];
  if(!entry || !entry.nextCursor || entry.loading) return;
  entry.loading = true;
  notify();
  chatApi.getMessages(channelId, entry.nextCursor, 50).then(function(page){
    entry.messages = page.messages.concat(entry.messages);
    entry.nextCursor = page.nextCursor;
    entry.loading = false;
    notify();
  }).catch(function(){
    entry.loading = false;
    toast('Could not load older messages.');
    notify();
  });
}

export function createChannel(name, isDirectMessage, memberUserIds){
  return chatApi.createChannel(name, isDirectMessage, memberUserIds).then(function(channel){
    var alreadyKnown = findChannel(channel.id);
    if(!alreadyKnown) chatState.channels.push(channel);
    notify();
    return channel;
  });
}

export function sendMessage(channelId, text){
  if(!text || !text.trim()) return Promise.resolve();
  return chatApi.postMessage(channelId, text.trim()).then(function(message){
    appendOrReplaceMessage(channelId, message);
    notify();
    return message;
  }, function(e){
    toast('Could not send message: ' + ((e && e.body && e.body.message) || 'unknown error'));
    throw e;
  });
}

export function editMessage(channelId, messageId, text){
  if(!text || !text.trim()) return Promise.resolve();
  return chatApi.updateMessage(channelId, messageId, text.trim()).then(function(message){
    appendOrReplaceMessage(channelId, message);
    notify();
    return message;
  }, function(e){
    toast('Could not update message: ' + ((e && e.body && e.body.message) || 'unknown error'));
    throw e;
  });
}

export function deleteMessage(channelId, messageId){
  return chatApi.deleteMessage(channelId, messageId).then(function(message){
    appendOrReplaceMessage(channelId, message);
    notify();
    return message;
  }, function(e){
    toast('Could not delete message: ' + ((e && e.body && e.body.message) || 'unknown error'));
    throw e;
  });
}

function appendOrReplaceMessage(channelId, message){
  var entry = chatState.messagesByChannel[channelId];
  if(!entry) return;
  var idx = entry.messages.findIndex(function(m){ return m.id === message.id; });
  if(idx === -1) entry.messages.push(message);
  else entry.messages[idx] = message;
}

/* Called from features/live-updates.js's dispatchEvent on a "chat-message" SSE frame — the tab that
   made the change already updated itself directly from the mutation's own response (see
   sendMessage/editMessage/deleteMessage above) and is excluded server-side from receiving its own
   echo, so this only ever fires for messages from OTHER users/tabs. */
export function handleChatMessageEvent(payload){
  var message = {
    id: payload.messageId, channelId: payload.channelId, authorUserId: payload.authorUserId,
    authorName: payload.authorName, text: payload.text, dateCreated: payload.dateCreated,
    isDeleted: payload.isDeleted, mentionedUserIds: payload.mentionedUserIds || []
  };
  appendOrReplaceMessage(payload.channelId, message);

  var isActiveAndOpen = chatState.isOpen && chatState.activeChannelId === payload.channelId;
  if(!isActiveAndOpen && payload.changeType === 'created'){
    chatState.unreadByChannel[payload.channelId] = (chatState.unreadByChannel[payload.channelId] || 0) + 1;
  }

  var iAmMentioned = payload.changeType !== 'deleted' && (payload.mentionedUserIds || []).indexOf(getCurrentUserId()) !== -1;
  if(iAmMentioned){
    var channel = findChannel(payload.channelId);
    toastWithAction((payload.authorName || 'Someone') + ' mentioned you' + (channel && channel.name ? ' in "' + channel.name + '"' : '') + '.', 'Open', function(){
      openChatPanel();
      openChannel(payload.channelId);
    });
  } else if(payload.changeType === 'created' && !isActiveAndOpen){
    var ch = findChannel(payload.channelId);
    toastWithAction((payload.authorName || 'Someone') + ' sent a new message' + (ch && ch.name ? ' in "' + ch.name + '"' : '') + '.', 'Open', function(){
      openChatPanel();
      openChannel(payload.channelId);
    });
  }

  notify();
}

export function truncateHistory(){
  return chatApi.truncate();
}

export function toggleRevealDeletedForAdmin(){
  chatState.revealDeletedForAdmin = !chatState.revealDeletedForAdmin;
  notify();
}

export function currentUserCanRevealDeleted(){
  return isOrgAdmin();
}
