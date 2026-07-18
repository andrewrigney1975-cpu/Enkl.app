const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
  };
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  let lastBlobText = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  installFakeFileReader(window);
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Seeded tasks are all unarchived by default ────────────────────────
  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  log('seeded tasks all have archived:false', Object.values(proj.tasks).every(t => t.archived === false));

  // ── 2. Archived button starts with no count badge (nothing archived yet) ──
  log('archived count badge hidden when nothing is archived', doc.getElementById('archivedCountBadge').classList.contains('kf-vis-hidden'));

  // ── 3. Task modal has an Archived checkbox, unchecked by default ─────────
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  card.click();
  await wait(10);
  log('task modal has an Archived checkbox', doc.getElementById('taskArchivedCheckbox') !== null);
  log('Archived checkbox starts unchecked for a non-archived task', doc.getElementById('taskArchivedCheckbox').checked === false);

  // ── 4. Checking Archived and saving hides the task everywhere ────────────
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const cardsAfter = Array.from(doc.querySelectorAll('.kf-card'));
  log('archived task no longer appears on the board', !cardsAfter.some(c => c.textContent.indexOf('Look at Project and App Settings') !== -1), cardsAfter.length);
  log('board card count dropped to 4', cardsAfter.length === 4, cardsAfter.length);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const archivedTaskId = Object.keys(proj.tasks).find(id => proj.tasks[id].title === 'Look at Project and App Settings');
  log('archived flag persisted to localStorage', proj.tasks[archivedTaskId].archived === true);

  const backlogCol = Array.from(doc.querySelectorAll('.kf-column')).find(c => c.querySelector('.kf-column-name').textContent.trim() === 'Backlog');
  log('column count badge excludes the archived task (0, not 1)', backlogCol.querySelector('.kf-count-badge').textContent === '0', backlogCol.querySelector('.kf-count-badge').textContent);

  // ── 5. Archived task excluded from the List View ─────────────────────────
  doc.getElementById('taskListBtn').click();
  await wait(20);
  const listRows = doc.querySelectorAll('.kf-tasklist-row');
  log('List View shows only 4 tasks (archived one excluded)', listRows.length === 4, listRows.length);
  log('archived task title does not appear in the list', !Array.from(listRows).some(r => r.textContent.indexOf('Look at Project and App Settings') !== -1));
  doc.getElementById('taskListClose').click();
  await wait(10);

  // ── 6. Archived task excluded from the dependency graph ──────────────────
  doc.getElementById('depMapBtn').click();
  await wait(20);
  const nodes = doc.querySelectorAll('.kf-depnode');
  log('dependency graph shows only 4 nodes (archived one excluded)', nodes.length === 4, nodes.length);
  const nodeTitles = doc.querySelector('#depMapInner svg').innerHTML;
  log('archived task does not appear as a node', nodeTitles.indexOf('Look at Project and App Settings') === -1);
  doc.getElementById('depMapClose').click();
  await wait(10);

  // ── 7. Archived task excluded from the "Depends on" picker for OTHER tasks ──
  const otherCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Configure project modules, columns and details') !== -1);
  otherCard.click();
  await wait(10);
  const depRows = doc.querySelectorAll('#depList .kf-dep-row');
  log('archived task is not offered as a new dependency candidate', !Array.from(depRows).some(r => r.textContent.indexOf('Look at Project and App Settings') !== -1), depRows.length);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 8. Archived count badge updates ───────────────────────────────────────
  log('archived count badge now shows 1', !doc.getElementById('archivedCountBadge').classList.contains('kf-vis-hidden') && doc.getElementById('archivedCountBadge').textContent === '1', doc.getElementById('archivedCountBadge').textContent);

  // ── 9. Archived Tasks modal lists it and can reactivate it ────────────────
  doc.getElementById('archivedTasksBtn').click();
  await wait(20);
  log('Archived Tasks modal opens', !doc.getElementById('archivedTasksOverlay').classList.contains('hidden'));
  const archRows = doc.querySelectorAll('.kf-archived-row');
  log('Archived Tasks modal lists exactly the 1 archived task', archRows.length === 1, archRows.length);
  log('reactivate button starts disabled (nothing selected)', doc.getElementById('reactivateSelectedBtn').disabled);

  const archCheckbox = archRows[0].querySelector('input[type=checkbox]');
  archCheckbox.checked = true;
  archCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('selecting a row enables the reactivate button', !doc.getElementById('reactivateSelectedBtn').disabled);
  log('selected count summary updates', doc.getElementById('archivedSelectedCount').textContent.indexOf('1 of 1') !== -1, doc.getElementById('archivedSelectedCount').textContent);

  doc.getElementById('reactivateSelectedBtn').click();
  await wait(20);
  log('list becomes empty after reactivating the only archived task', doc.querySelector('.kf-member-empty') !== null || doc.querySelectorAll('.kf-archived-row').length === 0);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('reactivated task is archived:false again', proj.tasks[archivedTaskId].archived === false);

  doc.getElementById('archivedTasksDoneBtn').click();
  await wait(10);
  const cardsRestored = doc.querySelectorAll('.kf-card');
  log('task reappears on the board after reactivation', cardsRestored.length === 5, cardsRestored.length);
  log('archived count badge hides again once nothing is archived', doc.getElementById('archivedCountBadge').classList.contains('kf-vis-hidden'));

  // ── 10. Select-all checkbox works for multiple archived tasks ────────────
  const card2 = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  card2.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const card3 = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Draft project objectives') !== -1);
  card3.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('archivedTasksBtn').click();
  await wait(20);
  log('two archived tasks listed', doc.querySelectorAll('.kf-archived-row').length === 2, doc.querySelectorAll('.kf-archived-row').length);
  doc.getElementById('archivedSelectAllCheckbox').click();
  await wait(10);
  const checkedBoxes = Array.from(doc.querySelectorAll('.kf-archived-row input[type=checkbox]')).filter(c => c.checked);
  log('select-all checks every row', checkedBoxes.length === 2, checkedBoxes.length);
  doc.getElementById('reactivateSelectedBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('both tasks reactivated via select-all', Object.values(proj.tasks).every(t => t.archived === false));
  doc.getElementById('archivedTasksDoneBtn').click();
  await wait(10);

  // ── 11. Export and import preserve the archived flag ─────────────────────
  const card4 = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Draft project objectives') !== -1);
  card4.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  function findNode(nodes, title){
    for (const n of nodes) {
      if (n.title === title) return n;
      const f = findNode(n.subtasks || [], title);
      if (f) return f;
    }
    return null;
  }
  const exportedNode = findNode(exported.hierarchy, 'Draft project objectives');
  log('exported node includes archived:true', exportedNode.archived === true, JSON.stringify(exportedNode.archived));
  const otherNode = findNode(exported.hierarchy, 'Configure project modules, columns and details');
  log('exported node for a non-archived task includes archived:false', otherNode.archived === false);

  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  const importedCardsVisible = doc.querySelectorAll('.kf-card');
  log('imported board hides the archived task on the board', !Array.from(importedCardsVisible).some(c => c.textContent.indexOf('Draft project objectives') !== -1));
  doc.getElementById('archivedTasksBtn').click();
  await wait(20);
  log('imported project shows the archived task in the reactivation modal', doc.querySelectorAll('.kf-archived-row').length === 1, doc.querySelectorAll('.kf-archived-row').length);
  log('imported archived row is the expected task', doc.querySelector('.kf-archived-row').textContent.indexOf('Draft project objectives') !== -1);
  doc.getElementById('archivedTasksClose').click();
  await wait(10);

  // ── 12. Migration backfills archived:false for legacy tasks ───────────────
  const legacyDB = {
    projects: {
      legacy_p1: {
        id: 'legacy_p1', name: 'Legacy Project', key: 'LEG', taskCounter: 2,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: ['t1'] }],
        tasks: {
          t1: {
            id: 't1', key: 'LEG-1', title: 'Old task, no archived field',
            description: '', priority: 'medium', columnId: 'col1', dependencies: [],
            assigneeId: null, startDate: null, endDate: null, businessValue: 1, taskCost: 1,
            dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
            // deliberately no archived key
          }
        },
        members: [], startDate: null, endDate: null,
        dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null
      }
    },
    projectOrder: ['legacy_p1'], currentProjectId: 'legacy_p1'
  };
  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(legacyDB)); }
  });
  await wait(350);
  const raw2 = JSON.parse(dom2.window.localStorage.getItem('kanbanflow_v1_db'));
  log('migration backfills archived:false for legacy tasks', raw2.projects.legacy_p1.tasks.t1.archived === false, raw2.projects.legacy_p1.tasks.t1.archived);
  const legacyCard = dom2.window.document.querySelector('.kf-card');
  log('legacy task (migrated) still shows on the board', legacyCard !== null && legacyCard.textContent.indexOf('Old task') !== -1);

  console.log('\nArchived task test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
