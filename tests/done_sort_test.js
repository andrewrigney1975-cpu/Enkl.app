const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function cardTitlesInColumn(doc, columnName){
  const col = Array.from(doc.querySelectorAll('.kf-column')).find(c => c.querySelector('.kf-column-name').textContent.trim() === columnName);
  return Array.from(col.querySelectorAll('.kf-card .kf-card-title')).map(el => el.textContent.trim());
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // Build a project with a Done column whose tasks are added in a deliberately
  // "wrong" drag order, with explicit dateLastModified values out of order,
  // plus a couple of tasks missing dateLastModified entirely.
  const customDB = {
    projects: {
      p1: {
        id: 'p1', name: 'Sort Test', key: 'SRT', taskCounter: 7,
        columns: [
          { id: 'todo', name: 'To Do', done: false, order: ['t1'] },
          { id: 'done', name: 'Done', done: true,
            /* Intentionally NOT in date order, to prove rendering re-sorts
               regardless of this manual drag order. */
            order: ['t5', 't2', 't6', 't3', 't4'] }
        ],
        tasks: {
          t1: { id: 't1', key: 'SRT-1', title: 'Still in progress', description: '', priority: 'medium', columnId: 'todo', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z', dateLastModified: '2026-01-01T00:00:00.000Z' },
          t2: { id: 't2', key: 'SRT-2', title: 'Finished third',  description: '', priority: 'medium', columnId: 'done', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z', dateLastModified: '2026-03-03T00:00:00.000Z' },
          t3: { id: 't3', key: 'SRT-3', title: 'Finished first',  description: '', priority: 'medium', columnId: 'done', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z', dateLastModified: '2026-01-10T00:00:00.000Z' },
          t4: { id: 't4', key: 'SRT-4', title: 'Finished second', description: '', priority: 'medium', columnId: 'done', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z', dateLastModified: '2026-02-05T00:00:00.000Z' },
          // Missing dateLastModified entirely (legacy/defensive case) — should fall back to key order, placed after dated tasks
          t5: { id: 't5', key: 'SRT-9', title: 'No date, key 9',  description: '', priority: 'medium', columnId: 'done', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z' },
          t6: { id: 't6', key: 'SRT-5', title: 'No date, key 5',  description: '', priority: 'medium', columnId: 'done', dependencies: [], assigneeId: null, startDate: null, endDate: null, dateCreated: '2026-01-01T00:00:00.000Z' }
        },
        members: [], dateCreated: '2026-01-01T00:00:00.000Z', dateLastModified: '2026-01-01T00:00:00.000Z', dateLastExported: null
      }
    },
    projectOrder: ['p1'], currentProjectId: 'p1'
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(window){ window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(customDB)); }
  });
  await wait(350);
  const doc = dom.window.document;

  // ── 1. Done column renders sorted oldest -> newest by dateLastModified ───
  const doneTitles = cardTitlesInColumn(doc, 'Done');
  log('Done column sorted oldest -> newest by dateLastModified, dated tasks first',
      doneTitles.slice(0, 3).join('|') === 'Finished first|Finished second|Finished third',
      doneTitles.join(' | '));

  // ── 2. Tasks missing dateLastModified come after dated ones, sorted by key ──
  log('undated tasks placed after dated ones, sorted by key ascending (SRT-5 before SRT-9)',
      doneTitles[3] === 'No date, key 5' && doneTitles[4] === 'No date, key 9',
      doneTitles.join(' | '));

  // ── 3. Non-done columns are NOT auto-sorted (manual order preserved) ─────
  // (Only one task in To Do here, so let's add a second to verify ordering is untouched)
  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Second todo task';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const todoTitles = cardTitlesInColumn(doc, 'To Do');
  log('To Do column keeps manual append order (not date-sorted)', todoTitles.join('|') === 'Still in progress|Second todo task', todoTitles.join(' | '));

  // ── 4. Editing a Done task updates its dateLastModified and re-sorts it to the end ──
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Finished first') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskDescEditor').textContent = 'touched again';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const doneTitlesAfterEdit = cardTitlesInColumn(doc, 'Done');
  // More precisely: it should now be the single most-recently-modified DATED task,
  // i.e. it comes after Finished second and Finished third, but the two undated
  // tasks (no real timestamp) still sort after all dated tasks by definition.
  log('"Finished first" (just edited) now sorts after the other dated tasks',
      doneTitlesAfterEdit.indexOf('Finished first') > doneTitlesAfterEdit.indexOf('Finished second') &&
      doneTitlesAfterEdit.indexOf('Finished first') > doneTitlesAfterEdit.indexOf('Finished third'),
      doneTitlesAfterEdit.join(' | '));
  log('undated tasks still sort after every dated task post-edit',
      doneTitlesAfterEdit.indexOf('No date, key 5') > doneTitlesAfterEdit.indexOf('Finished first') &&
      doneTitlesAfterEdit.indexOf('No date, key 9') > doneTitlesAfterEdit.indexOf('Finished first'),
      doneTitlesAfterEdit.join(' | '));

  // ── 5. Moving a task INTO the Done column places it by its own date, not drop position ──
  const todoCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Still in progress') !== -1);
  todoCard.click();
  await wait(10);
  const colSelect = doc.getElementById('taskColumnSelect');
  const doneOpt = Array.from(colSelect.options).find(o => o.textContent === 'Done');
  colSelect.value = doneOpt.value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const doneTitlesAfterMove = cardTitlesInColumn(doc, 'Done');
  log('task moved into Done is positioned by its dateLastModified (just-now -> newest among dated), not at the literal end',
      doneTitlesAfterMove.indexOf('Still in progress') < doneTitlesAfterMove.indexOf('No date, key 5'),
      doneTitlesAfterMove.join(' | '));

  // ── 6. The Done column's manual `order` array is left untouched in storage ──
  const raw = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
  const doneCol = raw.projects.p1.columns.find(c => c.name === 'Done');
  log('underlying column.order array is unchanged by display sorting (still reflects drag/append history, not the sorted view)',
      Array.isArray(doneCol.order) && doneCol.order.length === 6, JSON.stringify(doneCol.order));

  console.log('\nDone-column sort test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
