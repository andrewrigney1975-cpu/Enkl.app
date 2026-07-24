"use strict";
import { escapeHTML } from '../utils.js';

/* A second, separately-scoped hand-rolled Markdown->HTML renderer, deliberately NOT shared with
   rich-text/markdown.js. That module is intentionally minimal (bold/italic/###-max headings/flat
   lists/blockquotes only) because it also has to serialize the OTHER direction (contenteditable DOM
   -> Markdown) for the rich-text editor's own round-trip needs, and extending its grammar would risk
   that editor's fidelity for a completely unrelated use case. This module is read-only, one direction
   only (Markdown -> HTML, for rendering USER-GUIDE.md/SYSTEMS-INTEGRATOR-GUIDE.md in the Guide Viewer
   modal — see modals/guide-viewer.js), so it can afford a larger grammar: headings h1-h6, fenced code
   blocks, GFM-style pipe tables, horizontal rules, one level of nested lists, blockquotes, inline
   code, bold/italic, and links — the actual subset both guide documents use (checked against their
   real content before writing this, not guessed).

   COMMONMARK-STANDARD SOFT BREAKS (the opposite choice from rich-text/markdown.js's deliberate hard-
   break divergence): both guides are hand-wrapped prose at ~90-100 columns for readability in a text
   editor, not real line breaks — a single "\n" inside a paragraph/list-item/blockquote is treated as
   a plain space here, so wrapped text reflows naturally instead of showing a forced break at every
   wrap point. Only a blank line starts a new paragraph.

   Same sanitization strategy as rich-text/markdown.js: the whole input is escapeHTML()'d before any
   Markdown-syntax matching runs, so every tag in the output is one this parser explicitly generated
   from recognized syntax; a link's href gets its own scheme allowlist since escaping doesn't cover
   attribute-value injection. No third-party Markdown library — same "hand-roll everything" rule as
   the rest of this app (root CLAUDE.md's charting-library principle, applied here too).

   ONE DELIBERATE EXCEPTION to "escape everything": a ```svg fenced block emits its content as REAL,
   unescaped SVG markup (diagrams — root CLAUDE.md's own no-charting-library convention, hand-rolled
   inline SVG same as every chart in the app) instead of a <pre><code> listing. This is safe only
   because these two guide documents are authored content shipped in this repo, not user-supplied
   input — the same trust boundary as any other string literal in this codebase. Extraction happens
   BEFORE the whole-input escape pass (a block-level placeholder swap, not the inline NUL/link scheme
   below) so the raw markup survives verbatim; every other fenced-block type is still fully escaped
   and rendered as inert text exactly as before. */

