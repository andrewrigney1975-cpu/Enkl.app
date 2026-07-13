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

  log('Documents button exists in the header', !!doc.getElementById('documentsBtn'));
  doc.getElementById('documentsBtn').click();
  await wait(20);
  log('clicking the button opens the Documents modal', !doc.getElementById('documentsOverlay').classList.contains('hidden'));
  const modalEl = doc.querySelector('#documentsOverlay .kf-modal');
  log('modal uses the kf-modal-lg size class (same as Dependency Map)', modalEl.classList.contains('kf-modal-lg'));

  log('starts on the list view', !doc.getElementById('documentsListView').classList.contains('hidden'));
  log('form view starts hidden', doc.getElementById('documentsFormView').classList.contains('hidden'));
  log('seeded project has no documents yet (empty state shown)', doc.getElementById('documentsList').textContent.indexOf('No documents yet') !== -1);

  doc.getElementById('addDocumentBtn').click();
  await wait(10);
  log('clicking New Document switches to the form view', !doc.getElementById('documentsFormView').classList.contains('hidden'));
  log('list view is hidden while in the form', doc.getElementById('documentsListView').classList.contains('hidden'));
  log('Delete button is hidden when creating a new document', doc.getElementById('deleteDocumentBtn').classList.contains('hidden'));

  doc.getElementById('documentTitleInput').value = 'Vendor Contract';
  doc.getElementById('documentUrlInput').value = 'docs.example.com/contract';
  doc.getElementById('documentDescriptionInput').value = 'Signed agreement with the hosting vendor.';
  doc.getElementById('documentFormSaveBtn').click();
  await wait(20);

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let savedDoc = proj.documents.find(d => d.title === 'Vendor Contract');
  log('document was created', !!savedDoc);
  log('key follows the <PROJECT>-DOC-NNN format, zero-padded', savedDoc.key === 'SMPL-DOC-001', savedDoc.key);
  log('URL gets auto-prefixed with https:// like the Task documentation field', savedDoc.url === 'https://docs.example.com/contract', savedDoc.url);
  log('saving returns to the list view', !doc.getElementById('documentsListView').classList.contains('hidden'));
  log('new document appears in the list', doc.getElementById('documentsList').textContent.indexOf('Vendor Contract') !== -1);
  log('new document\u2019s key appears in the list row', doc.getElementById('documentsList').textContent.indexOf('SMPL-DOC-001') !== -1);

  doc.getElementById('addDocumentBtn').click();
  await wait(10);
  doc.getElementById('documentTitleInput').value = 'Architecture Diagram';
  doc.getElementById('documentFormSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const secondDoc = proj.documents.find(d => d.title === 'Architecture Diagram');
  log('second document gets key 002', secondDoc.key === 'SMPL-DOC-002', secondDoc.key);

  const docRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Vendor Contract') !== -1);
  docRow.click();
  await wait(10);
  const ownerOptions = Array.from(doc.getElementById('documentOwnerSelect').options).map(o => o.textContent);
  log('owner select includes "Unassigned" plus seeded team members', ownerOptions[0] === 'Unassigned' && ownerOptions.length > 1, ownerOptions.join(','));
  const taskOptions = Array.from(doc.getElementById('documentTaskSelect').options).map(o => o.textContent);
  log('task select includes "No task linked" plus seeded tasks', taskOptions[0] === 'No task linked' && taskOptions.length > 1, taskOptions.length);

  const someTaskOpt = doc.getElementById('documentTaskSelect').options[1];
  doc.getElementById('documentTaskSelect').value = someTaskOpt.value;
  doc.getElementById('documentFormSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  savedDoc = proj.documents.find(d => d.title === 'Vendor Contract');
  log('linking a task persists taskId', savedDoc.taskId === someTaskOpt.value, savedDoc.taskId);
  log('linked task\u2019s key shows in the list row meta', doc.getElementById('documentsList').textContent.indexOf(proj.tasks[someTaskOpt.value].key) !== -1);

  log('document has dateCreated', !!savedDoc.dateCreated);
  log('document has dateLastModified', !!savedDoc.dateLastModified);
  const reopenedRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Vendor Contract') !== -1);
  reopenedRow.click();
  await wait(10);
  log('form shows the Added/Last changed meta line', doc.getElementById('documentMetaDates').textContent.indexOf('Added') !== -1);
  doc.getElementById('documentFormCancelBtn').click();
  await wait(10);

  const linkedTaskId = someTaskOpt.value;
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const linkedTaskKey = proj.tasks[linkedTaskId].key;
  doc.getElementById('documentsDoneBtn').click();
  await wait(10);
  const linkedCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(linkedTaskKey) !== -1);
  linkedCard.click();
  await wait(10);
  doc.getElementById('taskDeleteBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  savedDoc = proj.documents.find(d => d.title === 'Vendor Contract');
  log('document survives the linked task\u2019s deletion', !!savedDoc);
  log('document\u2019s taskId is cleared when the linked task is deleted', savedDoc.taskId === null, savedDoc.taskId);

  doc.getElementById('documentsBtn').click();
  await wait(20);
  const toDeleteRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Architecture Diagram') !== -1);
  toDeleteRow.click();
  await wait(10);
  doc.getElementById('deleteDocumentBtn').click();
  await wait(10);
  log('delete shows a confirmation dialog rather than deleting immediately',
      !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('document is actually removed', !proj.documents.find(d => d.title === 'Architecture Diagram'));
  log('deleting returns to the list view', !doc.getElementById('documentsListView').classList.contains('hidden'));

  doc.getElementById('documentsModalClose').click();
  await wait(10);
  log('close button closes the modal', doc.getElementById('documentsOverlay').classList.contains('hidden'));
  doc.getElementById('documentsBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the modal', doc.getElementById('documentsOverlay').classList.contains('hidden'));

  console.log('\nDocuments feature test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
