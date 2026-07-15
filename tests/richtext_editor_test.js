const { JSDOM } = require('jsdom');
const fs = require('fs');
const nodeCrypto = require('node:crypto');
const html = fs.readFileSync('../dist/index.html', 'utf8');

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;

  /* jsdom has no Web Crypto implementation - polyfill with Node's before any app startup code runs
     (needed for scenario 6's private-task encrypt/decrypt round trip). */
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });

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
  // setDescription receives the live #taskDescEditor element to populate however a given scenario
  // needs (innerHTML for pre-formatted content, textContent for plain text) BEFORE the one and only
  // Save click - saveTaskFromModal's normal-path finishSave() closes the modal and clears
  // ui.editingTaskId, so a second post-save Save click would create an unrelated second task instead
  // of updating this one, not append to it.
  async function addTask(title, setDescription){
    doc.querySelectorAll('.kf-add-task-btn')[0].click();
    await wait(20);
    doc.getElementById('taskTitleInput').value = title;
    setDescription(doc.getElementById('taskDescEditor'));
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
  }
  // Opens List View, expands the named task's row, hands back its .kf-richtext-content element,
  // then closes List View again - every scenario below that needs read-only rendering follows this
  // same open -> inspect -> close bracket so the board's "Add Task" button is never accidentally
  // clicked while covered by the List View overlay in the next scenario.
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

  // ── 1. Round-trip fidelity: type a mix of every supported formatting element, save, reopen ──
  const richHtml = '<p>Plain text with a <strong>bold</strong> word and an <em>italic</em> one.</p>' +
    '<h2>A heading</h2>' +
    '<ul><li>first item</li><li>second item</li></ul>' +
    '<blockquote>a quoted line</blockquote>' +
    '<p>Visit <a href="https://example.com">our site</a> for more.</p>';
  await addTask('Richtext round-trip task', el => { el.innerHTML = richHtml; });

  let stored = getStoredTask('Richtext round-trip task');
  const expectedMarkdown = 'Plain text with a **bold** word and an *italic* one.\n\n' +
    '## A heading\n\n' +
    '- first item\n- second item\n\n' +
    '> a quoted line\n\n' +
    'Visit [our site](https://example.com) for more.';
  log('saved description serializes to the expected Markdown', stored.description === expectedMarkdown, stored.description);

  let card = findCardByTitle('Richtext round-trip task');
  card.click();
  await wait(10);
  const reopenedEditor = doc.getElementById('taskDescEditor');
  log('reopened editor shows the bold word', reopenedEditor.querySelector('strong') && reopenedEditor.querySelector('strong').textContent === 'bold');
  log('reopened editor shows the italic word', reopenedEditor.querySelector('em') && reopenedEditor.querySelector('em').textContent === 'italic');
  log('reopened editor shows the heading', reopenedEditor.querySelector('h2') && reopenedEditor.querySelector('h2').textContent === 'A heading');
  log('reopened editor shows both list items', reopenedEditor.querySelectorAll('ul li').length === 2);
  log('reopened editor shows the blockquote', reopenedEditor.querySelector('blockquote') && reopenedEditor.querySelector('blockquote').textContent === 'a quoted line');
  const reopenedLink = reopenedEditor.querySelector('a');
  log('reopened editor shows the link with its href intact', reopenedLink && reopenedLink.getAttribute('href') === 'https://example.com' && reopenedLink.textContent === 'our site');
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 2. Regression: Chrome's execCommand('insertUnorderedList'/'insertOrderedList') can leave a
  //      <ul>/<ol> nested INSIDE the original <p> instead of replacing it, when the conversion is
  //      applied to a selection spanning pre-existing paragraph text (confirmed live in real
  //      Chromium - reported as "bullet list formatting lost on reopen"). Exercise the conversion
  //      function directly against that exact malformed shape, independent of execCommand itself
  //      (jsdom doesn't implement execCommand, so this is the right level to pin the fix at).
  await addTask('Nested list recovery task', el => {
    el.innerHTML = '<p><ul><li>first item</li><li>second item</li></ul></p>';
  });
  stored = getStoredTask('Nested list recovery task');
  log('a <ul> nested inside a <p> (execCommand artifact) still serializes to a real list, not flattened text', stored.description === '- first item\n- second item', JSON.stringify(stored.description));

  card = findCardByTitle('Nested list recovery task');
  card.click();
  await wait(10);
  const recoveredEditor = doc.getElementById('taskDescEditor');
  log('reopening shows a real <ul> with both items, not a flattened <p>', recoveredEditor.querySelectorAll('ul li').length === 2, recoveredEditor.innerHTML);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 3. Read-only rendering (task-list detail view) shows real formatted markup, not escaped text ──
  let contentEl = await getRenderedContentFor('Richtext round-trip task');
  log('detail view wraps the description in .kf-richtext-content', contentEl !== null && contentEl !== undefined);
  log('detail view renders a real <strong> element, not escaped text', contentEl.querySelector('strong') !== null);
  log('detail view renders a real <a href> element', contentEl.querySelector('a[href="https://example.com"]') !== null);

  // ── 4. Backward-compat: a legacy-style single newline (no blank line) becomes a <br>, ──
  //      not a collapsed space and not two separate <p> tags.
  await addTask('Legacy newline task', el => { el.textContent = 'Line one\nLine two'; });
  stored = getStoredTask('Legacy newline task');
  log('a bare text node with one newline serializes to one block with the newline preserved', stored.description === 'Line one\nLine two', JSON.stringify(stored.description));

  contentEl = await getRenderedContentFor('Legacy newline task');
  log('single newline renders as a hard <br>, not a collapsed space', contentEl.innerHTML.indexOf('Line one<br>Line two') !== -1, contentEl.innerHTML);
  log('single newline does NOT split into two separate <p> elements', contentEl.querySelectorAll('p').length === 1, contentEl.innerHTML);

  // ── 5. XSS / escaping: literal HTML and a javascript: link never become live markup ──
  await addTask('XSS test task', el => { el.textContent = '<script>alert(1)</script> and [click me](javascript:alert(1))'; });

  contentEl = await getRenderedContentFor('XSS test task');
  log('a literal <script> tag is never parsed as a real element', contentEl.querySelector('script') === null);
  log('a literal <script> tag renders as visible escaped text', contentEl.textContent.indexOf('<script>alert(1)</script>') !== -1, contentEl.textContent);
  log('a javascript: URL link is never emitted as a real <a href> element', contentEl.innerHTML.indexOf('href="javascript:') === -1, contentEl.innerHTML);

  // ── 6. Length cap: content stops growing past the cap, matching old textarea maxlength behavior ──
  await addTask('Length cap task', el => { el.innerHTML = '<p>Hello</p>'; });
  doc.getElementById('taskDescEditor').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(5);
  const beforeOverflow = doc.getElementById('taskDescEditor').innerHTML;
  doc.getElementById('taskDescEditor').innerHTML = '<p>' + 'a'.repeat(5000) + '</p>';
  doc.getElementById('taskDescEditor').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(5);
  const afterOverflow = doc.getElementById('taskDescEditor').innerHTML;
  log('content that would exceed the length cap is refused (reverted to the prior state)', afterOverflow === beforeOverflow, 'before.length=' + beforeOverflow.length + ' after.length=' + afterOverflow.length);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 7. Private-task flow: formatting survives encrypt-on-save / decrypt-on-unlock ──
  await addTask('Private richtext task', el => { el.innerHTML = '<p><strong>Confidential</strong> notes</p>'; });
  card = findCardByTitle('Private richtext task');
  card.click();
  await wait(10);
  doc.getElementById('taskPrivateCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(30);
  doc.getElementById('setPrivateKeyInput').value = 'hunter2';
  doc.getElementById('setPrivateKeyConfirmInput').value = 'hunter2';
  doc.getElementById('setPrivateKeyConfirmBtn').click();
  await wait(600);

  const rawStorageString = window.localStorage.getItem('kanbanflow_v1_db');
  log('the plaintext Markdown never survives in raw storage once private', rawStorageString.indexOf('**Confidential**') === -1);

  card = findCardByTitle('Private richtext task');
  card.click();
  await wait(10);
  doc.getElementById('unlockPrivateTaskInput').value = 'hunter2';
  doc.getElementById('unlockPrivateTaskConfirmBtn').click();
  await wait(600);
  const unlockedEditor = doc.getElementById('taskDescEditor');
  log('decrypted description round-trips through the editor with formatting intact', unlockedEditor.innerHTML === '<p><strong>Confidential</strong> notes</p>', unlockedEditor.innerHTML);
})();
