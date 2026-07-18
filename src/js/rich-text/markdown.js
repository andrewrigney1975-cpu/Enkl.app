"use strict";
import { escapeHTML } from '../utils.js';
import { HASHTAG_SCAN_RE, hashtagChipHtml } from '../features/hashtags.js';

/* =========================================================
   MARKDOWN <-> HTML — a hand-rolled, deliberately scoped conversion pair (not a full CommonMark
   implementation) backing the rich-text editor (editor.js) and any read-only rendering of stored
   Markdown elsewhere (e.g. views/task-list.js's row-expand detail view). No third-party
   markdown/sanitizer library, matching this app's "no runtime dependency, hand-roll everything"
   convention (see CLAUDE.md's charting-library principle, applied here to the same effect).

   Supported grammar only: bold (**x**), italic (*x*), #/##/### headings, "- " bullet lists (flat,
   no nesting), "1. " numbered lists (flat, no nesting), "> " blockquotes, [text](url) links, and
   paragraphs separated by a blank line. Underline, strikethrough, tables, images, nested lists, and
   raw HTML passthrough are all deliberately unsupported — none map cleanly onto plain Markdown
   without complexity disproportionate to a task description.

   SANITIZATION STRATEGY: markdownToHtml() escapes its entire input via escapeHTML() BEFORE any
   markdown-syntax matching runs. Every tag in its output is therefore one this parser explicitly
   generated from recognized syntax — arbitrary HTML can never be smuggled through a stored Markdown
   string, from the UI or from a non-UI API client, without a separate allowlist-sanitizer pass. The
   one exception requiring its own check is link URLs (see SAFE_URL_RE below): an href attribute
   isn't tag syntax, so a "javascript:" URL needs its own scheme allowlist.

   COMMONMARK DIVERGENCE (deliberate, read this before "fixing" it): a single newline inside a
   paragraph becomes a hard <br>, not CommonMark's default soft-break-to-space. Every task's
   description predates this feature as plain text with literal newlines the user typed for visual
   line breaks — collapsing them to spaces would visibly corrupt every existing description's layout
   on first render after this ships. A genuine blank line (two consecutive newlines) still means a
   paragraph break as normal.
   ========================================================= */

var BLOCK_TAGS = ['P', 'DIV', 'H1', 'H2', 'H3', 'UL', 'OL', 'BLOCKQUOTE'];

// -------------------- HTML (contenteditable DOM) -> Markdown --------------------

function inlineNodeToMarkdown(node){
  if(node.nodeType === 3) return node.nodeValue; // Text node - pass through as-is.
  if(node.nodeType !== 1) return ''; // Comments etc. - ignore.
  var tag = node.tagName;
  if(tag === 'BR') return '\n';
  if(tag === 'STRONG' || tag === 'B') return '**' + inlineChildrenToMarkdown(node) + '**';
  if(tag === 'EM' || tag === 'I') return '*' + inlineChildrenToMarkdown(node) + '*';
  if(tag === 'A') return '[' + inlineChildrenToMarkdown(node) + '](' + (node.getAttribute('href') || '') + ')';
  // A hashtag chip (features/hashtags.js's hashtagChipHtml) round-trips back to its plain "#name"
  // text — checked before the generic fallback below, which would otherwise just read the chip's
  // own "#name" text content anyway (harmless here since it happens to match), but relying on that
  // coincidence would silently break the moment the chip's rendered content ever diverges from its
  // data-hashtag attribute (e.g. a future "show tag usage count" badge inside the chip).
  if(tag === 'SPAN' && node.hasAttribute && node.hasAttribute('data-hashtag')) return '#' + node.getAttribute('data-hashtag');
  // Any other inline wrapper shouldn't occur (only toolbar commands ever write into this DOM), but
  // recurse into its children defensively rather than silently dropping content.
  return inlineChildrenToMarkdown(node);
}

function inlineChildrenToMarkdown(containerEl){
  return Array.prototype.map.call(containerEl.childNodes, inlineNodeToMarkdown).join('');
}

