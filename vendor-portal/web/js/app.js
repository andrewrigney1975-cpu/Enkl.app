"use strict";

import { api, ApiError } from './api.js';
import { hydrateIcons } from './icons.js';
import { applyTheme, currentTheme, toggleTheme } from './theme.js';
import { renderDashboard } from './views/dashboard.js';
import { renderOrganisations } from './views/organisations.js';
import { renderLicenses } from './views/licenses.js';
import { renderContracts } from './views/contracts.js';

var loginWrap = document.getElementById('loginWrap');
var viewRoot = document.getElementById('viewRoot');
var sideNav = document.getElementById('sideNav');
var logoutBtn = document.getElementById('logoutBtn');
var sessionUserLabel = document.getElementById('sessionUserLabel');

var VIEWS = {
  dashboard: { render: renderDashboard, navBtn: 'navDashboardBtn' },
  organisations: { render: renderOrganisations, navBtn: 'navOrganisationsBtn' },
  licenses: { render: renderLicenses, navBtn: 'navLicensesBtn' },
  contracts: { render: renderContracts, navBtn: 'navContractsBtn' }
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
