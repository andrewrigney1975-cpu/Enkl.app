"use strict";
import { toast } from '../ui.js';

export function downloadBlob(blob, filename){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export var SVG_EXPORT_BAKED_PROPS = ['fill', 'stroke', 'color', 'opacity', 'stroke-width', 'stroke-opacity', 'fill-opacity', 'font-family', 'paint-order'];

export function cloneSvgWithBakedStyles(svgEl){
  var clone = svgEl.cloneNode(true);
  var liveAll = [svgEl].concat(Array.prototype.slice.call(svgEl.querySelectorAll('*')));
  var cloneAll = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
  for(var i = 0; i < liveAll.length; i++){
    var liveStyle = window.getComputedStyle(liveAll[i]);
    var cssText = '';
    for(var j = 0; j < SVG_EXPORT_BAKED_PROPS.length; j++){
      var prop = SVG_EXPORT_BAKED_PROPS[j];
      var val = liveStyle.getPropertyValue(prop);
      if(val) cssText += prop + ':' + val + ';';
    }
    if(cssText) cloneAll[i].setAttribute('style', cssText);
  }
  return clone;
}

export function resolveCssVarsInString(str){
  var rootStyle = window.getComputedStyle(document.documentElement);
  for(var pass = 0; pass < 5; pass++){
    var changed = false;
    str = str.replace(/var\((--[a-zA-Z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, function(match, varName, fallback){
      var resolved = rootStyle.getPropertyValue(varName).trim();
      if(resolved){ changed = true; return resolved; }
      if(fallback){ changed = true; return fallback.trim(); }
      return match;
    });
    if(!changed) break;
  }
  return str;
}

export function serializeResolvedSvg(svgEl){
  var clone = cloneSvgWithBakedStyles(svgEl);
  var w = parseFloat(svgEl.getAttribute('width')) || (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width) || svgEl.clientWidth || 800;
  var h = parseFloat(svgEl.getAttribute('height')) || (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.height) || svgEl.clientHeight || 600;
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  var markup = new XMLSerializer().serializeToString(clone);
  markup = resolveCssVarsInString(markup);
  if(markup.indexOf('<?xml') !== 0) markup = '<?xml version="1.0" encoding="UTF-8"?>\n' + markup;
  return {markup: markup, width: w, height: h};
}

export function exportSvgElementAsSvgFile(svgEl, filenameBase){
  var result = serializeResolvedSvg(svgEl);
  var blob = new Blob([result.markup], {type: 'image/svg+xml'});
  downloadBlob(blob, filenameBase + '.svg');
  toast('Exported ' + filenameBase + '.svg');
}

export function exportSvgElementAsPng(svgEl, filenameBase, scale){
  var result = serializeResolvedSvg(svgEl);
  var svgBlob = new Blob([result.markup], {type: 'image/svg+xml'});
  var url = URL.createObjectURL(svgBlob);
  var img = new Image();
  img.onload = function(){
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(result.width * scale));
    canvas.height = Math.max(1, Math.round(result.height * scale));
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob(function(blob){
      if(!blob){ toast('PNG export failed.'); return; }
      downloadBlob(blob, filenameBase + '.png');
      toast('Exported ' + filenameBase + '.png');
    }, 'image/png');
  };
  img.onerror = function(){
    URL.revokeObjectURL(url);
    toast('PNG export failed.');
  };
  img.src = url;
}

export function toggleExportAsPanel(panelId){
  var panel = document.getElementById(panelId);
  var wasHidden = panel.classList.contains('hidden');
  closeAllExportAsPanels();
  if(wasHidden) panel.classList.remove('hidden');
}

export function closeAllExportAsPanels(){
  document.querySelectorAll('.kf-export-as-panel').forEach(function(panel){
    panel.classList.add('hidden');
  });
}
