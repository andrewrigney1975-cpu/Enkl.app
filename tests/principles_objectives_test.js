const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
  };
}

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
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra!==undefined?' :: '+extra:'')); }

  const group = doc.getElementById('principlesBtn').parentElement;
  const order = Array.from(group.children).map(el => el.id);
  log('Principles button exists', !!doc.getElementById('principlesBtn'));
  log('Objectives button exists', !!doc.getElementById('objectivesBtn'));
  log('Principles comes before Objectives within the movable nav group', order.indexOf('principlesBtn') < order.indexOf('objectivesBtn'), order.join(','));
  const outerOrder = Array.from(doc.getElementById('healthBtn').parentElement.children).map(el => el.id);
  log('Health Dashboard comes before the movable nav group (which contains Principles/Objectives) overall',
      outerOrder.indexOf('healthBtn') < outerOrder.indexOf('headerMovableGroup'), outerOrder.join(','));

  doc.getElementById('principlesBtn').click();
  await wait(20);
  log('Principles modal is sized kf-modal-lg', doc.querySelector('#principlesOverlay .kf-modal').classList.contains('kf-modal-lg'));
  log('empty state shown initially', doc.getElementById('principlesList').textContent.indexOf('No principles yet') !== -1);

  doc.getElementById('addPrincipleBtn').click();
  await wait(10);
  doc.getElementById('principleTitleInput').value = 'Simplicity First';
  doc.getElementById('principleDescEditor').textContent = 'Prefer the simplest solution that works.';
  doc.getElementById('principleDocUrlInput').value = 'docs.example.com/principle1';
  doc.getElementById('principleFormSaveBtn').click();
  await wait(20);

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let principle1 = proj.principles.find(p => p.title === 'Simplicity First');
  log('Principle created with key format <PROJECT>-PRIN-001', principle1.key === proj.key + '-PRIN-001', principle1.key);
  log('Principle URL normalized with https://', principle1.documentUrl === 'https://docs.example.com/principle1', principle1.documentUrl);

  log('list row shows an external link for the principle\u2019s document URL', !!doc.querySelector('.kf-doc-row-link'));

  doc.getElementById('addPrincipleBtn').click();
  await wait(10);
  doc.getElementById('principleTitleInput').value = 'Security by Default';
  doc.getElementById('principleFormSaveBtn').click();
  await wait(20);

  doc.getElementById('principlesSearchInput').value = 'simplicity';
  doc.getElementById('principlesSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('search filters the principles list', doc.querySelectorAll('#principlesList .kf-release-row').length === 1);
  doc.getElementById('principlesSearchInput').value = '';
  doc.getElementById('principlesSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);

  doc.getElementById('principlesModalClose').click();
  await wait(10);

  doc.getElementById('objectivesBtn').click();
  await wait(20);
  log('Objectives modal is sized kf-modal-lg', doc.querySelector('#objectivesOverlay .kf-modal').classList.contains('kf-modal-lg'));

  doc.getElementById('addObjectiveBtn').click();
  await wait(10);
  log('the principle picker is labeled "Bound by these Principles"',
      doc.getElementById('objectivesFormView').textContent.indexOf('Bound by these Principles') !== -1);
  const objPrincipleCheckboxes = doc.querySelectorAll('#objectivePrinciplePicker input[type=checkbox]');
  log('picker lists both existing principles', objPrincipleCheckboxes.length === 2, objPrincipleCheckboxes.length);

  doc.getElementById('objectiveTitleInput').value = 'Ship a secure, simple MVP';
  doc.getElementById('objectiveDescEditor').textContent = 'Deliver the core flow without unnecessary complexity.';
  objPrincipleCheckboxes.forEach(cb => { cb.checked = true; });
  doc.getElementById('objectiveFormSaveBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  let objective1 = proj.objectives.find(o => o.title === 'Ship a secure, simple MVP');
  log('Objective created with key format <PROJECT>-OBJ-001', objective1.key === proj.key + '-OBJ-001', objective1.key);
  log('Objective\u2019s principleIds includes both principles', objective1.principleIds.length === 2);

  const objRowText = doc.getElementById('objectivesList').textContent;
  log('list shows the principle count', objRowText.indexOf('2 principles') !== -1, objRowText);

  doc.getElementById('objectivesModalClose').click();
  await wait(10);

  doc.getElementById('risksBtn').click();
  await wait(20);
  doc.getElementById('addRiskBtn').click();
  await wait(10);
  log('Risk form has an "Associated principle(s)" picker', !!doc.getElementById('riskPrinciplePicker'));
  log('Risk form has an "Associated objective(s)" picker', !!doc.getElementById('riskObjectivePicker'));
  const riskPrinBoxes = doc.querySelectorAll('#riskPrinciplePicker input[type=checkbox]');
  const riskObjBoxes = doc.querySelectorAll('#riskObjectivePicker input[type=checkbox]');
  log('risk\u2019s principle picker lists both principles', riskPrinBoxes.length === 2);
  log('risk\u2019s objective picker lists the one objective', riskObjBoxes.length === 1);

  doc.getElementById('riskTitleInput').value = 'Scope creep risk';
  riskPrinBoxes[0].checked = true;
  riskObjBoxes[0].checked = true;
  doc.getElementById('riskFormSaveBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  let risk1 = proj.risks.find(r => r.title === 'Scope creep risk');
  log('Risk\u2019s principleIds persisted', risk1.principleIds.length === 1);
  log('Risk\u2019s objectiveIds persisted', risk1.objectiveIds.length === 1);

  const riskRowText = doc.getElementById('risksList').textContent;
  log('risk list shows the principle and objective counts', riskRowText.indexOf('1 principle') !== -1 && riskRowText.indexOf('1 objective') !== -1, riskRowText);

  doc.getElementById('risksModalClose').click();
  await wait(10);

  doc.getElementById('principlesBtn').click();
  await wait(20);
  const principle1Row = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Simplicity First') !== -1);
  principle1Row.click();
  await wait(10);
  doc.getElementById('deletePrincipleBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  objective1 = proj.objectives.find(o => o.title === 'Ship a secure, simple MVP');
  risk1 = proj.risks.find(r => r.title === 'Scope creep risk');
  log('deleting the principle removes it from the Objective\u2019s principleIds', objective1.principleIds.length === 1);
  log('deleting the principle removes it from the Risk\u2019s principleIds', risk1.principleIds.length === 0);

  doc.getElementById('principlesModalClose').click();
  await wait(10);

  doc.getElementById('objectivesBtn').click();
  await wait(20);
  const objective1Row = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Ship a secure') !== -1);
  objective1Row.click();
  await wait(10);
  doc.getElementById('deleteObjectiveBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  risk1 = proj.risks.find(r => r.title === 'Scope creep risk');
  log('deleting the objective removes it from the Risk\u2019s objectiveIds', risk1.objectiveIds.length === 0);

  doc.getElementById('objectivesModalClose').click();
  await wait(10);

  doc.getElementById('appSettingsBtn').click();
  await wait(20);
  log('App Settings has a Principles checkbox', !!doc.getElementById('settingsShowPrinciplesBtn'));
  log('App Settings has an Objectives checkbox', !!doc.getElementById('settingsShowObjectivesBtn'));
  doc.getElementById('settingsShowPrinciplesBtn').checked = false;
  doc.getElementById('settingsShowPrinciplesBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('unchecking Principles hides its header button', doc.getElementById('principlesBtn').classList.contains('hidden'));
  doc.getElementById('settingsShowPrinciplesBtn').checked = true;
  doc.getElementById('settingsShowPrinciplesBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);

  doc.getElementById('principlesBtn').click();
  await wait(20);
  doc.getElementById('addPrincipleBtn').click();
  await wait(10);
  doc.getElementById('principleTitleInput').value = 'Round Trip Principle';
  doc.getElementById('principleFormSaveBtn').click();
  await wait(20);
  doc.getElementById('principlesModalClose').click();
  await wait(10);

  doc.getElementById('objectivesBtn').click();
  await wait(20);
  doc.getElementById('addObjectiveBtn').click();
  await wait(10);
  doc.getElementById('objectiveTitleInput').value = 'Round Trip Objective';
  const rtPrinRow = Array.from(doc.querySelectorAll('#objectivePrinciplePicker .kf-risk-doc-picker-row')).find(r => r.textContent.indexOf('Round Trip Principle') !== -1);
  const rtPrinCb = rtPrinRow.querySelector('input[type=checkbox]');
  rtPrinCb.checked = true;
  doc.getElementById('objectiveFormSaveBtn').click();
  await wait(20);
  doc.getElementById('objectivesModalClose').click();
  await wait(10);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  log('export includes a principles array', Array.isArray(exported.principles) && exported.principles.length > 0);
  log('export includes an objectives array', Array.isArray(exported.objectives) && exported.objectives.length > 0);
  const exportedObjective = exported.objectives.find(o => o.title === 'Round Trip Objective');
  log('exported objective carries principleIds', exportedObjective.principleIds.length === 1);

  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const importedProj = raw.projects[raw.currentProjectId];
  log('imported project has principles', importedProj.principles.length > 0);
  log('imported project has objectives', importedProj.objectives.length > 0);
  const importedObjective = importedProj.objectives.find(o => o.title === 'Round Trip Objective');
  const importedPrinciple = importedProj.principles.find(p => p.title === 'Round Trip Principle');
  log('imported objective\u2019s principleIds correctly re-mapped to the imported principle\u2019s NEW id',
      importedObjective.principleIds.length === 1 && importedObjective.principleIds[0] === importedPrinciple.id);

  const legacyDB = {
    projects: {
      legacy_p1: {
        id: 'legacy_p1', name: 'Legacy Project', key: 'LEG', taskCounter: 1,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: [] }],
        tasks: {},
        members: [], releases: [], taskTypes: [],
        documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1, approvers: [], roles: [],
        headerButtonVisibility: { documents: true, risks: true, decisions: true, health: true },
        startDate: null, endDate: null,
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
  const legacyProj = raw2.projects.legacy_p1;
  log('migration backfills an empty principles array', Array.isArray(legacyProj.principles) && legacyProj.principles.length === 0);
  log('migration backfills prinCounter starting at 1', legacyProj.prinCounter === 1);
  log('migration backfills an empty objectives array', Array.isArray(legacyProj.objectives) && legacyProj.objectives.length === 0);
  log('migration backfills objCounter starting at 1', legacyProj.objCounter === 1);

  const doc2 = dom2.window.document;
  doc2.getElementById('principlesBtn').click();
  await wait(20);
  log('Principles modal opens cleanly on a freshly-migrated legacy project', !doc2.getElementById('principlesOverlay').classList.contains('hidden'));
  doc2.getElementById('principlesModalClose').click();
  await wait(10);
  doc2.getElementById('objectivesBtn').click();
  await wait(20);
  log('Objectives modal opens cleanly on a freshly-migrated legacy project', !doc2.getElementById('objectivesOverlay').classList.contains('hidden'));

  // ── 10. Decisions: "Influenced by" Principles, "Alignment with" Objectives ──
  doc.getElementById('principlesBtn').click();
  await wait(20);
  doc.getElementById('addPrincipleBtn').click();
  await wait(10);
  doc.getElementById('principleTitleInput').value = 'Decision Test Principle';
  doc.getElementById('principleFormSaveBtn').click();
  await wait(20);
  doc.getElementById('principlesModalClose').click();
  await wait(10);

  doc.getElementById('objectivesBtn').click();
  await wait(20);
  doc.getElementById('addObjectiveBtn').click();
  await wait(10);
  doc.getElementById('objectiveTitleInput').value = 'Decision Test Objective';
  doc.getElementById('objectiveFormSaveBtn').click();
  await wait(20);
  doc.getElementById('objectivesModalClose').click();
  await wait(10);

  doc.getElementById('decisionsBtn').click();
  await wait(20);
  doc.getElementById('addDecisionBtn').click();
  await wait(10);
  log('Decision form has a picker labeled "Influenced by"', doc.getElementById('decisionsFormView').textContent.indexOf('Influenced by') !== -1);
  log('Decision form has a picker labeled "Alignment with"', doc.getElementById('decisionsFormView').textContent.indexOf('Alignment with') !== -1);

  const decPrinRow = Array.from(doc.querySelectorAll('#decisionPrinciplePicker .kf-risk-doc-picker-row')).find(r => r.textContent.indexOf('Decision Test Principle') !== -1);
  const decObjRow = Array.from(doc.querySelectorAll('#decisionObjectivePicker .kf-risk-doc-picker-row')).find(r => r.textContent.indexOf('Decision Test Objective') !== -1);
  log('"Influenced by" picker lists the principle', !!decPrinRow);
  log('"Alignment with" picker lists the objective', !!decObjRow);

  doc.getElementById('decisionTitleInput').value = 'Adopt the new architecture';
  decPrinRow.querySelector('input[type=checkbox]').checked = true;
  decObjRow.querySelector('input[type=checkbox]').checked = true;
  doc.getElementById('decisionFormSaveBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  let decision1 = proj.decisions.find(d => d.title === 'Adopt the new architecture');
  log('Decision\u2019s principleIds persisted', decision1.principleIds.length === 1);
  log('Decision\u2019s objectiveIds persisted', decision1.objectiveIds.length === 1);

  const decisionRowText = doc.getElementById('decisionsList').textContent;
  log('decision list shows the principle and objective counts', decisionRowText.indexOf('1 principle') !== -1 && decisionRowText.indexOf('1 objective') !== -1, decisionRowText);

  // ── Deleting the principle/objective also unlinks from the Decision ──────
  doc.getElementById('decisionsModalClose').click();
  await wait(10);
  doc.getElementById('principlesBtn').click();
  await wait(20);
  const dtPrinRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Decision Test Principle') !== -1);
  dtPrinRow.click();
  await wait(10);
  doc.getElementById('deletePrincipleBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  decision1 = proj.decisions.find(d => d.title === 'Adopt the new architecture');
  log('deleting the principle removes it from the Decision\u2019s principleIds', decision1.principleIds.length === 0);

  doc.getElementById('principlesModalClose').click();
  await wait(10);
  doc.getElementById('objectivesBtn').click();
  await wait(20);
  const dtObjRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Decision Test Objective') !== -1);
  dtObjRow.click();
  await wait(10);
  doc.getElementById('deleteObjectiveBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  decision1 = proj.decisions.find(d => d.title === 'Adopt the new architecture');
  log('deleting the objective removes it from the Decision\u2019s objectiveIds', decision1.objectiveIds.length === 0);
  doc.getElementById('objectivesModalClose').click();
  await wait(10);

  console.log('\nPrinciples/Objectives test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
