"use strict";
import { deriveKeyMaterial, computeVerifier, decryptText } from '../features/crypto.js';

var pendingTask = null;
var pendingOnResult = null;

function showUnlockError(message){
  var el = document.getElementById('unlockPrivateTaskError');
  el.textContent = message;
  el.classList.remove('hidden');
}

export function openUnlockPrivateTaskModal(task, onResult){
  pendingTask = task;
  pendingOnResult = onResult;
  document.getElementById('unlockPrivateTaskInput').value = '';
  document.getElementById('unlockPrivateTaskError').classList.add('hidden');
  document.getElementById('unlockPrivateTaskOverlay').classList.remove('hidden');
  document.getElementById('unlockPrivateTaskInput').focus();
}

/* Cancel, the X button, backdrop click, and Escape all route here. Unlike
   the Set-Key modal, this one must always resolve the caller's pending
   flow (opening the task modal is otherwise left hanging) rather than
   silently no-op. */
export function closeUnlockPrivateTaskModal(){
  document.getElementById('unlockPrivateTaskOverlay').classList.add('hidden');
  document.getElementById('unlockPrivateTaskInput').value = '';
  var onResult = pendingOnResult;
  pendingTask = null;
  pendingOnResult = null;
  if(onResult) onResult({mode: 'cancel'});
}

export async function confirmUnlockFromModal(){
  var task = pendingTask;
  var onResult = pendingOnResult;
  if(!task || !onResult) return;
  var key = document.getElementById('unlockPrivateTaskInput').value;

  var derivedBits = await deriveKeyMaterial(key, task.privateSalt);
  var verifier = await computeVerifier(derivedBits);
  if(verifier !== task.privateVerifier){
    showUnlockError('Incorrect key.');
    return;
  }

  var description;
  try {
    description = await decryptText(task.encryptedDescription, task.encryptionIv, derivedBits);
  } catch(e){
    showUnlockError('Could not decrypt this task’s description — the stored data may be corrupted.');
    return;
  }

  pendingTask = null;
  pendingOnResult = null;
  document.getElementById('unlockPrivateTaskOverlay').classList.add('hidden');
  document.getElementById('unlockPrivateTaskInput').value = '';
  onResult({mode: 'unlocked', description: description, derivedBits: derivedBits});
}

export function continueWithoutKeyFromModal(){
  var onResult = pendingOnResult;
  pendingTask = null;
  pendingOnResult = null;
  document.getElementById('unlockPrivateTaskOverlay').classList.add('hidden');
  document.getElementById('unlockPrivateTaskInput').value = '';
  if(onResult) onResult({mode: 'continue'});
}
