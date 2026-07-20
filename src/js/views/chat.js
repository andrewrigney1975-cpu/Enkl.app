"use strict";
import {
  chatState, isChatPanelOpen, openChatPanel, closeChatPanel, totalUnreadCount,
  openChannel, loadOlderMessages, createChannel, sendMessage, editMessage, deleteMessage,
  toggleReaction, truncateHistory, toggleRevealDeletedForAdmin, currentUserCanRevealDeleted, setChatDeps
} from '../features/chat.js';
import { CHAT_EMOJI } from '../features/chat-emoji.js';
import { getCurrentUserId, isOrgAdmin } from '../api.js';
import { isServerLoggedIn } from '../features/migration.js';
import { escapeHTML, memberLabel } from '../utils.js';
import { utcISOToLocalDisplayDateTime, memberInitials } from '../date-utils.js';
import { iconSvg, hydrateIcons } from '../icons.js';
import { toast } from '../ui.js';
import { confirmDialog } from '../modals/confirm.js';
import { downloadBlob } from '../features/svg-export.js';
import { getCaretPixelPosition } from '../features/sql-intellisense.js';
import { unlockAudio } from '../features/chat-sounds.js';

/* Non-blocking chat panel — single-pane, navigable (channel list <-> thread <-> new-chat picker),
   mirroring a mobile chat app's own navigation shape per the original ask, rather than a Slack-style
   permanent split view — also the simplest layout to make work well at both the small floating-
   window desktop size and the full-screen mobile size with the same markup. All state/API calls live
   in features/chat.js; this file is rendering + DOM event wiring only. */

var _pendingEditMessageId = null; // set while the compose box is editing an existing message instead of composing a new one
var _newChatPicker = {isDirectMessage: false, selectedUserIds: []};

/* ---- @mention and :emoji: autocomplete ----
   Caret tracking reuses sql-intellisense.js's getCaretPixelPosition mirror-div technique verbatim —
   the only existing plain-<textarea> caret-position mechanism in this app (the rich-text editor's own
   hashtag autocomplete tracks a contenteditable caret instead, a different API entirely). Accept key
   is Tab or Space, matching the rich-text editor's mention/hashtag convention (this is prose
   composition, unlike the board search box's Tab-only convention where Space needs to stay a normal
   typable character). Mention and emoji share one dropdown/state — only one can be "open" at a time,
   since they're triggered by different, non-overlapping lead characters ("@" vs ":"). */
var _intellisense = null; // {kind: 'mention'|'emoji', prefixStart, prefixEnd, options: [...], activeIndex} or null when closed

var MENTION_TRIGGER_RE = /(^|\s)@([^\n]{0,60})$/;
var EMOJI_TRIGGER_RE = /(^|\s):([a-zA-Z0-9]{0,20})$/;

function detectMentionQuery(textarea){
  var caret = textarea.selectionStart;
  if(caret !== textarea.selectionEnd) return null; // no autocomplete mid-selection
  var before = textarea.value.slice(0, caret);
  var m = MENTION_TRIGGER_RE.exec(before);
  if(!m) return null;
  var prefix = m[2];
  if(/\s\s/.test(prefix)) return null; // two consecutive spaces - no longer composing a mention
  var atPos = m.index + m[1].length;
  // prefixStart sits right AFTER the "@" — accepting a mention keeps the "@" in place and inserts
  // just the display name after it.
  return {prefix: prefix, prefixStart: atPos + 1, prefixEnd: caret};
}

function detectEmojiQuery(textarea){
  var caret = textarea.selectionStart;
  if(caret !== textarea.selectionEnd) return null;
  var before = textarea.value.slice(0, caret);
  var m = EMOJI_TRIGGER_RE.exec(before);
  if(!m) return null;
  var colonPos = m.index + m[1].length;
  // prefixStart sits AT the ":" itself — accepting an emoji replaces the whole ":code" token
  // (colon included) with the literal unicode character.
  return {prefix: m[2], prefixStart: colonPos, prefixEnd: caret};
}

function updateComposeIntellisense(textarea, channelId){
  var mentionQuery = detectMentionQuery(textarea);
  if(mentionQuery){
    var channel = findChannel(channelId);
    var lowerPrefix = mentionQuery.prefix.toLowerCase();
    var options = (channel ? channel.members : []).filter(function(m){
      return m.userId !== getCurrentUserId() && m.displayName.toLowerCase().indexOf(lowerPrefix) === 0;
    });
    if(options.length > 0){
      _intellisense = {kind: 'mention', prefixStart: mentionQuery.prefixStart, prefixEnd: mentionQuery.prefixEnd, options: options, activeIndex: 0};
      renderIntellisenseDropdown(textarea);
      return;
    }
  }

  var emojiQuery = detectEmojiQuery(textarea);
  if(emojiQuery){
    var lowerCode = emojiQuery.prefix.toLowerCase();
    var emojiOptions = CHAT_EMOJI.filter(function(e){ return e.code.indexOf(lowerCode) === 0; });
    if(emojiOptions.length > 0){
      _intellisense = {kind: 'emoji', prefixStart: emojiQuery.prefixStart, prefixEnd: emojiQuery.prefixEnd, options: emojiOptions, activeIndex: 0};
      renderIntellisenseDropdown(textarea);
      return;
    }
  }

  closeIntellisenseDropdown();
}

