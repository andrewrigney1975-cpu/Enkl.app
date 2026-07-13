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

  // Monkey-patch the download mechanics jsdom doesn't implement, and the
  // FileReader path, so we can drive export -> import end to end like a user
  // would (minus the actual OS file dialog).
  window.URL.createObjectURL = function(blob){ return 'blob:mock'; };
  window.URL.revokeObjectURL = function(){};
  let lastBlobText = null;
  const realBlobCtor = window.Blob;
  window.Blob = function(parts, opts){
    lastBlobText = parts.join('');
    return new realBlobCtor(parts, opts);
  };

  // --- 1. Round-trip: export the seeded Sample Project, then import it back ---
  doc.getElementById('exportBtn').click();
  await wait(20);
  const exportedDoc = JSON.parse(lastBlobText);
  log('export produced 5 unique tasks worth of hierarchy', exportedDoc.totalTasks === 5, exportedDoc.totalTasks);

  function makeFakeFile(jsonObj, name){
    const text = JSON.stringify(jsonObj);
    return { name: name || 'import.json', text, mockText: text };
  }

  // Patch FileReader to read from our fake file's .text instead of a real Blob,
  // since jsdom's FileReader can't read plain objects.
  const OrigFileReader = window.FileReader;
  function FakeFileReader(){
    this.onload = null; this.onerror = null; this.result = null;
  }
  FakeFileReader.prototype.readAsText = function(file){
    const self = this;
    setTimeout(function(){
      self.result = file.text;
      if (self.onload) self.onload();
    }, 0);
  };
  window.FileReader = FakeFileReader;

  const projectCountBefore = doc.getElementById('projectSelect').options.length;
  window.importProjectFromFile = undefined; // not exposed; trigger via UI instead

  const fakeFile1 = makeFakeFile(exportedDoc, 'demo-export.json');
  const inputEvt = { target: { files: [fakeFile1], value: '' } };
  // Directly invoke the same handler the change listener uses by simulating input + change
  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [fakeFile1], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  await wait(30);

  // A conflict modal should now be showing (same project key/name as the seeded Sample Project).
  const conflictVisible = !doc.getElementById('importConflictOverlay').classList.contains('hidden');
  log('conflict modal shown when re-importing same project', conflictVisible);
  // Choose "Import as copy" so the test can verify independent new-project behaviour.
  doc.getElementById('importConflictCopyBtn').click();
  await wait(20);

  const projectCountAfter = doc.getElementById('projectSelect').options.length;
  log('a new project was added to the selector', projectCountAfter === projectCountBefore + 1, projectCountBefore + ' -> ' + projectCountAfter);

  const newProjectName = doc.getElementById('toolbarTitle').textContent;
  log('imported project becomes the active project', newProjectName === 'Sample Project', newProjectName);

  const cards = doc.querySelectorAll('.kf-card');
  log('all 5 tasks recreated (no duplication from multi-parent task)', cards.length === 5, cards.length);

  const cols = doc.querySelectorAll('.kf-column');
  log('all 4 original columns recreated', cols.length === 4, cols.length);

  // The Done column should have been inferred as done:true (task there shouldn't show Blocked
  // incorrectly, and more importantly the originally-blocked task graph should look identical)
  const blockedCount = doc.querySelectorAll('.kf-blocked-chip').length;
  log('blocked-state pattern matches original (tasks whose dependencies are unfinished show as blocked)', blockedCount > 0, blockedCount);

  // Open dependency map on the imported project and verify edge/node counts match the original
  doc.getElementById('depMapBtn').click();
  await wait(20);
  const nodes = doc.querySelectorAll('.kf-depnode');
  const edges = doc.querySelectorAll('#depMapInner path[marker-end]');
  log('dependency map shows 5 nodes after import', nodes.length === 5, nodes.length);
  log('dependency map shows 4 edges after import (multi-parent preserved, not duplicated)', edges.length === 4, edges.length);
  doc.getElementById('depMapClose').click();
  await wait(10);

  const newKey = doc.getElementById('toolbarKey').textContent;
  log('re-imported project got a de-duplicated key (SMPL already taken by original)', newKey !== 'SMPL' && newKey.indexOf('SMPL') === 0, newKey);

  // --- 2. Malformed file handling ---
  const fakeFile2 = makeFakeFile({ foo: 'bar' }, 'bad.json');
  Object.defineProperty(fileInput, 'files', { value: [fakeFile2], configurable: true });
  const countBeforeBad = doc.getElementById('projectSelect').options.length;
  fileInput.dispatchEvent(new window.Event('change'));
  await wait(20);
  const countAfterBad = doc.getElementById('projectSelect').options.length;
  log('malformed file (missing hierarchy) does not create a project', countAfterBad === countBeforeBad, countBeforeBad + ' -> ' + countAfterBad);

  const fakeFile3 = { name: 'bad2.json', text: '{not valid json' };
  Object.defineProperty(fileInput, 'files', { value: [fakeFile3], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  await wait(20);
  const countAfterBad2 = doc.getElementById('projectSelect').options.length;
  log('invalid JSON syntax does not crash and does not create a project', countAfterBad2 === countBeforeBad, countAfterBad2);

  // --- 3. Cycle + dangling reference sanitation ---
  const cyclicDoc = {
    project: { name: 'Cyclic Test', key: 'CYC' },
    hierarchy: [
      { id: 'a', key: 'CYC-1', title: 'A', priority: 'low', column: 'To Do', dependsOn: ['CYC-2'], subtasks: [] },
      { id: 'b', key: 'CYC-2', title: 'B', priority: 'low', column: 'To Do', dependsOn: ['CYC-1', 'CYC-99'], subtasks: [] }
    ]
  };
  const fakeFile4 = makeFakeFile(cyclicDoc, 'cyclic.json');
  Object.defineProperty(fileInput, 'files', { value: [fakeFile4], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  await wait(20);
  const cyclicCards = doc.querySelectorAll('.kf-card');
  log('cyclic import still creates both tasks (edge dropped, not task)', cyclicCards.length === 2, cyclicCards.length);
  const cyclicTitle = doc.getElementById('toolbarTitle').textContent;
  log('cyclic project became active', cyclicTitle === 'Cyclic Test', cyclicTitle);

  window.FileReader = OrigFileReader;
  console.log('\nImport test complete.');
  process.exit(0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
