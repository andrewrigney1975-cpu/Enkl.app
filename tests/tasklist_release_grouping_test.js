const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function createRelease(doc, name, status, startVal, endVal){
  doc.getElementById('releasesBtn').click();
  doc.getElementById('addReleaseBtn').click();
  doc.getElementById('releaseNameInput').value = name;
  doc.getElementById('releaseStatusSelect').value = status;
  doc.getElementById('releaseStartDateInput').value = startVal || '';
  doc.getElementById('releaseEndDateInput').value = endVal || '';
  doc.getElementById('releaseFormSaveBtn').click();
}
function assignTaskToRelease(doc, taskTitle, releaseName){
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(taskTitle) !== -1);
  card.click();
  const opt = Array.from(doc.getElementById('taskReleaseSelect').options).find(o => o.textContent === releaseName);
  doc.getElementById('taskReleaseSelect').value = opt ? opt.value : '';
  doc.getElementById('taskSaveBtn').click();
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  createRelease(doc, 'March Release', 'pending', '2026-03-01', '2026-03-15');
  await wait(20);
  doc.getElementById('releasesDoneBtn').click();
  await wait(10);

  createRelease(doc, 'January Release', 'in_progress', '2026-01-01', '2026-01-15');
  await wait(20);
  doc.getElementById('releasesDoneBtn').click();
  await wait(10);

  createRelease(doc, 'June Release', 'deployed', '2026-06-01', '2026-06-15');
  await wait(20);
  doc.getElementById('releasesDoneBtn').click();
  await wait(10);

  createRelease(doc, 'Undated Release', 'pending', '', '');
  await wait(20);
  doc.getElementById('releasesDoneBtn').click();
  await wait(10);

  assignTaskToRelease(doc, 'Look at Project and App Settings', 'June Release');
  await wait(20);
  assignTaskToRelease(doc, 'Configure project modules, columns and details', 'January Release');
  await wait(20);
  assignTaskToRelease(doc, 'Draft project objectives', 'March Release');
  await wait(20);
  assignTaskToRelease(doc, 'Set up Team members for this project', 'Undated Release');
  await wait(20);

  doc.getElementById('taskListBtn').click();
  await wait(20);

  // ── 1. Group headers exist, one per release plus "No Release" ────────────
  const groupHeaders = Array.from(doc.querySelectorAll('.kf-tasklist-group-header'));
  log('5 group headers rendered (4 releases + No Release)', groupHeaders.length === 5, groupHeaders.length);

  const groupNames = groupHeaders.map(h => h.querySelector('.kf-tasklist-group-name').textContent);
  log('groups are ordered by release startDate ascending, dated before undated, "No Release" last',
      groupNames.join(',') === 'January Release,March Release,June Release,Undated Release,No Release',
      groupNames.join(','));

  // ── 2. Each group header shows status pill, date range, and task count ───
  const januaryHeader = groupHeaders.find(h => h.textContent.indexOf('January Release') !== -1);
  log('January Release header shows its status pill', januaryHeader.querySelector('.kf-release-status-pill.in_progress') !== null);
  log('January Release header shows its date range', januaryHeader.textContent.indexOf('2026') !== -1, januaryHeader.textContent);
  log('January Release header shows a task count of 1', januaryHeader.textContent.indexOf('1 task') !== -1, januaryHeader.textContent);

  const undatedHeader = groupHeaders.find(h => h.textContent.indexOf('Undated Release') !== -1);
  log('Undated Release header has no date range text (since it has none)', !/\d{4}/.test(undatedHeader.querySelector('.kf-tasklist-group-dates') ? undatedHeader.querySelector('.kf-tasklist-group-dates').textContent : ''));

  const noReleaseHeader = groupHeaders.find(h => h.querySelector('.kf-tasklist-group-name-none'));
  log('"No Release" header is styled distinctly (italic/faint)', !!noReleaseHeader && noReleaseHeader.querySelector('.kf-tasklist-group-name-none').textContent === 'No Release');
  log('"No Release" header has no status pill', noReleaseHeader.querySelector('.kf-release-status-pill') === null);
  log('"No Release" group contains the 1 unassigned task', noReleaseHeader.textContent.indexOf('1 task') !== -1, noReleaseHeader.textContent);

  // ── 3. Tasks render directly after their group's header, in the right group ──
  function tasksInGroup(headerEl){
    const out = [];
    let el = headerEl.nextElementSibling;
    while (el && el.classList.contains('kf-tasklist-row')) {
      out.push(el.querySelector('.kf-tasklist-title').textContent);
      el = el.nextElementSibling;
      if (el && el.classList.contains('kf-tasklist-detail')) el = el.nextElementSibling;
    }
    return out;
  }
  const marchHeader = groupHeaders.find(h => h.textContent.indexOf('March Release') !== -1);
  log('March Release group contains exactly its assigned task', tasksInGroup(marchHeader).includes('Draft project objectives') && tasksInGroup(marchHeader).length === 1,
      tasksInGroup(marchHeader));
  log('No Release group contains the unreleased task', tasksInGroup(noReleaseHeader).includes('Create project board'));

  // ── 4. Search still filters within the grouped view; empty groups vanish ──
  doc.getElementById('taskListSearchInput').value = 'project board';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  const filteredHeaders = doc.querySelectorAll('.kf-tasklist-group-header');
  log('searching narrows to only the matching group (No Release)', filteredHeaders.length === 1 && filteredHeaders[0].textContent.indexOf('No Release') !== -1, filteredHeaders.length);
  doc.getElementById('taskListSearchInput').value = '';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);

  // ── 5. Column sorting still applies WITHIN each group ─────────────────────
  const keyHeaderCell = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Key') !== -1);
  keyHeaderCell.click();
  await wait(10);
  const allRowsAfterSort = Array.from(doc.querySelectorAll('.kf-tasklist-row'));
  log('rows still render correctly after re-sorting (5 total)', allRowsAfterSort.length === 5, allRowsAfterSort.length);
  log('group headers persist after re-sorting', doc.querySelectorAll('.kf-tasklist-group-header').length === 5);

  // ── 6. Expand/collapse still works correctly inside a grouped list ───────
  const firstChevron = doc.querySelector('button.kf-tasklist-chevron');
  firstChevron.click();
  await wait(10);
  const expandedChevron = doc.querySelector('button.kf-tasklist-chevron.expanded');
  log('expand/collapse still works with grouping in place', !!expandedChevron);
  const detailPanel = expandedChevron.closest('.kf-tasklist-row').nextElementSibling;
  log('detail panel renders immediately after the expanded row, not disrupted by grouping', detailPanel && detailPanel.classList.contains('kf-tasklist-detail'));

  console.log('\nTask List release-grouping test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