function renderIntellisenseDropdown(textarea){
  var dropdown = document.getElementById('chatMentionDropdown');
  if(!dropdown || !_intellisense) return;

  dropdown.innerHTML = _intellisense.options.map(function(opt, i){
    var label = _intellisense.kind === 'mention' ? escapeHTML(memberLabel({name: opt.displayName, isActive: opt.isActive})) : (opt.char + ' :' + escapeHTML(opt.code) + ':');
    return '<div class="kf-intellisense-option' + (i === _intellisense.activeIndex ? ' active' : '') + '" data-index="' + i + '">' + label + '</div>';
  }).join('');
  dropdown.classList.remove('hidden');

  // Real-browser-only positioning (getCaretPixelPosition's own doc comment: jsdom performs no real
  // layout) — wrapped defensively so a jsdom/headless test environment never throws here. The compose
  // box sits near the bottom of an already-short floating chat panel, so a below-caret dropdown with
  // several rows (the emoji list especially, now 11 entries) routinely had nowhere near enough room
  // and ran off the bottom of the viewport — flip it to open UPWARD from the caret whenever there
  // isn't enough space below, same "flip if it doesn't fit" rule any other viewport-anchored popover
  // in this app would want.
  try {
    var pos = getCaretPixelPosition(textarea);
    var rect = textarea.getBoundingClientRect();
    var caretTop = rect.top + pos.top - textarea.scrollTop;
    var below = caretTop + pos.lineHeight;
    var dropdownHeight = dropdown.getBoundingClientRect().height || (_intellisense.options.length * 28 + 8);
    var margin = 8;

    dropdown.style.position = 'fixed';
    dropdown.style.left = Math.round(rect.left + pos.left - textarea.scrollLeft) + 'px';
    if(below + dropdownHeight + margin > window.innerHeight && caretTop - dropdownHeight >= margin){
      dropdown.style.top = Math.round(caretTop - dropdownHeight) + 'px';
    } else {
      dropdown.style.top = Math.round(Math.min(below, window.innerHeight - dropdownHeight - margin)) + 'px';
    }
  } catch(e){ /* jsdom or similar — dropdown still renders, just unpositioned */ }
}

function closeIntellisenseDropdown(){
  _intellisense = null;
  var dropdown = document.getElementById('chatMentionDropdown');
  if(dropdown){ dropdown.classList.add('hidden'); dropdown.innerHTML = ''; }
}

function acceptIntellisenseOption(textarea, index){
  if(!_intellisense || !_intellisense.options[index]) return;
  var value = textarea.value;
  var insertText = _intellisense.kind === 'mention' ? _intellisense.options[index].displayName : _intellisense.options[index].char;
  var newValue = value.slice(0, _intellisense.prefixStart) + insertText + ' ' + value.slice(_intellisense.prefixEnd);
  var newCaret = _intellisense.prefixStart + insertText.length + 1;
  textarea.value = newValue;
  textarea.setSelectionRange(newCaret, newCaret);
  closeIntellisenseDropdown();
}

export function initChatView(){
  setChatDeps({onUpdate: renderChatPanel});
}

export function toggleChatPanel(){
  unlockAudio();
  if(isChatPanelOpen()) closeChatPanel();
  else openChatPanel();
}

export function updateChatBubbleVisibility(){
  var btn = document.getElementById('chatBubbleBtn');
  if(btn) btn.classList.toggle('kf-vis-hidden', !isServerLoggedIn());
}

function updateChatBubbleBadge(){
  var badge = document.getElementById('chatBubbleBadge');
  if(!badge) return;
  var count = totalUnreadCount();
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('kf-vis-hidden', count === 0);
}

/* Full-screen chat: a pure CSS state toggle (see #chatPanel.kf-chat-fullscreen in styles.css),
   same convention as the Tables & Columns ERD panel's own full-screen mode
   (modals/project-search.js's erdFullscreenActive/isProjectQueryErdFullscreenOpen) — no separate
   overlay/modal element, no second copy of the thread/picker markup to keep in sync. The flag lives
   here (not in features/chat.js's chatState) since it's a pure view/display concern, matching where
   this file's other view-only state (_pendingEditMessageId, _newChatPicker) already lives. Never
   persists across a close/reopen — renderChatPanel() resets it the moment the panel is hidden, same
   as the ERD toggle never remembering fullscreen across a fresh open. */
var _chatFullscreen = false;

export function isChatFullscreenOpen(){
  return _chatFullscreen;
}

