const { JSDOM } = require('jsdom');
const fs = require('fs');
const nodeCrypto = require('node:crypto');
const html = fs.readFileSync('../dist/index.html', 'utf8');

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(file){ const self = this; setTimeout(() => { self.result = file._text; if(self.onload) self.onload(); }, 0); }
  };
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  let lastBlobText = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;

  /* jsdom has no Web Crypto implementation — polyfill with Node's
     before any app startup code runs. */
  Object.defineProperty(window, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });

  installFakeFileReader(window);
  window.URL.createObjectURL = function(){ return 'blob://fake'; };
  window.URL.revokeObjectURL = function(){};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  function findCardByTitle(title){
    return Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(title) !== -1);
  }
  function getStoredTask(taskTitle){
    const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
    const project = raw.projects[raw.currentProjectId];
    return Object.values(project.tasks).find(t => t.title === taskTitle);
  }

  // --- 1. Open a seeded task, note its title + original plaintext description ---
  let card = doc.querySelector('.kf-card');
  card.click();
  await wait(10);
  const taskTitle = doc.getElementById('taskTitleInput').value;
  const originalDescription = doc.getElementById('taskDescInput').value;
  log('picked a seeded task with a non-empty description', originalDescription.length > 0, JSON.stringify({taskTitle, originalDescription}));
  log('Private checkbox exists and starts unchecked', doc.getElementById('taskPrivateCheckbox') !== null && doc.getElementById('taskPrivateCheckbox').checked === false);

  // --- 2. Mark it private: check the box, save, fill in the Set Key modal ---
  doc.getElementById('taskPrivateCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(30);
  log('checking Private + Save opens the Set Private Key modal (task modal still open underneath)', !doc.getElementById('setPrivateKeyOverlay').classList.contains('hidden'));

  doc.getElementById('setPrivateKeyInput').value = 'hunter2';
  doc.getElementById('setPrivateKeyConfirmInput').value = 'hunter2different';
  doc.getElementById('setPrivateKeyConfirmBtn').click();
  await wait(30);
  log('mismatched confirm key shows an inline error and keeps the modal open', !doc.getElementById('setPrivateKeyError').classList.contains('hidden') && !doc.getElementById('setPrivateKeyOverlay').classList.contains('hidden'));

  doc.getElementById('setPrivateKeyInput').value = 'hunter2';
  doc.getElementById('setPrivateKeyConfirmInput').value = 'hunter2';
  doc.getElementById('setPrivateKeyConfirmBtn').click();
  await wait(600);
  log('matching key closes the Set Private Key modal', doc.getElementById('setPrivateKeyOverlay').classList.contains('hidden'));
  log('task modal closes after the private save completes', doc.getElementById('taskOverlay').classList.contains('hidden'));

  // --- 3. Core security property: plaintext must not survive in storage ---
  const rawStorageString = window.localStorage.getItem('kanbanflow_v1_db');
  log('raw localStorage no longer contains the plaintext description', rawStorageString.indexOf(originalDescription) === -1);

  let storedTask = getStoredTask(taskTitle);
  log('task is flagged isPrivate', storedTask.isPrivate === true);
  log('task has a salt, verifier, ciphertext and IV', !!storedTask.privateSalt && !!storedTask.privateVerifier && !!storedTask.encryptedDescription && !!storedTask.encryptionIv);
  log('plaintext description field is cleared', storedTask.description === '');

  // --- 4. Reopening now prompts for the key instead of showing the form ---
  card = findCardByTitle(taskTitle);
  log('board card shows the private lock chip', card.querySelector('.kf-private-chip') !== null);
  card.click();
  await wait(10);
  log('reopening a private task shows the Unlock modal, not the task form', !doc.getElementById('unlockPrivateTaskOverlay').classList.contains('hidden') && doc.getElementById('taskOverlay').classList.contains('hidden'));

  // --- 5. Wrong key ---
  doc.getElementById('unlockPrivateTaskInput').value = 'wrongkey';
  doc.getElementById('unlockPrivateTaskConfirmBtn').click();
  await wait(600);
  log('an incorrect key shows an inline error and the task form never opens', !doc.getElementById('unlockPrivateTaskError').classList.contains('hidden') && doc.getElementById('taskOverlay').classList.contains('hidden'));
  log('unlock modal stays open for a retry after a wrong key', !doc.getElementById('unlockPrivateTaskOverlay').classList.contains('hidden'));

  // --- 6. Correct key reveals the full form with the description decrypted ---
  doc.getElementById('unlockPrivateTaskInput').value = 'hunter2';
  doc.getElementById('unlockPrivateTaskConfirmBtn').click();
  await wait(600);
  log('correct key closes the unlock modal and opens the full task form', doc.getElementById('unlockPrivateTaskOverlay').classList.contains('hidden') && !doc.getElementById('taskOverlay').classList.contains('hidden'));
  log('full fields are visible and reduced view is hidden', !doc.getElementById('taskFullFields').classList.contains('hidden') && doc.getElementById('taskPrivateReducedView').classList.contains('hidden'));
  log('decrypted description matches the original exactly', doc.getElementById('taskDescInput').value === originalDescription, doc.getElementById('taskDescInput').value);

  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // --- 7. "Continue without a key" shows only the title ---
  card = findCardByTitle(taskTitle);
  card.click();
  await wait(10);
  doc.getElementById('unlockPrivateTaskContinueBtn').click();
  await wait(20);
  log('"Continue without a key" opens the task modal in reduced view', !doc.getElementById('taskOverlay').classList.contains('hidden') && !doc.getElementById('taskPrivateReducedView').classList.contains('hidden'));
  log('reduced view hides the full field set', doc.getElementById('taskFullFields').classList.contains('hidden'));
  log('reduced view shows only the title', doc.getElementById('taskPrivateReducedTitle').textContent === taskTitle);
  log('reduced view hides the Save button (nothing editable)', doc.getElementById('taskSaveBtn').classList.contains('hidden'));
  doc.getElementById('taskModalClose').click();
  await wait(10);

  // --- 8. Dependency Map shows a lock badge for this task ---
  doc.getElementById('depMapBtn').click();
  await wait(20);
  const depMapHTML = doc.getElementById('depMapInner').innerHTML;
  log('Dependency Map renders a "Private task" lock badge', depMapHTML.indexOf('Private task') !== -1);
  doc.getElementById('depMapClose').click();
  await wait(10);

  // --- 9. Export preserves the encrypted fields (not the plaintext) ---
  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  function findExportedNode(nodes, title){
    for(const n of nodes){
      if(n.title === title) return n;
      const found = findExportedNode(n.subtasks || [], title);
      if(found) return found;
    }
    return null;
  }
  const exportedNode = findExportedNode(exported.hierarchy, taskTitle);
  log('exported node carries the encrypted description and crypto fields', !!exportedNode && exportedNode.isPrivate === true && !!exportedNode.encryptedDescription && !!exportedNode.privateSalt && !!exportedNode.privateVerifier && !!exportedNode.encryptionIv);
  log('exported node does not carry the plaintext description', exportedNode.description === '');

  /* Independent, UI-free verification that the exported ciphertext is
     genuinely decryptable — re-derives the key and decrypts using
     Node's own crypto primitives (mirroring crypto.js's PBKDF2 + SHA-256
     verifier + AES-GCM exactly), rather than round-tripping through the
     app's import UI. (The app's "import as copy" flow was found to
     regenerate task ids in a way that leaves already-rendered board
     cards referencing stale ids — a pre-existing quirk reproducible with
     a plain, non-private task and confirmed unrelated to this feature —
     so re-clicking a reimported card here would be testing that quirk,
     not this feature.) */
  function verifyEncryptedDescription(node, password){
    const PBKDF2_ITERATIONS = 275000;
    const salt = Buffer.from(node.privateSalt, 'base64');
    const derivedBits = nodeCrypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
    const verifier = nodeCrypto.createHash('sha256').update(derivedBits).digest('base64');
    if(verifier !== node.privateVerifier) throw new Error('verifier mismatch');
    const ciphertextAndTag = Buffer.from(node.encryptedDescription, 'base64');
    const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
    const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
    const iv = Buffer.from(node.encryptionIv, 'base64');
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', derivedBits, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  try {
    const independentlyDecrypted = verifyEncryptedDescription(exportedNode, 'hunter2');
    log('exported ciphertext independently decrypts (Node crypto) to the original plaintext', independentlyDecrypted === originalDescription, independentlyDecrypted);
  } catch(e){
    log('exported ciphertext independently decrypts (Node crypto) to the original plaintext', false, e.message);
  }
  try {
    verifyEncryptedDescription(exportedNode, 'wrongkey');
    log('the wrong key is rejected by the verifier', false, 'expected verifier mismatch to throw');
  } catch(e){
    log('the wrong key is rejected by the verifier', e.message === 'verifier mismatch', e.message);
  }

  // --- 10. Turning Private back off (while unlocked) restores plaintext ---
  card = findCardByTitle(taskTitle);
  card.click();
  await wait(10);
  doc.getElementById('unlockPrivateTaskInput').value = 'hunter2';
  doc.getElementById('unlockPrivateTaskConfirmBtn').click();
  await wait(600);
  doc.getElementById('taskPrivateCheckbox').checked = false;
  doc.getElementById('taskSaveBtn').click();
  await wait(30);
  const revertedTask = getStoredTask(taskTitle);
  log('unchecking Private reverts isPrivate to false', revertedTask.isPrivate === false);
  log('crypto fields are cleared', revertedTask.privateSalt === null && revertedTask.privateVerifier === null && revertedTask.encryptedDescription === null && revertedTask.encryptionIv === null);
  log('plaintext description is restored in storage', revertedTask.description === originalDescription, revertedTask.description);

  console.log('\nPrivate task test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
