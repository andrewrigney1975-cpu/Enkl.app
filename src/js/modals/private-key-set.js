"use strict";
import { generateSalt, deriveKeyMaterial, computeVerifier } from '../features/crypto.js';

var pendingOnSuccess = null;

function showSetPrivateKeyError(message){
  var el = document.getElementById('setPrivateKeyError');
  el.textContent = message;
  el.classList.remove('hidden');
}

export function openSetPrivateKeyModal(onSuccess){
  pendingOnSuccess = onSuccess;
  document.getElementById('setPrivateKeyInput').value = '';
  document.getElementById('setPrivateKeyConfirmInput').value = '';
  document.getElementById('setPrivateKeyError').classList.add('hidden');
  document.getElementById('setPrivateKeyOverlay').classList.remove('hidden');
  document.getElementById('setPrivateKeyInput').focus();
}

export function closeSetPrivateKeyModal(){
  document.getElementById('setPrivateKeyOverlay').classList.add('hidden');
  document.getElementById('setPrivateKeyInput').value = '';
  document.getElementById('setPrivateKeyConfirmInput').value = '';
  pendingOnSuccess = null;
}

export async function confirmSetPrivateKeyFromModal(){
  var key = document.getElementById('setPrivateKeyInput').value;
  var confirmKey = document.getElementById('setPrivateKeyConfirmInput').value;
  if(!key){ showSetPrivateKeyError('Please enter a key.'); return; }
  if(key !== confirmKey){ showSetPrivateKeyError("Keys don't match."); return; }

  var onSuccess = pendingOnSuccess;
  var salt = await generateSalt();
  var derivedBits = await deriveKeyMaterial(key, salt);
  var verifier = await computeVerifier(derivedBits);

  closeSetPrivateKeyModal();
  if(onSuccess) await onSuccess({salt: salt, verifier: verifier, derivedBits: derivedBits});
}