function updateFullscreenButtonState(){
  var btn = document.getElementById('chatFullscreenBtn');
  if(!btn) return;
  var icon = btn.querySelector('.kf-icon');
  if(icon){
    icon.setAttribute('data-icon', _chatFullscreen ? 'collapse' : 'expand');
    hydrateIcons(btn);
  }
  btn.title = _chatFullscreen ? 'Exit Full Screen' : 'Full Screen';
}

export function openChatFullscreen(){
  if(_chatFullscreen) return;
  _chatFullscreen = true;
  updateFullscreenButtonState();
  renderChatPanel();
}

export function closeChatFullscreen(){
  if(!_chatFullscreen) return;
  _chatFullscreen = false;
  updateFullscreenButtonState();
  renderChatPanel();
}

export function toggleChatFullscreen(){
  if(_chatFullscreen) closeChatFullscreen(); else openChatFullscreen();
}

export function renderChatPanel(){
  updateChatBubbleBadge();
  var panel = document.getElementById('chatPanel');
  if(!panel) return;
  panel.classList.toggle('hidden', !isChatPanelOpen());
  closeReactionPopover();
  if(!isChatPanelOpen()){
    _chatFullscreen = false;
    return;
  }
  panel.classList.toggle('kf-chat-fullscreen', _chatFullscreen);
  updateFullscreenButtonState();

  var body = document.getElementById('chatPanelBody');
  var title = document.getElementById('chatPanelTitle');
  var backBtn = document.getElementById('chatBackBtn');

  // Same three-way branch as before full screen existed — it still decides the contextual title
  // and whether "back" would apply, just no longer writes straight into `body`/`backBtn` itself
  // (that happens once, below, so both the docked and full-screen layouts share this logic).
  var titleText, showBack, mainHtml, wireMain;
  if(chatState.newChatPickerOpen){
    titleText = _newChatPicker.isDirectMessage ? 'New direct message' : 'New channel';
    showBack = true;
    mainHtml = newChatPickerHtml();
    wireMain = wireNewChatPicker;
  } else if(chatState.activeChannelId){
    titleText = channelDisplayName(findChannel(chatState.activeChannelId));
    showBack = true;
    mainHtml = threadHtml(chatState.activeChannelId);
    wireMain = function(root){ wireThread(root, chatState.activeChannelId); };
  } else {
    titleText = 'Chat';
    showBack = false;
    // In full screen the rail already shows the channel list permanently, so the main pane gets a
    // simple empty state instead of a second copy of it.
    mainHtml = _chatFullscreen ? '<div class="kf-chat-fullscreen-empty">Select a chat to get started.</div>' : channelListHtml();
    wireMain = _chatFullscreen ? null : wireChannelList;
  }

  title.textContent = titleText;
  // The rail replaces "back" entirely in full screen — you click a different row instead.
  backBtn.classList.toggle('kf-vis-hidden', !showBack || _chatFullscreen);

  // A re-render can be triggered by an incoming SSE message while the user is mid-sentence in the
  // compose box (this whole panel re-renders wholesale, no partial DOM diffing anywhere in this
  // app — see CLAUDE.md's "no client-side framework" convention) — preserve whatever's already
  // typed (and the caret position, and any in-progress edit) across that rebuild rather than
  // silently discarding it. ID-based lookup, so it works unchanged regardless of how deeply
  // #chatComposeInput ends up nested (plain body vs. the full-screen main pane below).
  var oldInput = document.getElementById('chatComposeInput');
  var preserved = oldInput ? {value: oldInput.value, selStart: oldInput.selectionStart, selEnd: oldInput.selectionEnd} : null;
  closeIntellisenseDropdown();

  if(_chatFullscreen){
    body.innerHTML =
      '<div class="kf-chat-fullscreen-body">' +
        '<div class="kf-chat-fullscreen-rail">' + channelListHtml() + '</div>' +
        '<div class="kf-chat-fullscreen-main">' + mainHtml + '</div>' +
      '</div>';
    var rail = body.querySelector('.kf-chat-fullscreen-rail');
    var main = body.querySelector('.kf-chat-fullscreen-main');
    wireChannelList(rail);
    if(wireMain) wireMain(main);
    if(chatState.activeChannelId){
      var activeRow = rail.querySelector('.kf-chat-channel-row[data-channel-id="' + chatState.activeChannelId + '"]');
      if(activeRow) activeRow.classList.add('kf-chat-channel-row-active');
    }
  } else {
    body.innerHTML = mainHtml;
    if(wireMain) wireMain(body);
  }

  if(chatState.activeChannelId && preserved && preserved.value){
    var newInput = document.getElementById('chatComposeInput');
    if(newInput){
      newInput.value = preserved.value;
      newInput.setSelectionRange(preserved.selStart, preserved.selEnd);
    }
    if(_pendingEditMessageId){
      document.getElementById('chatCancelEditBtn').classList.remove('kf-vis-hidden');
      document.getElementById('chatSendBtn').textContent = 'Save';
    }
  }
  if(chatState.activeChannelId) scrollMessagesToBottomIfNeeded(body);

  hydrateIcons(body);
}

