"use strict";
import { aiAssistantApi } from '../api.js';
import { getCurrentProject } from '../store.js';
import { isServerAuthoritative } from './migration.js';
import { summarizeProjectAlerts } from './session-alerts.js';
import { toast } from '../ui.js';

/* v4 Phase 1 AI Assistant — state + API orchestration only, no DOM here (views/ai-assistant.js owns
   rendering), same one-directional "state module" + "view module" pair shape as features/chat.js vs.
   views/chat.js. Server-authoritative projects only (see AiAssistantController.cs's ProjectMember
   gate) — a local-only project has no server-side project id for the assistant to act against.
   Deliberately stateless across page reloads (no persisted conversation) — see the plan's "Data
   model additions" note for why that's a later phase, not this one. */

export var aiAssistantState = {
  isOpen: false,
  messages: [], // {role: 'user'|'assistant', content: string}
  sending: false,
  actions: [] // most recent turn's [{type, taskId, taskKey, title}], for a "did something" confirmation chip
};

var _onUpdate = function(){};
var _onTaskMutated = function(){};

/* Dependency injection (break the features/ai-assistant.js <-> views/ai-assistant.js circular import,
   plus a hook for the board to refresh itself after a create_task/update_task tool call) — same
   convention as features/chat.js's setChatDeps. */
export function setAiAssistantDeps(deps){
  if(deps.onUpdate) _onUpdate = deps.onUpdate;
  if(deps.onTaskMutated) _onTaskMutated = deps.onTaskMutated;
}

function notify(){ _onUpdate(); }

export function isAiAssistantAvailable(){
  var project = getCurrentProject();
  return !!(project && isServerAuthoritative(project));
}

export function isAiAssistantPanelOpen(){ return aiAssistantState.isOpen; }

export function openAiAssistantPanel(){
  aiAssistantState.isOpen = true;
  notify();
}
export function closeAiAssistantPanel(){
  aiAssistantState.isOpen = false;
  notify();
}

/* Called on project switch/logout — a stray leftover transcript from a different project talking
   about that project's own tasks would be actively misleading in the next one. */
export function resetAiAssistantState(){
  aiAssistantState.isOpen = false;
  aiAssistantState.messages = [];
  aiAssistantState.sending = false;
  aiAssistantState.actions = [];
  notify();
}

export function sendAiAssistantMessage(text){
  var trimmed = (text || '').trim();
  if(!trimmed || aiAssistantState.sending) return Promise.resolve();

  var project = getCurrentProject();
  if(!project || !isServerAuthoritative(project)){
    toast('The AI assistant is only available for projects saved to the server.');
    return Promise.resolve();
  }

  aiAssistantState.messages.push({role: 'user', content: trimmed});
  aiAssistantState.sending = true;
  aiAssistantState.actions = [];
  notify();

  var alertsSummary = summarizeProjectAlerts().map(function(a){ return a.message; }).join('; ');

  return aiAssistantApi.chat(project.serverProjectId, aiAssistantState.messages, alertsSummary)
    .then(function(result){
      aiAssistantState.messages.push({role: 'assistant', content: result.reply});
      aiAssistantState.actions = result.actions || [];
    })
    .catch(function(){
      aiAssistantState.messages.push({role: 'assistant', content: "Sorry, I couldn't process that — please try again."});
    })
    .then(function(){
      // Deliberately OUTSIDE the try/catch above — the chat call already succeeded or failed and its
      // own message is already pushed; a board-refresh hook that throws (app.js's own
      // setAiAssistantBoardRefreshHook callback, or anything else a future caller wires in) must never
      // retroactively turn a successful reply into a shown "Sorry, I couldn't process that" error, and
      // must never silently prevent the refresh from running by being swallowed into that same catch.
      if(aiAssistantState.actions.length > 0){
        try { _onTaskMutated(); } catch(e){ /* best-effort — the chat turn itself already succeeded */ }
      }
    })
    .then(function(){
      aiAssistantState.sending = false;
      notify();
    });
}
