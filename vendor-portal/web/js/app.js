"use strict";

import { api, ApiError } from './api.js';
import { hydrateIcons } from './icons.js';
import { applyTheme, currentTheme, toggleTheme } from './theme.js';
import { renderDashboard } from './views/dashboard.js';
import { renderOrganisations } from './views/organisations.js';
import { renderLicenses } from './views/licenses.js';
import { renderContracts } from './views/contracts.js';
import { renderAnnouncements } from './views/announcements.js';
import { closeAllExportAsPanels } from './features/svg-export.js';
import { closeDbLatencyModal, isDbLatencyModalOpen } from './features/db-latency-monitor.js';
import { closeWebappLatencyModal, isWebappLatencyModalOpen } from './features/webapp-latency-monitor.js';

var loginWrap = document.getElementById('loginWrap');
var viewRoot = document.getElementById('viewRoot');
var sideNav = document.getElementById('sideNav');
var logoutBtn = document.getElementById('logoutBtn');
var sessionUserLabel = document.getElementById('sessionUserLabel');

var VIEWS = {
  dashboard: { render: renderDashboard, navBtn: 'navDashboardBtn' },
  organisations: { render: renderOrganisations, navBtn: 'navOrganisationsBtn' },
  licenses: { render: renderLicenses, navBtn: 'navLicensesBtn' },
  contracts: { render: renderContracts, navBtn: 'navContractsBtn' },
  announcements: { render: renderAnnouncements, navBtn: 'navAnnouncementsBtn' }
};

var currentView = 'dashboard';

async function showView(name){
  currentView = name;
  Object.keys(VIEWS).forEach(function(key){
    document.getElementById(VIEWS[key].navBtn).classList.toggle('active', key === name);
  });
  try{
    await VIEWS[name].render(viewRoot);
  }catch(e){
    if(e instanceof ApiError && e.status === 401){
      showLoggedOut();
      return;
    }
    viewRoot.innerHTML = '<div class="kf-view"><p style="color:var(--kf-danger);">' + e.message + '</p></div>';
  }
}

function showLoggedIn(username){
  loginWrap.classList.add('hidden');
  sideNav.classList.remove('hidden');
  viewRoot.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
  sessionUserLabel.textContent = username || '';
  showView(currentView);
}

function showLoggedOut(){
  loginWrap.classList.remove('hidden');
  sideNav.classList.add('hidden');
  viewRoot.classList.add('hidden');
  logoutBtn.classList.add('hidden');
  sessionUserLabel.textContent = '';
}

Object.keys(VIEWS).forEach(function(key){
  document.getElementById(VIEWS[key].navBtn).addEventListener('click', function(){ showView(key); });
});

document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);

document.addEventListener('click', function(e){
  if(!e.target.closest('.kf-export-as-wrap')) closeAllExportAsPanels();
});

// Database Latency "big view" modal — static markup (always present in index.html, unlike the
// Dashboard view's own dynamically-rendered content), so it's wired once here rather than per-render
// in views/dashboard.js. Backdrop-click and Escape-to-close match the main Enkl App's own modal
// convention (see e.g. its modals/health.js + app.js wiring) — neither existed yet for this
// portal's older License/Contract modals, but this one gets the full treatment.
document.getElementById('dbLatencyModalClose').addEventListener('click', closeDbLatencyModal);
document.getElementById('dbLatencyModalOverlay').addEventListener('mousedown', function(e){
  if(e.target.id === 'dbLatencyModalOverlay') closeDbLatencyModal();
});
// Same big-view-modal wiring, for the sibling "APM - Web App Responsiveness" chart's own modal.
document.getElementById('webappLatencyModalClose').addEventListener('click', closeWebappLatencyModal);
document.getElementById('webappLatencyModalOverlay').addEventListener('mousedown', function(e){
  if(e.target.id === 'webappLatencyModalOverlay') closeWebappLatencyModal();
});
document.addEventListener('keydown', function(e){
  if(e.key !== 'Escape') return;
  if(isDbLatencyModalOpen()) closeDbLatencyModal();
  else if(isWebappLatencyModalOpen()) closeWebappLatencyModal();
});

logoutBtn.addEventListener('click', async function(){
  await api.post('/logout').catch(function(){});
  showLoggedOut();
});

var loginError = document.getElementById('loginError');

async function attemptLogin(){
  var username = document.getElementById('loginUsernameInput').value;
  var password = document.getElementById('loginPasswordInput').value;
  loginError.classList.add('hidden');
  try{
    var session = await api.post('/login', { username: username, password: password });
    showLoggedIn(session.username);
  }catch(e){
    loginError.textContent = e.message;
    loginError.classList.remove('hidden');
  }
}

document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
document.getElementById('loginPasswordInput').addEventListener('keydown', function(e){
  if(e.key === 'Enter') attemptLogin();
});

async function init(){
  applyTheme(currentTheme());
  hydrateIcons(document);
  try{
    var session = await api.get('/session');
    showLoggedIn(session.username);
  }catch(e){
    showLoggedOut();
  }
}

init();
