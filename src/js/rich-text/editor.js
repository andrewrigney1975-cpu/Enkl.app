"use strict";
import { htmlToMarkdown, markdownToHtml } from './markdown.js';

/* =========================================================
   RICH-TEXT EDITOR — a hand-rolled contenteditable-based WYSIWYG editor factory, no third-party
   library (matches this app's "no runtime dependency, hand-roll everything" convention — see
   CLAUDE.md's charting-library principle, applied here to the same effect).

   Command execution is a deliberate hybrid: document.execCommand() for the four simple toggles that
   behave consistently across every evergreen browser (bold/italic/bullet list/numbered list) —
   hand-rolling list-item Range logic (splitting/merging <li>s on Enter) is real complexity with no
   payoff. Headings/blockquote/link are hand-rolled via window.getSelection()+Range instead, since
   execCommand('formatBlock'/'createLink') behaves inconsistently across engines and can't enforce a
   clean href allowlist.

   Designed as a generic, reusable factory (createRichTextEditor(containerEl, toolbarEl, opts)) per
   this codebase's "engine factory + thin wrapper" convention (CLAUDE.md §7) — mounting a second
   instance into a different modal later (Document/Risk/Decision/etc. description fields) is meant to
   be a two-line integration, not a re-architecture.
   ========================================================= */

var BLOCK_LEVEL_TAGS = ['P', 'DIV', 'H1', 'H2', 'H3', 'BLOCKQUOTE'];

function closestBlockAncestor(node, rootEl){
  if(!node) return null;
  var el = node.nodeType === 1 ? node : node.parentElement;
  while(el && el !== rootEl){
    if(BLOCK_LEVEL_TAGS.indexOf(el.tagName) !== -1) return el;
    el = el.parentElement;
  }
  return null;
}

