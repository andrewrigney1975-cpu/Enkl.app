"use strict";

/* Hand-rolled Web Audio API chat sounds — no audio files, no third-party library, matching this
   app's "no runtime dependency" philosophy. A single shared AudioContext is created lazily on first
   use (browsers refuse to start one before a user gesture) and reused/resumed after that; both call
   sites here (chat.js's sendMessage/handleChatMessageEvent) are reachable only from an already-open
   chat panel, which itself only opens via a click, so the context is always unlocked by the time
   either sound plays. */

var _ctx = null;

function getAudioContext(){
  if(_ctx) return _ctx;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if(!Ctor) return null;
  _ctx = new Ctor();
  return _ctx;
}

function resumeIfSuspended(ctx){
  if(ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(function(){});
}

/* Must be called synchronously from within a real user-gesture event handler (a click, not a
   promise/fetch callback several ticks removed from one) — that's what actually satisfies browser
   autoplay policy, not merely having had a click happen somewhere earlier in the task. Call this
   from every entry point that leads to a sound (opening the chat panel, submitting the compose
   box) so the AudioContext is already running by the time playSendSound/playReceiveSound need it. */
export function unlockAudio(){
  var ctx = getAudioContext();
  if(ctx) resumeIfSuspended(ctx);
}

function tone(ctx, opts){
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.type = opts.type || 'sine';
  osc.connect(gain);
  gain.connect(ctx.destination);

  var now = opts.startTime;
  osc.frequency.setValueAtTime(opts.freq, now);
  if(opts.freqEnd !== undefined){
    osc.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd, 1), now + opts.duration);
  }

  var peak = opts.gain !== undefined ? opts.gain : 0.2;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + (opts.attack || 0.01));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + opts.duration);

  osc.start(now);
  osc.stop(now + opts.duration + 0.02);
}

/* Outgoing-message confirmation: a quick downward sweep ("whoosh") immediately followed by a short
   upward blip ("bloop"). */
export function playSendSound(){
  var ctx = getAudioContext();
  if(!ctx) return;
  resumeIfSuspended(ctx);
  var now = ctx.currentTime;

  tone(ctx, {type: 'sine', freq: 700, freqEnd: 220, duration: 0.14, gain: 0.15, attack: 0.005, startTime: now});
  tone(ctx, {type: 'triangle', freq: 320, freqEnd: 520, duration: 0.09, gain: 0.12, attack: 0.005, startTime: now + 0.12});
}

/* Incoming-message alert: a bell-like "bing" — a fundamental tone plus a quieter higher harmonic
   for shimmer. */
export function playReceiveSound(){
  var ctx = getAudioContext();
  if(!ctx) return;
  resumeIfSuspended(ctx);
  var now = ctx.currentTime;

  tone(ctx, {type: 'sine', freq: 880, duration: 0.35, gain: 0.18, attack: 0.005, startTime: now});
  tone(ctx, {type: 'sine', freq: 1760, duration: 0.25, gain: 0.08, attack: 0.005, startTime: now});
}
