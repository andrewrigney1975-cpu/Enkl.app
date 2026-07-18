"use strict";

/* =========================================================
   APP VERSION
   Format: major.minor.yyyymmdd.hhmm — e.g. "1.00.20260623.0705".
   Starts at 1.00. Every subsequent build increments the minor
   version by 1 and recalculates the date/time to that build's
   timestamp. This value is informational only: it's included in a
   project's export file but is never read back in on import.
   ========================================================= */
export var APP_VERSION = '2.240.20260718.1130';

/* =========================================================
   ICONS — inline SVG, line-icon style, stroke=currentColor
   ========================================================= */
export var ICON_PATHS = {
  plus:        '<path d="M12 5v14M5 12h14"/>',
  edit:        '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:       '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  link:        '<path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 6"/><path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.4a5 5 0 0 0 7.07 7.07L14 18"/>',
  externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  close:       '<path d="M18 6 6 18M6 6l12 12"/>',
  download:    '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload:      '<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 21h14"/>',
  refresh:     '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  cloud:       '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  logout:      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  grip:        '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  warning:     '<path d="M10.29 3.86l-8.18 14.18A1.5 1.5 0 0 0 3.4 20h17.2a1.5 1.5 0 0 0 1.29-2.26L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  clock:       '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  stopwatch:   '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9 2h6"/><path d="M12 3.5v1.5"/><path d="M17.5 5.5l1 1"/>',
  search:      '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  board:       '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="10" rx="1"/><rect x="16" y="4" width="5" height="13" rx="1"/>',
  /* Deliberately its own path rather than reusing `board` — equal-height columns crossed by one
     horizontal line near the top, so it reads as swimlanes (a header lane + body) rather than a
     plain kanban board. */
  retrospective: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/><path d="M3 8h18"/>',
  /* Three horizontal swimlanes — the Portfolio Planner groups a whole org's project suite into
     rows/lanes (categories), so this is `retrospective`'s three-column layout transposed 90°. */
  portfolioPlanner: '<rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="9.5" width="18" height="5" rx="1"/><rect x="3" y="15" width="18" height="5" rx="1"/>',
  p_critical:  '<path d="M6 16l6-6 6 6"/><path d="M6 10l6-6 6 6"/>',
  p_high:      '<path d="M6 15l6-6 6 6"/>',
  p_medium:    '<path d="M5 9h14"/><path d="M5 15h14"/>',
  p_low:       '<path d="M6 9l6 6 6-6"/>',
  p_trivial:   '<circle cx="12" cy="12" r="3.2"/>',
  inbox:       '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
  list:        '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="3.5" cy="6" r="1.3"/><circle cx="3.5" cy="12" r="1.3"/><circle cx="3.5" cy="18" r="1.3"/>',
  grid:        '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
  timeline:    '<circle cx="4" cy="6" r="1.6"/><path d="M8 6h12"/><circle cx="9" cy="12" r="1.6"/><path d="M13 12h7"/><circle cx="6" cy="18" r="1.6"/><path d="M10 18h10"/>',
  rocket:      '<path d="M12 2c2.5 2 4 5.5 4 9 0 2-.5 4-1.5 5.5L12 19l-2.5-2.5C8.5 15 8 13 8 11c0-3.5 1.5-7 4-9Z"/><path d="M9.5 14.5 6 16l1.5-3.5"/><path d="M14.5 14.5 18 16l-1.5-3.5"/><circle cx="12" cy="9" r="1.5"/><path d="M10 19l-1 3"/><path d="M14 19l1 3"/>',
  tag:         '<path d="M12.59 2.41 21 10.83a2 2 0 0 1 0 2.83l-7.34 7.34a2 2 0 0 1-2.83 0L2.41 12.59a2 2 0 0 1-.41-2.18L4.5 4.5a2 2 0 0 1 1.79-1.21L10.41 3a2 2 0 0 1 2.18.41Z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  sparkle:     '<path d="M12 2.5 13.8 8.7 20 10.5 13.8 12.3 12 18.5 10.2 12.3 4 10.5 10.2 8.7Z"/><path d="M19 15.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9Z"/>',
  bug:         '<path d="M9 9h6"/><path d="M8 13a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0Z"/><path d="M5 12H3"/><path d="M21 12h-2"/><path d="M5 19l2.5-2"/><path d="M19 19l-2.5-2"/><path d="M5 6l2.5 2.5"/><path d="M19 6l-2.5 2.5"/><path d="M12 6V4"/>',
  archive:     '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  database:    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  quadrant:    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/><circle cx="7.5" cy="7.5" r="1.4"/><circle cx="16" cy="8.5" r="1.4"/><circle cx="8.5" cy="16" r="1.4"/><circle cx="16.5" cy="16.5" r="1.4"/>',
  menu:        '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
  graph:       '<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.1 7.2 10.3 16"/><path d="M16.9 7.2 13.7 16"/><path d="M7.3 6h9.4"/>',
  zoomIn:      '<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6"/><path d="M21 21l-4.35-4.35"/>',
  zoomOut:     '<circle cx="11" cy="11" r="7"/><path d="M8 11h6"/><path d="M21 21l-4.35-4.35"/>',
  fit:         '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  team:        '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M22.5 21v-2a4 4 0 0 0-3-3.87"/><path d="M16.5 3.13a4 4 0 0 1 0 7.75"/>',
  orgChart:    '<rect x="9" y="3" width="6" height="6" rx="1"/><rect x="2" y="15" width="6" height="6" rx="1"/><rect x="16" y="15" width="6" height="6" rx="1"/><path d="M12 9v3M5 12h14M5 12v3M19 12v3"/>',
  radar:       '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 12 19 6"/>',
  lock:        '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.5"/>',
  key:         '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2 11.4 11.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/>',
  workflow:    '<rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4"/><path d="M12 12l4-7"/><path d="M12 12l4 7"/>',
  sun:         '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>',
  moon:        '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/>',
  help:        '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  printer:     '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',

  /* Task Type icon library — 24 icons covering common project
     activities, selectable per Task Type in the Task Types modal. */
  ty_investigate: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9"/><path d="M5 8h6"/><path d="M5 12h4"/><circle cx="16" cy="16" r="4"/><path d="M19.5 19.5 22 22"/>',
  ty_document:    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h3"/>',
  ty_analyse:     '<path d="M3 3v18h18"/><rect x="6" y="13" width="3" height="5"/><rect x="11" y="9" width="3" height="9"/><rect x="16" y="6" width="3" height="12"/>',
  ty_procure:     '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6"/>',
  ty_audit:       '<path d="M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1Z"/><path d="M9 4h6v2H9z"/><path d="M9 12l2 2 4-4"/>',
  ty_report:      '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8"/><path d="M12 16v4"/><path d="M7 13l3-3 2.5 2.5L17 8"/>',
  ty_communicate: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
  ty_design:      '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75Z"/><path d="M14.06 6.19l2.5-2.5a1.5 1.5 0 0 1 2.12 0l1.63 1.63a1.5 1.5 0 0 1 0 2.12l-2.5 2.5"/>',
  ty_develop:     '<path d="M8 17l-5-5 5-5"/><path d="M16 7l5 5-5 5"/>',
  ty_test:        '<path d="M9 2h6"/><path d="M10 2v6.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 8.5V2"/><path d="M8.5 14h7"/>',
  ty_review:      '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>',
  ty_plan:        '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M7 14l2 2 4-5"/>',
  compass:        '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  target:         '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  ty_research:    '<path d="M2 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15a1.5 1.5 0 0 0-1.5-1.5H2Z"/><path d="M22 5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v15a1.5 1.5 0 0 1 1.5-1.5H22Z"/>',
  ty_train:       '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12.5V17c0 1.5 2.5 3 6 3s6-1.5 6-3v-4.5"/>',
  ty_support:     '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2" y="13" width="4" height="6" rx="1.5"/><rect x="18" y="13" width="4" height="6" rx="1.5"/><path d="M20 19v1a3 3 0 0 1-3 3h-3"/>',
  ty_deploy:      '<path d="M7 18a4.5 4.5 0 0 1-1-8.9 5 5 0 0 1 9.6-1.9A4 4 0 0 1 18 15.5"/><path d="M12 12v8"/><path d="M9 15l3-3 3 3"/>',
  ty_migrate:     '<path d="M16 3l4 4-4 4"/><path d="M20 7H6a3 3 0 0 0-3 3"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h14a3 3 0 0 0 3-3"/>',
  ty_configure:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  ty_monitor:     '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  heartPulse:     '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  ty_approve:     '<path d="M12 2l2.4 1.4 2.7-.4 1.3 2.4 2.4 1.3-.4 2.7L22 12l-1.6 2.4.4 2.7-2.4 1.3-1.3 2.4-2.7-.4L12 22l-2.4-1.6-2.7.4-1.3-2.4-2.4-1.3.4-2.7L2 12l1.6-2.4-.4-2.7 2.4-1.3 1.3-2.4 2.7.4Z"/><path d="M9 12l2 2 4-4"/>',
  ty_negotiate:   '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 0 0 6 0Z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0Z"/>',
  ty_schedule:    '<rect x="3" y="5" width="14" height="16" rx="2"/><path d="M7 3v4"/><path d="M13 3v4"/><path d="M3 10h10"/><circle cx="18" cy="17" r="4"/><path d="M18 15.5V17l1 1"/>',
  ty_maintain:    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94Z"/>',
  ty_coordinate:  '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5 16 7.5"/><path d="M7 8l4 8"/><path d="M17 8l-4 8"/>'
};

