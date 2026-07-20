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

  // Seed data no longer includes fake members (see storage.js's createSeedDB() comment) — recreate
  // the same "2 members, 3 of 5 tasks assigned (John x2, Jan x1)" shape this test was originally
  // written against, via the same UI actions this test itself exercises below.
  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  doc.getElementById('newMemberNameInput').value = 'John Brown';
  doc.getElementById('addMemberBtn').click();
  await wait(20);
  doc.getElementById('newMemberNameInput').value = 'Jan Smith';
  doc.getElementById('addMemberBtn').click();
  await wait(20);
  doc.getElementById('teamDoneBtn').click();
  await wait(20);

  async function assignSeedTaskTo(titleSubstring, memberName){
    const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(titleSubstring) !== -1);
    card.click();
    await wait(20);
    const select = doc.getElementById('taskAssigneeSelect');
    const opt = Array.from(select.options).find(o => o.textContent === memberName);
    select.value = opt.value;
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
  }
  await assignSeedTaskTo('Configure project modules', 'John Brown');
  await assignSeedTaskTo('Draft project objectives', 'Jan Smith');
  await assignSeedTaskTo('Set up Team members', 'John Brown');

  const avatarsOnBoard = doc.querySelectorAll('.kf-card .kf-avatar');
  log('seeded demo project shows assignee avatars on cards', avatarsOnBoard.length === 3, 'got ' + avatarsOnBoard.length);

  // Open Manage Team modal
  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const teamHidden = doc.getElementById('teamOverlay').classList.contains('hidden');
  log('team modal opens', !teamHidden);
  const rows = doc.querySelectorAll('.kf-member-row');
  log('shows 2 existing members', rows.length === 2, rows.length);
  log('email input is hidden for a local-only project (no account gets created)', doc.getElementById('newMemberEmailInput').classList.contains('hidden'));

  // Add a new member
  doc.getElementById('newMemberNameInput').value = 'Jordan Park';
  doc.getElementById('addMemberBtn').click();
  await wait(20);
  const rowsAfterAdd = doc.querySelectorAll('.kf-member-row');
  log('new member added to list', rowsAfterAdd.length === 3, rowsAfterAdd.length);

  // Rename a member via inline input
  const firstRow = doc.querySelector('.kf-member-row[data-member-id]');
  const nameInput = firstRow.querySelector('.kf-member-name-input');
  nameInput.value = 'John Brown-Martinez';
  nameInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);

  doc.getElementById('teamDoneBtn').click();
  await wait(10);
  log('team modal closes via Done', doc.getElementById('teamOverlay').classList.contains('hidden'));

  // Renamed member should now show updated initials/tooltip on the board card it's assigned to
  const renamedAvatar = Array.from(doc.querySelectorAll('.kf-card .kf-avatar')).find(a => a.title.indexOf('John Brown-Martinez') !== -1);
  log('card avatar reflects renamed member', !!renamedAvatar, renamedAvatar ? renamedAvatar.title : 'not found');

  // New member should appear in the task modal's assignee dropdown
  const anyCard = doc.querySelector('.kf-card');
  anyCard.click();
  await wait(20);
  const assigneeOptions = Array.from(doc.getElementById('taskAssigneeSelect').options).map(o => o.textContent);
  log('assignee dropdown includes Unassigned + all 3 members', assigneeOptions.length === 4 && assigneeOptions[0] === 'Unassigned', assigneeOptions.join(' | '));
  log('newly added member appears in assignee dropdown', assigneeOptions.indexOf('Jordan Park') !== -1);

  // Assign this task to Jordan Park and save
  const jordanOpt = Array.from(doc.getElementById('taskAssigneeSelect').options).find(o => o.textContent === 'Jordan Park');
  doc.getElementById('taskAssigneeSelect').value = jordanOpt.value;
  const titleBefore = doc.getElementById('taskTitleInput').value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  const updatedCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(titleBefore) !== -1);
  log('task card now shows Jordan Park avatar after assignment', updatedCard.innerHTML.indexOf('title="Assigned to Jordan Park"') !== -1);

  // Assignee filter dropdown should now list all 3 members + Unassigned
  doc.getElementById('assigneeFilterBtn').click();
  await wait(10);
  const panelHidden = doc.getElementById('assigneeFilterPanel').classList.contains('hidden');
  log('assignee filter dropdown opens on click', !panelHidden);
  const assigneeRows = doc.querySelectorAll('#assigneeFilterPanel .kf-dropdown-filter-row');
  log('assignee filter dropdown shows 3 members + Unassigned row (4 total)', assigneeRows.length === 4, assigneeRows.length);

  // Filter board to only Jordan Park's tasks
  const jordanRow = Array.from(assigneeRows).find(r => r.textContent.indexOf('Jordan Park') !== -1);
  const jordanCheckbox = jordanRow.querySelector('input[type=checkbox]');
  jordanCheckbox.checked = true;
  jordanCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  const allCardsNow = doc.querySelectorAll('.kf-board .kf-card');
  log('filtering by Jordan Park narrows the board to just his task', allCardsNow.length === 1, allCardsNow.length);
  log('dropdown button label reflects the single selected assignee', doc.getElementById('assigneeFilterLabel').textContent === 'Jordan Park', doc.getElementById('assigneeFilterLabel').textContent);

  // Re-open the (rebuilt) panel and uncheck to clear the filter
  doc.getElementById('assigneeFilterBtn').click();
  await wait(10);
  const jordanRow2 = Array.from(doc.querySelectorAll('#assigneeFilterPanel .kf-dropdown-filter-row')).find(r => r.textContent.indexOf('Jordan Park') !== -1);
  const jordanCheckbox2 = jordanRow2.querySelector('input[type=checkbox]');
  jordanCheckbox2.checked = false;
  jordanCheckbox2.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  log('unchecking restores the full board', doc.querySelectorAll('.kf-board .kf-card').length > 1);
  log('dropdown button label resets to "Assignee" when nothing selected', doc.getElementById('assigneeFilterLabel').textContent === 'Assignee', doc.getElementById('assigneeFilterLabel').textContent);

  // Clicking outside the dropdown closes it
  doc.getElementById('assigneeFilterBtn').click();
  await wait(10);
  doc.body.click();
  await wait(10);
  log('clicking outside the dropdown closes it', doc.getElementById('assigneeFilterPanel').classList.contains('hidden'));

  // Remove a member and confirm their tasks get unassigned
  doc.getElementById('manageTeamBtn').click();
  await wait(20);
  const samRow = Array.from(doc.querySelectorAll('.kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value.indexOf('Jan Smith') !== -1);
  samRow.querySelector('[data-action="remove-member"]').click();
  await wait(20);
  const confirmVisible = !doc.getElementById('confirmOverlay').classList.contains('hidden');
  log('removing a member asks for confirmation', confirmVisible);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  const rowsAfterRemove = doc.querySelectorAll('.kf-member-row');
  log('member removed from team list', rowsAfterRemove.length === 2, rowsAfterRemove.length);

  doc.getElementById('teamDoneBtn').click();
  await wait(10);
  const samAvatarsLeft = Array.from(doc.querySelectorAll('.kf-card .kf-avatar')).filter(a => a.title.indexOf('Jan Smith') !== -1);
  log('Jan Smith unassigned from her task (no orphan avatar remains)', samAvatarsLeft.length === 0, samAvatarsLeft.length);

  // Persistence check
  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  log('members persisted to localStorage', Array.isArray(proj.members) && proj.members.length === 2, JSON.stringify(proj.members.map(m=>m.name)));
  log('local-only members never get an email (not required, no account created)', proj.members.every(m => !m.email), JSON.stringify(proj.members.map(m=>m.email)));

  console.log('\nTeam member test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
