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
  let lastOpenedUrl = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  installFakeFileReader(window);
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };
  window.open = function(url){ lastOpenedUrl = url; return null; };

  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  const card = doc.querySelector('.kf-card');
  card.click();
  await wait(10);
  log('task modal has a Documentation field', doc.getElementById('taskDocUrlInput') !== null);

  const fieldsInOrder = Array.from(doc.querySelectorAll('.kf-modal-body .kf-field, .kf-modal-body .kf-field-row'));
  const descIdx = fieldsInOrder.findIndex(el => el.querySelector && el.querySelector('#taskDescEditor'));
  const docIdx = fieldsInOrder.findIndex(el => el.querySelector && el.querySelector('#taskDocUrlInput'));
  log('Documentation field appears immediately after Description', docIdx === descIdx + 1, `desc=${descIdx} doc=${docIdx}`);

  log('open-link button starts hidden for a task with no documentation set', doc.getElementById('taskDocUrlOpenBtn').classList.contains('hidden'));
  doc.getElementById('taskDocUrlInput').value = 'https://example.com/docs';
  doc.getElementById('taskDocUrlInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  log('open-link button appears live as soon as a value is typed (before saving)', !doc.getElementById('taskDocUrlOpenBtn').classList.contains('hidden'));
  doc.getElementById('taskDocUrlInput').value = '';
  doc.getElementById('taskDocUrlInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  log('open-link button hides again if the value is cleared', doc.getElementById('taskDocUrlOpenBtn').classList.contains('hidden'));

  doc.getElementById('taskDocUrlInput').value = 'https://example.com/spec';
  doc.getElementById('taskDocUrlInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  const taskId = Object.keys(proj.tasks)[0];
  log('saved documentationUrl persists exactly as entered (already had a scheme)', proj.tasks[taskId].documentationUrl === 'https://example.com/spec', proj.tasks[taskId].documentationUrl);

  const cardAgain = doc.querySelector('.kf-card');
  cardAgain.click();
  await wait(10);
  log('reopening shows the saved URL', doc.getElementById('taskDocUrlInput').value === 'https://example.com/spec');
  log('reopening shows the open-link button (value is present)', !doc.getElementById('taskDocUrlOpenBtn').classList.contains('hidden'));

  doc.getElementById('taskDocUrlOpenBtn').click();
  log('clicking the open-link button opens the saved URL', lastOpenedUrl === 'https://example.com/spec', lastOpenedUrl);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  const card2 = doc.querySelector('.kf-card');
  card2.click();
  await wait(10);
  doc.getElementById('taskDocUrlInput').value = 'docs.example.com/page';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('a scheme-less URL gets auto-prefixed with https:// on save', proj.tasks[taskId].documentationUrl === 'https://docs.example.com/page', proj.tasks[taskId].documentationUrl);

  const card3 = doc.querySelector('.kf-card');
  card3.click();
  await wait(10);
  doc.getElementById('taskDocUrlInput').value = '';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('clearing the field removes the stored URL (back to null)', proj.tasks[taskId].documentationUrl === null);

  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  log('a brand-new task has an empty Documentation field by default', doc.getElementById('taskDocUrlInput').value === '');
  log('open-link button is hidden for a brand-new task', doc.getElementById('taskDocUrlOpenBtn').classList.contains('hidden'));
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  const card4 = doc.querySelector('.kf-card');
  card4.click();
  await wait(10);
  doc.getElementById('taskDocUrlInput').value = 'https://wiki.example.org/spec/123';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  function flattenNodes(nodes, acc){ nodes.forEach(n => { acc.push(n); flattenNodes(n.subtasks || [], acc); }); return acc; }
  const exportedTask = flattenNodes(exported.hierarchy, []).find(n => n.documentationUrl === 'https://wiki.example.org/spec/123');
  log('export includes the documentationUrl field on the task node', !!exportedTask, JSON.stringify(flattenNodes(exported.hierarchy, []).map(n => n.documentationUrl)));

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
  const importedTask = Object.values(proj.tasks).find(t => t.documentationUrl === 'https://wiki.example.org/spec/123');
  log('imported task correctly carries over the documentationUrl', !!importedTask);

  const legacyDB = {
    projects: {
      legacy_p1: {
        id: 'legacy_p1', name: 'Legacy Project', key: 'LEG', taskCounter: 2,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: ['t1'] }],
        tasks: {
          t1: {
            id: 't1', key: 'LEG-1', title: 'Old task, no documentationUrl field',
            description: '', priority: 'medium', columnId: 'col1', dependencies: [],
            assigneeId: null, releaseId: null, typeId: null, startDate: null, endDate: null,
            businessValue: 1, taskCost: 1, archived: false,
            dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
          }
        },
        members: [], releases: [], taskTypes: [], startDate: null, endDate: null,
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
  log('migration backfills documentationUrl as null for legacy tasks', raw2.projects.legacy_p1.tasks.t1.documentationUrl === null, raw2.projects.legacy_p1.tasks.t1.documentationUrl);

  console.log('\nDocumentation field test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
