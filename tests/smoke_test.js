const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('../dist/index.html', 'utf8');

// Minimal localStorage polyfill for jsdom (jsdom does support localStorage with url set)
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'http://localhost/',
  pretendToBeVisual: true
});

const { window } = dom;

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  function log(label, ok, extra){
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
  }

  // 1. Initial render: seed project should be loaded
  const board = doc.getElementById('board');
  log('board exists', !!board);
  const columns = board.querySelectorAll('.kf-column');
  log('seed columns rendered (4)', columns.length === 4, 'got ' + columns.length);
  const cards = board.querySelectorAll('.kf-card');
  log('seed cards rendered (5)', cards.length === 5, 'got ' + cards.length);

  const toolbarTitle = doc.getElementById('toolbarTitle').textContent;
  log('toolbar shows Sample Project', toolbarTitle === 'Sample Project', toolbarTitle);

  // 2. Create a new project via modal flow
  doc.getElementById('newProjectBtn').click();
  await wait(20);
  const projOverlayHidden1 = doc.getElementById('projectOverlay').classList.contains('hidden');
  log('project modal opens', !projOverlayHidden1 === true, 'hidden=' + projOverlayHidden1);
  doc.getElementById('projectNameInput').value = 'Test Project';
  doc.getElementById('projectKeyInput').value = 'TST';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);
  const sel = doc.getElementById('projectSelect');
  const opts = Array.from(sel.options).map(o => o.textContent);
  log('new project appears in selector', opts.some(t => t.indexOf('Test Project') !== -1), opts.join(' | '));

  // 3. Add a column
  doc.getElementById('addColumnTopBtn').click();
  await wait(20);
  doc.getElementById('columnNameInput').value = 'Review';
  doc.getElementById('columnSaveBtn').click();
  await wait(20);
  const newCols = doc.querySelectorAll('.kf-column');
  log('column added to new (empty) project', newCols.length === 4, 'got ' + newCols.length); // default 3 + 1 added

  // 4. Add a task
  const addTaskBtns = doc.querySelectorAll('.kf-add-task-btn');
  addTaskBtns[0].click();
  await wait(20);
  doc.getElementById('taskTitleInput').value = 'First task';
  doc.getElementById('taskDescInput').value = 'Some description';
  doc.getElementById('taskPrioritySelect').value = 'high';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const cardsAfterAdd = doc.querySelectorAll('.kf-card');
  log('task card created', cardsAfterAdd.length === 1, 'got ' + cardsAfterAdd.length);
  log('task title rendered', cardsAfterAdd[0].textContent.indexOf('First task') !== -1);

  // 5. Add second task depending on first
  const addTaskBtns2 = doc.querySelectorAll('.kf-add-task-btn');
  addTaskBtns2[0].click();
  await wait(20);
  doc.getElementById('taskTitleInput').value = 'Second task';
  // select dependency checkbox for "First task"
  const depRows = doc.querySelectorAll('#depList .kf-dep-row');
  log('dependency candidate listed', depRows.length === 1, 'got ' + depRows.length);
  if (depRows.length) {
    const cb = depRows[0].querySelector('input[type=checkbox]');
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const cardsAfter2 = doc.querySelectorAll('.kf-card');
  log('second task created with dependency chip', cardsAfter2.length === 2, 'got ' + cardsAfter2.length);
  const secondCardHTML = Array.from(cardsAfter2).find(c => c.textContent.indexOf('Second task') !== -1).innerHTML;
  log('dependency chip shown on second card', secondCardHTML.indexOf('kf-dep-chip') !== -1);
  log('blocked chip shown (dependency not done)', secondCardHTML.indexOf('kf-blocked-chip') !== -1);

  // 6. Try editing the FIRST task to depend on the SECOND -> should be prevented (cycle)
  const firstCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('First task') !== -1);
  firstCard.click();
  await wait(20);
  const depRowsForFirst = doc.querySelectorAll('#depList .kf-dep-row');
  let secondTaskRow = null;
  depRowsForFirst.forEach(r => { if (r.textContent.indexOf('Second task') !== -1) secondTaskRow = r; });
  log('second task disabled as dependency option for first (cycle prevention)', secondTaskRow && secondTaskRow.classList.contains('disabled'));
  doc.getElementById('taskCancelBtn').click();
  await wait(20);

  // 7. Delete a task
  const cardToDelete = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('First task') !== -1);
  cardToDelete.click();
  await wait(20);
  doc.getElementById('taskDeleteBtn').click();
  await wait(20);
  // confirm dialog should now be open
  const confirmHidden = doc.getElementById('confirmOverlay').classList.contains('hidden');
  log('confirm dialog appears before delete', !confirmHidden);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  const cardsAfterDelete = doc.querySelectorAll('.kf-card');
  log('task removed after confirm', cardsAfterDelete.length === 1, 'got ' + cardsAfterDelete.length);

  // 8. localStorage persistence check
  const raw = window.localStorage.getItem('kanbanflow_v1_db');
  log('localStorage populated', !!raw);
  let parsed;
  try { parsed = JSON.parse(raw); } catch(e) {}
  log('localStorage JSON parses', !!parsed);
  log('current project switched to Test Project', parsed && parsed.projects[parsed.currentProjectId].name === 'Test Project');

  // 9. Export hierarchy function correctness (call internal logic indirectly via re-derived check)
  // We can't access closures directly, but we can verify export button triggers a download attempt without throwing.
  let exportThrew = false;
  try {
    doc.getElementById('exportBtn').click();
  } catch(e) {
    exportThrew = true;
    console.log(e);
  }
  log('export button does not throw', !exportThrew);

  console.log('\\nSmoke test complete.');
  process.exit(0);
})().catch(e => {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(1);
});
