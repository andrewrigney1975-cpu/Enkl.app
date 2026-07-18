"use strict";
import { htmlToMarkdown, markdownToHtml } from './markdown.js';
import { HASHTAG_NAME_RE, hashtagChipHtml, filterHashtags } from '../features/hashtags.js';

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
 * serialized Markdown length, enforced on every input event. opts.getHashtags is an optional
 * `() => string[]` callback supplying the current project's existing tag names for the "#" inline
 * autocomplete below — a callback rather than a direct storage/store.js import, so this factory stays
 * domain-agnostic (per this file's own "generic, reusable factory" design note above); a mount site
 * with no hashtag support needed can simply omit it.
 */
export function createRichTextEditor(containerEl, toolbarEl, opts){
  opts = opts || {};
  var maxLength = opts.maxLength || 4000;
  var getHashtags = opts.getHashtags || function(){ return []; };
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

  /* Hashtag "#" inline autocomplete — see features/hashtags.js's own doc comment for why a hashtag
     is just plain "#name" text with no separate entity/API surface. hashtagState is non-null only
     while the dropdown is open, mid-composition; it's the single source of truth for both the
     rendered options and exactly which text range (a start/end offset inside one specific text node)
     Tab/Space would replace. */
  var hashtagDropdownEl = null;
  var hashtagState = null;

  function closeHashtagDropdown(){
    hashtagState = null;
    if(hashtagDropdownEl) hashtagDropdownEl.classList.add('hidden');
  }

  function ensureHashtagDropdown(){
    if(hashtagDropdownEl) return hashtagDropdownEl;
    hashtagDropdownEl = document.createElement('div');
    // kf-intellisense-dropdown for the shared visual styling; kf-hashtag-intellisense-dropdown as a
    // distinguishing selector - the Advanced Query tab's own SQL intellisense dropdown
    // (#projectQueryIntellisenseDropdown, a static element already in index.html) shares the same
    // base class, so anything needing to target THIS dropdown specifically needs a second hook.
    hashtagDropdownEl.className = 'kf-intellisense-dropdown kf-hashtag-intellisense-dropdown hidden';
    document.body.appendChild(hashtagDropdownEl);
    // mousedown (not click), with preventDefault, so this wins the race against containerEl's own
    // blur - clicking a dropdown option must never let the editor lose focus/selection first, same
    // convention the toolbar's own mousedown handler above (and sql-intellisense.js's dropdown) use.
    hashtagDropdownEl.addEventListener('mousedown', function(e){
      var optEl = e.target.closest ? e.target.closest('[data-index]') : null;
      if(!optEl) return;
      e.preventDefault();
      acceptHashtagOption(parseInt(optEl.getAttribute('data-index'), 10));
    });
    return hashtagDropdownEl;
  }

  function renderHashtagDropdown(){
    var el = ensureHashtagDropdown();
    el.innerHTML = hashtagState.options.map(function(opt, i){
      var cls = 'kf-intellisense-option' + (i === hashtagState.activeIndex ? ' active' : '') + (opt.isNew ? ' kf-hashtag-intellisense-option-new' : '');
      var label = opt.isNew ? 'Create "#' + opt.tag + '"' : '#' + opt.tag;
      return '<div class="' + cls + '" data-index="' + i + '">' + label + '</div>';
    }).join('');
  }

  function positionHashtagDropdown(){
    var el = ensureHashtagDropdown();
    var rect = null;
    try {
      var sel = window.getSelection();
      if(sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch(e){
      // Range.getBoundingClientRect() isn't implemented in every environment this code runs under
      // (e.g. jsdom, which this app's own test suite boots against) - fall through to the container
      // rect below rather than letting a positioning nicety crash the whole intellisense feature.
    }
    if(!rect || (rect.width === 0 && rect.height === 0)) rect = containerEl.getBoundingClientRect();
    el.style.left = rect.left + 'px';
    el.style.top = (rect.bottom + 4) + 'px';
  }

  /* Scans backward from the live caret, within its own text node only (a hashtag never spans
     multiple DOM nodes while being composed - see below), for an unterminated "#name" the user is
     mid-typing. Runs after every input event. */
  function updateHashtagIntellisense(){
    var sel = window.getSelection();
    if(!sel || sel.rangeCount === 0 || !sel.isCollapsed){ closeHashtagDropdown(); return; }
    var range = sel.getRangeAt(0);
    var textNode = range.startContainer;
    if(!containerEl.contains(textNode) || textNode.nodeType !== 3){ closeHashtagDropdown(); return; }

    var caret = range.startOffset;
    var text = textNode.nodeValue;

    var hashIndex = -1;
    for(var i = caret - 1; i >= 0; i--){
      var ch = text.charAt(i);
      if(ch === '#'){ hashIndex = i; break; }
      if(/\s/.test(ch)) break;
    }
    if(hashIndex === -1){ closeHashtagDropdown(); return; }
    // Boundary rule (features/hashtags.js's HASHTAG_SCAN_RE): '#' must start the text node or follow
    // whitespace, never sit mid-word (e.g. "issue#42").
    if(hashIndex > 0 && !/\s/.test(text.charAt(hashIndex - 1))){ closeHashtagDropdown(); return; }

    var prefix = text.slice(hashIndex + 1, caret);
    if(prefix && !HASHTAG_NAME_RE.test(prefix)){ closeHashtagDropdown(); return; }

    var matches = filterHashtags(getHashtags(), prefix);
    var options = matches.map(function(t){ return {tag: t, isNew: false}; });
    var exactMatch = matches.some(function(t){ return t.toLowerCase() === prefix.toLowerCase(); });
    if(prefix && !exactMatch) options.push({tag: prefix, isNew: true});
    if(options.length === 0){ closeHashtagDropdown(); return; }

    hashtagState = {options: options, activeIndex: 0, textNode: textNode, hashIndex: hashIndex, caret: caret};
    renderHashtagDropdown();
    positionHashtagDropdown();
    ensureHashtagDropdown().classList.remove('hidden');
  }

  function acceptHashtagOption(index){
    if(!hashtagState || !hashtagState.options[index]) return;
    insertHashtagChip(hashtagState.options[index].tag);
  }

  function insertHashtagChip(tagName){
    var textNode = hashtagState.textNode;
    var hashIndex = hashtagState.hashIndex;
    var sel = window.getSelection();
    // Re-read the live caret rather than trusting the stashed one - typing can continue between the
    // dropdown's last render and the accept keystroke (e.g. one more letter typed, then Tab).
    var liveCaret = (sel && sel.rangeCount && sel.getRangeAt(0).startContainer === textNode) ? sel.getRangeAt(0).startOffset : hashtagState.caret;

    var range = document.createRange();
    range.setStart(textNode, hashIndex);
    range.setEnd(textNode, liveCaret);
    range.deleteContents();

    var wrapper = document.createElement('div');
    wrapper.innerHTML = hashtagChipHtml(tagName);
    var chipEl = wrapper.firstChild;
    range.insertNode(chipEl);

    // A plain space, not a special character - inserted right after the (atomic, contenteditable
    // false) chip so the caret has somewhere ordinary to land and typing continues normally, and so
    // it round-trips through markdown as unremarkable whitespace.
    var spaceNode = document.createTextNode(' ');
    if(chipEl.nextSibling) chipEl.parentNode.insertBefore(spaceNode, chipEl.nextSibling);
    else chipEl.parentNode.appendChild(spaceNode);

    var newRange = document.createRange();
    newRange.setStart(spaceNode, 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    closeHashtagDropdown();
    lastGoodHtml = containerEl.innerHTML;
    updateToolbarState();
  }

  function onHashtagKeydown(e){
    if(!hashtagState) return;
    if(e.key === 'ArrowDown'){
      e.preventDefault();
      hashtagState.activeIndex = (hashtagState.activeIndex + 1) % hashtagState.options.length;
      renderHashtagDropdown();
    } else if(e.key === 'ArrowUp'){
      e.preventDefault();
      hashtagState.activeIndex = (hashtagState.activeIndex - 1 + hashtagState.options.length) % hashtagState.options.length;
      renderHashtagDropdown();
    } else if(e.key === 'Tab' || e.key === ' '){
      // Tab or Space confirms - selects the highlighted option (an existing tag, or the currently-
      // typed text itself when nothing existing matches, per the "isNew" option above).
      e.preventDefault();
      acceptHashtagOption(hashtagState.activeIndex);
    } else if(e.key === 'Escape'){
      // Belt-and-suspenders like sql-intellisense.js's own Escape handling: stopPropagation so a
      // global Escape handler (e.g. one that closes the whole modal) doesn't also fire from the same
      // keystroke the dropdown itself just consumed.
      e.preventDefault();
      e.stopPropagation();
      closeHashtagDropdown();
    }
    // Enter/letters/backspace/etc. all fall through to normal editing - onInput() re-evaluates the
    // dropdown afterward.
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
      closeHashtagDropdown();
      return;
    }
    lastGoodHtml = containerEl.innerHTML;
    updateHashtagIntellisense();
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
  containerEl.addEventListener('keydown', onHashtagKeydown);
  containerEl.addEventListener('input', onInput);
  containerEl.addEventListener('keyup', updateToolbarState);
  containerEl.addEventListener('mouseup', updateToolbarState);
  containerEl.addEventListener('blur', closeHashtagDropdown);

  return {
    getMarkdown: getMarkdown,
    setMarkdown: setMarkdown,
    focus: function(){ containerEl.focus(); },
    destroy: function(){} // Stub kept for API symmetry - a later Phase 2 modal may need real teardown.
  };
}