var SAFE_URL_RE = /^(https?:\/\/|mailto:|\/|#)/i;

function applyInlineCode(text){
  return text.replace(/`([^`]+)`/g, '<code>$1</code>');
}
function applyBoldItalic(text){
  // Bold first, non-greedy — otherwise "**x**"'s outer asterisks get consumed by the italic pattern
  // before bold ever gets a chance to match (same ordering rule as rich-text/markdown.js).
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// Distinct control-character placeholder schemes so link/code substitution never collides with real
// prose or with each other — same technique as rich-text/markdown.js's NUL/SOH placeholders.
var NUL = String.fromCharCode(0);
var LINK_PLACEHOLDER_RE = new RegExp(NUL + '(\\d+)' + NUL, 'g');
var SOH = String.fromCharCode(1);
var SVG_FENCE_RE = /```svg[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
var SVG_PLACEHOLDER_RE = new RegExp('^' + SOH + '(\\d+)' + SOH + '$');

function inlineToHtml(text){
  var links = [];
  var withLinkPlaceholders = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(match, label, url){
    var html;
    if(SAFE_URL_RE.test(url)){
      html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + applyBoldItalic(label) + '</a>';
    } else {
      // Unrecognized URL scheme (e.g. javascript:) — keep the escaped literal text unchanged rather
      // than ever writing attacker-controlled text into an href attribute.
      html = match;
    }
    links.push(html);
    return NUL + (links.length - 1) + NUL;
  });

  // Inline code before bold/italic — a literal "*" inside a `code span` must never be read as
  // emphasis syntax, and code content shouldn't be bold/italic-formatted either.
  var withInlineCode = applyInlineCode(withLinkPlaceholders);
  var withFormatting = applyBoldItalic(withInlineCode);

  return withFormatting.replace(LINK_PLACEHOLDER_RE, function(m, idx){ return links[idx]; });
}

function isBlockStart(line){
  return /^```/.test(line) ||
    /^#{1,6}[ \t]+/.test(line) ||
    /^-{3,}\s*$/.test(line) ||
    /^[ \t]*\|/.test(line) ||
    /^[-*+][ \t]+/.test(line) ||
    /^\d+\.[ \t]+/.test(line) ||
    /^&gt;[ \t]?/.test(line);
}

// A GFM-style pipe-table row: "| a | b |" (leading/trailing pipes optional on data rows in real
// Markdown, but both guides always write them, so this doesn't need to handle the bare-pipe-optional
// case). Strips the leading/trailing pipe before splitting on interior "|".
function splitTableRow(line){
  var trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(function(cell){ return cell.trim(); });
}

/** Parses a Markdown string into safe, printable HTML — see the module doc comment for grammar
    coverage and the escape-then-generate sanitization strategy. */
export function markdownToDocHtml(markdown){
  var svgBlocks = [];
  var withSvgPlaceholders = (markdown || '').replace(SVG_FENCE_RE, function(match, svgContent){
    svgBlocks.push(svgContent);
    return SOH + (svgBlocks.length - 1) + SOH;
  });

  var lines = escapeHTML(withSvgPlaceholders).split(/\r?\n/);
  var out = [];
  var i = 0;

  while(i < lines.length){
    var line = lines[i];
    if(line.trim() === ''){ i++; continue; }

    // A ```svg block, already extracted above and swapped for a one-line placeholder before escaping
    // - emit its ORIGINAL, unescaped content verbatim (see the module doc comment's "one deliberate
    // exception" note) rather than treating it like any other paragraph/code content.
    var svgPlaceholderMatch = SVG_PLACEHOLDER_RE.exec(line.trim());
    if(svgPlaceholderMatch){
      out.push(svgBlocks[Number(svgPlaceholderMatch[1])]);
      i++;
      continue;
    }

    // Fenced code block — content is left completely unprocessed (no inline formatting), joined by
    // real newlines inside <pre> so whitespace-sensitive content (ASCII diagrams, sample output)
    // renders exactly as written. Already HTML-escaped by the whole-input escape pass above.
    if(/^```/.test(line)){
      i++;
      var codeLines = [];
      while(i < lines.length && !/^```/.test(lines[i])){ codeLines.push(lines[i]); i++; }
      i++; // skip closing fence (or run off the end if the fence was never closed — best-effort)
      out.push('<pre><code>' + codeLines.join('\n') + '</code></pre>');
      continue;
    }

    // Horizontal rule — must be checked before headings/lists since "---" alone matches none of those.
    if(/^-{3,}\s*$/.test(line)){
      out.push('<hr>');
      i++;
      continue;
    }

    var headingMatch = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if(headingMatch){
      var hTag = 'h' + headingMatch[1].length;
      out.push('<' + hTag + '>' + inlineToHtml(headingMatch[2]) + '</' + hTag + '>');
      i++;
      continue;
    }

    // Table: current line has a pipe, and the NEXT line is a separator row ("|---|:--:|---|" etc).
    if(/^[ \t]*\|/.test(line) && i + 1 < lines.length && /^[ \t]*\|?[\s:|-]+\|?[ \t]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])){
      var headerCells = splitTableRow(line);
      i += 2;
      var bodyRows = [];
      while(i < lines.length && /^[ \t]*\|/.test(lines[i])){ bodyRows.push(splitTableRow(lines[i])); i++; }
      var thead = '<thead><tr>' + headerCells.map(function(c){ return '<th>' + inlineToHtml(c) + '</th>'; }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + bodyRows.map(function(r){
        return '<tr>' + r.map(function(c){ return '<td>' + inlineToHtml(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      out.push('<table>' + thead + tbody + '</table>');
      continue;
    }

    // Blockquote — consecutive "&gt; " lines (post-escape form of "> "), soft-joined like paragraphs.
    if(/^&gt;[ \t]?/.test(line)){
      var quoteLines = [];
      while(i < lines.length && /^&gt;[ \t]?/.test(lines[i])){ quoteLines.push(lines[i].replace(/^&gt;[ \t]?/, '')); i++; }
      out.push('<blockquote><p>' + inlineToHtml(quoteLines.join(' ')) + '</p></blockquote>');
      continue;
    }

    // Lists — unordered (-, *, +) or ordered (1.), with exactly one level of nested unordered
    // sub-items (2+ leading spaces + a bullet marker) — the only nesting depth either guide uses.
    // Wrapped continuation lines (2+ leading spaces, no bullet marker) are soft-joined onto whichever
    // item - top-level or sub - they trail, same soft-break convention as paragraphs/blockquotes
    // above; without this, a hand-wrapped bullet's second line fell through as its own stray <p>,
    // breaking the sentence out of the list entirely.
    var isUl = /^[-*+][ \t]+/.test(line);
    var isOl = /^\d+\.[ \t]+/.test(line);
    if(isUl || isOl){
      var ordered = isOl;
      var topRe = ordered ? /^\d+\.[ \t]+/ : /^[-*+][ \t]+/;
      var subRe = /^[ \t]{2,}[-*+][ \t]+/;
      var indentRe = /^[ \t]+/;
      var items = [];
      while(i < lines.length && topRe.test(lines[i])){
        var itemParts = [lines[i].replace(topRe, '')];
        i++;
        var subItemParts = [];
        var currentParts = itemParts;
        while(i < lines.length){
          var ln = lines[i];
          if(ln.trim() === '' || topRe.test(ln)) break;
          if(subRe.test(ln)){
            var newSubParts = [ln.replace(subRe, '')];
            subItemParts.push(newSubParts);
            currentParts = newSubParts;
            i++;
            continue;
          }
          if(indentRe.test(ln)){
            currentParts.push(ln.replace(indentRe, ''));
            i++;
            continue;
          }
          break;
        }
        var subItemsHtml = subItemParts.map(function(parts){ return '<li>' + inlineToHtml(parts.join(' ')) + '</li>'; }).join('');
        items.push('<li>' + inlineToHtml(itemParts.join(' ')) + (subItemsHtml ? '<ul>' + subItemsHtml + '</ul>' : '') + '</li>');
      }
      var listTag = ordered ? 'ol' : 'ul';
      out.push('<' + listTag + '>' + items.join('') + '</' + listTag + '>');
      continue;
    }

    // Paragraph — gather consecutive non-blank lines up to the next block-starting line or a blank
    // line, soft-joining wrapped lines with a space (see the module doc comment on why, unlike
    // rich-text/markdown.js's hard-break convention).
    var paraLines = [line];
    i++;
    while(i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])){
      paraLines.push(lines[i]);
      i++;
    }
    out.push('<p>' + inlineToHtml(paraLines.join(' ')) + '</p>');
  }

  return out.join('');
}
