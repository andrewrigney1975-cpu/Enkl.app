const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function rowForType(doc, typeName){
  return Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === typeName);
}
function assignIconViaPicker(doc, typeName, iconLabel){
  const row = rowForType(doc, typeName);
  row.querySelector('.kf-tasktype-icon-trigger').click();
  const opt = Array.from(row.querySelectorAll('.kf-tasktype-icon-option')).find(o => o.getAttribute('title') === iconLabel);
  opt.click();
}
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

  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  doc.getElementById('newTaskTypeNameInput').value = 'Chore';
  doc.getElementById('addTaskTypeBtn').click();
  await wait(10);

  const featureRow = rowForType(doc, 'Feature');
  featureRow.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  const iconOptions = Array.from(featureRow.querySelectorAll('.kf-tasktype-icon-option'));
  log('icon library has exactly 26 icons (24 activity icons + Feature/Bug)', iconOptions.length === 26, iconOptions.length);
  const labels = iconOptions.map(o => o.getAttribute('title'));
  log('library includes "Feature" (sparkle icon)', labels.includes('Feature'), labels.join(','));
  log('library includes "Bug"', labels.includes('Bug'), labels.join(','));
  ['Investigate', 'Document', 'Analyse', 'Procure', 'Audit', 'Report', 'Communicate'].forEach(name => {
    log('library includes "' + name + '"', labels.includes(name), labels.join(','));
  });
  featureRow.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);

  log('icon panel starts hidden for a freshly-rendered row', featureRow.querySelector('.kf-tasktype-icon-panel').classList.contains('hidden'));
  log('unset trigger gets the muted placeholder class', featureRow.querySelector('.kf-tasktype-icon-trigger').classList.contains('kf-tasktype-icon-unset'));

  assignIconViaPicker(doc, 'Feature', 'Investigate');
  await wait(10);
  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let featureType = proj.taskTypes.find(t => t.name === 'Feature');
  log('selecting an icon persists immediately', featureType.iconName === 'ty_investigate', featureType.iconName);

  const featureRowAfter = rowForType(doc, 'Feature');
  log('the trigger button itself updates to show the newly assigned icon', !featureRowAfter.querySelector('.kf-tasktype-icon-trigger').classList.contains('kf-tasktype-icon-unset'));
  featureRowAfter.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  const selectedOpt = featureRowAfter.querySelector('.kf-tasktype-icon-option.selected');
  log('the chosen icon shows the "selected" highlight when reopened', selectedOpt && selectedOpt.getAttribute('title') === 'Investigate', selectedOpt && selectedOpt.getAttribute('title'));
  featureRowAfter.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);

  const featureRow2 = rowForType(doc, 'Feature');
  featureRow2.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  featureRow2.querySelector('.kf-tasktype-icon-clear').click();
  await wait(10);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  featureType = proj.taskTypes.find(t => t.name === 'Feature');
  log('"No icon" clears the assignment back to null', featureType.iconName === null, featureType.iconName);

  assignIconViaPicker(doc, 'Feature', 'Investigate');
  await wait(10);
  assignIconViaPicker(doc, 'Bug', 'Audit');
  await wait(10);

  const bugRow = rowForType(doc, 'Bug');
  bugRow.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  log('Bug\u2019s picker is open', !bugRow.querySelector('.kf-tasktype-icon-panel').classList.contains('hidden'));
  const choreRow = rowForType(doc, 'Chore');
  choreRow.querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  log('opening Chore\u2019s picker closes Bug\u2019s (one at a time)', rowForType(doc, 'Bug').querySelector('.kf-tasktype-icon-panel').classList.contains('hidden'));
  log('Chore\u2019s picker is now open', !choreRow.querySelector('.kf-tasktype-icon-panel').classList.contains('hidden'));

  doc.getElementById('newTaskTypeNameInput').click();
  await wait(10);
  log('clicking outside any picker closes it', rowForType(doc, 'Chore').querySelector('.kf-tasktype-icon-panel').classList.contains('hidden'));

  rowForType(doc, 'Chore').querySelector('.kf-tasktype-icon-trigger').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes an open icon picker (without closing the whole modal)',
      rowForType(doc, 'Chore').querySelector('.kf-tasktype-icon-panel').classList.contains('hidden') &&
      !doc.getElementById('taskTypesOverlay').classList.contains('hidden'));

  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);

  setTaskType(doc, 'Look at Project and App Settings', 'Feature');
  await wait(20);
  setTaskType(doc, 'Configure project modules, columns and details', 'Bug');
  await wait(20);
  setTaskType(doc, 'Draft project objectives', 'Chore');
  await wait(20);

  const featureCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  const bugCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Configure project modules, columns and details') !== -1);
  const choreCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Draft project objectives') !== -1);
  const noTypeCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Set up Team members for this project') !== -1);

  log('Feature-typed card (icon assigned) shows a type icon with the correct tooltip',
      featureCard.querySelector('.kf-card-type-icon') !== null && featureCard.querySelector('.kf-card-type-icon').getAttribute('title') === 'Feature');
  log('Bug-typed card (icon assigned) shows a type icon with the correct tooltip',
      bugCard.querySelector('.kf-card-type-icon') !== null && bugCard.querySelector('.kf-card-type-icon').getAttribute('title') === 'Bug');
  log('Feature and Bug use DIFFERENT icon glyphs (distinct assigned icons)',
      featureCard.querySelector('.kf-card-type-icon').innerHTML !== bugCard.querySelector('.kf-card-type-icon').innerHTML);
  log('a type with NO icon assigned (Chore) shows NOTHING on the card, even though the task has a type',
      choreCard.querySelector('.kf-card-type-icon') === null);
  log('a task with no type at all also shows nothing', noTypeCard.querySelector('.kf-card-type-icon') === null);

  doc.getElementById('depMapBtn').click();
  await wait(20);
  function nodeFor(taskKey){
    return Array.from(doc.querySelectorAll('.kf-depnode')).find(n => n.textContent.indexOf(taskKey) !== -1);
  }
  function titlesIn(node){ return Array.from(node.querySelectorAll('title')).map(t => t.textContent); }
  const featureNode = nodeFor('SMPL-1');
  const bugNode = nodeFor('SMPL-2');
  const choreNode = nodeFor('SMPL-3');
  const noTypeNode = nodeFor('SMPL-4');

  log('Feature node (icon assigned) includes a <title> for "Feature"', titlesIn(featureNode).includes('Feature'), titlesIn(featureNode));
  log('Bug node (icon assigned) includes a <title> for "Bug"', titlesIn(bugNode).includes('Bug'), titlesIn(bugNode));
  log('Chore node (type set, but NO icon assigned) shows no type-name title', !titlesIn(choreNode).includes('Chore'), titlesIn(choreNode));
  log('a node with no type at all shows no type-name title either', !titlesIn(noTypeNode).some(t => ['Feature','Bug','Chore'].includes(t)), titlesIn(noTypeNode));
  doc.getElementById('depMapClose').click();
  await wait(10);

  doc.getElementById('taskListBtn').click();
  await wait(20);
  function listRowFor(title){ return Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf(title) !== -1); }
  const featureListRow = listRowFor('Look at Project and App Settings');
  const choreListRow = listRowFor('Draft project objectives');
  log('List View: Feature row (icon assigned) shows the type icon', featureListRow.querySelector('.kf-tasklist-type-icon') !== null);
  log('List View: Chore row (no icon assigned) shows nothing, consistent with board/dep-graph', choreListRow.querySelector('.kf-tasklist-type-icon') === null);
  doc.getElementById('taskListClose').click();
  await wait(10);

  let lastBlobText = null;
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };
  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  const exportedFeatureType = exported.taskTypes.find(t => t.name === 'Feature');
  log('export carries the assigned iconName for the type', exportedFeatureType.iconName === 'ty_investigate', exportedFeatureType.iconName);
  const exportedChoreType = exported.taskTypes.find(t => t.name === 'Chore');
  log('export shows null iconName for an unassigned type', exportedChoreType.iconName === null, exportedChoreType.iconName);

  console.log('\nTask Type icon library test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