function blockHtmlToMarkdown(el){
  var tag = el.tagName;
  if(tag === 'H1') return '# ' + inlineChildrenToMarkdown(el);
  if(tag === 'H2') return '## ' + inlineChildrenToMarkdown(el);
  if(tag === 'H3') return '### ' + inlineChildrenToMarkdown(el);
  if(tag === 'UL'){
    return Array.prototype.map.call(el.children, function(li){ return '- ' + inlineChildrenToMarkdown(li); }).join('\n');
  }
  if(tag === 'OL'){
    return Array.prototype.map.call(el.children, function(li, i){ return (i + 1) + '. ' + inlineChildrenToMarkdown(li); }).join('\n');
  }
  if(tag === 'BLOCKQUOTE'){
    return inlineChildrenToMarkdown(el).split('\n').map(function(line){ return '> ' + line; }).join('\n');
  }
  // P, DIV, or anything else block-level -> a plain paragraph.
  return inlineChildrenToMarkdown(el);
}

/* Walks a container's childNodes into an array of markdown block strings: a run of non-block-level
   children (text/BR/STRONG/EM/A) accumulates into one implicit paragraph, and each block-level
   child becomes its own block via blockHtmlToMarkdown(). A P/DIV is a special case: execCommand's
   insertUnorderedList/insertOrderedList (Chrome, confirmed live) can leave a genuine block element
   like <ul> nested INSIDE a <p> instead of replacing it - "<p><ul><li>a</li></ul></p>" is invalid
   markup no HTML parser would produce from a string, but it's exactly what's left in the live DOM
   after that command runs on a selection spanning existing paragraph text. A P/DIV's own children
   are therefore re-scanned with this same function rather than assumed to be pure inline content -
   otherwise that nested <ul> falls through the "unrecognized inline wrapper" fallback in
   inlineNodeToMarkdown below and its list items silently run together with no "- " markers and no
   separators at all, which is exactly the formatting-loss bug this recursion exists to prevent. */
function collectMarkdownBlocks(containerEl){
  var blocks = [];
  var looseParts = [];

  function flushLoose(){
    if(looseParts.length){
      var text = looseParts.join('').trim();
      if(text) blocks.push(text);
      looseParts = [];
    }
  }

  Array.prototype.forEach.call(containerEl.childNodes, function(node){
    var isBlock = node.nodeType === 1 && BLOCK_TAGS.indexOf(node.tagName) !== -1;
    if(isBlock){
      flushLoose();
      if(node.tagName === 'P' || node.tagName === 'DIV'){
        collectMarkdownBlocks(node).forEach(function(b){ if(b.trim()) blocks.push(b); });
      } else {
        var md = blockHtmlToMarkdown(node);
        if(md.trim()) blocks.push(md);
      }
    } else {
      // A bare text node, or an inline element (e.g. a stray <br> from Shift+Enter, or text typed
      // before the browser wraps the line in a <p>/<div>) sitting directly under this container -
      // accumulate consecutive bare nodes into one implicit paragraph rather than one block each, so
      // e.g. "Hello<br>World" at the root round-trips as a single "Hello\nWorld" paragraph.
      looseParts.push(inlineNodeToMarkdown(node));
    }
  });
  flushLoose();

  return blocks;
}

/** Serializes a mounted editor's contenteditable DOM (rootEl) to this module's scoped Markdown. */
export function htmlToMarkdown(rootEl){
  return collectMarkdownBlocks(rootEl).join('\n\n');
}

// -------------------- Markdown -> HTML --------------------

var SAFE_URL_RE = /^(https?:\/\/|mailto:|\/)/i;