export function chatBackClicked(){
  if(chatState.newChatPickerOpen){
    chatState.newChatPickerOpen = false;
  } else {
    chatState.activeChannelId = null;
  }
  renderChatPanel();
}

function findChannel(channelId){
  return chatState.channels.concat(chatState.adminVisibleChannels).find(function(c){ return c.id === channelId; });
}

function channelDisplayName(channel){
  if(!channel) return 'Chat';
  if(channel.name) return channel.name;
  if(channel.isDirectMessage){
    var other = channel.members.find(function(m){ return m.userId !== getCurrentUserId(); });
    return other ? memberLabel({name: other.displayName, isActive: other.isActive}) : 'Direct message';
  }
  return 'Chat';
}

/* ---- Channel list view ---- */

function channelRowHtml(channel, isAdminOnly){
  var unread = chatState.unreadByChannel[channel.id] || 0;
  var anyOnline = channel.members.some(function(m){ return m.userId !== getCurrentUserId() && m.isOnline; });
  return (
    '<div class="kf-chat-channel-row' + (isAdminOnly ? ' kf-chat-channel-row-admin' : '') + '" data-channel-id="' + channel.id + '">' +
      '<span class="kf-chat-presence-dot' + (anyOnline ? ' online' : '') + '"></span>' +
      '<span class="kf-chat-channel-name">' + (channel.isDirectMessage ? '' : '# ') + escapeHTML(channelDisplayName(channel)) + '</span>' +
      (unread > 0 ? '<span class="kf-chat-unread-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
    '</div>'
  );
}

function channelListHtml(){
  var html = '<div class="kf-chat-channel-list">';
  html += '<div class="kf-chat-new-row">' +
    '<button class="kf-btn kf-btn-secondary kf-chat-new-btn" id="chatNewChannelBtn">' + iconSvg('plus', 14) + ' New channel</button>' +
    '<button class="kf-btn kf-btn-secondary kf-chat-new-btn" id="chatNewDmBtn">' + iconSvg('plus', 14) + ' New message</button>' +
  '</div>';

  if(chatState.channels.length === 0 && chatState.adminVisibleChannels.length === 0){
    html += '<div class="kf-chat-empty">No conversations yet. Start a channel or direct message above.</div>';
  }

  if(chatState.channels.length > 0){
    html += chatState.channels.slice().sort(function(a, b){
      return new Date(b.dateCreated) - new Date(a.dateCreated);
    }).map(function(c){ return channelRowHtml(c, false); }).join('');
  }

  if(isOrgAdmin() && chatState.adminVisibleChannels.length > 0){
    html += '<div class="kf-chat-channel-group-label">All Org Channels (Admin view)</div>';
    html += chatState.adminVisibleChannels.map(function(c){ return channelRowHtml(c, true); }).join('');
  }

  if(isOrgAdmin()){
    html += '<button type="button" class="kf-btn kf-btn-ghost kf-chat-truncate-btn" id="chatTruncateBtn">' +
      iconSvg('trash', 13) + ' Truncate Chat History (180+ days)</button>';
  }

  html += '</div>';
  return html;
}

function wireChannelList(root){
  root.querySelectorAll('.kf-chat-channel-row').forEach(function(row){
    row.addEventListener('click', function(){
      openChannel(row.getAttribute('data-channel-id'));
    });
  });
  var newChannelBtn = root.querySelector('#chatNewChannelBtn');
  if(newChannelBtn) newChannelBtn.addEventListener('click', function(){ openNewChatPicker(false); });
  var newDmBtn = root.querySelector('#chatNewDmBtn');
  if(newDmBtn) newDmBtn.addEventListener('click', function(){ openNewChatPicker(true); });
  var truncateBtn = root.querySelector('#chatTruncateBtn');
  if(truncateBtn) truncateBtn.addEventListener('click', chatTruncateHistoryClicked);
}

/* ---- New channel / DM picker ---- */

function openNewChatPicker(isDirectMessage){
  _newChatPicker = {isDirectMessage: isDirectMessage, selectedUserIds: []};
  chatState.newChatPickerOpen = true;
  renderChatPanel();
}

function newChatPickerHtml(){
  var me = getCurrentUserId();
  var users = chatState.orgUsers.filter(function(u){ return u.id !== me; });
  var html = '<div class="kf-chat-new-picker">';
  if(!_newChatPicker.isDirectMessage){
    html += '<div class="kf-field"><label for="chatNewChannelNameInput">Channel name</label>' +
      '<input type="text" id="chatNewChannelNameInput" maxlength="200" placeholder="e.g. General"></div>';
  }
  html += '<div class="kf-field"><label>' + (_newChatPicker.isDirectMessage ? 'Send to' : 'Members') + '</label>' +
    '<div class="kf-chat-user-picker-list">';
  if(users.length === 0){
    html += '<div class="kf-chat-empty">No other colleagues in your organisation yet.</div>';
  }
  html += users.map(function(u){
    var checked = _newChatPicker.selectedUserIds.indexOf(u.id) !== -1;
    var inputType = _newChatPicker.isDirectMessage ? 'radio' : 'checkbox';
    return '<label class="kf-chat-user-picker-row">' +
      '<input type="' + inputType + '" name="chatNewChatUser" value="' + u.id + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="kf-chat-presence-dot' + (u.isOnline ? ' online' : '') + '"></span>' +
      '<span>' + escapeHTML(u.displayName) + '</span>' +
    '</label>';
  }).join('');
  html += '</div></div>';
  html += '<button class="kf-btn kf-btn-primary kf-chat-new-picker-create" id="chatCreateChatBtn">' +
    (_newChatPicker.isDirectMessage ? 'Start conversation' : 'Create channel') + '</button>';
  html += '</div>';
  return html;
}

function wireNewChatPicker(root){
  root.querySelectorAll('input[name="chatNewChatUser"]').forEach(function(input){
    input.addEventListener('change', function(){
      if(_newChatPicker.isDirectMessage){
        _newChatPicker.selectedUserIds = input.checked ? [input.value] : [];
      } else {
        var idx = _newChatPicker.selectedUserIds.indexOf(input.value);
        if(input.checked && idx === -1) _newChatPicker.selectedUserIds.push(input.value);
        else if(!input.checked && idx !== -1) _newChatPicker.selectedUserIds.splice(idx, 1);
      }
    });
  });

  var createBtn = root.querySelector('#chatCreateChatBtn');
  if(createBtn){
    createBtn.addEventListener('click', function(){
      if(_newChatPicker.selectedUserIds.length === 0){
        toast(_newChatPicker.isDirectMessage ? 'Choose who to message.' : 'Choose at least one member.');
        return;
      }
      var nameInput = root.querySelector('#chatNewChannelNameInput');
      var name = nameInput ? nameInput.value.trim() : null;
      if(!_newChatPicker.isDirectMessage && !name){
        toast('Please enter a channel name.');
        return;
      }
      createChannel(name, _newChatPicker.isDirectMessage, _newChatPicker.selectedUserIds).then(function(channel){
        chatState.newChatPickerOpen = false;
        openChannel(channel.id);
      }).catch(function(e){
        toast('Could not create: ' + ((e && e.body && e.body.message) || 'unknown error'));
      });
    });
  }
}

/* ---- Thread view ---- */

// Matches a message consisting of nothing but one or more emoji (optionally separated by
// whitespace) — \p{Extended_Pictographic} covers the emoji character set itself,
// \p{Emoji_Modifier} the Fitzpatrick skin-tone modifiers, and the zero-width-joiner (U+200D)
// and variation-selector code points multi-part emoji sequences (e.g. a family or a flag) are built
// from. Any actual text content anywhere in the message — even a single letter — fails this and
// falls back to the normal message font size.
var EMOJI_ONLY_MESSAGE_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]+$/u;
function isEmojiOnlyMessage(text){
  return !!text && EMOJI_ONLY_MESSAGE_RE.test(text);
}

