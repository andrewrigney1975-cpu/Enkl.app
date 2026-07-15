const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(500);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  function getCurrentStoredProject(){
    const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
    return raw.projects[raw.currentProjectId];
  }

  // ── 1. New/Edit Project modal has a rich-text Description field ──
  doc.getElementById('editProjectBtn').click();
  await wait(20);
  log('project modal has a Description rich-text editor', doc.getElementById('projectDescEditor') !== null);
  log('project modal has a Description toolbar', doc.getElementById('projectDescToolbar') !== null);

  // ── 2. Editing and saving persists the description as Markdown ──
  doc.getElementById('projectDescEditor').textContent = 'Important project context.';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);
  let stored = getCurrentStoredProject();
  log('project description is persisted', stored.description === 'Important project context.', stored.description);

  // ── 3. Reopening the modal shows the saved description back ──
  doc.getElementById('editProjectBtn').click();
  await wait(20);
  log('reopened editor shows the saved description', doc.getElementById('projectDescEditor').textContent === 'Important project context.', doc.getElementById('projectDescEditor').textContent);
  doc.getElementById('projectCancelBtn').click();
  await wait(20);

  // ── 4. A brand new project defaults to an empty description (no crash on missing field) ──
  doc.getElementById('newProjectBtn').click();
  await wait(20);
  doc.getElementById('projectNameInput').value = 'Second Project';
  doc.getElementById('projectKeyInput').value = 'SEC';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);
  const secondProject = getCurrentStoredProject();
  log('a brand new project has an empty description, not undefined', secondProject.description === '', JSON.stringify(secondProject.description));

  // ── 5. Project Management Report includes the project description ──
  doc.getElementById('editProjectBtn').click();
  await wait(20);
  doc.getElementById('projectDescEditor').textContent = 'Second project notes.';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);

  doc.getElementById('projectsMenuBtn').click();
  await wait(20);
  doc.querySelector('#projectsMenuPanel [data-nav-target="projectMgmtReportBtn"]').click();
  await wait(20);
  const reportHTML = doc.getElementById('reportBody').innerHTML;
  log('Project Management Report includes the project description', reportHTML.indexOf('Second project notes.') !== -1);
  log('project description sits in its own styled block', reportHTML.indexOf('kf-report-project-description') !== -1);

  console.log('\nProject description test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
