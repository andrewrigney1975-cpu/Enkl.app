const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(file){ const self = this; setTimeout(() => { self.result = file._text; if (self.onload) self.onload(); }, 0); }
  };
}

const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
installFakeFileReader(window);
let lastBlobText = null;
window.URL.createObjectURL = function(){ return 'blob://fake'; };
window.URL.revokeObjectURL = function(){};
const OrigBlob = window.Blob;
window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // --- 1. Export the seeded Sample Project and inspect the raw doc shape ---
  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);

  log('export includes a top-level members array', Array.isArray(exported.members), JSON.stringify(exported.members));
  log('export has exactly the 2 seeded members', exported.members.length === 2, exported.members.map(m=>m.name).join(','));
  log('each exported member has id, name, color', exported.members.every(m => m.id && m.name && m.color));

  function findNode(nodes, title){
    for (const n of nodes) {
      if (n.title === title) return n;
      const found = findNode(n.subtasks || [], title);
      if (found) return found;
    }
    return null;
  }
  const designNode = findNode(exported.hierarchy, 'Configure project modules, columns and details');
  log('hierarchy node for an assigned task includes assigneeId + assignee name', !!designNode && !!designNode.assigneeId && designNode.assignee === 'John Brown', designNode ? JSON.stringify({assigneeId: designNode.assigneeId, assignee: designNode.assignee}) : 'not found');
  const researchNode = findNode(exported.hierarchy, 'Look at Project and App Settings');
  log('hierarchy node for an unassigned task has null assignee', researchNode && researchNode.assigneeId === null && researchNode.assignee === null);

  // --- 2. Import that file back in as a new project, verify members + assignments survive ---
  const fileInput = doc.getElementById('importFileInput');
  const fakeFile = new FakeFile(lastBlobText);
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  // Conflict modal: same SMPL key — choose "Import as copy".
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }

  const toastTexts = Array.from(doc.querySelectorAll('.kf-toast')).map(t => t.textContent);
  log('import toast mentions team members', toastTexts.some(t => t.indexOf('team member') !== -1), toastTexts.join(' | '));

  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const memberNames = Array.from(doc.querySelectorAll('.kf-member-name-input')).map(i => i.value).sort();
  log('imported project has both members', memberNames.length === 2 && memberNames.includes('John Brown') && memberNames.includes('Jan Smith'), memberNames.join(','));
  doc.getElementById('teamDoneBtn').click();
  await wait(10);

  const designCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Configure project modules, columns and details') !== -1);
  log('imported task still shows the right assignee avatar', designCard.innerHTML.indexOf('title="Assigned to John Brown"') !== -1, designCard.innerHTML);

  const researchCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  log('previously-unassigned task remains unassigned (no avatar)', researchCard.querySelector('.kf-avatar') === null);

  // --- 3. Re-export the imported project; member set + assignments should be stable ---
  doc.getElementById('exportBtn').click();
  await wait(20);
  const reExported = JSON.parse(lastBlobText);
  log('re-export still has 2 members', reExported.members.length === 2);
  const reDesignNode = findNode(reExported.hierarchy, 'Configure project modules, columns and details');
  log('re-export assignment matches original (by name)', reDesignNode.assignee === 'John Brown');

  // --- 4. Hand-edited / legacy file without a members array should import fine, unassigned ---
  const noMembersDoc = JSON.parse(JSON.stringify(exported));
  delete noMembersDoc.members;
  const fakeFile2 = new FakeFile(JSON.stringify(noMembersDoc));
  Object.defineProperty(fileInput, 'files', { value: [fakeFile2], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  // Conflict modal may appear (same project key) — choose "Import as copy".
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  const avatarsAfterNoMembersImport = doc.querySelectorAll('.kf-card .kf-avatar');
  log('file without a members array imports cleanly with no assignees', avatarsAfterNoMembersImport.length === 0, avatarsAfterNoMembersImport.length);
  const toastTexts2 = Array.from(doc.querySelectorAll('.kf-toast')).map(t => t.textContent);
  log('no crash / friendly toast for members-less file', toastTexts2[toastTexts2.length-1].indexOf('Imported') !== -1, toastTexts2[toastTexts2.length-1]);

  console.log('\nMember export/import test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