function messageAuthorLabel(message, channel){
  var member = channel && message.authorUserId ? (channel.members || []).filter(function(m){ return m.userId === message.authorUserId; })[0] : null;
  return memberLabel({name: message.authorName || 'Unknown', isActive: member ? member.isActive !== false : true});
}

function messageRowHtml(message, channel){
  var isAuthor = message.authorUserId && message.authorUserId === getCurrentUserId();
  var canEdit = isAuthor && !message.isDeleted;
  var canDelete = (isAuthor || isOrgAdmin()) && !message.isDeleted;
  var canReact = !message.isDeleted; // any channel member/admin — reacting is a form of viewing, not authorship
  var showRealText = !message.isDeleted || (isOrgAdmin() && chatState.revealDeletedForAdmin);
  var text = showRealText ? highlightMentions(message.text, channel) : 'Message deleted';
  var isEmojiOnly = showRealText && isEmojiOnlyMessage(message.text);

  return (
    '<div class="kf-chat-message-row' + (message.isDeleted ? ' kf-chat-message-deleted' : '') + (isAuthor ? ' kf-chat-message-own' : '') + '" data-message-id="' + message.id + '">' +
      '<div class="kf-chat-message-avatar">' + escapeHTML(memberInitials(message.authorName || '?')) + '</div>' +
      '<div class="kf-chat-message-content">' +
        '<div class="kf-chat-message-meta">' +
          '<span class="kf-chat-message-author">' + escapeHTML(messageAuthorLabel(message, channel)) + '</span>' +
          '<span class="kf-chat-message-time">' + escapeHTML(utcISOToLocalDisplayDateTime(message.dateCreated)) + '</span>' +
          (message.isDeleted ? '<span class="kf-chat-deleted-icon" title="Deleted">' + iconSvg('trash', 11) + '</span>' : '') +
        '</div>' +
        '<div class="kf-chat-message-text' + (isEmojiOnly ? ' kf-chat-message-emoji-only' : '') + '">' + text + '</div>' +
        reactionPillsHtml(message) +
        (canReact || canEdit || canDelete ? '<div class="kf-chat-message-actions">' +
          (canReact ? '<button type="button" data-action="react" title="Add reaction">' + iconSvg('smile', 12) + '</button>' : '') +
          (canEdit ? '<button type="button" data-action="edit" title="Edit">' + iconSvg('edit', 12) + '</button>' : '') +
          (canDelete ? '<button type="button" data-action="delete" title="Delete">' + iconSvg('trash', 12) + '</button>' : '') +
        '</div>' : '') +
      '</div>' +
    '</div>'
  );
}

