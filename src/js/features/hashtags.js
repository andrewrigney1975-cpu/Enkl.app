"use strict";

/* Hashtags — a lightweight, front-end-only tagging convenience layered onto the rich-text editor
   (rich-text/editor.js) and its read-only renderer (rich-text/markdown.js). A hashtag is just
   "#name" text inside a description's stored Markdown — there is no separate entity, table, or API
   surface for it (nothing to migrate, no server schema change, per the ask). "The project's tags"
   are derived by scanning every description field already stored on the project, matching this
   app's general "reuse over reinvention" bias (CLAUDE.md §1) instead of introducing a new synced
   list that would need to be kept in sync with the text itself.

   Character set is deliberately narrow (letters/digits/underscore/hyphen) — wide enough for normal
   tag names, narrow enough that a matched tag name can never contain markup-unsafe characters, so
   chip HTML can be built directly from a validated match with no further escaping needed. */

export var HASHTAG_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Boundary-aware: a hashtag must start a line or follow whitespace, so "issue#42" in ordinary prose
// is never mistaken for a tag — only ever (start-of-text|whitespace)#name. Shared by both the
// project-wide scan below and markdown.js's read-only rendering pass, so the two can never disagree
// about what counts as a hashtag.
export var HASHTAG_SCAN_RE = /(^|\s)#([A-Za-z0-9_-]+)/g;

/** The exact chip markup used both for live insertion (rich-text/editor.js) and read-only rendering
    (rich-text/markdown.js's inlineToHtml) — one implementation so the two paths can never visually
    drift apart. contenteditable="false" is what makes the chip an atomic, single-backspace-deletes-
    the-whole-tag unit wherever it's inserted into a live contenteditable surface; it's simply
    ignored (harmless) anywhere else this HTML is rendered read-only. */
export function hashtagChipHtml(tagName){
  return '<span class="kf-hashtag-chip" contenteditable="false" data-hashtag="' + tagName + '">#' + tagName + '</span>';
}

function collectHashtagsFromText(text, acc){
  if(!text) return;
  var re = new RegExp(HASHTAG_SCAN_RE.source, 'g');
  var match;
  while((match = re.exec(text))){
    var tag = match[2];
    var key = tag.toLowerCase();
    if(!acc.seen[key]){
      acc.seen[key] = true;
      acc.list.push(tag);
    }
  }
}

/* Every description-bearing field across the project's entities — the same set query-engine.js's
   TABLE_SCHEMAS and features/project-search.js's buildProjectSearchGroups already know about; check
   those before adding a new entity type here so this list can't quietly drift out of sync with them.
   Unlike project-search's own scan, this one is NOT gated by App Settings module-visibility toggles
   — a hashtag typed while a module happened to be enabled should still surface as a suggestion later
   even if that module gets hidden afterward, since the tag is just plain text sitting in already-
   stored content either way. */
export function getProjectHashtags(project){
  var acc = {seen: {}, list: []};
  if(!project) return [];
  collectHashtagsFromText(project.description, acc);
  Object.keys(project.tasks || {}).forEach(function(id){ collectHashtagsFromText(project.tasks[id].description, acc); });
  (project.documents || []).forEach(function(d){ collectHashtagsFromText(d.description, acc); });
  (project.risks || []).forEach(function(r){ collectHashtagsFromText(r.description, acc); });
  (project.decisions || []).forEach(function(d){ collectHashtagsFromText(d.description, acc); });
  (project.principles || []).forEach(function(p){ collectHashtagsFromText(p.description, acc); });
  (project.objectives || []).forEach(function(o){ collectHashtagsFromText(o.description, acc); });
  (project.teamsCommittees || []).forEach(function(tc){ collectHashtagsFromText(tc.description, acc); });
  return acc.list.sort(function(a, b){ return a.toLowerCase().localeCompare(b.toLowerCase()); });
}

/** Prefix match, case-insensitive — same "indexOf === 0" convention as sql-intellisense.js's own
    matchesPrefix, not a fuzzy match. */
export function filterHashtags(tags, prefix){
  var needle = (prefix || '').toLowerCase();
  return tags.filter(function(t){ return t.toLowerCase().indexOf(needle) === 0; });
}