function applyBoldItalic(text){
  // Bold's pattern must run first, and non-greedy - otherwise "**x**"'s outer asterisks get
  // consumed by the italic pattern before bold ever gets a chance to match.
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// A U+0000 NUL character can never occur in genuine description text, so it is safe to use as a
// placeholder-token delimiter that cannot collide with real prose - unlike a scheme built purely
// from printable characters (digits, spaces, letters), all of which real text can legitimately
// contain. Built via String.fromCharCode rather than a literal escape in source, purely so this
// file's bytes stay unambiguous plain ASCII throughout.
var NUL = String.fromCharCode(0);
var LINK_PLACEHOLDER_RE = new RegExp(NUL + '(\\d+)' + NUL, 'g');

// A distinct control character from the link placeholder's NUL above, so the two placeholder
// schemes can never collide with (or be mistaken for) each other during restoration.
var SOH = String.fromCharCode(1);
var HASHTAG_PLACEHOLDER_RE = new RegExp(SOH + '(\\d+)' + SOH, 'g');

/* Applies link, then hashtag, then bold/italic, to one already-escaped line/segment of text. Links
   and hashtags are both extracted into placeholder tokens first and swapped back in AFTER the
   bold/italic pass, rather than letting bold/italic run over the whole string including freshly-
   generated <a>/chip markup - otherwise a stray asterisk inside a URL (query strings do this), or a
   plain "*" character that happens to sit right next to a chip, could be wrongly consumed as
   formatting syntax spanning across a tag boundary. */
function inlineToHtml(text){
  var links = [];
  var withLinkPlaceholders = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(match, label, url){
    var html;
    if(SAFE_URL_RE.test(url)){
      html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + applyBoldItalic(label) + '</a>';
    } else {
      // Unrecognized URL scheme (e.g. javascript:) - keep the escaped literal text unchanged rather
      // than ever writing attacker-controlled text into an href attribute.
      html = match;
    }
    links.push(html);
    return NUL + (links.length - 1) + NUL;
  });

  // Boundary-aware (see features/hashtags.js's HASHTAG_SCAN_RE doc comment): only a "#name" that
  // starts a line or follows whitespace is a hashtag, so "issue#42" in prose is left alone. The
  // leading boundary character itself is preserved in the replacement, only the "#name" part becomes
  // a placeholder.
  var tags = [];
  var withHashtagPlaceholders = withLinkPlaceholders.replace(HASHTAG_SCAN_RE, function(match, lead, tag){
    tags.push(hashtagChipHtml(tag));
    return lead + SOH + (tags.length - 1) + SOH;
  });

  var withFormatting = applyBoldItalic(withHashtagPlaceholders);

  return withFormatting
    .replace(HASHTAG_PLACEHOLDER_RE, function(m, idx){ return tags[idx]; })
    .replace(LINK_PLACEHOLDER_RE, function(m, idx){ return links[idx]; });
}

function blockToHtml(block){
  var trimmed = block.trim();
  if(trimmed === '') return '';

  var lines = trimmed.split('\n');

  // Headings are always single-line in this scoped grammar - a multi-line block whose first line
  // happens to start with "#" text falls through to a plain paragraph instead.
  var headingMatch = lines.length === 1 ? /^(#{1,3})[ \t]+(.*)$/.exec(trimmed) : null;
  if(headingMatch){
    var tag = 'h' + headingMatch[1].length;
    return '<' + tag + '>' + inlineToHtml(headingMatch[2]) + '</' + tag + '>';
  }

  if(lines.every(function(l){ return /^-[ \t]+/.test(l); })){
    var ulHtml = lines.map(function(l){ return '<li>' + inlineToHtml(l.replace(/^-[ \t]+/, '')) + '</li>'; }).join('');
    return '<ul>' + ulHtml + '</ul>';
  }

  if(lines.every(function(l){ return /^\d+\.[ \t]+/.test(l); })){
    var olHtml = lines.map(function(l){ return '<li>' + inlineToHtml(l.replace(/^\d+\.[ \t]+/, '')) + '</li>'; }).join('');
    return '<ol>' + olHtml + '</ol>';
  }

  // "&gt; " is the post-escape form of "> " - escapeHTML() already ran over the whole input before
  // this function ever sees it (see markdownToHtml below).
  if(lines.every(function(l){ return /^&gt;[ \t]+/.test(l); })){
    var qHtml = lines.map(function(l){ return inlineToHtml(l.replace(/^&gt;[ \t]+/, '')); }).join('<br>');
    return '<blockquote>' + qHtml + '</blockquote>';
  }

  // Plain paragraph - see the module doc comment's "COMMONMARK DIVERGENCE" note for why a single
  // newline becomes a hard <br> here instead of CommonMark's soft-break-to-space default.
  return '<p>' + lines.map(inlineToHtml).join('<br>') + '</p>';
}

/** Parses a stored Markdown string into safe HTML — see the module doc comment for the sanitization
    strategy this implements (escape-then-generate, plus a link-URL scheme allowlist). */
export function markdownToHtml(markdown){
  var escaped = escapeHTML(markdown || '');
  return escaped.split(/\n[ \t]*\n/).map(blockToHtml).filter(function(html){ return html !== ''; }).join('');
}