function placeCaretAtEnd(el){
  var range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * containerEl: the contenteditable surface. toolbarEl: the button row (may be null for a read-only/
 * headless use, though this module is only ever used for the editable case today — markdown.js's
 * markdownToHtml is what read-only renderers should import instead). opts.maxLength caps the
 * serialized Markdown length, enforced on every input event.
 */
export function createRichTextEditor(containerEl, toolbarEl, opts){
  opts = opts || {};
  var maxLength = opts.maxLength || 4000;
  var lastGoodHtml = containerEl.innerHTML;

  // Chrome defaults to wrapping loose typed text in a bare <div> rather than a <p> — force <p> so
  // freshly-typed paragraphs get the same tag (and CSS margins) as ones that arrived via
  // setMarkdown(). htmlToMarkdown()/markdownToHtml() both already treat P and DIV identically, so
  // this is purely a visual-consistency nicety, not a correctness requirement.
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch(e){ /* ignore */ }

  function setMarkdown(markdown){
    containerEl.innerHTML = markdownToHtml(markdown || '');
    lastGoodHtml = containerEl.innerHTML;
  }

  function getMarkdown(){
    return htmlToMarkdown(containerEl);
  }

  function convertBlock(block, tagName){
    // Toggle back to a plain paragraph if the block is already this type, otherwise convert it.
    var newTag = block.tagName === tagName ? 'P' : tagName;
    var replacement = document.createElement(newTag);
    while(block.firstChild) replacement.appendChild(block.firstChild);
    block.parentNode.replaceChild(replacement, block);
    return replacement;
  }

  function toggleBlock(tagName){
    var sel = window.getSelection();
    if(!sel || sel.rangeCount === 0 || !containerEl.contains(sel.anchorNode)) return;
    var block = closestBlockAncestor(sel.anchorNode, containerEl);
    if(!block){
      // No single enclosing block element found for anchorNode - either a bare text/inline node
      // sitting directly under the editor root, OR (confirmed live) a genuine multi-paragraph
      // selection such as Ctrl+A, where Selection.anchorNode is the editor container itself rather
      // than a descendant. Convert every top-level block-level child individually rather than
      // wrapping them all inside one new block - the latter produced an invalid nested structure
      // (e.g. "<h2><p>a</p><p>b</p></h2>") with no single valid markdown representation, and
      // silently lost the paragraph break between them on save.
      var topLevelBlocks = Array.prototype.filter.call(containerEl.children, function(el){
        return BLOCK_LEVEL_TAGS.indexOf(el.tagName) !== -1;
      });
      if(topLevelBlocks.length === 0) return;
      var lastReplacement = null;
      topLevelBlocks.forEach(function(el){ lastReplacement = convertBlock(el, tagName); });
      if(lastReplacement) placeCaretAtEnd(lastReplacement);
      return;
    }
    placeCaretAtEnd(convertBlock(block, tagName));
  }

  function insertLink(){
    var sel = window.getSelection();
    if(!sel || sel.rangeCount === 0 || !containerEl.contains(sel.anchorNode)) return;
    var url = window.prompt('Link URL:', 'https://');
    if(!url) return;
    var range = sel.getRangeAt(0);
    var a = document.createElement('a');
    a.setAttribute('href', url);
    if(range.collapsed){
      a.textContent = url;
      range.insertNode(a);
    } else {
      try {
        range.surroundContents(a);
      } catch(e){
        // The selection spans multiple block-level elements (surroundContents throws on a
        // non-well-formed range) - fall back to extracting the selected content into the link
        // manually rather than leaving the command silently do nothing.
        var frag = range.extractContents();
        a.appendChild(frag);
        range.insertNode(a);
      }
    }
    sel.removeAllRanges();
  }

  function runCommand(cmd){
    containerEl.focus();
    if(cmd === 'bold') document.execCommand('bold');
    else if(cmd === 'italic') document.execCommand('italic');
    else if(cmd === 'ul') document.execCommand('insertUnorderedList');
    else if(cmd === 'ol') document.execCommand('insertOrderedList');
    else if(cmd === 'h1') toggleBlock('H1');
    else if(cmd === 'h2') toggleBlock('H2');
    else if(cmd === 'h3') toggleBlock('H3');
    else if(cmd === 'quote') toggleBlock('BLOCKQUOTE');
    else if(cmd === 'link') insertLink();
    lastGoodHtml = containerEl.innerHTML;
    updateToolbarState();
  }

  function updateToolbarState(){
    if(!toolbarEl) return;
    var boldActive = false, italicActive = false;
    try {
      boldActive = document.queryCommandState('bold');
      italicActive = document.queryCommandState('italic');
    } catch(e){ /* queryCommandState can throw outside a live selection in some browsers - ignore */ }

    var sel = window.getSelection();
    var block = (sel && sel.rangeCount && containerEl.contains(sel.anchorNode)) ? closestBlockAncestor(sel.anchorNode, containerEl) : null;
    var blockTag = block ? block.tagName : null;

    var buttons = toolbarEl.querySelectorAll('[data-cmd]');
    Array.prototype.forEach.call(buttons, function(btn){
      var cmd = btn.getAttribute('data-cmd');
      var active =
        (cmd === 'bold' && boldActive) ||
        (cmd === 'italic' && italicActive) ||
        (cmd === 'h1' && blockTag === 'H1') ||
        (cmd === 'h2' && blockTag === 'H2') ||
        (cmd === 'h3' && blockTag === 'H3') ||
        (cmd === 'quote' && blockTag === 'BLOCKQUOTE');
      btn.classList.toggle('active', active);
    });
  }

  function onInput(){
    var markdown = htmlToMarkdown(containerEl);
    if(markdown.length > maxLength){
      // Refuse the edit that pushed content over the cap - same net effect as a native
      // <textarea maxlength>. Reverting to the last known-good DOM snapshot is simpler and more
      // robust than trying to reverse a partial edit after the fact, which risks leaving a
      // dangling/unbalanced tag mid-word.
      containerEl.innerHTML = lastGoodHtml;
      placeCaretAtEnd(containerEl);
      return;
    }
    lastGoodHtml = containerEl.innerHTML;
  }

  if(toolbarEl){
    toolbarEl.addEventListener('mousedown', function(e){
      // Prevent the toolbar button from stealing focus (and therefore the live selection) away from
      // the editable surface before the click handler below gets to run the command against it —
      // without this, clicking Bold on a selection collapses the selection on mousedown and the
      // click handler ends up applying bold to nothing.
      if(e.target.closest && e.target.closest('[data-cmd]')) e.preventDefault();
    });
    toolbarEl.addEventListener('click', function(e){
      var btn = e.target.closest ? e.target.closest('[data-cmd]') : null;
      if(!btn) return;
      e.preventDefault();
      runCommand(btn.getAttribute('data-cmd'));
    });
  }
  containerEl.addEventListener('input', onInput);
  containerEl.addEventListener('keyup', updateToolbarState);
  containerEl.addEventListener('mouseup', updateToolbarState);

  return {
    getMarkdown: getMarkdown,
    setMarkdown: setMarkdown,
    focus: function(){ containerEl.focus(); },
    destroy: function(){} // Stub kept for API symmetry - a later Phase 2 modal may need real teardown.
  };
}
