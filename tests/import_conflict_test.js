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
function conflictVisible(doc){ return !doc.getElementById('importConflictOverlay').classList.contains('hidden'); }
function projectCount(doc){ return doc.getElementById('projectSelect').options.length; }
function currentKey(doc){ return doc.getElementById('toolbarKey').textContent; }
function currentTitle(doc){ return doc.getElementById('toolbarTitle').textContent; }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // Export the seeded Sample Project so we have a known payload to re-import.
  doc.getElementById('exportBtn').click();
  await wait(20);
  const demoExportText = lastBlobText;
  const demoExport = JSON.parse(demoExportText);
  const startCount = projectCount(doc);

  // ── 1. No conflict: completely different key and name ───────────────────────
  const freshDoc = JSON.parse(demoExportText);
  freshDoc.project.name = 'Brand New Project';
  freshDoc.project.key  = 'BNP';
  await triggerImport(doc, JSON.stringify(freshDoc));
  log('no conflict modal for a project with a unique key+name', !conflictVisible(doc));
  log('new project added to selector', projectCount(doc) === startCount + 1, projectCount(doc));
  log('"Brand New Project" becomes active', currentTitle(doc) === 'Brand New Project', currentTitle(doc));

  // ── 2. Conflict by key ───────────────────────────────────────────────────────
  const countBeforeKeyConflict = projectCount(doc);
  // Switch back to Sample Project first so we know what's active
  const demoOpt = Array.from(doc.getElementById('projectSelect').options).find(o => o.textContent.indexOf('Sample Project') !== -1 && o.textContent.indexOf('(SMPL)') !== -1);
  doc.getElementById('projectSelect').value = demoOpt.value;
  doc.getElementById('projectSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  await triggerImport(doc, demoExportText); // same key SMPL → conflict
  log('conflict modal shown for matching project key', conflictVisible(doc));
  log('project count unchanged while modal is open (no premature insert)', projectCount(doc) === countBeforeKeyConflict, projectCount(doc));

  // ── 3. Cancel: nothing happens ───────────────────────────────────────────────
  doc.getElementById('importConflictCancelBtn').click();
  await wait(10);
  log('cancel hides the conflict modal', !conflictVisible(doc));
  log('cancel does not add a new project', projectCount(doc) === countBeforeKeyConflict, projectCount(doc));
  log('cancel does not change the active project', currentTitle(doc) === 'Sample Project', currentTitle(doc));

  // ── 4. Conflict by name (different key, same name) ──────────────────────────
  const nameOnlyDoc = JSON.parse(demoExportText);
  nameOnlyDoc.project.key = 'XYZQ';  // different key — should still conflict by name
  await triggerImport(doc, JSON.stringify(nameOnlyDoc));
  log('conflict modal shown for matching project name (different key)', conflictVisible(doc));
  doc.getElementById('importConflictCancelBtn').click();
  await wait(10);

  // ── 5. "Import as copy" gives a de-duplicated key, adds a new project ────────
  const countBeforeCopy = projectCount(doc);
  await triggerImport(doc, demoExportText);
  log('conflict modal shown again', conflictVisible(doc));
  doc.getElementById('importConflictCopyBtn').click();
  await wait(20);
  log('conflict modal hidden after choosing copy', !conflictVisible(doc));
  log('import-as-copy adds a new project entry', projectCount(doc) === countBeforeCopy + 1, projectCount(doc));
  const copyKey = currentKey(doc);
  log('copy project has a de-duplicated key (not SMPL)', copyKey !== 'SMPL', copyKey);
  log('copy project name still says Sample Project', currentTitle(doc) === 'Sample Project', currentTitle(doc));

  const copyCards = doc.querySelectorAll('.kf-card');
  log('copy has all 5 original tasks', copyCards.length === 5, copyCards.length);

  // ── 6. "Update existing" overwrites the matched project in-place ─────────────
  // First give the matched Sample Project a distinct local change so we can verify it was overwritten.
  // Switch to the original SMPL project.
  const origDemoOpt = Array.from(doc.getElementById('projectSelect').options)
    .find(o => o.textContent.includes('(SMPL)') && o.textContent.includes('Sample Project'));
  doc.getElementById('projectSelect').value = origDemoOpt.value;
  doc.getElementById('projectSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  const origDemoId = origDemoOpt.value;
  const countBeforeOverwrite = projectCount(doc);

  // Delete one task locally so the board is clearly "different" from the exported file.
  const firstCard = doc.querySelector('.kf-card');
  firstCard.click(); await wait(10);
  doc.getElementById('taskDeleteBtn').click(); await wait(10);
  doc.getElementById('confirmOkBtn').click(); await wait(20);
  const cardsAfterLocalDelete = doc.querySelectorAll('.kf-card');
  log('local delete reduces card count to 4', cardsAfterLocalDelete.length === 4, cardsAfterLocalDelete.length);

  // Now import the original 5-task export and choose "Update existing".
  await triggerImport(doc, demoExportText);
  log('conflict modal shown for overwrite path', conflictVisible(doc));
  const conflictMsg = doc.getElementById('importConflictMessage').innerHTML;
  log('conflict message names the matched project', conflictMsg.indexOf('Sample Project') !== -1, conflictMsg.slice(0,80));
  doc.getElementById('importConflictOverwriteBtn').click();
  await wait(20);
  log('conflict modal hidden after overwrite', !conflictVisible(doc));
  log('overwrite does NOT add a new project entry (same count)', projectCount(doc) === countBeforeOverwrite, projectCount(doc) + ' vs ' + countBeforeOverwrite);
  log('overwritten project is still active', currentTitle(doc) === 'Sample Project', currentTitle(doc));
  log('overwritten project still has SMPL key', currentKey(doc) === 'SMPL', currentKey(doc));
  log('overwritten project has the original id preserved',
      doc.getElementById('projectSelect').value === origDemoId, doc.getElementById('projectSelect').value + ' vs ' + origDemoId);

  const cardsAfterOverwrite = doc.querySelectorAll('.kf-card');
  log('overwrite restores all 5 tasks (local delete was undone)', cardsAfterOverwrite.length === 5, cardsAfterOverwrite.length);

  // ── 7. Escape key closes the conflict modal ─────────────────────────────────
  await triggerImport(doc, demoExportText);
  log('conflict modal shows for escape-key test', conflictVisible(doc));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape key closes the conflict modal', !conflictVisible(doc));
  log('Escape does not add a project', projectCount(doc) === countBeforeOverwrite, projectCount(doc));

  console.log('\nImport conflict test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
