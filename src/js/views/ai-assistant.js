"use strict";
import {
  aiAssistantState, isAiAssistantPanelOpen, openAiAssistantPanel, closeAiAssistantPanel,
  isAiAssistantAvailable, sendAiAssistantMessage, setAiAssistantDeps, startAiAssistantAvailabilityPolling
} from '../features/ai-assistant.js';
import { escapeHTML } from '../utils.js';
import { hydrateIcons } from '../icons.js';
import { animatedLogoSvgMarkup, startAnimatedLogo } from '../features/animated-logo.js';

/* v4 Phase 1 AI Assistant panel — floating bubble + non-blocking panel, same shape as
   views/chat.js's own bubble/panel (no .kf-overlay backdrop, board stays usable underneath). All
   state/API calls live in features/ai-assistant.js; this file is rendering + DOM event wiring only.
   Voice input is the browser's own Web Speech API (SpeechRecognition) — free, no server round trip,
   feature-detected and hidden entirely where unsupported (Safari/Firefox), matching this app's
   existing graceful-degradation convention rather than a hard dependency. */

var _recognition = null; // lazily constructed SpeechRecognition instance, reused across toggles
var _recognizing = false;
var AI_ASSISTANT_BUBBLE_LOGO_ID_PREFIX = 'aiAssistantBubbleLogo';

export function initAiAssistantView(){
  // onUpdate must also re-check bubble visibility, not just re-render the panel body - the
  // availability poll's async fetch (features/ai-assistant.js) calls notify() once its result comes
  // back, and that's the only signal that an entitlement change actually happened; without this, the
  // bubble would only ever reflect a stale orgEntitled value until some unrelated render happened to
  // call applyHeaderButtonVisibility() again.
  setAiAssistantDeps({
    onUpdate: function(){ renderAiAssistantPanel(); updateAiAssistantBubbleVisibility(); },
    onTaskMutated: notifyTaskMutated
  });

  // The same "talking" 3-bar mark as the Welcome Name modal's logo (features/animated-logo.js),
  // shrunk to fit the bubble — runs continuously rather than only while a modal is open, since the
  // bubble itself has no open/close lifecycle to hook the animation to (it's just hidden/shown via
  // kf-vis-hidden — see updateAiAssistantBubbleVisibility below). Negligible cost (a few DOM attribute
  // writes every 150-350ms), same as the modal's own version.
  var bubbleLogo = document.getElementById('aiAssistantBubbleLogo');
  if(bubbleLogo){
    bubbleLogo.innerHTML = animatedLogoSvgMarkup(24, AI_ASSISTANT_BUBBLE_LOGO_ID_PREFIX);
    startAnimatedLogo(AI_ASSISTANT_BUBBLE_LOGO_ID_PREFIX);
  }

  var bubbleBtn = document.getElementById('aiAssistantBubbleBtn');
  if(bubbleBtn) bubbleBtn.addEventListener('click', toggleAiAssistantPanel);

  var closeBtn = document.getElementById('aiAssistantCloseBtn');
  if(closeBtn) closeBtn.addEventListener('click', closeAiAssistantPanel);

  var sendBtn = document.getElementById('aiAssistantSendBtn');
  var input = document.getElementById('aiAssistantInput');
  if(sendBtn && input){
    sendBtn.addEventListener('click', function(){ submitComposedMessage(input); });
    input.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        submitComposedMessage(input);
      }
    });
  }

  var micBtn = document.getElementById('aiAssistantMicBtn');
  if(micBtn){
    var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(SpeechRecognitionCtor){
      micBtn.classList.remove('kf-vis-hidden');
      micBtn.addEventListener('click', function(){ toggleVoiceInput(SpeechRecognitionCtor, micBtn, input); });
    }
  }

  renderAiAssistantPanel();
}

function submitComposedMessage(input){
  var text = input.value;
  input.value = '';
  sendAiAssistantMessage(text);
}

