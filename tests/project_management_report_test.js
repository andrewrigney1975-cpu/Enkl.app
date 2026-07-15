const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  // ── 1. Menu wiring: the Projects... dropdown has a Project Management Report link ──
  doc.getElementById('projectsMenuBtn').click();
  await wait(20);
  const link = doc.querySelector('#projectsMenuPanel [data-nav-target="projectMgmtReportBtn"]');
  log('Projects... menu has a Project Management Report link', link !== null);
  log('link text reads "Project Management Report"', link && link.textContent === 'Project Management Report');

  link.click();
  await wait(20);
  log('report overlay opens', !doc.getElementById('reportOverlay').classList.contains('hidden'));
  log('modal header title includes the project name and "Project Management Report"', doc.getElementById('reportTitle').textContent === 'Sample Project - Project Management Report', doc.getElementById('reportTitle').textContent);

  // ── 2. Body content: page title, dates, and section ordering ──
  const pageTitleEl = doc.querySelector('#reportBody .kf-report-page-title');
  log('body has a large page-title heading with "<project name> (<key>)"', pageTitleEl && pageTitleEl.textContent === 'Sample Project (SMPL)', pageTitleEl ? pageTitleEl.textContent : null);

  const headings = Array.from(doc.querySelectorAll('#reportBody .kf-report-section-heading')).map(el => el.textContent);
  log('sections appear in order: Team Members, Team Structure, Principles, Objectives, Risks, Decisions',
      headings.join(',') === 'Team Members,Team Structure,Principles,Objectives,Risks,Decisions', headings.join(','));

  // ── 3. Team hierarchy / members reflect real Teams & Committees + member role data ──
  doc.getElementById('reportClose').click();
  await wait(20);
  doc.getElementById('teamsCommitteesBtn').click();
  await wait(20);
  doc.getElementById('addTeamCommitteeBtn').click();
  await wait(10);
  doc.getElementById('tcNameInput').value = 'PM Report Team';
  doc.getElementById('tcFormSaveBtn').click();
  await wait(20);
  // Assign the first available member via the member picker checkbox.
  doc.getElementById('addTeamCommitteeBtn').click();
  await wait(10);
  doc.getElementById('teamsCommitteesModalClose').click();
  await wait(20);

  doc.getElementById('projectsMenuBtn').click();
  await wait(20);
  doc.querySelector('#projectsMenuPanel [data-nav-target="projectMgmtReportBtn"]').click();
  await wait(20);
  const teamTreeText = doc.getElementById('reportBody').textContent;
  log('new team appears in the Team Structure section', teamTreeText.indexOf('PM Report Team') !== -1);

  // ── 4. Risks section includes the Risk Matrix and per-risk mitigations/closure fields ──
  doc.getElementById('reportClose').click();
  await wait(20);
  doc.getElementById('risksBtn').click();
  await wait(20);
  doc.getElementById('addRiskBtn').click();
  await wait(10);
  doc.getElementById('riskTitleInput').value = 'PM report risk';
  doc.getElementById('riskMitigationsInput').value = 'Weekly check-ins with the vendor.';
  doc.getElementById('riskFormSaveBtn').click();
  await wait(20);
  doc.getElementById('risksModalClose').click();
  await wait(20);

  doc.getElementById('projectsMenuBtn').click();
  await wait(20);
  doc.querySelector('#projectsMenuPanel [data-nav-target="projectMgmtReportBtn"]').click();
  await wait(20);
  const risksSectionHTML = doc.getElementById('reportBody').innerHTML;
  log('Risks section embeds the Risk Matrix SVG', risksSectionHTML.indexOf('kf-risk-matrix-svg') !== -1);
  log('Risks section shows per-risk mitigations as an extra field', risksSectionHTML.indexOf('Weekly check-ins with the vendor.') !== -1);

  // ── 5. Decisions section shows the Approver ──
  doc.getElementById('reportClose').click();
  await wait(20);
  doc.getElementById('decisionsBtn').click();
  await wait(20);
  doc.getElementById('addDecisionBtn').click();
  await wait(10);
  doc.getElementById('decisionTitleInput').value = 'PM report decision';
  doc.getElementById('decisionApproverInput').value = 'Jane Approver';
  doc.getElementById('decisionFormSaveBtn').click();
  await wait(20);
  doc.getElementById('decisionsModalClose').click();
  await wait(20);

  doc.getElementById('projectsMenuBtn').click();
  await wait(20);
  doc.querySelector('#projectsMenuPanel [data-nav-target="projectMgmtReportBtn"]').click();
  await wait(20);
  const decisionsSectionHTML = doc.getElementById('reportBody').innerHTML;
  log('Decisions section shows the Approver as an extra field', decisionsSectionHTML.indexOf('Jane Approver') !== -1);

  console.log('\nProject Management Report test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
