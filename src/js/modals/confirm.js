"use strict";

var pendingConfirmAction = null;
// Optional — only fires from the dialog's own labeled Cancel button (see app.js), never from the X
// close button or an outside click, both of which stay a pure no-op abort for every existing caller
// (neither passes this 4th arg). Added for Advanced Query's "New" button, where the two dialog
// buttons mean "Save first" / "Discard" rather than the usual "Confirm" / "back out entirely".
var pendingCancelAction = null;

export function confirmDialog(title, message, onConfirm, onCancel){
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  pendingConfirmAction = onConfirm;
  pendingCancelAction = onCancel || null;
  document.getElementById('confirmOverlay').classList.remove('hidden');
}
export function closeConfirmDialog(){
  document.getElementById('confirmOverlay').classList.add('hidden');
  pendingConfirmAction = null;
  pendingCancelAction = null;
}
export function getPendingConfirmAction(){
  return pendingConfirmAction;
}
export function getPendingCancelAction(){
  return pendingCancelAction;
}
