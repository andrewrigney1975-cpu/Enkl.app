"use strict";
import { TABLE_SCHEMAS, TABLE_RELATIONSHIPS } from './query-engine.js';

/* =========================================================
   SQL INTELLISENSE
   Inline autocomplete engine for the Advanced Query tab's SQL textarea (modals/project-search.js).
   Pure logic here (no DOM except the caret-measurement utility at the bottom) — the modal file owns
   all the dropdown DOM/keyboard wiring, same "engine module + thin UI wiring" split as
   features/query-engine.js and features/schema-erd.js.

   Built entirely from query-engine.js's own TABLE_SCHEMAS (the same single source of truth the ERD
   panel reads from), so suggestions can never drift out of sync with what's actually queryable.
   ========================================================= */

// Single-token keywords only (not "GROUP BY"/"ORDER BY" as one phrase) so word-by-word typing matches
// naturally — a real SQL tokenizer would suggest the same way. Matches whatever AlaSQL's SELECT-only
// grammar accepts, per query-engine.js's own FORBIDDEN_PATTERN (write/DDL keywords are the only ones
// actually blocked there).
export var SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER',
  'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS', 'NULL', 'BETWEEN', 'DISTINCT', 'TOP', 'LIMIT', 'ASC',
  'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'UNION', 'ALL'
];

