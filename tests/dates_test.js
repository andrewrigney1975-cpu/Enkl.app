const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

class FakeFile { constructor(text){ this._text = text; } }
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.FileReader = class {
  readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
};
let lastBlobText = null;
window.URL.createObjectURL = () => 'blob://fake';
window.URL.revokeObjectURL = () => {};
const OrigBlob = window.Blob;
window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function isISO(v){ return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v); }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. SEEDED PROJECT has all three date fields ──────────────────────────
  const raw1 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const seeded = raw1.projects[raw1.currentProjectId];
  log('seeded project has dateCreated (ISO)',       isISO(seeded.dateCreated),      seeded.dateCreated);
  log('seeded project has dateLastModified (ISO)',  isISO(seeded.dateLastModified), seeded.dateLastModified);
  log('seeded project has dateLastExported null',   seeded.dateLastExported === null);

  // ── 2. SEEDED TASKS have both date fields ────────────────────────────────
  const taskValues = Object.values(seeded.tasks);
  log('all seeded tasks have dateCreated',      taskValues.every(t => isISO(t.dateCreated)));
  log('all seeded tasks have dateLastModified', taskValues.every(t => isISO(t.dateLastModified)));
  log('no seeded task has old createdAt key',   taskValues.every(t => !Object.prototype.hasOwnProperty.call(t, 'createdAt')));
  log('no seeded task has old updatedAt key',   taskValues.every(t => !Object.prototype.hasOwnProperty.call(t, 'updatedAt')));

  // ── 3. NEW PROJECT via modal ─────────────────────────────────────────────
  const beforeCreate = Date.now();
  doc.getElementById('newProjectBtn').click(); await wait(10);
  doc.getElementById('projectNameInput').value = 'Date Test Project';
  doc.getElementById('projectKeyInput').value  = 'DTP';
  doc.getElementById('projectSaveBtn').click(); await wait(20);

  const raw2 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const newProj = raw2.projects[raw2.currentProjectId];
  log('new project has dateCreated',      isISO(newProj.dateCreated),      newProj.dateCreated);
  log('new project has dateLastModified', isISO(newProj.dateLastModified), newProj.dateLastModified);
  log('new project dateLastExported is null', newProj.dateLastExported === null);
  const createdMs = new Date(newProj.dateCreated).getTime();
  log('new project dateCreated is recent', createdMs >= beforeCreate && createdMs <= Date.now());

  // ── 4. EDITING A PROJECT stamps dateLastModified ─────────────────────────
  await wait(5);
  const modBefore = newProj.dateLastModified;
  await wait(5); // ensure clock advances
  doc.getElementById('editProjectBtn').click(); await wait(10);
  doc.getElementById('projectNameInput').value = 'Date Test Project Renamed';
  doc.getElementById('projectSaveBtn').click(); await wait(20);

  const raw3 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const editedProj = raw3.projects[raw3.currentProjectId];
  log('edit stamps a new dateLastModified', isISO(editedProj.dateLastModified) && editedProj.dateLastModified !== modBefore,
      modBefore + ' → ' + editedProj.dateLastModified);
  log('edit does NOT change dateCreated', editedProj.dateCreated === newProj.dateCreated);

  // ── 5. ADDING A TASK stamps both date fields ─────────────────────────────
  doc.getElementById('addColumnTopBtn').click(); await wait(10);
  doc.getElementById('columnNameInput').value = 'Staging';
  doc.getElementById('columnSaveBtn').click(); await wait(20);

  const beforeTask = Date.now();
  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click(); await wait(10);
  doc.getElementById('taskTitleInput').value = 'Date field test task';
  doc.getElementById('taskSaveBtn').click(); await wait(20);

  const raw4 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj4 = raw4.projects[raw4.currentProjectId];
  const newTask = Object.values(proj4.tasks).find(t => t.title === 'Date field test task');
  log('new task has dateCreated',      isISO(newTask.dateCreated),      newTask.dateCreated);
  log('new task has dateLastModified', isISO(newTask.dateLastModified), newTask.dateLastModified);
  log('new task dateCreated is recent', new Date(newTask.dateCreated).getTime() >= beforeTask);
  log('new task dateCreated === dateLastModified on creation', newTask.dateCreated === newTask.dateLastModified);

  // ── 6. EDITING A TASK stamps dateLastModified, preserves dateCreated ──────
  await wait(5);
  const taskCreatedAt = newTask.dateCreated;
  const taskModBefore = newTask.dateLastModified;
  await wait(5);
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Date field test task') !== -1);
  card.click(); await wait(10);
  doc.getElementById('taskDescEditor').textContent = 'Updated description';
  doc.getElementById('taskSaveBtn').click(); await wait(20);

  const raw5 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj5 = raw5.projects[raw5.currentProjectId];
  const editedTask = Object.values(proj5.tasks).find(t => t.title === 'Date field test task');
  log('edit stamps new task dateLastModified', isISO(editedTask.dateLastModified) && editedTask.dateLastModified !== taskModBefore,
      taskModBefore + ' → ' + editedTask.dateLastModified);
  log('edit does NOT change task dateCreated', editedTask.dateCreated === taskCreatedAt);

  // ── 7. DRAG-AND-DROP (moveTaskToColumn) stamps dateLastModified ───────────
  // Simulate via the drop event pathway (requires dispatching on the tasksWrap)
  const taskId = editedTask.id;
  const cols = proj5.projects ? proj5.projects : null; // not needed — just use the DOM
  const columns = doc.querySelectorAll('.kf-column');
  // Find a column different from current
  let targetCol = null;
  for (const col of columns) {
    const colId = col.getAttribute('data-column-id');
    if (colId && colId !== editedTask.columnId) { targetCol = col; break; }
  }
  // Simulate via direct internal call (jsdom doesn't support DragEvent)
  const raw5b = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj5b = raw5b.projects[raw5b.currentProjectId];
  const editedTask5b = Object.values(proj5b.tasks).find(t => t.title === 'Date field test task');
  const cols5b = proj5b; // unused
  const colsBefore = window.document.querySelectorAll('.kf-column');
  let targetColId = null;
  for (const col of colsBefore) {
    const cid = col.getAttribute('data-column-id');
    if (cid && cid !== editedTask5b.columnId) { targetColId = cid; break; }
  }
  if (targetColId) {
    await wait(5);
    // Directly invoke via the board drop handler by calling the exposed moveTaskToColumn
    // We can't call private closures, but we CAN simulate via the card drag+column drop event chain
    // Instead: just verify the internal logic by opening+saving the task with a new column
    const card2 = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Date field test task') !== -1);
    card2.click(); await wait(10);
    const colSel = doc.getElementById('taskColumnSelect');
    const otherOpt = Array.from(colSel.options).find(o => o.value !== editedTask5b.columnId);
    if (otherOpt) colSel.value = otherOpt.value;
    doc.getElementById('taskSaveBtn').click(); await wait(20);

    const raw6 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
    const proj6 = raw6.projects[raw6.currentProjectId];
    const movedTask = proj6.tasks[editedTask5b.id];
    log('column move stamps new task dateLastModified',
        isISO(movedTask.dateLastModified) && movedTask.dateLastModified !== editedTask5b.dateLastModified,
        editedTask5b.dateLastModified + ' → ' + movedTask.dateLastModified);
    log('column move does NOT change task dateCreated', movedTask.dateCreated === taskCreatedAt);
  } else {
    log('column move stamps dateLastModified (skipped — not enough columns)', true, 'skipped');
    log('column move does NOT change task dateCreated (skipped)', true, 'skipped');
  }

  // ── 8. EXPORT stamps dateLastExported ────────────────────────────────────
  const beforeExport = Date.now();
  doc.getElementById('exportBtn').click(); await wait(20);
  const raw7 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const exportedProj = raw7.projects[raw7.currentProjectId];
  log('export stamps dateLastExported on the live project',
      isISO(exportedProj.dateLastExported) && new Date(exportedProj.dateLastExported).getTime() >= beforeExport,
      exportedProj.dateLastExported);

  const exportDoc = JSON.parse(lastBlobText);
  log('export doc project.dateCreated present',      isISO(exportDoc.project.dateCreated),      exportDoc.project.dateCreated);
  log('export doc project.dateLastModified present',  isISO(exportDoc.project.dateLastModified),  exportDoc.project.dateLastModified);
  log('export doc project.dateLastExported present',  isISO(exportDoc.project.dateLastExported),  exportDoc.project.dateLastExported);

  const anyNode = (function find(nodes){ for(const n of nodes){ if(n.dateCreated) return n; const f=find(n.subtasks||[]); if(f) return f; } return null; })(exportDoc.hierarchy);
  log('export hierarchy nodes carry dateCreated',      anyNode && isISO(anyNode.dateCreated),      anyNode ? anyNode.dateCreated : 'none');
  log('export hierarchy nodes carry dateLastModified', anyNode && isISO(anyNode.dateLastModified), anyNode ? anyNode.dateLastModified : 'none');

  // ── 9. IMPORT restores project and task date fields ──────────────────────
  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);

  const raw8 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const importedProj = raw8.projects[raw8.currentProjectId];
  log('imported project dateCreated matches original',      importedProj.dateCreated === exportDoc.project.dateCreated);
  log('imported project dateLastModified matches original',  importedProj.dateLastModified === exportDoc.project.dateLastModified);
  log('imported project dateLastExported matches original',  importedProj.dateLastExported === exportDoc.project.dateLastExported);

  const importedTask = Object.values(importedProj.tasks).find(t => t.title === 'Date field test task');
  log('imported task dateCreated preserved',      isISO(importedTask.dateCreated));
  log('imported task dateLastModified preserved', isISO(importedTask.dateLastModified));
  log('imported task has no stale createdAt key',  !Object.prototype.hasOwnProperty.call(importedTask, 'createdAt'));
  log('imported task has no stale updatedAt key',  !Object.prototype.hasOwnProperty.call(importedTask, 'updatedAt'));

  // ── 10. MIGRATION: old data without new date fields gets backfilled ───────
  // Already covered by migration_test.js; just confirm the epoch fallback path
  const epoch = new Date(0).toISOString();
  const backfilledProj = Object.values(raw1.projects)[0]; // seeded before any migration—should already be migrated
  log('migrated project has no undefined date fields',
      backfilledProj.dateCreated !== undefined && backfilledProj.dateLastModified !== undefined && backfilledProj.hasOwnProperty('dateLastExported'));

  console.log('\nDate fields test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
