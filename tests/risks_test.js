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

  log('Risks button exists in the header', !!doc.getElementById('risksBtn'));
  doc.getElementById('risksBtn').click();
  await wait(20);
  log('clicking the button opens the Risks modal', !doc.getElementById('risksOverlay').classList.contains('hidden'));
  log('modal uses the kf-modal-lg size class (same as Dependency Map)', doc.querySelector('#risksOverlay .kf-modal').classList.contains('kf-modal-lg'));
  log('seeded project has no risks yet (empty state shown)', doc.getElementById('risksList').textContent.indexOf('No risks yet') !== -1);

  doc.getElementById('risksModalClose').click();
  await wait(10);
  doc.getElementById('documentsBtn').click();
  await wait(20);
  doc.getElementById('addDocumentBtn').click();
  await wait(10);
  doc.getElementById('documentTitleInput').value = 'Mitigation Plan';
  doc.getElementById('documentFormSaveBtn').click();
  await wait(20);
  doc.getElementById('documentsModalClose').click();
  await wait(10);

  doc.getElementById('risksBtn').click();
  await wait(20);
  doc.getElementById('addRiskBtn').click();
  await wait(10);

  log('clicking New Risk switches to the form view', !doc.getElementById('risksFormView').classList.contains('hidden'));
  log('Delete button is hidden when creating a new risk', doc.getElementById('deleteRiskBtn').classList.contains('hidden'));

  const likelihoodOptions = Array.from(doc.getElementById('riskLikelihoodSelect').options).map(o => o.textContent);
  log('likelihood 1 is "Rare"', likelihoodOptions[0].indexOf('Rare') !== -1, likelihoodOptions[0]);
  log('likelihood 2 is "Unlikely"', likelihoodOptions[1].indexOf('Unlikely') !== -1, likelihoodOptions[1]);
  log('likelihood 3 is "Moderate"', likelihoodOptions[2].indexOf('Moderate') !== -1, likelihoodOptions[2]);
  log('likelihood 4 is "Likely"', likelihoodOptions[3].indexOf('Likely') !== -1, likelihoodOptions[3]);
  log('likelihood 5 is "Almost certain"', likelihoodOptions[4].indexOf('Almost certain') !== -1, likelihoodOptions[4]);

  const impactOptions = Array.from(doc.getElementById('riskImpactSelect').options).map(o => o.textContent);
  log('impact 1 is "Insignificant"', impactOptions[0].indexOf('Insignificant') !== -1, impactOptions[0]);
  log('impact 2 is "Minor"', impactOptions[1].indexOf('Minor') !== -1, impactOptions[1]);
  log('impact 3 is "Significant"', impactOptions[2].indexOf('Significant') !== -1, impactOptions[2]);
  log('impact 4 is "Major"', impactOptions[3].indexOf('Major') !== -1, impactOptions[3]);
  log('impact 5 is "Severe"', impactOptions[4].indexOf('Severe') !== -1, impactOptions[4]);

  doc.getElementById('riskLikelihoodSelect').value = '5';
  doc.getElementById('riskImpactSelect').value = '5';
  doc.getElementById('riskLikelihoodSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('5x5 = score 25, banded Critical', doc.getElementById('riskScorePreview').textContent.indexOf('Score 25') !== -1 &&
      doc.getElementById('riskScorePreview').textContent.indexOf('Critical') !== -1, doc.getElementById('riskScorePreview').textContent);

  doc.getElementById('riskLikelihoodSelect').value = '1';
  doc.getElementById('riskImpactSelect').value = '1';
  doc.getElementById('riskImpactSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('1x1 = score 1, banded Low', doc.getElementById('riskScorePreview').textContent.indexOf('Score 1') !== -1 &&
      doc.getElementById('riskScorePreview').textContent.indexOf('Low') !== -1, doc.getElementById('riskScorePreview').textContent);

  const docCheckboxes = doc.querySelectorAll('#riskDocumentPicker input[type=checkbox]');
  log('document picker lists the one existing document', docCheckboxes.length === 1, docCheckboxes.length);
  log('document picker shows the document\u2019s key and title', doc.getElementById('riskDocumentPicker').textContent.indexOf('Mitigation Plan') !== -1);

  doc.getElementById('riskTitleInput').value = 'Key vendor may miss delivery date';
  doc.getElementById('riskDescriptionInput').value = 'The primary hosting vendor has a history of delayed delivery.';
  doc.getElementById('riskLikelihoodSelect').value = '3';
  doc.getElementById('riskImpactSelect').value = '4';
  doc.getElementById('riskMitigationsInput').value = 'Maintain a backup vendor relationship.';
  doc.getElementById('riskStatusSelect').value = 'in_review';
  doc.getElementById('riskCloseTargetInput').value = '2026-09-01';
  docCheckboxes[0].checked = true;
  doc.getElementById('riskFormSaveBtn').click();
  await wait(20);

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let risk = proj.risks.find(r => r.title === 'Key vendor may miss delivery date');
  log('risk was created', !!risk);
  log('key follows the <PROJECT>-RISK-NNN format, zero-padded', risk.key === 'SMPL-RISK-001', risk.key);
  log('likelihood persisted correctly', risk.likelihood === 3, risk.likelihood);
  log('impact persisted correctly', risk.impact === 4, risk.impact);
  log('status persisted correctly', risk.status === 'in_review', risk.status);
  log('target closure date persisted', !!risk.dateToClose);
  log('linked document persisted in documentIds', risk.documentIds.length === 1, JSON.stringify(risk.documentIds));
  log('dateClosed is null (status is not Closed)', risk.dateClosed === null, risk.dateClosed);

  const rowText = doc.getElementById('risksList').textContent;
  log('list shows the risk key', rowText.indexOf('SMPL-RISK-001') !== -1);
  log('list shows the status label', rowText.indexOf('In Review') !== -1);
  log('list shows the computed score (3x4=12)', rowText.indexOf('Score 12') !== -1, rowText);
  log('list shows the linked document count', rowText.indexOf('1 doc') !== -1, rowText);

  const riskRow = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Key vendor') !== -1);
  riskRow.click();
  await wait(10);
  log('reopening shows the previously saved likelihood', doc.getElementById('riskLikelihoodSelect').value === '3');
  log('reopening shows the previously saved document link checked', doc.getElementById('riskDocumentPicker').querySelector('input[type=checkbox]').checked);
  doc.getElementById('riskStatusSelect').value = 'closed';
  doc.getElementById('riskClosedDateInput').value = '2026-07-01';
  doc.getElementById('riskFormSaveBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  risk = proj.risks.find(r => r.title === 'Key vendor may miss delivery date');
  log('status updated to closed', risk.status === 'closed');
  log('dateClosed persisted', !!risk.dateClosed);

  doc.getElementById('risksModalClose').click();
  await wait(10);
  doc.getElementById('documentsBtn').click();
  await wait(20);
  const docRowToDelete = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Mitigation Plan') !== -1);
  docRowToDelete.click();
  await wait(10);
  doc.getElementById('deleteDocumentBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  risk = proj.risks.find(r => r.title === 'Key vendor may miss delivery date');
  log('risk survives the linked document\u2019s deletion', !!risk);
  log('risk\u2019s documentIds no longer references the deleted document', risk.documentIds.length === 0, JSON.stringify(risk.documentIds));

  doc.getElementById('documentsModalClose').click();
  await wait(10);
  doc.getElementById('risksBtn').click();
  await wait(20);
  const riskRowAgain = Array.from(doc.querySelectorAll('.kf-release-row')).find(r => r.textContent.indexOf('Key vendor') !== -1);
  riskRowAgain.click();
  await wait(10);
  doc.getElementById('deleteRiskBtn').click();
  await wait(10);
  log('delete shows a confirmation dialog', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('risk is actually removed', !proj.risks.find(r => r.title === 'Key vendor may miss delivery date'));

  doc.getElementById('risksModalClose').click();
  await wait(10);
  doc.getElementById('risksBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the Risks modal', doc.getElementById('risksOverlay').classList.contains('hidden'));

  console.log('\nRisks feature test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
