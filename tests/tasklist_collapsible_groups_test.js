const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function createRelease(doc, name, startVal, endVal){
  doc.getElementById('releasesBtn').click();
  doc.getElementById('addReleaseBtn').click();
  doc.getElementById('releaseNameInput').value = name;
  doc.getElementById('releaseStartDateInput').value = startVal || '';
  doc.getElementById('releaseEndDateInput').value = endVal || '';
  doc.getElementById('releaseFormSaveBtn').click();
  doc.getElementById('releasesDoneBtn').click();
}
function setTaskScores(doc, taskTitle, businessValue, taskCost, releaseName){
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(taskTitle) !== -1);
  card.click();
  doc.getElementById('taskBusinessValueInput').value = String(businessValue);
  doc.getElementById('taskCostInput').value = String(taskCost);
  if(releaseName){
    const opt = Array.from(doc.getElementById('taskReleaseSelect').options).find(o => o.textContent === releaseName);
    doc.getElementById('taskReleaseSelect').value = opt ? opt.value : '';
  }
  doc.getElementById('taskSaveBtn').click();
}
function headerFor(doc, name){
  return Array.from(doc.querySelectorAll('.kf-tasklist-group-header')).find(h => h.textContent.indexOf(name) !== -1);
}
function rowsAfterHeader(headerEl){
  const out = [];
  let el = headerEl.nextElementSibling;
  while (el && el.classList.contains('kf-tasklist-row')) {
    out.push(el);
    el = el.nextElementSibling;
    if (el && el.classList.contains('kf-tasklist-detail')) el = el.nextElementSibling;
  }
  return out;
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  createRelease(doc, 'Alpha Release', '2026-01-01', '2026-01-15');
  await wait(20);

  setTaskScores(doc, 'Configure project modules, columns and details', 800, 150, 'Alpha Release');
  await wait(20);
  setTaskScores(doc, 'Draft project objectives', 500, 200, 'Alpha Release');
  await wait(20);

  doc.getElementById('taskListBtn').click();
  await wait(20);

  // ── 1. Release Value Proposition is the weighted aggregate, not an average ──
  const alphaHeader = headerFor(doc, 'Alpha Release');
  const alphaVpPill = alphaHeader.querySelector('.kf-valueprop-pill');
  log('release header shows an aggregate Value Proposition pill', !!alphaVpPill);
  log('aggregate VP is sum(value)/sum(cost) = 3.71, not the average of individual ratios (3.92)',
      alphaVpPill.textContent.trim() === '3.71', alphaVpPill.textContent.trim());
  log('aggregate VP is color-coded "good" (>1), same threshold as per-task pills', alphaVpPill.classList.contains('good'));
  log('VP pill tooltip explains it is an aggregate', alphaVpPill.title.indexOf('Aggregate') !== -1, alphaVpPill.title);

  // ── 2. "No Release" header has no Value Proposition pill ─────────────────
  const noReleaseHeader = headerFor(doc, 'No Release');
  log('"No Release" header has no Value Proposition pill (nothing to aggregate)', noReleaseHeader.querySelector('.kf-valueprop-pill') === null);

  // ── 3. Every group header has a chevron, defaulting to expanded ──────────
  const headers = Array.from(doc.querySelectorAll('.kf-tasklist-group-header'));
  log('every group header has a chevron', headers.every(h => h.querySelector('.kf-tasklist-chevron') !== null));
  log('all chevrons start expanded (List View opens with everything shown)',
      headers.every(h => h.querySelector('.kf-tasklist-chevron').classList.contains('expanded')));
  log('all groups start with their rows visible', rowsAfterHeader(alphaHeader).length === 2, rowsAfterHeader(alphaHeader).length);

  // ── 4. Clicking a header collapses just that group ────────────────────────
  alphaHeader.click();
  await wait(10);
  const alphaHeaderAfter = headerFor(doc, 'Alpha Release');
  log('clicking the header collapses its chevron', !alphaHeaderAfter.querySelector('.kf-tasklist-chevron').classList.contains('expanded'));
  log('aria-expanded reflects the collapsed state', alphaHeaderAfter.getAttribute('aria-expanded') === 'false');
  log('collapsing hides that group\'s rows', rowsAfterHeader(alphaHeaderAfter).length === 0);
  log('the count badge still shows 2 tasks even while collapsed', alphaHeaderAfter.textContent.indexOf('2 task') !== -1, alphaHeaderAfter.textContent);

  const otherHeader = headerFor(doc, 'No Release');
  log('other groups are unaffected by collapsing this one', otherHeader.querySelector('.kf-tasklist-chevron').classList.contains('expanded') && rowsAfterHeader(otherHeader).length > 0);

  // ── 5. Clicking it again re-expands ────────────────────────────────────────
  headerFor(doc, 'Alpha Release').click();
  await wait(10);
  const alphaHeaderReexpanded = headerFor(doc, 'Alpha Release');
  log('clicking again re-expands the group', alphaHeaderReexpanded.querySelector('.kf-tasklist-chevron').classList.contains('expanded'));
  log('rows reappear after re-expanding', rowsAfterHeader(alphaHeaderReexpanded).length === 2);

  // ── 6. Collapse all / Expand all ──────────────────────────────────────────
  doc.getElementById('taskListCollapseAllBtn').click();
  await wait(10);
  let allHeaders = Array.from(doc.querySelectorAll('.kf-tasklist-group-header'));
  log('Collapse all collapses every visible group', allHeaders.every(h => !h.querySelector('.kf-tasklist-chevron').classList.contains('expanded')));
  log('Collapse all hides every group\'s rows', doc.querySelectorAll('.kf-tasklist-row').length === 0);

  doc.getElementById('taskListExpandAllBtn').click();
  await wait(10);
  allHeaders = Array.from(doc.querySelectorAll('.kf-tasklist-group-header'));
  log('Expand all re-expands every group', allHeaders.every(h => h.querySelector('.kf-tasklist-chevron').classList.contains('expanded')));
  log('Expand all restores every row', doc.querySelectorAll('.kf-tasklist-row').length === 5);

  // ── 7. Collapse all only affects groups visible under the current search ──
  doc.getElementById('taskListExpandAllBtn').click();
  await wait(10);
  doc.getElementById('taskListSearchInput').value = 'Configure project modules';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('search narrows to just the matching group', doc.querySelectorAll('.kf-tasklist-group-header').length === 1);
  doc.getElementById('taskListCollapseAllBtn').click();
  await wait(10);

  doc.getElementById('taskListSearchInput').value = '';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  const alphaAfterScopedCollapse = headerFor(doc, 'Alpha Release');
  const noReleaseAfterScopedCollapse = headerFor(doc, 'No Release');
  log('the group that was visible during "Collapse all" is now collapsed', !alphaAfterScopedCollapse.querySelector('.kf-tasklist-chevron').classList.contains('expanded'));
  log('a group that was NOT visible during "Collapse all" is unaffected (still expanded)',
      noReleaseAfterScopedCollapse.querySelector('.kf-tasklist-chevron').classList.contains('expanded'));

  doc.getElementById('taskListExpandAllBtn').click();
  await wait(10);

  // ── 8. Collapse state survives re-sorting ─────────────────────────────────
  headerFor(doc, 'Alpha Release').click();
  await wait(10);
  const keyHeaderCell = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Key') !== -1);
  keyHeaderCell.click();
  await wait(10);
  log('collapse state survives re-sorting by a column', !headerFor(doc, 'Alpha Release').querySelector('.kf-tasklist-chevron').classList.contains('expanded'));

  const otherRowChevron = doc.querySelector('button.kf-tasklist-chevron');
  otherRowChevron.click();
  await wait(10);
  log('toggling an individual task detail panel does not affect group collapse state', !headerFor(doc, 'Alpha Release').querySelector('.kf-tasklist-chevron').classList.contains('expanded'));

  // ── 9. An empty (filtered-out) collapsed group's header disappears too ───
  let alphaCheck = headerFor(doc, 'Alpha Release');
  if (alphaCheck.querySelector('.kf-tasklist-chevron').classList.contains('expanded')) {
    alphaCheck.click();
    await wait(10);
  }
  doc.getElementById('taskListSearchInput').value = 'zzz-nothing-matches-this';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('a collapsed group with no matching tasks under search disappears entirely, same as an expanded one would',
      doc.querySelector('.kf-tasklist-empty') !== null && doc.querySelectorAll('.kf-tasklist-group-header').length === 0);
  doc.getElementById('taskListSearchInput').value = '';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);

  // ── 10. Reopening the List View resets all groups back to expanded ───────
  doc.getElementById('taskListClose').click();
  await wait(10);
  doc.getElementById('taskListBtn').click();
  await wait(20);
  const headersOnReopen = Array.from(doc.querySelectorAll('.kf-tasklist-group-header'));
  log('reopening the List View resets every group back to expanded',
      headersOnReopen.every(h => h.querySelector('.kf-tasklist-chevron').classList.contains('expanded')));
  log('reopening shows all rows again', doc.querySelectorAll('.kf-tasklist-row').length === 5);

  console.log('\nCollapsible release headers + aggregate Value Proposition test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