function reactionPillsHtml(message){
  var reactions = message.reactions || [];
  if(reactions.length === 0) return '';
  return '<div class="kf-chat-reactions">' + reactions.map(function(r){
    return '<button type="button" class="kf-chat-reaction-pill' + (r.reactedByMe ? ' reacted' : '') + '" data-emoji="' + escapeHTML(r.emoji) + '" title="' + escapeHTML(r.userNames.join(', ')) + '">' +
      r.emoji + ' <span>' + r.count + '</span></button>';
  }).join('') + '</div>';
}

/* Wraps "@FullDisplayName" occurrences (matched against the channel's own member roster, same
   longest-name-first rule the server uses for ParseMentions) in a highlighted span for display —
   mirrors features/hashtags.js's hashtagChipHtml idea, kept separate since the match target (full
   names with spaces, looked up against a live roster) is a different shape than hashtags' fixed-
   charset regex. */
function highlightMentions(text, channel){
  var escaped = escapeHTML(text);
  if(!channel) return escaped;
  var names = channel.members.map(function(m){ return m.displayName; })
    .filter(Boolean)
    .sort(function(a, b){ return b.length - a.length; });
  names.forEach(function(name){
    var needle = '@' + escapeHTML(name);
    if(escaped.indexOf(needle) === -1) return;
    escaped = escaped.split(needle).join('<span class="kf-chat-mention">' + needle + '</span>');
  });
  return escaped;
}

function threadHtml(channelId){
  var entry = chatState.messagesByChannel[channelId] || {messages: [], nextCursor: null, loading: false};
  var channel = findChannel(channelId);
  var html = '<div class="kf-chat-thread">';

  html += '<div class="kf-chat-thread-toolbar">' +
    '<button type="button" class="kf-btn kf-btn-ghost" id="chatExportBtn" title="Export this conversation as a text file">' + iconSvg('download', 13) + ' Export</button>';
  if(currentUserCanRevealDeleted()){
    html += '<label class="kf-chat-reveal-deleted-toggle" title="Org Admin only: show the original text of deleted messages instead of the placeholder">' +
      '<input type="checkbox" id="chatRevealDeletedCheckbox"' + (chatState.revealDeletedForAdmin ? ' checked' : '') + '>' +
      'Reveal deleted' +
    '</label>';
  }
  html += '</div>';

  html += '<div class="kf-chat-messages" id="chatMessagesScroll">';
  if(entry.nextCursor){
    html += '<button type="button" class="kf-btn kf-btn-ghost kf-chat-load-older-btn" id="chatLoadOlderBtn"' + (entry.loading ? ' disabled' : '') + '>' +
      (entry.loading ? 'Loading…' : 'Load older messages') + '</button>';
  }
  if(entry.messages.length === 0 && !entry.loading){
    html += '<div class="kf-chat-empty">No messages yet — say hello!</div>';
  }
  html += entry.messages.map(function(m){ return messageRowHtml(m, channel); }).join('');
  html += '</div>';
  html += '<div id="chatReactionPopover" class="kf-chat-reaction-popover hidden"></div>';
  html += '<div class="kf-chat-compose">' +
    '<textarea id="chatComposeInput" placeholder="Message ' + escapeHTML(channelDisplayName(channel)) + '..." rows="2"></textarea>' +
    '<div class="kf-chat-compose-row">' +
      '<button type="button" class="kf-btn kf-btn-ghost kf-vis-hidden" id="chatCancelEditBtn">Cancel edit</button>' +
      '<button type="button" class="kf-btn kf-btn-primary" id="chatSendBtn">Send</button>' +
    '</div>' +
    '<div id="chatMentionDropdown" class="kf-intellisense-dropdown hidden"></div>' +
  '</div>';
  html += '</div>';
  return html;
}

function scrollMessagesToBottomIfNeeded(root){
  var scroll = root.querySelector('#chatMessagesScroll');
  if(scroll) scroll.scrollTop = scroll.scrollHeight;
}

/* ---- Reaction popover — hover/click a message's smiley trigger for a horizontal emoji picker.
   One shared element per open thread (like #chatMentionDropdown above), tracked by which message it's
   currently open for so a second click on the same trigger toggles it closed. Closes on any outside
   click via a one-off capture-phase listener, added only while open and always removed on close. */
