"use strict";

import { TASK_SCORE_MIN, TASK_SCORE_MAX, TASK_PROGRESS_MIN, TASK_PROGRESS_MAX, MEMBER_PALETTE } from './config.js';

export function pad2(n){ return n < 10 ? '0' + n : '' + n; }

export function localDateValueFromDate(d){
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* "YYYY-MM-DD" (local, from a date input) -> UTC ISO string, or null */
export function localDateValueToUTCISO(value){
  if(!value) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!m) return null;
  var d = new Date(parseInt(m[1],10), parseInt(m[2],10) - 1, parseInt(m[3],10));
  if(isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* UTC ISO string -> "YYYY-MM-DD" (local, for a date input), or '' */
export function utcISOToLocalDateValue(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return localDateValueFromDate(d);
}

/* This app's internal representation of a "date-only" field (task/release/risk start/end dates etc.)
   is, perhaps surprisingly, a full UTC ISO datetime string — specifically, the UTC instant of LOCAL
   midnight on the intended calendar date (see localDateValueToUTCISO above). The server's equivalent
   fields are genuine DateOnly values, wire-formatted as a bare "YYYY-MM-DD" with no time or timezone
   component at all.

   Converting between the two must go through the LOCAL calendar date (utcISOToLocalDateValue —
   exactly what the <input type="date"> already shows), never by slicing the first 10 characters off
   the UTC ISO string directly. Slicing reads off the UTC calendar date instead, which only happens to
   match the local one for timezones behind UTC (roughly the Americas) — anywhere ahead of UTC
   (Australia included), local midnight has already rolled into the PREVIOUS UTC day, so the sliced
   date is one day earlier than what was actually entered. This was the cause of a real bug: task
   start/end dates silently shifting back a day for every server round-trip in AEST. */
export function isoToServerDateOnly(iso){
  if(!iso) return null;
  return utcISOToLocalDateValue(iso) || null;
}

/* Inverse of isoToServerDateOnly — a bare "YYYY-MM-DD" DateOnly string from the server back into this
   app's internal UTC-ISO-local-midnight representation. Same format as a date <input>'s value, so this
   is just localDateValueToUTCISO under a name that documents which direction/purpose it's used for. */
export function serverDateOnlyToIso(dateOnly){
  return localDateValueToUTCISO(dateOnly);
}

/* UTC ISO string -> a friendly local display string, or '' */
export function utcISOToLocalDisplayDate(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'});
}

/* UTC ISO string -> a friendly local date+time display string, or ''.
   Used for audit-trail timestamps, where the time of day (not just the
   day) is the point. */
export function utcISOToLocalDisplayDateTime(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'}) +
    ', ' + d.toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit'});
}

/* "YYYY-MM-DDTHH:mm" (local, from a datetime-local input) -> ISO string, or null.
   Unlike localDateValueToUTCISO above, no local-midnight workaround is needed here: a bare (no
   timezone suffix) "YYYY-MM-DD" string is spec'd to parse as UTC, which is what that workaround
   exists to correct for — but a bare "YYYY-MM-DDTHH:mm" string is spec'd to parse as LOCAL time, so
   new Date(value) already does the right thing and toISOString() round-trips it losslessly. */
export function localDateTimeValueToISO(value){
  if(!value) return null;
  var d = new Date(value);
  if(isNaN(d.getTime())) return null;
  return d.toISOString();
}

/* ISO string -> "YYYY-MM-DDTHH:mm" (local, for a datetime-local input), or '' */
export function isoToLocalDateTimeValue(iso){
  if(!iso) return '';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  return localDateValueFromDate(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

export function defaultStartDateValue(){
  return localDateValueFromDate(new Date());
}

export function defaultEndDateValue(){
  var d = new Date();
  d.setDate(d.getDate() + 14);
  return localDateValueFromDate(d);
}

/* Guards against hand-edited/corrupted import files passing through
   garbage as a date string. */
export function isValidISODateString(v){
  return typeof v === 'string' && v.length > 0 && !isNaN(new Date(v).getTime());
}

/* Business Value and Task Cost are integers clamped to [1, 1000].
   Anything missing, non-numeric, or out of range falls back to the
   floor of the range (1) rather than being rejected outright, so a
   hand-edited or legacy file always yields a usable score. */
export function clampTaskScore(value){
  var n = Math.round(Number(value));
  if(!isFinite(n)) return TASK_SCORE_MIN;
  if(n < TASK_SCORE_MIN) return TASK_SCORE_MIN;
  if(n > TASK_SCORE_MAX) return TASK_SCORE_MAX;
  return n;
}

/* Progress is an integer percentage clamped to [0, 100]. Anything
   missing or non-numeric falls back to 0 (not yet started). */
export function clampProgress(value){
  var n = Math.round(Number(value));
  if(!isFinite(n)) return TASK_PROGRESS_MIN;
  if(n < TASK_PROGRESS_MIN) return TASK_PROGRESS_MIN;
  if(n > TASK_PROGRESS_MAX) return TASK_PROGRESS_MAX;
  return n;
}

/* Allocated Fraction is an integer percentage clamped to [0, 100], unlike Progress it has a
   meaningful "unset" state (a member with no allocation figure at all) — an empty/missing/
   non-numeric value stays null rather than defaulting to 0, so "not yet assigned an allocation"
   stays distinguishable from "explicitly allocated 0%". */
export function clampAllocatedFraction(value){
  if(value === null || value === '' || value === undefined) return null;
  var n = Math.round(Number(value));
  if(!isFinite(n)) return null;
  if(n < 0) return 0;
  if(n > 100) return 100;
  return n;
}

/* Effort hours are decimal and non-negative, rounded to 2dp to avoid
   float drift. Anything missing, non-numeric, or negative falls back
   to 0 (not yet estimated/logged). */
export function clampEffortHours(value){
  var n = Number(value);
  if(!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

export function memberColorForIndex(i){
  return MEMBER_PALETTE[i % MEMBER_PALETTE.length];
}

/* Blends a "#rrggbb" color 14/15 of the way to white, e.g. #ff0000 ->
   #ffeeee, for use as a subtle background tint behind that color's
   accent border. Invalid input returns null so callers can skip
   applying a tint. */
export function lightenHexColor(hex){
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if(!m) return null;
  var num = parseInt(m[1], 16);
  var r = (num >> 16) & 255;
  var g = (num >> 8) & 255;
  var b = num & 255;
  function towardWhite(c){ return Math.round(c + (255 - c) * (14/15)); }
  function hex2(c){ var s = c.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + hex2(towardWhite(r)) + hex2(towardWhite(g)) + hex2(towardWhite(b));
}

/* Blends a "#rrggbb" color 12/15 of the way to black, the dark-theme counterpart to lightenHexColor's
   14/15-toward-white blend — e.g. #ff0000 -> #330000 — so a colored column's background tint stays a
   subtle dark shade instead of the near-white tint lightenHexColor would produce, which clashes with
   the rest of the dark theme's palette. Invalid input returns null so callers can skip applying a tint. */
export function darkenHexColor(hex){
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if(!m) return null;
  var num = parseInt(m[1], 16);
  var r = (num >> 16) & 255;
  var g = (num >> 8) & 255;
  var b = num & 255;
  function towardBlack(c){ return Math.round(c - c * (12/15)); }
  function hex2(c){ var s = c.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + hex2(towardBlack(r)) + hex2(towardBlack(g)) + hex2(towardBlack(b));
}

/* Blends a "#rrggbb" color toward white (positive amount) or black (negative amount) by the given
   fraction (0-1) — a subtler, parameterized sibling of lightenHexColor/darkenHexColor above (whose
   fixed 14/15 and 12/15 ratios are tuned for pale background TINTS, not for a "slightly offset
   shade of the same color" panel like #projectSelect sitting on a custom-colored header — that
   relationship is closer to --kf-navy-light's small step off --kf-navy than either of those). */
export function shadeHexColor(hex, amount){
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if(!m) return null;
  var num = parseInt(m[1], 16);
  var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  var target = amount >= 0 ? 255 : 0;
  var frac = Math.min(1, Math.abs(amount));
  function blend(c){ return Math.round(c + (target - c) * frac); }
  function hex2(c){ var s = c.toString(16); return s.length < 2 ? '0' + s : s; }
  return '#' + hex2(blend(r)) + hex2(blend(g)) + hex2(blend(b));
}

/* WCAG relative-luminance formula (sRGB, no gamma-correction shortcuts) — feeds contrastTextColor
   below. Originally local to portfolio-bars.js (for the Planner's on-bar project-key label);
   promoted here once a second consumer (My Preferences' header colour picker) needed the exact
   same black-vs-white contrast decision, rather than duplicating the formula a second time. */
export function relativeLuminance(hex){
  var rgb = [1, 3, 5].map(function(i){
    var c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/* Picks whichever of pure black/white has the higher WCAG contrast ratio against bgHex — correct
   for any background color without hand-tuning per case. */
export function contrastTextColor(bgHex){
  var l = relativeLuminance(bgHex);
  var contrastWithWhite = 1.05 / (l + 0.05);
  var contrastWithBlack = (l + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#000000';
}

export function memberInitials(name){
  var parts = String(name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length === 0) return '?';
  if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}
