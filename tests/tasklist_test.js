const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Opening the List View ───────────────────────────────────────────────
  log('List View modal starts hidden', doc.getElementById('taskListOverlay').classList.contains('hidden'));
  doc.getElementById('taskListBtn').click();
  await wait(20);
  log('List View modal opens', !doc.getElementById('taskListOverlay').classList.contains('hidden'));
  log('modal title includes the project name', doc.getElementById('taskListTitle').textContent.indexOf('Sample Project') !== -1, doc.getElementById('taskListTitle').textContent);

  const rows = doc.querySelectorAll('.kf-tasklist-row');
  log('lists all 5 seeded tasks', rows.length === 5, rows.length);
  log('count summary shows "5 tasks"', doc.getElementById('taskListCount').textContent === '5 tasks', doc.getElementById('taskListCount').textContent);

  // ── 2. Required columns are present in a row ───────────────────────────────
  const firstRow = rows[0];
  log('row shows key', firstRow.querySelector('.kf-tasklist-key') !== null);
  log('row shows title', firstRow.querySelector('.kf-tasklist-title') !== null);
  log('row shows an expand/collapse chevron', firstRow.querySelector('.kf-tasklist-chevron') !== null);
  log('row shows assignee', firstRow.querySelector('.kf-tasklist-assignee') !== null);
  log('row shows priority pill', firstRow.querySelector('.kf-priority-pill') !== null);
  log('row shows start + end date cells', firstRow.querySelectorAll('.kf-tasklist-date').length === 2);
  log('row shows the Value Proposition pill', firstRow.querySelector('.kf-valueprop-pill') !== null);

  // ── 3. Value Proposition calculation is correct (businessValue / taskCost) ──
  // SMPL-2 "Configure project modules, columns and details": bv=800, cost=150 -> 5.33
  const designRow = Array.from(rows).find(r => r.textContent.indexOf('Configure project modules, columns and details') !== -1);
  const designPill = designRow.querySelector('.kf-valueprop-pill');
  log('Value Proposition computed correctly (800/150 = 5.33)', designPill.textContent.trim() === '5.33', designPill.textContent);
  log('Value Proposition tooltip shows the raw inputs', designPill.title.indexOf('800') !== -1 && designPill.title.indexOf('150') !== -1, designPill.title);
  log('Value > 1 is color-coded "good"', designPill.classList.contains('good'), designPill.className);

  // ── 4. Expand/collapse toggles the detail panel ─────────────────────────────
  const chevron = designRow.querySelector('.kf-tasklist-chevron');
  log('chevron starts collapsed', !chevron.classList.contains('expanded'));
  let detail = designRow.nextElementSibling;
  log('no detail panel shown before expanding', !detail || !detail.classList.contains('kf-tasklist-detail'));

  chevron.click();
  await wait(10);
  const designRowAfter = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Configure project modules, columns and details') !== -1);
  const chevronAfter = designRowAfter.querySelector('.kf-tasklist-chevron');
  log('chevron shows expanded state after click', chevronAfter.classList.contains('expanded'));
  detail = designRowAfter.nextElementSibling;
  log('detail panel appears immediately after the row', detail && detail.classList.contains('kf-tasklist-detail'));
  log('detail panel shows the description', detail.textContent.indexOf('Define how projects') !== -1, detail.textContent.slice(0,60));
  log('detail panel shows Business Value and Task Cost', detail.textContent.indexOf('800') !== -1 && detail.textContent.indexOf('150') !== -1);
  log('detail panel shows the Column', detail.textContent.indexOf('To Do') !== -1, detail.textContent);
  log('detail panel shows Depends on (SMPL-1)', detail.textContent.indexOf('SMPL-1') !== -1, detail.textContent);
  log('detail panel has an Edit task button', detail.querySelector('.kf-tasklist-edit-btn') !== null);

  // Collapse again
  chevronAfter.click();
  await wait(10);
  const designRowCollapsed = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Configure project modules, columns and details') !== -1);
  log('chevron collapses back', !designRowCollapsed.querySelector('.kf-tasklist-chevron').classList.contains('expanded'));
  log('detail panel removed after collapsing', !designRowCollapsed.nextElementSibling || !designRowCollapsed.nextElementSibling.classList.contains('kf-tasklist-detail'));

  // ── 5. "Edit task" button opens the task modal and closes the list ─────────
  const chevron2 = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Configure project modules, columns and details') !== -1).querySelector('.kf-tasklist-chevron');
  chevron2.click();
  await wait(10);
  const editBtn = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Configure project modules, columns and details') !== -1).nextElementSibling.querySelector('.kf-tasklist-edit-btn');
  editBtn.click();
  await wait(20);
  log('clicking Edit task closes the List View', doc.getElementById('taskListOverlay').classList.contains('hidden'));
  log('clicking Edit task opens the Task modal for the right task', doc.getElementById('taskTitleInput').value === 'Configure project modules, columns and details', doc.getElementById('taskTitleInput').value);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 6. Sorting by header click ──────────────────────────────────────────────
  doc.getElementById('taskListBtn').click();
  await wait(20);
  const vpHeader = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Value Prop') !== -1);
  vpHeader.click();
  await wait(10);
  let pills = Array.from(doc.querySelectorAll('.kf-valueprop-pill')).map(p => parseFloat(p.textContent));
  const ascending = pills.every((v, i) => i === 0 || pills[i-1] <= v);
  log('clicking Value Proposition header sorts ascending', ascending, pills.join(','));
  const vpHeaderAfter = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Value Prop') !== -1);
  log('sorted header cell gets the "sorted" highlight class', vpHeaderAfter.classList.contains('sorted'), vpHeaderAfter.className);

  vpHeaderAfter.click();
  await wait(10);
  pills = Array.from(doc.querySelectorAll('.kf-valueprop-pill')).map(p => parseFloat(p.textContent));
  const descending = pills.every((v, i) => i === 0 || pills[i-1] >= v);
  log('clicking the same header again reverses to descending', descending, pills.join(','));

  const keyHeader = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Key') !== -1);
  keyHeader.click();
  await wait(10);
  const keys = Array.from(doc.querySelectorAll('.kf-tasklist-key')).map(k => k.textContent);
  log('sorting by Key gives SMPL-1..SMPL-5 in order', keys.join(',') === 'SMPL-1,SMPL-2,SMPL-3,SMPL-4,SMPL-5', keys.join(','));

  // ── 7. Search filters rows ──────────────────────────────────────────────────
  doc.getElementById('taskListSearchInput').value = 'project board';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  const filteredRows = doc.querySelectorAll('.kf-tasklist-row');
  log('search filters down to matching tasks', filteredRows.length === 1, filteredRows.length);
  log('count summary updates with the filtered count', doc.getElementById('taskListCount').textContent === '1 task', doc.getElementById('taskListCount').textContent);

  doc.getElementById('taskListSearchInput').value = 'zzz-no-match';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('no matches shows an empty state', doc.querySelector('.kf-tasklist-empty') !== null);

  doc.getElementById('taskListSearchInput').value = '';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('clearing search restores all rows', doc.querySelectorAll('.kf-tasklist-row').length === 5);

  // ── 8. Close behaviors: × button, outside click, Escape ────────────────────
  doc.getElementById('taskListClose').click();
  await wait(10);
  log('× button closes the modal', doc.getElementById('taskListOverlay').classList.contains('hidden'));

  doc.getElementById('taskListBtn').click();
  await wait(10);
  doc.getElementById('taskListOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await wait(10);
  log('clicking the backdrop closes the modal', doc.getElementById('taskListOverlay').classList.contains('hidden'));

  doc.getElementById('taskListBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the modal', doc.getElementById('taskListOverlay').classList.contains('hidden'));

  // ── 9. Value Proposition color thresholds: good / neutral / bad ────────────
  doc.getElementById('taskListBtn').click();
  await wait(10);
  doc.getElementById('taskListClose').click();
  await wait(10);

  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Bad ratio task';
  doc.getElementById('taskBusinessValueInput').value = '50';
  doc.getElementById('taskCostInput').value = '200';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const addBtn2 = doc.querySelector('.kf-add-task-btn');
  addBtn2.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Neutral ratio task';
  doc.getElementById('taskBusinessValueInput').value = '100';
  doc.getElementById('taskCostInput').value = '100';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('taskListBtn').click();
  await wait(20);
  const badRow = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Bad ratio task') !== -1);
  const badPill = badRow.querySelector('.kf-valueprop-pill');
  log('value < 1 is color-coded "bad"', badPill.classList.contains('bad'), badPill.className + ' / ' + badPill.textContent);
  log('bad ratio computed correctly (50/200 = 0.25)', badPill.textContent.trim() === '0.25', badPill.textContent);

  const neutralRow = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Neutral ratio task') !== -1);
  const neutralPill = neutralRow.querySelector('.kf-valueprop-pill');
  log('value == 1 is color-coded "neutral"', neutralPill.classList.contains('neutral'), neutralPill.className + ' / ' + neutralPill.textContent);
  log('neutral ratio computed correctly (100/100 = 1.00)', neutralPill.textContent.trim() === '1.00', neutralPill.textContent);

  console.log('\nTask List view test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
