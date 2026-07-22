"use strict";

export function formatMoney(cents, currency){
  if(cents === null || cents === undefined) return '—';
  var amount = Number(cents) / 100;
  try{
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
  }catch(e){
    return (currency || 'USD') + ' ' + amount.toFixed(2);
  }
}

export function toCents(amount){
  return Math.round(Number(amount) * 100);
}

export function fromCents(cents){
  return cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2);
}

export function formatDate(value){
  if(!value) return '—';
  var d = new Date(value);
  if(isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value){
  if(!value) return '—';
  var d = new Date(value);
  if(isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch];
  });
}