/* =========================================================
   PRIORITY CONFIG
   ========================================================= */
export var PRIORITY_META = {
  trivial:  {label:'Trivial',  icon:'p_trivial'},
  low:      {label:'Low',      icon:'p_low'},
  medium:   {label:'Medium',   icon:'p_medium'},
  high:     {label:'High',     icon:'p_high'},
  critical: {label:'Critical', icon:'p_critical'}
};
export var PRIORITY_ORDER = ['trivial','low','medium','high','critical'];

/* Light/dark variants of each priority's color, badge background, and
   accent (used for dots, left-edge bars, and filter chips). The light
   badge backgrounds are near-white tints meant for a white card, so a
   dark-mode card needs its own darker, more saturated tints rather than
   just reusing the same hex values. */
export var PRIORITY_COLORS = {
  light: {
    trivial:  {color:'#6b778c', bg:'#f1f2f4', accent:'#6b778c'},
    low:      {color:'#0055cc', bg:'#e9f2ff', accent:'#2684ff'},
    medium:   {color:'#a54800', bg:'#fff7e6', accent:'#ffab00'},
    high:     {color:'#c9372c', bg:'#fff0ed', accent:'#ff7452'},
    critical: {color:'#ffffff', bg:'#c9372c', accent:'#de350b'}
  },
  dark: {
    trivial:  {color:'#aebbc9', bg:'#2c333a', accent:'#aebbc9'},
    low:      {color:'#85b8ff', bg:'#1c2b41', accent:'#6cabff'},
    medium:   {color:'#f5cd47', bg:'#3a2e12', accent:'#e2a03f'},
    high:     {color:'#fd9891', bg:'#42221f', accent:'#f87168'},
    critical: {color:'#1d2125', bg:'#f87168', accent:'#f87168'}
  }
};

