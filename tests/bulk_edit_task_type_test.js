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

  doc.getElementById('bulkEditBtn').click();
  await wait(20);

  const headerLabels = Array.from(doc.querySelectorAll('.kf-bulkedit-header > div')).map(c => c.textContent.trim());
  const priorityIdx = headerLabels.indexOf('Priority');
  const typeIdx = headerLabels.indexOf('Type');
  const assigneeIdx = headerLabels.indexOf('Assignee');
  log('a "Type" header exists', typeIdx !== -1, headerLabels.join(','));
  log('Type header appears immediately after Priority', typeIdx === priorityIdx + 1, headerLabels.join(','));
  log('Type header appears immediately before Assignee', assigneeIdx === typeIdx + 1, headerLabels.join(','));

  const designRow = rowFor(doc, 'Configure project modules, columns and details');
  const selects = designRow.querySelectorAll('select');
  log('row has 5 selects (Column, Release, Priority, Type, Assignee)', selects.length === 5, selects.length);
  const typeSelect = selects[3];

  const typeOptionLabels = Array.from(typeSelect.options).map(o => o.textContent);
  log('type select offers "No type" plus Feature and Bug', typeOptionLabels.join(',') === 'No type,Feature,Bug', typeOptionLabels.join(','));
  log('task starts with "No type" selected', typeSelect.value === '');

  const featureOpt = Array.from(typeSelect.options).find(o => o.textContent === 'Feature');
  typeSelect.value = featureOpt.value;
  typeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('changing the type select enables Save', !doc.getElementById('bulkEditSaveBtn').disabled);
  log('type select gets the dirty highlight', typeSelect.classList.contains('kf-bulkedit-dirty'));
  log('pending-count reflects 1 task changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('1 task') !== -1);

  typeSelect.value = '';
  typeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('reverting to the original value clears the dirty state', !typeSelect.classList.contains('kf-bulkedit-dirty'));
  log('Save disables again once nothing has really changed', doc.getElementById('bulkEditSaveBtn').disabled);

  typeSelect.value = featureOpt.value;
  typeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  const storageRow = rowFor(doc, 'Draft project objectives');
  const storageTypeSelect = storageRow.querySelectorAll('select')[3];
  const bugOpt = Array.from(storageTypeSelect.options).find(o => o.textContent === 'Bug');
  storageTypeSelect.value = bugOpt.value;
  storageTypeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('pending-count reflects 2 tasks changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('2 task') !== -1);

  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);
  log('modal closes after saving', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const designTask = Object.values(proj.tasks).find(t => t.title === 'Configure project modules, columns and details');
  const storageTask = Object.values(proj.tasks).find(t => t.title === 'Draft project objectives');
  log('Configure project modules, columns and details correctly assigned to Feature', designTask.typeId === featureOpt.value, designTask.typeId);
  log('Draft project objectives correctly assigned to Bug', storageTask.typeId === bugOpt.value, storageTask.typeId);

  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  const designRowAgain = rowFor(doc, 'Configure project modules, columns and details');
  const designTypeSelectAgain = designRowAgain.querySelectorAll('select')[3];
  log('reopening shows the previously saved type selected', designTypeSelectAgain.value === featureOpt.value);

  designTypeSelectAgain.value = '';
  designTypeSelectAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);

  const raw2 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj2 = raw2.projects[raw2.currentProjectId];
  const designTaskAfter = Object.values(proj2.tasks).find(t => t.title === 'Configure project modules, columns and details');
  log('un-assigning via "No type" in Bulk Edit persists typeId:null', designTaskAfter.typeId === null);

  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  const storageRowAgain = rowFor(doc, 'Draft project objectives');
  const storageTypeSelectAgain = storageRowAgain.querySelectorAll('select')[3];
  log('Cancel test starts from the previously saved Bug assignment', storageTypeSelectAgain.value === bugOpt.value);
  storageTypeSelectAgain.value = '';
  storageTypeSelectAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('bulkEditCancelBtn').click();
  await wait(10);

  const raw3 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj3 = raw3.projects[raw3.currentProjectId];
  const storageTaskAfterCancel = Object.values(proj3.tasks).find(t => t.title === 'Draft project objectives');
  log('Cancel does not persist the discarded type change', storageTaskAfterCancel.typeId === bugOpt.value, storageTaskAfterCancel.typeId);

  console.log('\nBulk Edit Task Type management test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
