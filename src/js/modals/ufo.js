"use strict";

var UFO_URL = 'https://enkl.app/ufo';

export function openUfoModal(){
  document.getElementById('ufoFrame').src = UFO_URL;
  document.getElementById('ufoOverlay').classList.remove('hidden');
}

export function closeUfoModal(){
  document.getElementById('ufoOverlay').classList.add('hidden');
  document.getElementById('ufoFrame').src = 'about:blank';
}

export function isUfoModalOpen(){
  return !document.getElementById('ufoOverlay').classList.contains('hidden');
}
