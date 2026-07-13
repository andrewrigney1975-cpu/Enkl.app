const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function setTaskType(doc, taskTitle, typeName){
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(taskTitle) !== -1);
  card.click();
  const opt = Array.from(doc.getElementById('taskTypeSelect').options).find(o => o.textContent === typeName);
  doc.getElementById('taskTypeSelect').value = opt ? opt.value : '';
  doc.getElementById('taskSaveBtn').click();
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  const toolbarChildren = Array.from(doc.querySelector('.kf-toolbar').children);
  const assigneeIdx = toolbarChildren.indexOf(doc.getElementById('assigneeFilterWrap'));
  const typeIdx = toolbarChildren.indexOf(doc.getElementById('taskTypeFilterWrap'));
  log('Task Type filter sits immediately after the Assignee filter', typeIdx === assigneeIdx + 1, `assignee=${assigneeIdx} type=${typeIdx}`);

  setTaskType(doc, 'Look at Project and App Settings', 'Feature');
  await wait(20);
  setTaskType(doc, 'Configure project modules, columns and details', 'Feature');
  await wait(20);
  setTaskType(doc, 'Draft project objectives', 'Bug');
  await wait(20);

  const wrap = doc.getElementById('taskTypeFilterWrap');
  log('dropdown filter is visible when the project has task types', !wrap.classList.contains('kf-vis-hidden'));

  log('panel starts closed', doc.getElementById('taskTypeFilterPanel').classList.contains('hidden'));
  doc.getElementById('taskTypeFilterBtn').click();
  await wait(10);
  log('panel opens on button click', !doc.getElementById('taskTypeFilterPanel').classList.contains('hidden'));
  doc.getElementById('taskTypeFilterBtn').click();
  await wait(10);
  log('panel closes on a second button click (toggle)', doc.getElementById('taskTypeFilterPanel').classList.contains('hidden'));

  doc.getElementById('taskTypeFilterBtn').click();
  await wait(10);
  let rows = doc.querySelectorAll('#taskTypeFilterPanel .kf-dropdown-filter-row');
  log('panel lists 2 types + No type (3 rows)', rows.length === 3, rows.length);

  const featureRow = Array.from(rows).find(r => r.textContent.indexOf('Feature') !== -1);
  featureRow.querySelector('input').checked = true;
  featureRow.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  let visibleCards = doc.querySelectorAll('.kf-board .kf-card');
  log('selecting Feature shows only its 2 tasks', visibleCards.length === 2, visibleCards.length);
  log('dropdown label shows "Feature" for a single selection', doc.getElementById('taskTypeFilterLabel').textContent === 'Feature', doc.getElementById('taskTypeFilterLabel').textContent);
  log('dropdown button gets the active style', doc.getElementById('taskTypeFilterWrap').classList.contains('active'));

  rows = doc.querySelectorAll('#taskTypeFilterPanel .kf-dropdown-filter-row');
  const bugRow = Array.from(rows).find(r => r.textContent.indexOf('Bug') !== -1);
  bugRow.querySelector('input').checked = true;
  bugRow.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  visibleCards = doc.querySelectorAll('.kf-board .kf-card');
  log('selecting both Feature and Bug shows the union of their tasks (3)', visibleCards.length === 3, visibleCards.length);
  log('dropdown label shows "2 types" for multi-select', doc.getElementById('taskTypeFilterLabel').textContent === '2 types', doc.getElementById('taskTypeFilterLabel').textContent);

  rows = doc.querySelectorAll('#taskTypeFilterPanel .kf-dropdown-filter-row');
  const noTypeRow = Array.from(rows).find(r => r.textContent.indexOf('No type') !== -1);
  noTypeRow.querySelector('input').checked = true;
  noTypeRow.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  const visibleAfterNoType = doc.querySelectorAll('.kf-board .kf-card');
  log('adding "No type" to the selection includes typeless tasks too', visibleAfterNoType.length === 5, visibleAfterNoType.length);
  log('dropdown label shows "3 types" with all three checked', doc.getElementById('taskTypeFilterLabel').textContent === '3 types', doc.getElementById('taskTypeFilterLabel').textContent);

  const clearBtn = doc.querySelector('#taskTypeFilterPanel .kf-dropdown-filter-clear');
  log('a "Clear selection" control appears once something is selected', !!clearBtn);
  clearBtn.click();
  await wait(20);
  log('clear selection restores the full board', doc.querySelectorAll('.kf-board .kf-card').length === 5);
  log('label resets to "Type" after clearing', doc.getElementById('taskTypeFilterLabel').textContent === 'Type');
  log('"Clear selection" disappears once nothing is selected', !doc.querySelector('#taskTypeFilterPanel .kf-dropdown-filter-clear'));

  doc.getElementById('taskTypeFilterBtn').click();
  await wait(10);
  log('panel open before Escape', !doc.getElementById('taskTypeFilterPanel').classList.contains('hidden'));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the task type filter panel', doc.getElementById('taskTypeFilterPanel').classList.contains('hidden'));

  doc.getElementById('taskTypeFilterBtn').click();
  await wait(10);
  doc.getElementById('assigneeFilterBtn').click();
  await wait(10);
  log('opening a different dropdown does not crash', doc.querySelectorAll('.kf-dropdown-filter-panel:not(.hidden)').length >= 1);
  doc.getElementById('assigneeFilterBtn').click();
  await wait(10);

  doc.getElementById('newProjectBtn').click();
  await wait(10);
  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  while (doc.querySelectorAll('#taskTypeList [data-action="remove-tasktype"]').length > 0) {
    doc.querySelector('#taskTypeList [data-action="remove-tasktype"]').click();
    await wait(10);
    doc.getElementById('confirmOkBtn').click();
    await wait(10);
  }
  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);
  log('dropdown filter is hidden for a project with zero task types',
      doc.getElementById('taskTypeFilterWrap').classList.contains('kf-vis-hidden'));

  console.log('\nTask Type dropdown filter test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
