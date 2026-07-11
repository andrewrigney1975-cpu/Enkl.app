"use strict";

import { THEME_STORAGE_KEY } from './config.js';
import { iconSvg } from './icons.js';

export function currentTheme(){
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme){
  if(theme === 'dark'){
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try{ localStorage.setItem(THEME_STORAGE_KEY, theme); }catch(e){ /* ignore */ }
  renderThemeToggleIcon();
}

export function renderThemeToggleIcon(){
  var btn = document.getElementById('themeToggleBtn');
  if(!btn) return;
  var dark = currentTheme() === 'dark';
  btn.innerHTML = iconSvg(dark ? 'sun' : 'moon', 16);
  btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.setAttribute('aria-label', btn.title);
}

export function toggleTheme(){
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
