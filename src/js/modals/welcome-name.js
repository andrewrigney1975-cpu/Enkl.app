"use strict";
import { getCurrentProject } from '../store.js';
import { claimSeedProjectAsFirstUser } from '../mutations.js';
import { toast } from '../ui.js';

/* First-run "what's your name?" prompt — shown once, only right after storage.js's loadDB() just
   created a brand-new seed DB (see app.js's applyFirstRunExperience()), never on a returning visit.
   Skippable (X, outside-click, or the Skip button) exactly like the Opening Experience picker it
   sits alongside — nothing here is forced, a skip just leaves the seed project's tasks unassigned,
   same as before this feature existed. */

export function openWelcomeNameModal(){
  document.getElementById('welcomeNameInput').value = '';
  document.getElementById('welcomeNameOverlay').classList.remove('hidden');
  document.getElementById('welcomeNameInput').focus();
}
export function closeWelcomeNameModal(){
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
