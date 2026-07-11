"use strict";

/* Icon subset copied from the main app's src/js/config.js (ICON_PATHS) — same SVG path data, kept
   in sync visually, trimmed to only what the portal's nav/chrome/modals actually use. */
export var ICON_PATHS = {
  menu:        '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
  close:       '<path d="M18 6 6 18M6 6l12 12"/>',
  plus:        '<path d="M12 5v14M5 12h14"/>',
  edit:        '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:       '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  logout:      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  sun:         '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>',
  moon:        '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"/>',
  grid:        '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  orgChart:    '<rect x="9" y="3" width="6" height="6" rx="1"/><rect x="2" y="15" width="6" height="6" rx="1"/><rect x="16" y="15" width="6" height="6" rx="1"/><path d="M12 9v3M5 12h14M5 12v3M19 12v3"/>',
  tag:         '<path d="M12.59 2.41 21 10.83a2 2 0 0 1 0 2.83l-7.34 7.34a2 2 0 0 1-2.83 0L2.41 12.59a2 2 0 0 1-.41-2.18L4.5 4.5a2 2 0 0 1 1.79-1.21L10.41 3a2 2 0 0 1 2.18.41Z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  ty_document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h3"/>',
  team:        '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M22.5 21v-2a4 4 0 0 0-3-3.87"/><path d="M16.5 3.13a4 4 0 0 1 0 7.75"/>'
};

export var THEME_STORAGE_KEY = 'enkl_portal_theme';
