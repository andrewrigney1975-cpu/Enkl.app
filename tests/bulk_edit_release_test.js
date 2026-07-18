const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function rowFor(doc, title){
  return Array.from(doc.querySelectorAll('.kf-bulkedit-row')).find(r => r.textContent.indexOf(title) !== -1);
}
function createRelease(doc, name){
  doc.getElementById('releasesBtn').click();
  doc.getElementById('addReleaseBtn').click();
  doc.getElementById('releaseNameInput').value = name;
  doc.getElementById('releaseFormSaveBtn').click();
  doc.getElementById('releasesDoneBtn').click();
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  createRelease(doc, 'v1.0 Launch');
  await wait(20);
  createRelease(doc, 'v2.0 Big Release');
  await wait(20);

  doc.getElementById('bulkEditBtn').click();
  await wait(20);

  const designRow = rowFor(doc, 'Configure project modules, columns and details');
  const releaseSelect = designRow.querySelectorAll('select')[1];

  // ── 1. Release select exists and lists "No release" + all releases ───────
  const releaseOptionLabels = Array.from(releaseSelect.options).map(o => o.textContent);
  log('release select offers "No release" plus both created releases',
      releaseOptionLabels.join(',') === 'No release,v1.0 Launch,v2.0 Big Release', releaseOptionLabels.join(','));
  log('task starts with "No release" selected', releaseSelect.value === '');

  // ── 2. Editing the release select stages a dirty change ──────────────────
  const v1Opt = Array.from(releaseSelect.options).find(o => o.textContent === 'v1.0 Launch');
  releaseSelect.value = v1Opt.value;
  releaseSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('changing the release select enables Save', !doc.getElementById('bulkEditSaveBtn').disabled);
  log('release select gets the dirty highlight', releaseSelect.classList.contains('kf-bulkedit-dirty'));
  log('pending-count reflects 1 task changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('1 task') !== -1);

  releaseSelect.value = '';
  releaseSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('reverting to the original value clears the dirty state', !releaseSelect.classList.contains('kf-bulkedit-dirty'));
  log('Save disables again once nothing has really changed', doc.getElementById('bulkEditSaveBtn').disabled);

  // ── 3. Assign two different tasks to two different releases, then save ───
  releaseSelect.value = v1Opt.value;
  releaseSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  const storageRow = rowFor(doc, 'Draft project objectives');
  const storageReleaseSelect = storageRow.querySelectorAll('select')[1];
  const v2Opt = Array.from(storageReleaseSelect.options).find(o => o.textContent === 'v2.0 Big Release');
  storageReleaseSelect.value = v2Opt.value;
  storageReleaseSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('pending-count reflects 2 tasks changed', doc.getElementById('bulkEditPendingCount').textContent.indexOf('2 task') !== -1);

  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);
  log('modal closes after saving', doc.getElementById('bulkEditOverlay').classList.contains('hidden'));

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const designTask = Object.values(proj.tasks).find(t => t.title === 'Configure project modules, columns and details');
  const storageTask = Object.values(proj.tasks).find(t => t.title === 'Draft project objectives');
  log('Configure project modules, columns and details correctly assigned to v1.0 Launch', designTask.releaseId === v1Opt.value, designTask.releaseId);
  log('Draft project objectives correctly assigned to v2.0 Big Release', storageTask.releaseId === v2Opt.value, storageTask.releaseId);

  // ── 4. Re-opening shows the saved assignments, and unassigning works too ──
  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  const designRowAgain = rowFor(doc, 'Configure project modules, columns and details');
  const designReleaseSelectAgain = designRowAgain.querySelectorAll('select')[1];
  log('reopening shows the previously saved release selected', designReleaseSelectAgain.value === v1Opt.value);

  designReleaseSelectAgain.value = '';
  designReleaseSelectAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('bulkEditSaveBtn').click();
  await wait(20);

  const raw2 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj2 = raw2.projects[raw2.currentProjectId];
  const designTaskAfter = Object.values(proj2.tasks).find(t => t.title === 'Configure project modules, columns and details');
  log('un-assigning via "No release" in Bulk Edit persists releaseId:null', designTaskAfter.releaseId === null);

  // ── 5. Cancel discards a staged release change without applying it ───────
  doc.getElementById('bulkEditBtn').click();
  await wait(20);
  const storageRowAgain = rowFor(doc, 'Draft project objectives');
  const storageReleaseSelectAgain = storageRowAgain.querySelectorAll('select')[1];
  log('Cancel test starts from the previously saved v2.0 assignment', storageReleaseSelectAgain.value === v2Opt.value);
  storageReleaseSelectAgain.value = '';
  storageReleaseSelectAgain.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('bulkEditCancelBtn').click();
  await wait(10);

  const raw3 = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj3 = raw3.projects[raw3.currentProjectId];
  const storageTaskAfterCancel = Object.values(proj3.tasks).find(t => t.title === 'Draft project objectives');
  log('Cancel does not persist the discarded release change', storageTaskAfterCancel.releaseId === v2Opt.value, storageTaskAfterCancel.releaseId);

  console.log('\nBulk Edit Release management test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
