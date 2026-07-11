"use strict";

import { ICON_PATHS } from './config.js';

export function iconSvg(name, size){
  size = size || 16;
  var inner = ICON_PATHS[name] || '';
  return '<svg viewBox="0 0 24 24" width="'+size+'" height="'+size+'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+inner+'</svg>';
}

export function hydrateIcons(root){
  var nodes = (root || document).querySelectorAll('[data-icon]');
  nodes.forEach(function(node){
    var name = node.getAttribute('data-icon');
    var size = node.getAttribute('data-size') || 16;
    node.innerHTML = iconSvg(name, size);
  });
}
