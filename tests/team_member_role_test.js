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

  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  log('seed project has exactly the 2 specified roles', JSON.stringify(proj.roles) === JSON.stringify(['Project Manager','Developer']), JSON.stringify(proj.roles));
  const john = proj.members.find(m => m.name === 'John Brown');
  const jan = proj.members.find(m => m.name === 'Jan Smith');
  log('John Brown is seeded as Project Manager', john.role === 'Project Manager', john.role);
  log('Jan Smith is seeded as Developer', jan.role === 'Developer', jan.role);

  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const firstRow = doc.querySelector('.kf-member-row');
  const nameInput = firstRow.querySelector('.kf-member-name-input');
  const roleInput = firstRow.querySelector('.kf-member-role-input');
  log('each member row has a role input', !!roleInput);
  log('role input comes after the name input in the row', Array.from(firstRow.children).indexOf(roleInput) > Array.from(firstRow.children).indexOf(nameInput));
  log('role input is backed by a datalist (combobox behavior)', roleInput.getAttribute('list') === 'memberRoleOptions');
  const datalistOptions = Array.from(doc.getElementById('memberRoleOptions').options).map(o => o.value);
  log('datalist offers both seeded roles', datalistOptions.includes('Project Manager') && datalistOptions.includes('Developer'), datalistOptions.join(','));

  const johnRow = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === 'John Brown');
  log('John’s role input is pre-filled with "Project Manager"', johnRow.querySelector('.kf-member-role-input').value === 'Project Manager');

  doc.getElementById('newMemberNameInput').value = 'Jordan Park';
  doc.getElementById('addMemberBtn').click();
  await wait(10);
  const jordanRow = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === 'Jordan Park');
  log('new member starts with an empty role field', jordanRow.querySelector('.kf-member-role-input').value === '');
  jordanRow.querySelector('.kf-member-role-input').value = 'QA Engineer';
  jordanRow.querySelector('.kf-member-role-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  let jordan = proj.members.find(m => m.name === 'Jordan Park');
  log('Jordan’s role persisted', jordan.role === 'QA Engineer', jordan.role);
  log('the new role is added to the project’s role vocabulary', proj.roles.includes('QA Engineer'), JSON.stringify(proj.roles));

  doc.getElementById('newMemberNameInput').value = 'Casey Wu';
  doc.getElementById('addMemberBtn').click();
  await wait(10);
  const caseyRow = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === 'Casey Wu');
  caseyRow.querySelector('.kf-member-role-input').value = 'developer';
  caseyRow.querySelector('.kf-member-role-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  const developerCount = proj.roles.filter(r => r.toLowerCase() === 'developer').length;
  log('typing "developer" (different casing) reuses the existing "Developer" entry, no duplicate created', developerCount === 1, JSON.stringify(proj.roles));
  const casey = proj.members.find(m => m.name === 'Casey Wu');
  log('Casey’s own role is stored using the existing canonical casing ("Developer")', casey.role === 'Developer', casey.role);

  caseyRow.querySelector('.kf-member-role-input').value = '';
  caseyRow.querySelector('.kf-member-role-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  log('clearing the role field sets role back to null', proj.members.find(m => m.name === 'Casey Wu').role === null);

  doc.getElementById('teamDoneBtn').click();
  await wait(10);

  const anyTask = doc.querySelectorAll('.kf-card')[0];
  anyTask.click();
  await wait(10);
  const assigneeSelect = doc.getElementById('taskAssigneeSelect');
  const johnOpt = Array.from(assigneeSelect.options).find(o => o.textContent === 'John Brown');
  assigneeSelect.value = johnOpt.value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('healthBtn').click();
  await wait(20);
  const topRows = Array.from(doc.querySelectorAll('.kf-health-top-member-row'));
  const johnTopRow = topRows.find(r => r.textContent.indexOf('John Brown') !== -1);
  log('John appears in the Top 5 Team Members list with his role shown beside his name',
      !!johnTopRow && !!johnTopRow.querySelector('.kf-health-top-member-role') && johnTopRow.querySelector('.kf-health-top-member-role').textContent === 'Project Manager',
      johnTopRow && johnTopRow.textContent);
  doc.getElementById('healthClose').click();
  await wait(10);

  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const caseyRowAgain = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === 'Casey Wu');
  log('a member with no role shows an empty role input (not a placeholder value leaking in)', caseyRowAgain.querySelector('.kf-member-role-input').value === '');
  doc.getElementById('teamDoneBtn').click();
  await wait(10);

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exported = JSON.parse(lastBlobText);
  log('export includes the project’s role vocabulary', Array.isArray(exported.roles) && exported.roles.includes('Project Manager') && exported.roles.includes('QA Engineer'), JSON.stringify(exported.roles));
  const exportedJohn = exported.members.find(m => m.name === 'John Brown');
  log('exported member carries their role', exportedJohn.role === 'Project Manager', exportedJohn.role);

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
  log('imported project carries over the role vocabulary', importedProj.roles.includes('Project Manager') && importedProj.roles.includes('QA Engineer'), JSON.stringify(importedProj.roles));
  const importedJohn = importedProj.members.find(m => m.name === 'John Brown');
  log('imported member retains their role', importedJohn && importedJohn.role === 'Project Manager', importedJohn && importedJohn.role);

  const legacyDB = {
    projects: {
      legacy_p1: {
        id: 'legacy_p1', name: 'Legacy Project', key: 'LEG', taskCounter: 1,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: [] }],
        tasks: {},
        members: [{ id: 'm1', name: 'Old Member', color: '#000000' }],
        releases: [], taskTypes: [],
        documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1, approvers: [],
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
  log('migration backfills an empty roles array for a legacy project missing it entirely', Array.isArray(legacyProj.roles) && legacyProj.roles.length === 0, JSON.stringify(legacyProj.roles));
  log('migration backfills role:null for a legacy member missing the field', legacyProj.members[0].role === null, legacyProj.members[0].role);

  const doc2 = dom2.window.document;
  doc2.getElementById('manageTeamBtn').click();
  await wait(20);
  log('Team modal opens cleanly on a freshly-migrated legacy project, role input present and empty',
      !!doc2.querySelector('.kf-member-role-input') && doc2.querySelector('.kf-member-role-input').value === '');

  console.log('\nTeam Member Role test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
