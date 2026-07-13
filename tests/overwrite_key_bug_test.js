const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

class FakeFile { constructor(text){ this._text = text; } }
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
window.FileReader = class {
  readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
};
let lastBlobText = null;
window.URL.createObjectURL = () => 'blob://fake';
window.URL.revokeObjectURL = () => {};
const OrigBlob = window.Blob;
window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
async function triggerImport(doc, text){
  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(text)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
}
function cardKeys(doc){
  return Array.from(doc.querySelectorAll('.kf-card-key')).map(el => el.textContent.trim()).sort();
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // Sanity: seeded Sample Project keys are SMPL-1..SMPL-5
  const keysBefore = cardKeys(doc);
  log('seeded project task keys all start with SMPL-', keysBefore.every(k => k.startsWith('SMPL-')), keysBefore.join(','));

  // Export it, then re-import and choose "Update existing" (overwrite).
  doc.getElementById('exportBtn').click();
  await wait(20);
  const exportedText = lastBlobText;

  await triggerImport(doc, exportedText);
  const conflictVisible = !doc.getElementById('importConflictOverlay').classList.contains('hidden');
  log('conflict modal appears on re-import', conflictVisible);

  doc.getElementById('importConflictOverwriteBtn').click();
  await wait(30);

  const keyAfter = doc.getElementById('toolbarKey').textContent;
  log('project key after overwrite is still SMPL (not SMPL2 etc.)', keyAfter === 'SMPL', keyAfter);

  const keysAfter = cardKeys(doc);
  log('every task key after overwrite starts with the correct "SMPL-" prefix',
      keysAfter.every(k => k.startsWith('SMPL-')), keysAfter.join(','));
  log('no task key carries a stale deduplicated prefix like SMPL2-',
      keysAfter.every(k => !/^SMPL\d+-/.test(k)), keysAfter.join(','));
  log('task key count unchanged (5)', keysAfter.length === 5, keysAfter.length);

  // Verify the numeric suffixes are sane (1..5, no duplicates, no NaN)
  const suffixes = keysAfter.map(k => parseInt(k.split('-')[1], 10)).sort((a,b)=>a-b);
  log('numeric suffixes are 1 through 5 with no NaN/duplicates',
      suffixes.every(n => !isNaN(n)) && new Set(suffixes).size === 5, suffixes.join(','));

  // Persisted data should match what's rendered
  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const persistedKeys = Object.values(proj.tasks).map(t => t.key).sort();
  log('persisted task keys in localStorage also match the corrected prefix',
      persistedKeys.every(k => k.startsWith('SMPL-')), persistedKeys.join(','));
  log('persisted project.key is SMPL', proj.key === 'SMPL', proj.key);

  // Re-export after the fix and confirm the export itself reflects correct keys too
  doc.getElementById('exportBtn').click();
  await wait(20);
  const reExported = JSON.parse(lastBlobText);
  function collectKeys(nodes, set){ (nodes||[]).forEach(n => { set.add(n.key); collectKeys(n.subtasks, set); }); }
  const exportedKeys = new Set();
  collectKeys(reExported.hierarchy, exportedKeys);
  log('re-exported hierarchy keys also use the correct SMPL- prefix',
      Array.from(exportedKeys).every(k => k.startsWith('SMPL-')), Array.from(exportedKeys).join(','));

  // Now test a SECOND consecutive overwrite to make sure the fix isn't a one-shot fluke
  await triggerImport(doc, exportedText);
  doc.getElementById('importConflictOverwriteBtn').click();
  await wait(30);
  const keysAfterSecond = cardKeys(doc);
  log('keys remain correctly prefixed after a second overwrite in a row',
      keysAfterSecond.every(k => k.startsWith('SMPL-')) && keysAfterSecond.length === 5, keysAfterSecond.join(','));

  console.log('\nOverwrite task-key bug regression test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
