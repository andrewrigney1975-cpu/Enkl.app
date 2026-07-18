const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// "Archive Done Tasks" (Archived Tasks modal footer, features/archived-tasks.js's
// archiveDoneTasksFromModal) — archives every active task sitting in a Column.done column, then
// reloads the board and reopens the Archived Tasks modal so both reflect the change immediately.
(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(800);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  // Seeded project has exactly one active task in the "Done" column: "Create project board".
  log('board starts with 5 cards', doc.querySelectorAll('.kf-card').length === 5, doc.querySelectorAll('.kf-card').length);

  doc.getElementById('archivedTasksBtn').click();
  await wait(20);
  log('Archived Tasks modal opens', !doc.getElementById('archivedTasksOverlay').classList.contains('hidden'));
  log('"Archive Done Tasks" button exists in the modal footer', doc.getElementById('archiveDoneTasksBtn') !== null);
  log('nothing archived yet', doc.querySelectorAll('.kf-archived-row').length === 0);

  doc.getElementById('archiveDoneTasksBtn').click();
  await wait(30);

  // ── Board reloaded ────────────────────────────────────────────────────────────────────
  log('the Done-column task no longer appears on the board', !Array.from(doc.querySelectorAll('.kf-card')).some(c => c.textContent.indexOf('Create project board') !== -1));
  log('board card count dropped to 4', doc.querySelectorAll('.kf-card').length === 4, doc.querySelectorAll('.kf-card').length);

  // ── Archived Tasks modal reloaded/reopened, now lists the newly-archived task ────────────
  log('Archived Tasks modal is (still/again) open', !doc.getElementById('archivedTasksOverlay').classList.contains('hidden'));
  const rows = doc.querySelectorAll('.kf-archived-row');
  log('modal now lists exactly 1 archived task', rows.length === 1, rows.length);
  log('the archived row is the Done-column task', rows[0].textContent.indexOf('Create project board') !== -1);

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const archivedId = Object.keys(proj.tasks).find(id => proj.tasks[id].title === 'Create project board');
  log('archived flag persisted to localStorage', proj.tasks[archivedId].archived === true);

  // Tasks in non-Done columns are untouched.
  log('tasks in non-Done columns were not archived', Object.values(proj.tasks).filter(t => t.id !== archivedId).every(t => t.archived === false));

  // ── Clicking again with nothing left to archive is a no-op (toast, no crash) ─────────────
  doc.getElementById('archiveDoneTasksBtn').click();
  await wait(20);
  log('clicking again with no active Done-column tasks left does not change the archived list', doc.querySelectorAll('.kf-archived-row').length === 1);

  doc.getElementById('archivedTasksDoneBtn').click();
  await wait(10);

  console.log('\nArchive Done Tasks test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