function isWordChar(ch){
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/* Counts unescaped single-quotes before `index` — an odd count means the caret sits inside an open
   string literal, where no suggestion should fire. Deliberately simple (no full SQL tokenizer): this
   textarea only ever holds a single SELECT statement, not a program with comments/multiple statements
   to worry about. */
function isInsideStringLiteral(sql, index){
  var count = 0;
  for(var i = 0; i < index; i++){
    if(sql[i] === '\'' && sql[i - 1] !== '\\') count++;
  }
  return count % 2 === 1;
}

/* Scans backward AND forward from caretIndex over identifier characters to get the FULL word being
   edited, not just the prefix up to the caret — so accepting a suggestion while the caret sits
   mid-word (`tas|ks`) replaces the whole token instead of leaving a leftover `ks` trailing the
   inserted text. */
function getWordSpan(sql, caretIndex){
  var start = caretIndex;
  while(start > 0 && isWordChar(sql[start - 1])) start--;
  var end = caretIndex;
  while(end < sql.length && isWordChar(sql[end])) end++;
  return {start: start, end: end, word: sql.slice(start, caretIndex)};
}

function previousToken(sql, wordStart){
  var i = wordStart;
  while(i > 0 && /\s/.test(sql[i - 1])) i--;
  var end = i;
  while(i > 0 && isWordChar(sql[i - 1])) i--;
  return sql.slice(i, end).toUpperCase();
}

/* Which known tables are actually referenced anywhere in the query (not just up to the caret — a
   field typed before its FROM clause, e.g. mid-edit, should still scope correctly once FROM exists
   elsewhere in the text). Unknown/mistyped table names are silently ignored, same as AlaSQL itself
   would just error on them later. */
function referencedTables(sql){
  var found = {};
  var re = /\b(?:FROM|JOIN)\s+\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi;
  var match;
  while((match = re.exec(sql))){
    var name = match[1];
    Object.keys(TABLE_SCHEMAS).forEach(function(table){
      if(table.toLowerCase() === name.toLowerCase()) found[table] = true;
    });
  }
  return Object.keys(found);
}

function fieldCandidateTables(sql){
  var referenced = referencedTables(sql);
  return referenced.length > 0 ? referenced : Object.keys(TABLE_SCHEMAS);
}

/* Every OTHER table any of `tables` has a TABLE_RELATIONSHIPS edge to, in either direction —
   self-referential FKs (from === to) excluded, since a table is always "related" to itself trivially
   and that's not useful ranking signal. Used to surface the most likely next JOIN target first. */
function relatedTables(tables){
  var tableSet = {};
  tables.forEach(function(t){ tableSet[t] = true; });
  var related = {};
  TABLE_RELATIONSHIPS.forEach(function(rel){
    if(rel.from === rel.to) return;
    if(tableSet[rel.from] && !tableSet[rel.to]) related[rel.to] = true;
    if(tableSet[rel.to] && !tableSet[rel.from]) related[rel.from] = true;
  });
  return related;
}

/* A field named "id" is its own table's primary key by this schema's universal convention (every
   table's own TABLE_SCHEMAS entry starts with "id", never enforced any other way — see schema-erd.js's
   own identical isKeyishField() heuristic). A field is a foreign key if it's some table's OWN column
   pointing at another table, i.e. it appears as a `fromField` on a TABLE_RELATIONSHIPS edge whose
   `from` is that same table — not just any field mentioned anywhere in the relationships list. */
function isForeignKeyField(table, field){
  return TABLE_RELATIONSHIPS.some(function(rel){ return rel.from === table && rel.fromField === field; });
}

function fieldKind(table, field){
  if(field === 'id') return 'field-pk';
  if(isForeignKeyField(table, field)) return 'field-fk';
  return 'field';
}

/* Builds one suggestion per distinct field name across `tables` — disambiguated with a `table.`
   prefix (both segments individually bracketed) whenever the same field name appears in more than
   one of those tables, bare `[field]` otherwise. `kind` distinguishes a plain field from a primary
   key (`field-pk`) or foreign key (`field-fk`) — see fieldKind() — purely for the UI's suggestion-
   type badge (a yellow key for PK, a white key for FK, nothing for an ordinary field). */
function buildFieldOptions(tables){
  var owners = {};
  tables.forEach(function(table){
    (TABLE_SCHEMAS[table] || []).forEach(function(field){
      if(!owners[field]) owners[field] = [];
      owners[field].push(table);
    });
  });
  var options = [];
  Object.keys(owners).sort().forEach(function(field){
    var fieldOwners = owners[field];
    if(fieldOwners.length === 1){
      // matchKey is the bare field name the user is actually typing — filtering must happen against
      // this, never the display label, or a disambiguated "tasks.id" label (which doesn't start with
      // the user's typed "i") would wrongly fail to match at all.
      options.push({label: field, matchKey: field, kind: fieldKind(fieldOwners[0], field), insertText: '[' + field + '] '});
    } else {
      fieldOwners.forEach(function(table){
        options.push({label: table + '.' + field, matchKey: field, kind: fieldKind(table, field), insertText: '[' + table + '].[' + field + '] '});
      });
    }
  });
  return options;
}

/* Table suggestions after FROM/JOIN, ranked so a table with a known TABLE_RELATIONSHIPS edge to a
   table already referenced in the query sorts before an unrelated one — alphabetical within each
   group. Before any FROM/JOIN exists yet, nothing is "related" and this is a plain alphabetical list,
   same as before this ranking was added. */
function buildTableOptions(sql){
  var referenced = referencedTables(sql);
  var related = relatedTables(referenced);
  return Object.keys(TABLE_SCHEMAS).sort(function(a, b){
    var ra = !!related[a], rb = !!related[b];
    if(ra !== rb) return ra ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }).map(function(table){
    return {label: table, matchKey: table, kind: 'table', insertText: '[' + table + '] '};
  });
}

function buildKeywordOptions(){
  return SQL_KEYWORDS.slice().sort().map(function(kw){
    return {label: kw, matchKey: kw, kind: 'keyword', insertText: kw + ' '};
  });
}

/* Smart JOIN-condition suggestions, offered only right after ON — one per TABLE_RELATIONSHIPS edge
   connecting two tables both already referenced in the query (FROM/JOIN'd), e.g. typing "ON " right
   after "FROM tasks JOIN columns" offers "tasks.columnId = columns.id" as a single one-shot
   suggestion, both sides bracketed. Self-referential FKs are skipped — "tasks.parentTaskId = tasks.id"
   is a real relationship but not a sensible suggestion when the query only references "tasks" once. */
function buildJoinConditionOptions(sql){
  var tables = referencedTables(sql);
  if(tables.length < 2) return [];
  var tableSet = {};
  tables.forEach(function(t){ tableSet[t] = true; });
  var seen = {};
  var options = [];
  TABLE_RELATIONSHIPS.forEach(function(rel){
    if(rel.from === rel.to) return;
    if(!tableSet[rel.from] || !tableSet[rel.to]) return;
    var label = rel.from + '.' + rel.fromField + ' = ' + rel.to + '.' + rel.toField;
    if(seen[label]) return;
    seen[label] = true;
    options.push({
      label: label, matchKey: label, kind: 'join',
      insertText: '[' + rel.from + '].[' + rel.fromField + '] = [' + rel.to + '].[' + rel.toField + '] '
    });
  });
  return options;
}

function matchesPrefix(matchKey, prefix){
  if(!prefix) return true;
  return matchKey.toLowerCase().indexOf(prefix.toLowerCase()) === 0;
}

/* Main entry point. Returns null when no suggestion applies at `caretIndex`, otherwise
   {start, end, type, options: [{label, matchKey, kind, insertText}]} — `start`/`end` is the full word
   span to replace (see getWordSpan), `type` is 'table' or 'field-or-keyword'. `matchKey` is the bare
   identifier the user is actually typing (used for prefix filtering); `label` is the display text,
   which for a disambiguated field differs from matchKey (`tasks.id` vs `id`). `kind` is
   'table'/'field'/'field-pk'/'field-fk'/'keyword'/'join', purely for the UI's suggestion-type badge. */
export function computeIntellisense(sql, caretIndex){
  if(isInsideStringLiteral(sql, caretIndex)) return null;

  var span = getWordSpan(sql, caretIndex);
  if(sql[span.start - 1] === '[') return null; // user is manually bracket-editing — leave them to it

  var prefix = sql.slice(span.start, caretIndex);
  var prevToken = previousToken(sql, span.start);
  var isTableContext = prevToken === 'FROM' || prevToken === 'JOIN';

  var options;
  var type;
  if(isTableContext){
    type = 'table';
    options = buildTableOptions(sql);
  } else {
    type = 'field-or-keyword';
    // Smart join-condition suggestions go first — right after ON, with two-or-more tables already
    // referenced, TABLE_RELATIONSHIPS usually has exactly the condition the user is about to type by
    // hand anyway. Still additive, not a replacement: plain field/keyword completion stays available
    // for conditions TABLE_RELATIONSHIPS doesn't cover.
    var joinOptions = prevToken === 'ON' ? buildJoinConditionOptions(sql) : [];
    options = joinOptions.concat(buildFieldOptions(fieldCandidateTables(sql)), buildKeywordOptions());
  }

  var filtered = options.filter(function(opt){ return matchesPrefix(opt.matchKey, prefix); });
  if(filtered.length === 0) return null;

  return {start: span.start, end: span.end, type: type, options: filtered};
}

/* =========================================================
   CARET PIXEL POSITION (hand-rolled mirror-div technique — no prior art/library anywhere in this
   codebase; a <textarea> exposes no native API for "where on screen is the caret", so the standard
   trick is to mirror its exact text/font layout into an off-screen div, fill it with the text up to
   the caret plus a marker span, then measure the marker.
   ========================================================= */

var MIRROR_COPY_PROPS = [
  'boxSizing', 'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily',
  'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textAlign', 'textIndent',
  'textTransform', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordWrap', 'overflowWrap'
];

/* Returns {left, top, lineHeight} of the caret relative to the textarea's own top-left border box —
   the caller adds textarea.getBoundingClientRect() and subtracts scrollLeft/scrollTop to place a
   viewport-fixed dropdown. jsdom performs no real layout, so this is only meaningful in a real
   browser — deliberately excluded from pixel-position assertions in this feature's test file. */
export function getCaretPixelPosition(textarea){
  var doc = textarea.ownerDocument;
  var computed = doc.defaultView.getComputedStyle(textarea);

  var mirror = doc.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  MIRROR_COPY_PROPS.forEach(function(prop){
    mirror.style[prop] = computed[prop];
  });

  var caretIndex = textarea.selectionStart;
  var before = textarea.value.slice(0, caretIndex);
  var marker = doc.createElement('span');
  marker.textContent = '​'; // zero-width space — a real, measurable inline box

  mirror.appendChild(doc.createTextNode(before));
  mirror.appendChild(marker);
  mirror.appendChild(doc.createTextNode(textarea.value.slice(caretIndex) || '.'));

  doc.body.appendChild(mirror);
  var lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2 || 16;
  var position = {left: marker.offsetLeft, top: marker.offsetTop, lineHeight: lineHeight};
  doc.body.removeChild(mirror);

  return position;
}
