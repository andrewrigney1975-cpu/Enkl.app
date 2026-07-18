const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra!==undefined?' :: '+extra:'')); }

  const healthBtn = doc.getElementById('healthBtn');
  log('Health button\u2019s visible label is now "Health Dashboard"', healthBtn.textContent.trim() === 'Health Dashboard', healthBtn.textContent.trim());
  log('Health button\u2019s tooltip/title is "Health Dashboard"', healthBtn.getAttribute('title') === 'Health Dashboard', healthBtn.getAttribute('title'));

  const group = healthBtn.parentElement;
  const siblings = Array.from(group.children).map(el => el.id);
  const healthIdx = siblings.indexOf('healthBtn');
  const movableGroupIdx = siblings.indexOf('headerMovableGroup');
  log('Health Dashboard button comes immediately before the movable nav group (Principles/Objectives/Documents/Risks/Decisions/Teams & Committees)',
      healthIdx === movableGroupIdx - 1, siblings.join(','));

  const movableGroup = doc.getElementById('headerMovableGroup');
  const movableSiblings = Array.from(movableGroup.children).map(el => el.id);
  log('within the movable group, Documents/Risks/Decisions/Teams & Committees all still exist in their expected relative order',
      movableSiblings.indexOf('documentsBtn') < movableSiblings.indexOf('risksBtn') &&
      movableSiblings.indexOf('risksBtn') < movableSiblings.indexOf('decisionsBtn') &&
      movableSiblings.indexOf('decisionsBtn') < movableSiblings.indexOf('teamsCommitteesBtn'),
      movableSiblings.join(','));

  const iconSpan = healthBtn.querySelector('.kf-icon');
  log('Health button\u2019s icon data-icon is "heartPulse"', iconSpan.getAttribute('data-icon') === 'heartPulse', iconSpan.getAttribute('data-icon'));
  const iconSvg = iconSpan.querySelector('svg');
  log('rendered icon SVG contains two paths (heart outline + pulse line)', iconSvg.querySelectorAll('path').length === 2, iconSvg.querySelectorAll('path').length);
  const pathData = Array.from(iconSvg.querySelectorAll('path')).map(p => p.getAttribute('d'));
  log('heart-shaped path is present (closed shape ending in Z)', pathData[0].trim().endsWith('Z'), pathData[0]);
  log('pulse-line path is present and distinct from the heart path', pathData[1] !== pathData[0] && pathData[1].length > 0);

  healthBtn.click();
  await wait(20);
  log('clicking the relabeled, repositioned button still opens the dashboard modal', !doc.getElementById('healthOverlay').classList.contains('hidden'));
  doc.getElementById('healthClose').click();
  await wait(10);

  doc.getElementById('appSettingsBtn').click();
  await wait(20);
  const settingsIcon = doc.getElementById('settingsShowHealthBtn').closest('label').querySelector('.kf-icon');
  log('App Settings\u2019 Health Dashboard checkbox icon matches the header button\u2019s new heart-pulse icon',
      settingsIcon.getAttribute('data-icon') === 'heartPulse', settingsIcon.getAttribute('data-icon'));
  log('App Settings\u2019 checkbox label is still "Health Dashboard"',
      doc.getElementById('settingsShowHealthBtn').closest('label').textContent.indexOf('Health Dashboard') !== -1);

  // App Settings was later restructured into categorized ".kf-setting-row" rows — the old
  // ".kf-risk-doc-picker-row" class this looked for doesn't exist anymore. Not every row is a plain
  // checkbox toggle either (e.g. "Authentication and Provisioning" links out to SSO/SAML/SCIM config
  // instead), so rows with no <input> are filtered out rather than assumed away. The expected order
  // below was also stale — Time Tracking, Sub-Tasks, Change Auditing, and Retrospectives were added
  // to App Settings since this list was written, without updating it.
  const settingsRows = Array.from(doc.querySelectorAll('#appSettingsOverlay .kf-setting-row'));
  const rowIds = settingsRows.map(r => r.querySelector('input')).filter(Boolean).map(input => input.id);
  log('App Settings order matches the current header button order (Health Dashboard first, then the rest of App Settings’ own categorized order)',
      rowIds.join(',') === 'settingsShowHealthBtn,settingsShowDocumentsBtn,settingsShowWorkflowBtn,settingsShowTimeTrackingBtn,settingsShowSubTasksBtn,settingsShowChangeAuditingBtn,settingsShowPrinciplesBtn,settingsShowObjectivesBtn,settingsShowRisksBtn,settingsShowDecisionsBtn,settingsShowRetrospectiveBtn,settingsShowTeamsCommitteesBtn',
      rowIds.join(','));

  console.log('\nHealth button rename/reposition/icon test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
