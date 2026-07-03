"use strict";
import { state } from '../storage.js';
import { escapeHTML } from '../views/board.js';
import { APP_VERSION } from '../config.js';

function logoSvgMarkup(size){
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="0" y="0" width="24" height="24" rx="5" fill="#0c66e4"/>' +
    '<rect x="5" y="6" width="4" height="12" rx="1" fill="#fff"/>' +
    '<rect x="10.5" y="6" width="4" height="7" rx="1" fill="#fff" opacity=".85"/>' +
    '<rect x="16" y="6" width="4" height="10" rx="1" fill="#fff" opacity=".7"/>' +
  '</svg>';
}

function renderAboutProjectsList(){
  var listEl = document.getElementById('aboutProjectsList');
  var ids = (state.db && state.db.projectOrder) || [];
  var projects = ids.map(function(id){ return state.db.projects[id]; }).filter(Boolean);
  if(projects.length === 0){
    listEl.innerHTML = '<div class="kf-about-projects-empty">No projects yet.</div>';
    return;
  }
  listEl.innerHTML = projects.map(function(p){
    return (
      '<div class="kf-about-project-row">' +
        '<span class="kf-about-project-key">' + escapeHTML(p.key) + '</span>' +
        '<span class="kf-about-project-name">' + escapeHTML(p.name) + '</span>' +
      '</div>'
    );
  }).join('');
}

export function openAboutModal(){
  document.getElementById('aboutLogoIcon').innerHTML = logoSvgMarkup(112);
  document.getElementById('aboutVersion').textContent = 'Version ' + APP_VERSION;
  renderAboutProjectsList();
  document.getElementById('aboutOverlay').classList.remove('hidden');
}
export function closeAboutModal(){
  document.getElementById('aboutOverlay').classList.add('hidden');
}
export function isAboutModalOpen(){
  return !document.getElementById('aboutOverlay').classList.contains('hidden');
}
