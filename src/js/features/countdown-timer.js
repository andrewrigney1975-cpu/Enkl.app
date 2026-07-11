"use strict";

/* Client-side-only countdown timer for the Retrospective form's timeboxing aid (see the "How this
   works" panel in modals/retrospectives.js — "use the timer for each section so there's room to
   talk without spiraling into unsolvable tangents"). Nothing about a running/paused timer is ever
   synced to the server; the only trace that survives a save is the *last-used duration*, which the
   caller reads back out via getLastDurationSeconds() to store as the retrospective's own
   lastTimerDurationSeconds field — a convenience default for next time, not a live session.

   Shaped like the other small stateful UI bits in features/ (e.g. bulk-edit.js's setXDeps + open/
   render trio): a single mount() call wires a fixed set of DOM ids once, and hands back a small
   handle object the caller drives/queries afterward. Module-level (not per-instance) state is fine
   here since there is only ever one Retrospective form open at a time. */

var PRESET_MINUTES = [5, 10, 15];
var MAX_MINUTES = 180;

var _intervalId = null;
var _remainingSeconds = 0;
var _lastDurationSeconds = 5 * 60;
var _els = null;

function pad2(n){ return n < 10 ? '0' + n : '' + n; }

function formatMMSS(totalSeconds){
  var s = Math.max(0, Math.round(totalSeconds));
  var m = Math.floor(s / 60);
  var sec = s % 60;
  return pad2(m) + ':' + pad2(sec);
}

function render(){
  if(!_els) return;
  _els.display.textContent = formatMMSS(_remainingSeconds);
  _els.display.classList.toggle('kf-retro-timer-done', _remainingSeconds <= 0 && !_intervalId);
}

function stop(){
  if(_intervalId){ clearInterval(_intervalId); _intervalId = null; }
  if(_els) _els.startBtn.textContent = 'Start';
  render();
}

function tick(){
  _remainingSeconds -= 1;
  if(_remainingSeconds <= 0){
    _remainingSeconds = 0;
    render();
    stop();
    return;
  }
  render();
}

function start(){
  if(_intervalId) return;
  if(_remainingSeconds <= 0) _remainingSeconds = _lastDurationSeconds;
  _intervalId = setInterval(tick, 1000);
  if(_els) _els.startBtn.textContent = 'Pause';
  render();
}

function toggleStartStop(){
  if(_intervalId) stop(); else start();
}

function reset(){
  stop();
  _remainingSeconds = _lastDurationSeconds;
  render();
}

/* Sets the running duration AND the "last used" default in one go — used both by the preset/custom
   buttons (user explicitly picking a new duration) and by setDefaultDurationSeconds below (loading a
   retrospective's previously-saved default when the form opens). */
function setDuration(seconds){
  var n = Number(seconds);
  if(!isFinite(n) || n <= 0) return;
  _lastDurationSeconds = Math.max(1, Math.min(MAX_MINUTES * 60, Math.round(n)));
  stop();
  _remainingSeconds = _lastDurationSeconds;
  render();
}

/* ids: {display, startBtn, resetBtn, presetWrap, customInput, setCustomBtn} — every id must already
   exist in the DOM (see the #retrospectivesFormView timer section in index.html). Safe to call more
   than once (e.g. if the module were ever reloaded); each call re-wires from scratch. */
export function mountCountdownTimer(ids){
  _els = {
    display: document.getElementById(ids.display),
    startBtn: document.getElementById(ids.startBtn),
    resetBtn: document.getElementById(ids.resetBtn),
    presetWrap: document.getElementById(ids.presetWrap),
    customInput: document.getElementById(ids.customInput),
    setCustomBtn: document.getElementById(ids.setCustomBtn)
  };

  _els.presetWrap.innerHTML = '';
  PRESET_MINUTES.forEach(function(minutes){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kf-btn kf-btn-secondary kf-retro-timer-preset';
    btn.textContent = minutes + ' min';
    btn.addEventListener('click', function(){ setDuration(minutes * 60); });
    _els.presetWrap.appendChild(btn);
  });

  _els.startBtn.addEventListener('click', toggleStartStop);
  _els.resetBtn.addEventListener('click', reset);
  _els.setCustomBtn.addEventListener('click', function(){
    var minutes = parseFloat(_els.customInput.value);
    if(isFinite(minutes) && minutes > 0) setDuration(minutes * 60);
  });

  render();

  return {
    start: start,
    stop: stop,
    reset: reset,
    setDuration: setDuration,
    /* Called each time the Retrospective form opens, to seed the display from that retrospective's
       own lastTimerDurationSeconds (falling back to the first preset for one that's never used the
       timer yet). Always stops any timer left running from whatever was previously open first. */
    setDefaultDurationSeconds: function(seconds){
      var n = Number(seconds);
      setDuration(isFinite(n) && n > 0 ? n : PRESET_MINUTES[0] * 60);
    },
    getLastDurationSeconds: function(){ return _lastDurationSeconds; },
    isRunning: function(){ return !!_intervalId; }
  };
}
