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

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  log('seeded Sample Project has default task types Feature and Bug', proj.taskTypes.map(t=>t.name).join(',') === 'Feature,Bug', JSON.stringify(proj.taskTypes.map(t=>t.name)));

  doc.getElementById('newProjectBtn').click();
  await wait(10);
  doc.getElementById('projectNameInput').value = 'Fresh Project';
  doc.getElementById('projectKeyInput').value = 'FRP';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('a brand-new project also defaults to Feature and Bug', proj.taskTypes.map(t=>t.name).join(',') === 'Feature,Bug');

  // Switch back to the Sample Project, which has actual seeded tasks to work with.
  const projSelect = doc.getElementById('projectSelect');
  const demoOption = Array.from(projSelect.options).find(o => o.textContent.indexOf('Sample Project') !== -1);
  projSelect.value = demoOption.value;
  projSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
  await wait(10);
  const row1Order = Array.from(doc.getElementById('toolbarRow1').querySelectorAll('button')).map(b => b.id).filter(Boolean);
  const archivedIdx = row1Order.indexOf('archivedTasksBtn');
  const taskTypesIdx = row1Order.indexOf('taskTypesBtn');
  const releasesIdx = row1Order.indexOf('releasesBtn');
  log('Task Types button exists in row 1 (Tools group)', taskTypesIdx !== -1, row1Order.join(','));
  log('Task Types sits directly after Archived', taskTypesIdx === archivedIdx + 1, row1Order.join(','));
  log('Releases sits directly after Task Types', releasesIdx === taskTypesIdx + 1, row1Order.join(','));

  log('modal starts hidden', doc.getElementById('taskTypesOverlay').classList.contains('hidden'));
  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  log('modal opens', !doc.getElementById('taskTypesOverlay').classList.contains('hidden'));
  let rows = doc.querySelectorAll('#taskTypeList .kf-member-row');
  log('lists the 2 default types', rows.length === 2, rows.length);

  doc.getElementById('newTaskTypeNameInput').value = 'Chore';
  doc.getElementById('addTaskTypeBtn').click();
  await wait(10);
  rows = doc.querySelectorAll('#taskTypeList .kf-member-row');
  log('adding a new type increases the list to 3', rows.length === 3, rows.length);
  log('input clears after adding', doc.getElementById('newTaskTypeNameInput').value === '');

  doc.getElementById('newTaskTypeNameInput').value = '';
  doc.getElementById('addTaskTypeBtn').click();
  await wait(10);
  log('adding with a blank name does nothing (no 4th row, no crash)', doc.querySelectorAll('#taskTypeList .kf-member-row').length === 3);

  const bugRow = Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('input').value === 'Bug');
  bugRow.querySelector('input').value = 'Defect';
  bugRow.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('renaming a type persists immediately', proj.taskTypes.some(t => t.name === 'Defect') && !proj.taskTypes.some(t => t.name === 'Bug'));

  const choreRow = Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('input').value === 'Chore');
  choreRow.querySelector('[data-action="remove-tasktype"]').click();
  await wait(10);
  log('removing shows a confirm dialog', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  doc.getElementById('confirmCancelBtn').click();
  await wait(10);
  log('cancelling the confirm leaves the type in place', doc.querySelectorAll('#taskTypeList .kf-member-row').length === 3);

  Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('input').value === 'Chore')
    .querySelector('[data-action="remove-tasktype"]').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  log('confirming removes the type', doc.querySelectorAll('#taskTypeList .kf-member-row').length === 2);

  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);
  log('Done closes the modal', doc.getElementById('taskTypesOverlay').classList.contains('hidden'));

  doc.getElementById('taskTypesBtn').click();
  await wait(10);
  doc.getElementById('taskTypesOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await wait(10);
  log('clicking the backdrop closes the modal', doc.getElementById('taskTypesOverlay').classList.contains('hidden'));

  doc.getElementById('taskTypesBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the modal', doc.getElementById('taskTypesOverlay').classList.contains('hidden'));

  const card = doc.querySelector('.kf-card');
  card.click();
  await wait(10);
  log('task modal has a Type select', doc.getElementById('taskTypeSelect') !== null);
  const fieldsInOrder = Array.from(doc.querySelectorAll('.kf-modal-body .kf-field, .kf-modal-body .kf-field-row'));
  const typeFieldIdx = fieldsInOrder.findIndex(el => el.querySelector && el.querySelector('#taskTypeSelect'));
  const titleFieldIdx = fieldsInOrder.findIndex(el => el.querySelector && el.querySelector('#taskTitleInput'));
  log('Type field appears before the Title field in the modal', typeFieldIdx !== -1 && titleFieldIdx !== -1 && typeFieldIdx < titleFieldIdx, `type=${typeFieldIdx} title=${titleFieldIdx}`);
  log('a pre-existing task with no typeId shows "No type" selected', doc.getElementById('taskTypeSelect').value === '');
  const typeOptionLabels = Array.from(doc.getElementById('taskTypeSelect').options).map(o => o.textContent);
  log('Type select lists "No type" plus both project types', typeOptionLabels.join(',') === 'No type,Feature,Defect', typeOptionLabels.join(','));

  const featureOpt = Array.from(doc.getElementById('taskTypeSelect').options).find(o => o.textContent === 'Feature');
  doc.getElementById('taskTypeSelect').value = featureOpt.value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const taskId = Object.keys(proj.tasks)[0];
  log('saving with a type selected persists typeId', proj.tasks[taskId].typeId === featureOpt.value);

  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  log('a brand-new task defaults to "No type" (empty)', doc.getElementById('taskTypeSelect').value === '');
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('input').value === 'Feature')
    .querySelector('[data-action="remove-tasktype"]').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('deleting a type in use clears it from the task that had it', proj.tasks[taskId].typeId === null);
  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);

  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  doc.getElementById('newTaskTypeNameInput').value = 'Spike';
  doc.getElementById('addTaskTypeBtn').click();
  await wait(10);
  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const spikeType = proj.taskTypes.find(t => t.name === 'Spike');
  const card2 = doc.querySelector('.kf-card');
  card2.click();
  await wait(10);
  doc.getElementById('taskTypeSelect').value = spikeType.id;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  log('export includes a taskTypes array', Array.isArray(exported.taskTypes) && exported.taskTypes.some(t => t.name === 'Spike'), JSON.stringify(exported.taskTypes));

  function flattenNodes(nodes, acc){ nodes.forEach(n => { acc.push(n); flattenNodes(n.subtasks || [], acc); }); return acc; }
  const exportedTaskWithType = flattenNodes(exported.hierarchy, []).find(n => n.type === 'Spike');
  log('the task assigned to Spike exports a type name+id reference', !!exportedTaskWithType && exportedTaskWithType.typeId === spikeType.id);

  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('imported project reconstructs the task types', proj.taskTypes.some(t => t.name === 'Spike'));
  const importedSpike = proj.taskTypes.find(t => t.name === 'Spike');
  const importedTaskWithType = Object.values(proj.tasks).find(t => t.typeId === importedSpike.id);
  log('imported task correctly re-links to the NEW type id', !!importedTaskWithType);

  doc.getElementById('newProjectBtn').click();
  await wait(10);
  doc.getElementById('projectNameInput').value = 'Empty Types Project';
  doc.getElementById('projectKeyInput').value = 'ETP';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);
  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  while (doc.querySelectorAll('#taskTypeList [data-action="remove-tasktype"]').length > 0) {
    doc.querySelector('#taskTypeList [data-action="remove-tasktype"]').click();
    await wait(10);
    doc.getElementById('confirmOkBtn').click();
    await wait(10);
  }
  log('project now has zero task types after deleting both defaults', doc.querySelectorAll('#taskTypeList .kf-member-row').length === 0);
  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);

  const addBtn2 = doc.querySelector('.kf-add-task-btn');
  addBtn2.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Task in a typeless project';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exportedEmpty = JSON.parse(lastBlobText);
  log('export explicitly captures an empty taskTypes array (not silently omitted)', Array.isArray(exportedEmpty.taskTypes) && exportedEmpty.taskTypes.length === 0, JSON.stringify(exportedEmpty.taskTypes));

  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('importing a file that deliberately exported zero types respects that (does NOT silently re-add Feature/Bug)', proj.taskTypes.length === 0, JSON.stringify(proj.taskTypes));

  const legacyDB = {
    projects: {
      legacy_p1: {
        id: 'legacy_p1', name: 'Legacy Project', key: 'LEG', taskCounter: 2,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: ['t1'] }],
        tasks: {
          t1: {
            id: 't1', key: 'LEG-1', title: 'Old task, no typeId field',
            description: '', priority: 'medium', columnId: 'col1', dependencies: [],
            assigneeId: null, releaseId: null, startDate: null, endDate: null,
            businessValue: 1, taskCost: 1, archived: false,
            dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
          }
        },
        members: [], releases: [], startDate: null, endDate: null,
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
  log('migration seeds Feature/Bug for a legacy project with no taskTypes array at all',
      raw2.projects.legacy_p1.taskTypes.map(t=>t.name).join(',') === 'Feature,Bug', JSON.stringify(raw2.projects.legacy_p1.taskTypes));
  log('migration backfills task.typeId as null for legacy tasks', raw2.projects.legacy_p1.tasks.t1.typeId === null, raw2.projects.legacy_p1.tasks.t1.typeId);

  const orphanDB = {
    projects: {
      orphan_p1: {
        id: 'orphan_p1', name: 'Orphan Project', key: 'ORP', taskCounter: 2,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: ['t1'] }],
        tasks: {
          t1: {
            id: 't1', key: 'ORP-1', title: 'Task pointing at a deleted type',
            description: '', priority: 'medium', columnId: 'col1', dependencies: [],
            assigneeId: null, releaseId: null, typeId: 'type_doesnotexist', startDate: null, endDate: null,
            businessValue: 1, taskCost: 1, archived: false,
            dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
          }
        },
        members: [], releases: [], taskTypes: [{id: 'type_a', name: 'Feature'}], startDate: null, endDate: null,
        dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null
      }
    },
    projectOrder: ['orphan_p1'], currentProjectId: 'orphan_p1'
  };
  const dom3 = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(orphanDB)); }
  });
  await wait(350);
  const raw3 = JSON.parse(dom3.window.localStorage.getItem('kanbanflow_v1_db'));
  log('migration clears a task typeId that points at a non-existent type', raw3.projects.orphan_p1.tasks.t1.typeId === null, raw3.projects.orphan_p1.tasks.t1.typeId);
  log('migration does NOT touch an existing, valid taskTypes array', raw3.projects.orphan_p1.taskTypes.length === 1 && raw3.projects.orphan_p1.taskTypes[0].name === 'Feature');

  console.log('\nTask Types test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