/* =========================================================
   THEME
   ========================================================= */
export var THEME_STORAGE_KEY = 'kanbanflow_theme';

/* =========================================================
   STORAGE
   ========================================================= */
export var STORAGE_KEY = 'kanbanflow_v1_db';

/* =========================================================
   MOBILE / TABLET
   ========================================================= */
export var MOBILE_BREAKPOINT = 1024;

/* =========================================================
   SCORING
   ========================================================= */
export var TASK_SCORE_MIN = 1;
export var TASK_SCORE_MAX = 1000;
export var TASK_PROGRESS_MIN = 0;
export var TASK_PROGRESS_MAX = 100;

/* =========================================================
   MEMBER PALETTE
   ========================================================= */
export var MEMBER_PALETTE = ['#0052CC','#00875A','#FF8B00','#974DE2','#DE350B','#006644','#5243AA','#B04632','#1B5E20','#8777D9'];

/* =========================================================
   RISKS
   ========================================================= */
export var RISK_STATUS_META = {
  new: {label: 'New'},
  in_review: {label: 'In Review'},
  closed: {label: 'Closed'}
};
export var RISK_LIKELIHOOD_META = {
  1: {label: 'Rare', description: 'Unlikely to happen and/or have minor or negligible consequences'},
  2: {label: 'Unlikely', description: 'Possible to happen and/or to have moderate consequences'},
  3: {label: 'Moderate', description: 'Likely to happen and/or to have serious consequences'},
  4: {label: 'Likely', description: 'Almost sure to happen and/or to have major consequences'},
  5: {label: 'Almost certain', description: 'Sure to happen and/or have major consequences'}
};
export var RISK_IMPACT_META = {
  1: {label: 'Insignificant', description: 'Won\'t cause serious harm or delays'},
  2: {label: 'Minor', description: 'Can cause harm or delays, only to a mild extent'},
  3: {label: 'Significant', description: 'Can cause harm or delays that will require additional treatments'},
  4: {label: 'Major', description: 'Can cause major harm or delays that will require significant treatment or changes to the project'},
  5: {label: 'Severe', description: 'Can result in critical harm or project failure'}
};

/* =========================================================
   DECISIONS
   ========================================================= */
export var DECISION_TYPE_META = {
  strategy: {label: 'Strategy'},
  policy: {label: 'Policy'},
  budgetary: {label: 'Budgetary'},
  financial: {label: 'Financial'},
  functional: {label: 'Functional'},
  technical: {label: 'Technical'},
  process: {label: 'Process'},
  operational: {label: 'Operational'}
};
export var DECISION_STATUS_META = {
  open: {label: 'Open'},
  in_review: {label: 'In Review'},
  completed: {label: 'Completed'}
};

/* =========================================================
   TEAMS & COMMITTEES
   ========================================================= */
export var TEAM_COMMITTEE_TYPES = {team: 'Team', committee: 'Committee'};