var _reactionPopoverMessageId = null;
var _reactionPopoverOutsideHandler = null;

function openReactionPopover(triggerBtn, channelId, messageId){
  var popover = document.getElementById('chatReactionPopover');
  if(!popover) return;
  if(_reactionPopoverMessageId === messageId){ closeReactionPopover(); return; }
  closeReactionPopover();
  _reactionPopoverMessageId = messageId;

  popover.innerHTML = CHAT_EMOJI.map(function(e){
    return '<button type="button" class="kf-chat-reaction-option" data-emoji="' + escapeHTML(e.char) + '" title="' + escapeHTML(e.label) + '">' + e.char + '</button>';
  }).join('');
  popover.classList.remove('hidden');

  // Real-browser-only positioning, same defensive try/catch as the mention/emoji dropdown above.
  // The chat panel itself sits near the viewport's right edge (see .kf-chat-panel's own right:24px),
  // and an own-message's trigger is further right still (row-reverse layout) — naively anchoring the
  // popover's LEFT edge to the trigger's left edge routinely pushed it half off-screen. Anchor to the
  // trigger's RIGHT edge instead (growing leftward, which is where the room actually is) and clamp
  // both edges against the viewport as a second line of defense.
  try {
    var rect = triggerBtn.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.top = Math.round(rect.bottom + 4) + 'px';
    popover.style.left = '0px'; // measure natural width first, then position
    var popoverWidth = popover.getBoundingClientRect().width;
    var margin = 8;
    var left = rect.right - popoverWidth;
    left = Math.min(left, window.innerWidth - popoverWidth - margin);
    left = Math.max(left, margin);
    popover.style.left = Math.round(left) + 'px';
  } catch(e){ /* jsdom or similar */ }

  popover.querySelectorAll('.kf-chat-reaction-option').forEach(function(btn){
    // mousedown (not click), with preventDefault — same "wins the race against blur" convention as
    // every other popover/dropdown in this app.
    btn.addEventListener('mousedown', function(evt){
      evt.preventDefault();
      toggleReaction(channelId, messageId, btn.getAttribute('data-emoji'));
      closeReactionPopover();
    });
  });

  _reactionPopoverOutsideHandler = function(evt){
    if(!popover.contains(evt.target) && evt.target !== triggerBtn) closeReactionPopover();
  };
  // Deferred one tick so the very click that opened the popover doesn't also immediately close it.
  setTimeout(function(){
    if(_reactionPopoverOutsideHandler) document.addEventListener('mousedown', _reactionPopoverOutsideHandler, true);
  }, 0);
}

function closeReactionPopover(){
  _reactionPopoverMessageId = null;
  var popover = document.getElementById('chatReactionPopover');
  if(popover){ popover.classList.add('hidden'); popover.innerHTML = ''; }
  if(_reactionPopoverOutsideHandler){
    document.removeEventListener('mousedown', _reactionPopoverOutsideHandler, true);
    _reactionPopoverOutsideHandler = null;
  }
}

