const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function rowFor(doc, title){
  return Array.from(doc.querySelectorAll('.kf-bulkedit-row')).find(r => r.textContent.indexOf(title) !== -1);
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Create project board') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  // ── 1. Opening the editor ──────────────────────────────────────────────────
  log('modal starts hidden', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));
  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  log('modal opens', !doc.getElementById('bulkEditOverlay').classList.contains('hidden'));
  log('title includes the project name', doc.getElementById('bulkEditTitle').textContent.indexOf('Sample Project') !== -1, doc.getElementById('bulkEditTitle').textContent);

  // ── 2. Shows BOTH active and archived tasks ───────────────────────────────
  const rows = doc.querySelectorAll('.kf-bulkedit-row');
  log('shows all 5 seeded tasks, including the archived one', rows.length === 5, rows.length);
  const archivedRow = rowFor(doc, 'Create project board');
  log('archived task is present in the grid', !!archivedRow);
  log('archived row is visually marked (status badge + dimmed)', archivedRow.classList.contains('kf-bulkedit-archived-row') && archivedRow.textContent.indexOf('Archived') !== -1);
  const activeRow = rowFor(doc, 'Configure project modules, columns and details');
  log('active task shows "Active" status', activeRow.textContent.indexOf('Active') !== -1);
  log('count summary mentions archived inclusion', doc.getElementById('bulkEditCount').textContent.indexOf('archived') !== -1, doc.getElementById('bulkEditCount').textContent);

  // ── 3. Each row exposes all editable fields (Progress included, since Time
  //      Tracking is enabled by default) ────────────────────────────────────
  const selects = activeRow.querySelectorAll('select');
  const inputs = activeRow.querySelectorAll('input');
  log('row has 5 selects (Column, Release, Priority, Type, Assignee)', selects.length === 5, selects.length);
  log('row has 5 inputs (Start, End, Business Value, Task Cost, Progress)', inputs.length === 5, inputs.length);

  // ── 4. Save button starts disabled; editing a cell enables it ────────────
  log('Save button starts disabled (no pending edits)', doc.getElementById('bulkEditSaveBtn').disabled);
  log('pending-count text starts empty', doc.getElementById('bulkEditPendingCount').textContent === '');

  const prioritySelect = activeRow.querySelectorAll('select')[2];
  const originalPriority = prioritySelect.value;
  const otherPriorityOpt = Array.from(prioritySelect.options).find(o => o.value !== originalPriority);
  prioritySelect.value = otherPriorityOpt.value;
  prioritySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('editing a cell enables the Save button', !doc.getElementById('bulkEditSaveBtn').disabled);
  log('pending-count reflects 1 task changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('1 task') !== -1, doc.getElementById('bulkEditPendingCount').textContent);
  log('the edited select gets the dirty highlight class', prioritySelect.classList.contains('kf-bulkedit-dirty'));

  // ── 5. Reverting the value back to original clears the dirty state ───────
  prioritySelect.value = originalPriority;
  prioritySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('reverting to the original value clears dirty state', !prioritySelect.classList.contains('kf-bulkedit-dirty'));
  log('Save button disables again once no real changes remain', doc.getElementById('bulkEditSaveBtn').disabled);

  // ── 6. Make several real edits across multiple tasks/fields ──────────────
  const taskARow = rowFor(doc, 'Configure project modules, columns and details');
  const taskAPriority = taskARow.querySelectorAll('select')[2];
  const taskANewPriority = Array.from(taskAPriority.options).find(o => o.value !== taskAPriority.value);
  taskAPriority.value = taskANewPriority.value;
  taskAPriority.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  const taskABV = taskARow.querySelectorAll('input')[2];
  taskABV.value = '999';
  taskABV.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  const taskBRow = rowFor(doc, 'Draft project objectives');
  const taskBColumn = taskBRow.querySelectorAll('select')[0];
  const taskBNewColumn = Array.from(taskBColumn.options).find(o => o.value !== taskBColumn.value);
  taskBColumn.value = taskBNewColumn.value;
  taskBColumn.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  log('pending-count now reflects 2 tasks changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('2 task') !== -1, doc.getElementById('bulkEditPendingCount').textContent);

  // ── 7. Date validation blocks save when end < start for any staged row ───
  const taskCRow = rowFor(doc, 'Look at Project and App Settings');
  const taskCStart = taskCRow.querySelectorAll('input')[0];
  const taskCEnd = taskCRow.querySelectorAll('input')[1];
  taskCStart.value = '2026-06-01';
  taskCStart.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  taskCEnd.value = '2026-01-01';
  taskCEnd.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);
  log('save is blocked when any staged row has end before start', !doc.getElementById('bulkEditOverlay').classList.contains('hidden'));
  const toasts1 = doc.querySelectorAll('.kf-toast');
  log('toast names the offending task by key', toasts1[toasts1.length-1].textContent.indexOf('SMPL-1') !== -1, toasts1[toasts1.length-1].textContent);

  taskCEnd.value = '2026-12-01';
  taskCEnd.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  // ── 8. Saving applies all changes atomically and closes the modal ────────
  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);
  log('modal closes after a successful save', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const savedTaskA = Object.values(proj.tasks).find(t => t.title === 'Configure project modules, columns and details');
  log('Task A priority change persisted', savedTaskA.priority === taskANewPriority.value, savedTaskA.priority);
  log('Task A business value change persisted', savedTaskA.businessValue === 999, savedTaskA.businessValue);
  const savedTaskB = Object.values(proj.tasks).find(t => t.title === 'Draft project objectives');
  log('Task B column change persisted', savedTaskB.columnId === taskBNewColumn.value, savedTaskB.columnId);
  const savedTaskC = Object.values(proj.tasks).find(t => t.title === 'Look at Project and App Settings');
  log('Task C (fixed) date changes persisted', !!savedTaskC.startDate && !!savedTaskC.endDate, JSON.stringify({s:savedTaskC.startDate,e:savedTaskC.endDate}));

  // ── 9. Successful save with real changes prompts a backup ────────────────
  log('backup-confirm dialog appears after a successful bulk save', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  log('backup prompt mentions tasks changed', doc.getElementById('confirmMessage').textContent.indexOf('task') !== -1, doc.getElementById('confirmMessage').textContent);
  doc.getElementById('confirmCancelBtn').click();
  await wait(10);
  log('declining the backup prompt does not undo the changes', JSON.parse(window.localStorage.getItem('kanbanflow_v1_db')).projects[raw.currentProjectId].tasks[savedTaskA.id].businessValue === 999);

  // ── 10. Saving with zero edits shows a friendly toast instead of erroring ──
  // (The Save button is disabled whenever there are no edits — already covered
  // above — so this exercises the function's own internal guard directly,
  // bypassing the disabled attribute, which jsdom/browsers correctly refuse
  // to dispatch a click through.)
  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  const saveBtn = doc.getElementById('bulkEditSaveBtn');
  log('Save button is disabled with zero pending edits (the real UI guard)', saveBtn.disabled);
  saveBtn.disabled = false;
  saveBtn.click();
  await wait(10);
  const toasts2 = doc.querySelectorAll('.kf-toast');
  log('saving with no edits shows "No changes to save"', toasts2[toasts2.length-1].textContent.indexOf('No changes') !== -1, toasts2[toasts2.length-1].textContent);
  log('modal stays open when there is nothing to save', !doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  // ── 11. Cancel discards staged edits without applying them ────────────────
  const taskDRow = rowFor(doc, 'Set up Team members for this project');
  const taskDCost = taskDRow.querySelectorAll('input')[3];
  const originalCost = taskDCost.value;
  taskDCost.value = '1';
  taskDCost.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('edit registers before cancel', !doc.getElementById('bulkEditSaveBtn').disabled);
  doc.getElementById('bulkEditCancelBtn').click();
  await wait(10);
  log('Cancel closes the modal', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));
  const rawAfterCancel = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const taskDPersisted = Object.values(rawAfterCancel.projects[rawAfterCancel.currentProjectId].tasks).find(t => t.title === 'Set up Team members for this project');
  log('Cancel does NOT persist the discarded edit', String(taskDPersisted.taskCost) === originalCost, taskDPersisted.taskCost + ' vs original ' + originalCost);

  // ── 12. Re-opening starts with a clean slate (no leftover staged edits) ──
  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  log('re-opening has no pending changes left over from before', doc.getElementById('bulkEditSaveBtn').disabled);
  doc.getElementById('bulkEditClose').click();
  await wait(10);

  // ── 13. Close behaviors: outside click and Escape ─────────────────────────
  doc.getElementById('bulkEditBtn').click();
  await wait(10);
  doc.getElementById('bulkEditOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await wait(10);
  log('clicking the backdrop closes the modal', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  doc.getElementById('bulkEditBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the modal', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  console.log('\nBulk Edit test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