function toggleAiAssistantPanel(){
  if(isAiAssistantPanelOpen()) closeAiAssistantPanel();
  else openAiAssistantPanel();
}

/* Best-effort — a re-render triggered by a create_task/update_task tool call just needs the board's
   own existing refresh path; wired from app.js via setAiAssistantDeps's onTaskMutated hook rather than
   importing views/board.js here directly (same circular-import-avoidance reason as every other
   cross-view dependency injection in this app). */
var _onTaskMutated = function(){};
export function setAiAssistantBoardRefreshHook(fn){ _onTaskMutated = fn; }
function notifyTaskMutated(){ _onTaskMutated(); }

function toggleVoiceInput(SpeechRecognitionCtor, micBtn, input){
  if(_recognizing){
    if(_recognition) _recognition.stop();
    return;
  }

  if(!_recognition){
    _recognition = new SpeechRecognitionCtor();
    _recognition.continuous = false;
    _recognition.interimResults = false;
    _recognition.onresult = function(event){
      var transcript = event.results[0][0].transcript;
      input.value = transcript;
      input.focus();
    };
    _recognition.onend = function(){
      _recognizing = false;
      micBtn.classList.remove('kf-ai-assistant-mic-active');
    };
    _recognition.onerror = function(){
      _recognizing = false;
      micBtn.classList.remove('kf-ai-assistant-mic-active');
    };
  }

  _recognizing = true;
  micBtn.classList.add('kf-ai-assistant-mic-active');
  try { _recognition.start(); } catch(e){ _recognizing = false; micBtn.classList.remove('kf-ai-assistant-mic-active'); }
}

export function updateAiAssistantBubbleVisibility(){
  // Idempotent - safe to call on every render (this function already is). Kicks off an immediate
  // fetch plus the recurring poll the first time it's called, so a mid-session entitlement
  // revocation is caught within AVAILABILITY_POLL_INTERVAL_MS without a page reload.
  startAiAssistantAvailabilityPolling();
  var available = isAiAssistantAvailable();
  var btn = document.getElementById('aiAssistantBubbleBtn');
  if(btn) btn.classList.toggle('kf-vis-hidden', !available);
  if(!available && isAiAssistantPanelOpen()) closeAiAssistantPanel();
}

export function renderAiAssistantPanel(){
  var panel = document.getElementById('aiAssistantPanel');
  if(!panel) return;
  panel.classList.toggle('hidden', !isAiAssistantPanelOpen());
  if(!isAiAssistantPanelOpen()) return;

  var messagesEl = document.getElementById('aiAssistantMessages');
  if(messagesEl){
    var html = aiAssistantState.messages.map(function(m){
      var bubbleClass = m.role === 'user' ? 'kf-ai-assistant-msg kf-ai-assistant-msg-user' : 'kf-ai-assistant-msg kf-ai-assistant-msg-assistant';
      return '<div class="' + bubbleClass + '">' + escapeHTML(m.content).replace(/\n/g, '<br>') + '</div>';
    }).join('');

    if(aiAssistantState.sending){
      html += '<div class="kf-ai-assistant-msg kf-ai-assistant-msg-assistant kf-ai-assistant-thinking">Thinking…</div>';
    }

    if(!aiAssistantState.sending && aiAssistantState.actions.length > 0){
      html += '<div class="kf-ai-assistant-actions">' + aiAssistantState.actions.map(function(a){
        var label = a.type === 'task_created' ? 'Created' : 'Updated';
        return '<span class="kf-ai-assistant-action-chip">' + label + ' ' + escapeHTML(a.taskKey || '') + '</span>';
      }).join('') + '</div>';
    }

    if(aiAssistantState.messages.length === 0){
      html = '<div class="kf-ai-assistant-empty">Ask me to create or edit a task, look one up, or tell you what\'s most critical right now.</div>';
    }

    messagesEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  var sendBtn = document.getElementById('aiAssistantSendBtn');
  if(sendBtn) sendBtn.disabled = aiAssistantState.sending;

  hydrateIcons(panel);
}
