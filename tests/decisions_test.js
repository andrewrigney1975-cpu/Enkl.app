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

  log('Decisions button exists in the header', !!doc.getElementById('decisionsBtn'));
  doc.getElementById('decisionsBtn').click();
  await wait(20);
  log('clicking the button opens the Decisions modal', !doc.getElementById('decisionsOverlay').classList.contains('hidden'));
  log('modal uses the kf-modal-lg size class (same as Dependency Map)', doc.querySelector('#decisionsOverlay .kf-modal').classList.contains('kf-modal-lg'));
  log('seeded project has no decisions yet (empty state shown)', doc.getElementById('decisionsList').textContent.indexOf('No decisions yet') !== -1);

  doc.getElementById('decisionsModalClose').click();
  await wait(10);
  doc.getElementById('documentsBtn').click();
  await wait(20);
  doc.getElementById('addDocumentBtn').click();
  await wait(10);
  doc.getElementById('documentTitleInput').value = 'Tech Spec';
  doc.getElementById('documentFormSaveBtn').click();
  await wait(20);
  doc.getElementById('documentsModalClose').click();
  await wait(10);

  doc.getElementById('decisionsBtn').click();
  await wait(20);
  doc.getElementById('addDecisionBtn').click();
  await wait(10);
  log('clicking New Decision switches to the form view', !doc.getElementById('decisionsFormView').classList.contains('hidden'));
  log('Delete button is hidden when creating a new decision', doc.getElementById('deleteDecisionBtn').classList.contains('hidden'));

  const typeOptions = Array.from(doc.getElementById('decisionTypeSelect').options).map(o => o.value);
  log('type select offers exactly 8 options', typeOptions.length === 8, typeOptions.length);
  log('type options match the spec exactly, in order',
      typeOptions.join(',') === 'strategy,policy,budgetary,financial,functional,technical,process,operational', typeOptions.join(','));
  log('defaults to Strategy for a new decision', doc.getElementById('decisionTypeSelect').value === 'strategy');

  const docCheckboxes = doc.querySelectorAll('#decisionDocumentPicker input[type=checkbox]');
  log('document picker lists the one existing document', docCheckboxes.length === 1, docCheckboxes.length);
  log('document picker shows the document\u2019s title', doc.getElementById('decisionDocumentPicker').textContent.indexOf('Tech Spec') !== -1);

  doc.getElementById('decisionTitleInput').value = 'Adopt PostgreSQL';
  doc.getElementById('decisionDescEditor').textContent = 'Chosen over MySQL for better JSON support.';
  doc.getElementById('decisionTypeSelect').value = 'technical';
  const taskOpt = doc.getElementById('decisionTaskSelect').options[1];
  doc.getElementById('decisionTaskSelect').value = taskOpt.value;
  const ownerOpt = doc.getElementById('decisionOwnerSelect').options[1];
  doc.getElementById('decisionOwnerSelect').value = ownerOpt.value;
  docCheckboxes[0].checked = true;
  doc.getElementById('decisionFormSaveBtn').click();
  await wait(20);

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let decision = proj.decisions.find(d => d.title === 'Adopt PostgreSQL');
  log('decision was created', !!decision);
  log('key follows the <PROJECT>-DEC-NNN format, zero-padded', decision.key === 'SMPL-DEC-001', decision.key);
  log('type persisted correctly', decision.type === 'technical', decision.type);
  log('owner persisted correctly', decision.ownerId === ownerOpt.value);
  log('linked task persisted correctly', decision.taskId === taskOpt.value);
  log('linked document persisted in documentIds', decision.documentIds.length === 1, JSON.stringify(decision.documentIds));
  log('decision has dateCreated and dateLastModified', !!decision.dateCreated && !!decision.dateLastModified);

  doc.getElementById('addDecisionBtn').click();
  await wait(10);
  doc.getElementById('decisionTitleInput').value = 'Use feature flags for rollout';
  doc.getElementById('decisionFormSaveBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const secondDecision = proj.decisions.find(d => d.title === 'Use feature flags for rollout');
  log('second decision gets key 002', secondDecision.key === 'SMPL-DEC-002', secondDecision.key);
  log('a decision left at the default still gets a valid type (Strategy)', secondDecision.type === 'strategy', secondDecision.type);

  const rowText = doc.getElementById('decisionsList').textContent;
  log('list shows the decision key', rowText.indexOf('SMPL-DEC-001') !== -1);
  log('list shows the type label', rowText.indexOf('Technical') !== -1, rowText);
  log('list shows the linked document count', rowText.indexOf('1 doc') !== -1, rowText);

  const decisionRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Adopt PostgreSQL') !== -1);
  decisionRow.click();
  await wait(10);
  log('reopening shows the previously saved type', doc.getElementById('decisionTypeSelect').value === 'technical');
  log('reopening shows the previously saved document link checked', doc.getElementById('decisionDocumentPicker').querySelector('input[type=checkbox]').checked);
  log('form shows the Added/Last changed meta line', doc.getElementById('decisionMetaDates').textContent.indexOf('Added') !== -1);
  doc.getElementById('decisionFormCancelBtn').click();
  await wait(10);

  doc.getElementById('decisionsModalClose').click();
  await wait(10);
  doc.getElementById('documentsBtn').click();
  await wait(20);
  const docRowToDelete = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Tech Spec') !== -1);
  docRowToDelete.click();
  await wait(10);
  doc.getElementById('deleteDocumentBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  decision = proj.decisions.find(d => d.title === 'Adopt PostgreSQL');
  log('decision survives the linked document\u2019s deletion', !!decision);
  log('decision\u2019s documentIds no longer references the deleted document', decision.documentIds.length === 0, JSON.stringify(decision.documentIds));

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const linkedTaskKey = proj.tasks[decision.taskId].key;
  doc.getElementById('documentsModalClose').click();
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
  decision = proj.decisions.find(d => d.title === 'Adopt PostgreSQL');
  log('decision\u2019s taskId is cleared when the linked task is deleted', decision.taskId === null, decision.taskId);

  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const ownerRow = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('[data-action="remove-member"]'));
  ownerRow.querySelector('[data-action="remove-member"]').click();
  await wait(10);
  if(!doc.getElementById('confirmOverlay').classList.contains('hidden')){
    doc.getElementById('confirmOkBtn').click();
    await wait(20);
  }
  doc.getElementById('teamDoneBtn').click();
  await wait(10);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  decision = proj.decisions.find(d => d.title === 'Adopt PostgreSQL');
  log('decision\u2019s ownerId is cleared when the owning member is removed', decision.ownerId === null, decision.ownerId);

  doc.getElementById('decisionsBtn').click();
  await wait(20);
  const toDeleteRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Use feature flags') !== -1);
  toDeleteRow.click();
  await wait(10);
  doc.getElementById('deleteDecisionBtn').click();
  await wait(10);
  log('delete shows a confirmation dialog rather than deleting immediately', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('decision is actually removed', !proj.decisions.find(d => d.title === 'Use feature flags for rollout'));
  log('deleting returns to the list view', !doc.getElementById('decisionsListView').classList.contains('hidden'));

  doc.getElementById('decisionsModalClose').click();
  await wait(10);
  log('close button closes the modal', doc.getElementById('decisionsOverlay').classList.contains('hidden'));
  doc.getElementById('decisionsBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the modal', doc.getElementById('decisionsOverlay').classList.contains('hidden'));

  console.log('\nDecisions feature test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