function wireThread(root, channelId){
  var loadOlderBtn = root.querySelector('#chatLoadOlderBtn');
  if(loadOlderBtn) loadOlderBtn.addEventListener('click', function(){ loadOlderMessages(channelId); });

  var exportBtn = root.querySelector('#chatExportBtn');
  if(exportBtn) exportBtn.addEventListener('click', chatExportChannelClicked);

  var revealCheckbox = root.querySelector('#chatRevealDeletedCheckbox');
  if(revealCheckbox) revealCheckbox.addEventListener('change', chatToggleRevealDeleted);

  root.querySelectorAll('[data-action="edit"]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var row = btn.closest('.kf-chat-message-row');
      var messageId = row.getAttribute('data-message-id');
      var entry = chatState.messagesByChannel[channelId];
      var message = entry.messages.find(function(m){ return m.id === messageId; });
      if(!message) return;
      _pendingEditMessageId = messageId;
      var input = root.querySelector('#chatComposeInput');
      input.value = message.text;
      input.focus();
      root.querySelector('#chatCancelEditBtn').classList.remove('kf-vis-hidden');
      root.querySelector('#chatSendBtn').textContent = 'Save';
    });
  });

  root.querySelectorAll('[data-action="delete"]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var row = btn.closest('.kf-chat-message-row');
      var messageId = row.getAttribute('data-message-id');
      confirmDialog('Delete this message?', 'This cannot be undone from the message list, but the message is kept in the database.', function(){
        deleteMessage(channelId, messageId);
      });
    });
  });

  root.querySelectorAll('[data-action="react"]').forEach(function(btn){
    btn.addEventListener('click', function(evt){
      evt.stopPropagation();
      var row = btn.closest('.kf-chat-message-row');
      var messageId = row.getAttribute('data-message-id');
      openReactionPopover(btn, channelId, messageId);
    });
  });

  root.querySelectorAll('.kf-chat-reaction-pill').forEach(function(pill){
    pill.addEventListener('click', function(){
      var row = pill.closest('.kf-chat-message-row');
      var messageId = row.getAttribute('data-message-id');
      toggleReaction(channelId, messageId, pill.getAttribute('data-emoji'));
    });
  });

  var cancelEditBtn = root.querySelector('#chatCancelEditBtn');
  if(cancelEditBtn){
    cancelEditBtn.addEventListener('click', function(){
      resetComposeBox(root);
    });
  }

  var sendBtn = root.querySelector('#chatSendBtn');
  var input = root.querySelector('#chatComposeInput');
  function submit(){
    unlockAudio();
    var text = input.value;
    if(!text.trim()) return;
    var promise = _pendingEditMessageId
      ? editMessage(channelId, _pendingEditMessageId, text)
      : sendMessage(channelId, text);
    promise.then(function(){
      resetComposeBox(document.getElementById('chatPanelBody'));
    }).catch(function(){ /* toast already shown by features/chat.js */ });
  }
  if(sendBtn) sendBtn.addEventListener('click', submit);
  if(input){
    input.addEventListener('input', function(){
      updateComposeIntellisense(input, channelId);
    });
    input.addEventListener('blur', function(){
      // A short delay so a mousedown on a dropdown option (see below) still registers before the
      // dropdown disappears out from under it.
      setTimeout(closeIntellisenseDropdown, 150);
    });
    input.addEventListener('keydown', function(e){
      if(_intellisense){
        if(e.key === 'ArrowDown'){
          e.preventDefault();
          _intellisense.activeIndex = (_intellisense.activeIndex + 1) % _intellisense.options.length;
          renderIntellisenseDropdown(input);
          return;
        }
        if(e.key === 'ArrowUp'){
          e.preventDefault();
          _intellisense.activeIndex = (_intellisense.activeIndex - 1 + _intellisense.options.length) % _intellisense.options.length;
          renderIntellisenseDropdown(input);
          return;
        }
        if(e.key === 'Tab' || e.key === ' '){
          e.preventDefault();
          acceptIntellisenseOption(input, _intellisense.activeIndex);
          return;
        }
        if(e.key === 'Escape'){
          e.preventDefault();
          e.stopPropagation();
          closeIntellisenseDropdown();
          return;
        }
      }
      if(e.key === 'Enter' && !e.shiftKey && !_intellisense){
        e.preventDefault();
        submit();
      }
    });
  }

  var dropdown = root.querySelector('#chatMentionDropdown');
  if(dropdown){
    // mousedown (not click), with preventDefault — wins the race against the textarea's own blur,
    // same convention every other intellisense/autocomplete dropdown in this app uses.
    dropdown.addEventListener('mousedown', function(e){
      var option = e.target.closest('[data-index]');
      if(!option) return;
      e.preventDefault();
      acceptIntellisenseOption(input, parseInt(option.getAttribute('data-index'), 10));
      input.focus();
    });
  }
}

function resetComposeBox(root){
  _pendingEditMessageId = null;
  if(!root) return;
  var input = root.querySelector('#chatComposeInput');
  if(input) input.value = '';
  var cancelBtn = root.querySelector('#chatCancelEditBtn');
  if(cancelBtn) cancelBtn.classList.add('kf-vis-hidden');
  var sendBtn = root.querySelector('#chatSendBtn');
  if(sendBtn) sendBtn.textContent = 'Send';
}

/* ---- Admin: reveal-deleted toggle + Truncate History (see modals/chat-admin.js for the UI these
   two functions are wired from — kept here since they operate on chat panel state/rendering) ---- */

export function chatToggleRevealDeleted(){
  toggleRevealDeletedForAdmin();
}

export function chatTruncateHistoryClicked(){
  confirmDialog(
    'Truncate chat history?',
    'Permanently deletes every message older than 180 days across the whole organisation, including already-deleted ones. This cannot be undone.',
    function(){
      truncateHistory().then(function(result){
        toast('Removed ' + result.deletedCount + ' message(s) older than ' + new Date(result.cutoffDate).toLocaleDateString() + '.');
      }, function(e){
        toast('Could not truncate chat history: ' + ((e && e.body && e.body.message) || 'unknown error'));
      });
    }
  );
}

export function chatExportChannelClicked(){
  if(!chatState.activeChannelId) return;
  var channel = findChannel(chatState.activeChannelId);
  var entry = chatState.messagesByChannel[chatState.activeChannelId];
  if(!entry || entry.messages.length === 0){
    toast('No messages to export yet.');
    return;
  }
  var lines = entry.messages.map(function(m){
    var text = (!m.isDeleted || (isOrgAdmin() && chatState.revealDeletedForAdmin)) ? m.text : '[deleted]';
    return '[' + utcISOToLocalDisplayDateTime(m.dateCreated) + '] ' + (m.authorName || 'Unknown') + ': ' + text;
  });
  var filename = (channelDisplayName(channel) || 'chat').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.txt';
  downloadBlob(new Blob([lines.join('\n')], {type: 'text/plain'}), filename);
}
