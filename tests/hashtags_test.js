const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers the hashtag chip feature layered onto the rich-text editor (rich-text/editor.js) and its
   markdown round-trip (rich-text/markdown.js): (1) a chip authored directly as HTML serializes back
   to plain "#tag" markdown and re-renders as a chip on reopen, (2) read-only rendering (task-list
   detail view) also shows a real chip element, not escaped "#tag" text, (3) the live "#" inline
   autocomplete — typing an unrecognized tag then pressing Tab inserts a new chip and offers a
   "Create" option; typing a prefix of an EXISTING tag (seeded by a prior saved task) offers it with
   its original canonical casing, and accepting it inserts that casing rather than whatever case was
   typed, (4) Escape closes the dropdown without inserting anything. */

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  function getStoredTask(taskTitle){
    const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
    const project = raw.projects[raw.currentProjectId];
    return Object.values(project.tasks).find(t => t.title === taskTitle);
  }
  function findCardByTitle(title){
    return Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(title) !== -1);
  }
  async function addTask(title, setDescription){
    doc.querySelectorAll('.kf-add-task-btn')[0].click();
    await wait(20);
    doc.getElementById('taskTitleInput').value = title;
    setDescription(doc.getElementById('taskDescEditor'));
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
  }
  async function getRenderedContentFor(title){
    doc.getElementById('taskListBtn').click();
    await wait(20);
    const row = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf(title) !== -1);
    row.querySelector('.kf-tasklist-chevron').click();
    await wait(10);
    const rowAfter = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf(title) !== -1);
    const contentEl = rowAfter.nextElementSibling.querySelector('.kf-richtext-content');
    doc.getElementById('taskListClose').click();
    await wait(10);
    return contentEl;
  }
  // Places the caret at the very end of a text node's content — the live typing scenarios below
  // build up plain text content directly, then position the caret there before dispatching 'input',
  // mirroring what a real keystroke would leave behind without needing jsdom to simulate key events
  // it doesn't actually implement editing behavior for (contenteditable text mutation isn't part of
  // jsdom's DOM implementation — same limitation this suite's other rich-text tests already work
  // around by mutating innerHTML/textContent directly rather than dispatching keypress events).
  function placeCaretAtEndOfTextNode(textNode){
    const range = doc.createRange();
    range.setStart(textNode, textNode.nodeValue.length);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── 1. A chip authored directly as HTML round-trips to plain "#tag" markdown ──
  await addTask('Hashtag round-trip task', el => {
    el.innerHTML = '<p>Ship the release <span class="kf-hashtag-chip" contenteditable="false" data-hashtag="urgent">#urgent</span> please</p>';
  });
  let stored = getStoredTask('Hashtag round-trip task');
  log('chip authored via HTML serializes to plain "#tag" text in storage', stored.description.indexOf('#urgent') !== -1 && stored.description.indexOf('kf-hashtag-chip') === -1, stored.description);

  let card = findCardByTitle('Hashtag round-trip task');
  card.click();
  await wait(10);
  let reopenedEditor = doc.getElementById('taskDescEditor');
  let reopenedChip = reopenedEditor.querySelector('.kf-hashtag-chip');
  log('reopened editor re-renders it as a real chip element', reopenedChip !== null && reopenedChip.getAttribute('data-hashtag') === 'urgent', reopenedEditor.innerHTML);
  log('reopened chip is contenteditable="false" (atomic token)', reopenedChip && reopenedChip.getAttribute('contenteditable') === 'false');
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 2. Read-only rendering (task-list detail view) also shows a real chip, not literal "#tag" text ──
  const contentEl = await getRenderedContentFor('Hashtag round-trip task');
  const readOnlyChip = contentEl.querySelector('.kf-hashtag-chip');
  log('read-only detail view renders a real chip element', readOnlyChip !== null && readOnlyChip.textContent === '#urgent', contentEl.innerHTML);

  // ── 3. Live typing: "#" + a brand-new tag name, Tab accepts, offered as "Create" (no existing match) ──
  doc.querySelectorAll('.kf-add-task-btn')[0].click();
  await wait(20);
  doc.getElementById('taskTitleInput').value = 'Live hashtag typing task';
  let editorEl = doc.getElementById('taskDescEditor');
  editorEl.textContent = 'Working on #newtag';
  const textNode = editorEl.firstChild;
  placeCaretAtEndOfTextNode(textNode);
  editorEl.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);

  const dropdown = doc.querySelector('.kf-hashtag-intellisense-dropdown');
  log('dropdown opens while typing an unrecognized tag', dropdown !== null && !dropdown.classList.contains('hidden'));
  log('dropdown offers a "Create" option for a brand-new tag', dropdown && dropdown.textContent.indexOf('Create "#newtag"') !== -1, dropdown ? dropdown.textContent : null);

  editorEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await wait(10);
  log('Tab inserts a chip and closes the dropdown', editorEl.querySelector('.kf-hashtag-chip[data-hashtag="newtag"]') !== null && dropdown.classList.contains('hidden'), editorEl.innerHTML);

  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  stored = getStoredTask('Live hashtag typing task');
  log('the Tab-accepted chip round-trips to "#newtag" in stored markdown', stored.description === 'Working on #newtag', JSON.stringify(stored.description));

  // ── 4. Existing-tag suggestion: typing a prefix of "urgent" (seeded by task #1 above) offers it, ──
  //      and accepting it inserts the CANONICAL casing, not whatever case was typed.
  doc.querySelectorAll('.kf-add-task-btn')[0].click();
  await wait(20);
  doc.getElementById('taskTitleInput').value = 'Existing tag suggestion task';
  editorEl = doc.getElementById('taskDescEditor');
  editorEl.textContent = 'See #URG';
  placeCaretAtEndOfTextNode(editorEl.firstChild);
  editorEl.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);

  const dropdown2 = doc.querySelector('.kf-hashtag-intellisense-dropdown');
  log('existing tag "urgent" is suggested for a case-insensitive prefix match on "URG"', dropdown2 && dropdown2.textContent.indexOf('#urgent') !== -1, dropdown2 ? dropdown2.textContent : null);

  editorEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await wait(10);
  const acceptedChip = editorEl.querySelector('.kf-hashtag-chip');
  log('accepting the suggestion inserts the existing tag\'s canonical casing ("urgent"), not the typed case ("URG")', acceptedChip && acceptedChip.getAttribute('data-hashtag') === 'urgent', acceptedChip ? acceptedChip.getAttribute('data-hashtag') : null);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 5. Escape closes the dropdown without inserting anything ──
  doc.querySelectorAll('.kf-add-task-btn')[0].click();
  await wait(20);
  doc.getElementById('taskTitleInput').value = 'Escape cancels dropdown task';
  editorEl = doc.getElementById('taskDescEditor');
  editorEl.textContent = 'Testing #abandoned';
  placeCaretAtEndOfTextNode(editorEl.firstChild);
  editorEl.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  const dropdown3 = doc.querySelector('.kf-hashtag-intellisense-dropdown');
  log('dropdown is open before Escape', dropdown3 && !dropdown3.classList.contains('hidden'));
  editorEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(10);
  log('Escape closes the dropdown', dropdown3.classList.contains('hidden'));
  log('Escape does not insert a chip - the text stays as plain "#abandoned"', editorEl.querySelector('.kf-hashtag-chip') === null, editorEl.textContent);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  console.log('\nHashtags test complete.');
  process.exit(0);
})().catch(e => {
  console.error('HASHTAGS TEST CRASHED:', e);
  process.exit(1);
});
