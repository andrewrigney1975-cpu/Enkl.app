const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function setProjectDates(doc, startVal, endVal){
  doc.getElementById('editProjectBtn').click();
  doc.getElementById('projectStartDateInput').value = startVal || '';
  doc.getElementById('projectEndDateInput').value = endVal || '';
  doc.getElementById('projectSaveBtn').click();
}

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Toolbar placement: Timeline comes right after Dependency Map ──────
  // jsdom defaults to innerWidth=1024, which is within our mobile/tablet
  // breakpoint — the view buttons live in the drawer at that width, so
  // resize to a clear desktop width first to check toolbar order.
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
  await wait(10);
  const toolbarOrder = Array.from(doc.getElementById('toolbarRow2').querySelectorAll('button')).map(b => b.id).filter(Boolean);
  const listIdx = toolbarOrder.indexOf('taskListBtn');
  const depIdx = toolbarOrder.indexOf('depMapBtn');
  const tlIdx = toolbarOrder.indexOf('timelineBtn');
  log('Timeline button exists in the toolbar at desktop width', tlIdx !== -1, toolbarOrder.join(','));
  log('Timeline button comes after List View and before Dependency Map', tlIdx === listIdx + 1 && tlIdx === depIdx - 1, toolbarOrder.join(','));

  // ── 2. Empty state: no project dates and no task dates set yet ───────────
  doc.getElementById('newProjectBtn').click();
  await wait(10);
  doc.getElementById('projectNameInput').value = 'Dateless Project';
  doc.getElementById('projectKeyInput').value = 'DLP';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('modal opens', !doc.getElementById('timelineOverlay').classList.contains('hidden'));
  log('shows guidance when there is no usable start or end date', doc.querySelector('.kf-timeline-empty') !== null);
  log('guidance mentions both a start and an end date are needed', doc.getElementById('timelineInner').textContent.indexOf('start date') !== -1 && doc.getElementById('timelineInner').textContent.indexOf('end date') !== -1);
  doc.getElementById('timelineClose').click();
  await wait(10);

  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Has a start date';
  doc.getElementById('taskStartDateInput').value = '2026-03-01';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('still shows guidance when only an end date is missing', doc.querySelector('.kf-timeline-empty') !== null);
  log('guidance specifically calls out the missing end date', doc.getElementById('timelineInner').textContent.indexOf('end date') !== -1, doc.getElementById('timelineInner').textContent);
  doc.getElementById('timelineClose').click();
  await wait(10);

  // ── 3. Setting project end date (but no project start) ───────────────────
  setProjectDates(doc, '', '2026-06-30');
  await wait(20);
  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('renders a real timeline once the project end date + a task start date exist',
      doc.querySelector('.kf-timeline-empty') === null && doc.querySelectorAll('.kf-timeline-row').length > 0);
  let headerCells = doc.querySelectorAll('.kf-timeline-header-row .kf-timeline-col-header');
  log('header row has time-unit columns', headerCells.length > 0, headerCells.length);
  doc.getElementById('timelineClose').click();
  await wait(10);

  // ── 4. Start = earlier of project start vs. task start ────────────────────
  setProjectDates(doc, '2026-01-01', '2026-06-30');
  await wait(20);
  doc.getElementById('timelineBtn').click();
  await wait(20);
  let firstHeaderLabel = doc.querySelector('.kf-timeline-col-header').textContent;
  log('timeline renders with project start earlier than task start', firstHeaderLabel.length > 0, firstHeaderLabel);
  doc.getElementById('timelineClose').click();
  await wait(10);

  setProjectDates(doc, '2026-05-01', '2026-06-30');
  await wait(20);
  doc.getElementById('timelineBtn').click();
  await wait(20);
  const firstColHeader = doc.querySelector('.kf-timeline-col-header').textContent;
  log('timeline renders with task start earlier than project start', firstColHeader.length > 0, firstColHeader);
  doc.getElementById('timelineClose').click();
  await wait(10);

  // ── 5. Switch to the Demo Project for the rest of the tests ──────────────
  const projSelect = doc.getElementById('projectSelect');
  const demoOption = Array.from(projSelect.options).find(o => o.textContent.indexOf('Sample Project') !== -1);
  projSelect.value = demoOption.value;
  projSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  setProjectDates(doc, '2026-01-01', '2026-12-31');
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('Sample Project timeline renders 5 rows (all seeded tasks have dates)', doc.querySelectorAll('.kf-timeline-row').length === 5, doc.querySelectorAll('.kf-timeline-row').length);
  log('each row has a colored bar (since every seeded task has start+end dates)', doc.querySelectorAll('.kf-timeline-bar').length === 5, doc.querySelectorAll('.kf-timeline-bar').length);

  // ── 6. Timescale selector changes the grid ────────────────────────────────
  const scaleSelect = doc.getElementById('timelineScaleSelect');
  log('default timescale is Week', scaleSelect.value === 'week', scaleSelect.value);
  const weekColCount = doc.querySelectorAll('.kf-timeline-col-header').length;

  scaleSelect.value = 'year';
  scaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  const yearColCount = doc.querySelectorAll('.kf-timeline-col-header').length;
  log('switching to Year produces far fewer, wider columns than Week', yearColCount < weekColCount, `week=${weekColCount} year=${yearColCount}`);

  scaleSelect.value = 'day';
  scaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  const dayColCount = doc.querySelectorAll('.kf-timeline-col-header').length;
  log('switching to Day produces far more columns than Week', dayColCount > weekColCount, `week=${weekColCount} day=${dayColCount}`);

  scaleSelect.value = 'week';
  scaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);

  // ── 7. Column widths stay within the configured min/max for fill-to-width ──
  const colHeaderEls = Array.from(doc.querySelectorAll('.kf-timeline-header-row .kf-timeline-col-header'));
  const widths = colHeaderEls.map(c => parseFloat(c.style.width));
  log('week-scale column widths are clamped within [50,100]px', widths.every(w => w >= 50 && w <= 100), widths.slice(0,5));
  log('all columns in a render share the same width', new Set(widths.map(w => Math.round(w))).size === 1, widths.slice(0,3));

  // ── 8. Archived tasks excluded by default; toggle reveals them ghosted ───
  doc.getElementById('timelineClose').click();
  await wait(10);
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('toggle is off by default', !doc.getElementById('timelineArchiveToggle').classList.contains('active'));
  log('archived task excluded by default (4 rows)', doc.querySelectorAll('.kf-timeline-row').length === 4, doc.querySelectorAll('.kf-timeline-row').length);

  doc.getElementById('timelineArchiveToggle').click();
  await wait(20);
  log('toggle becomes active', doc.getElementById('timelineArchiveToggle').classList.contains('active'));
  log('archived task now shown (5 rows)', doc.querySelectorAll('.kf-timeline-row').length === 5, doc.querySelectorAll('.kf-timeline-row').length);
  const archivedRow = Array.from(doc.querySelectorAll('.kf-timeline-row')).find(r => r.textContent.indexOf('Look at Project and App Settings') !== -1);
  log('archived row is marked for ghosting', archivedRow.classList.contains('kf-timeline-row-archived'));
  const archivedBar = archivedRow.querySelector('.kf-timeline-bar');
  log('archived bar gets the ghosted class', archivedBar && archivedBar.classList.contains('kf-timeline-bar-archived'));
  log('legend explains the ghosting only while toggle is on', doc.getElementById('timelineLegend').textContent.indexOf('Archived') !== -1);

  doc.getElementById('timelineArchiveToggle').click();
  await wait(20);
  log('toggling off hides it again', doc.querySelectorAll('.kf-timeline-row').length === 4);
  log('legend no longer mentions archived once off', doc.getElementById('timelineLegend').textContent.indexOf('Archived') === -1);

  doc.getElementById('timelineClose').click();
  await wait(10);

  // ── 9. Overrun alert ────────────────────────────────────────────────────────
  function designCard(){ return Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Configure project modules, columns and details') !== -1); }
  designCard().click();
  await wait(10);
  doc.getElementById('taskEndDateInput').value = '2027-03-01';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('overrun alert banner appears', !doc.getElementById('timelineAlertBanner').classList.contains('hidden'));
  log('alert names the offending task', doc.getElementById('timelineAlertBanner').textContent.indexOf('Configure project modules, columns and details') !== -1, doc.getElementById('timelineAlertBanner').textContent);
  log('alert mentions the project end date', doc.getElementById('timelineAlertBanner').textContent.indexOf('2026') !== -1);

  doc.getElementById('timelineClose').click();
  await wait(10);
  designCard().click();
  await wait(10);
  doc.getElementById('taskEndDateInput').value = '2026-08-15';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('alert clears once the overrunning task is fixed', doc.getElementById('timelineAlertBanner').classList.contains('hidden'));

  // ── 10. A completed task overrunning the end date does NOT alert ─────────
  doc.getElementById('timelineClose').click();
  await wait(10);
  designCard().click();
  await wait(10);
  doc.getElementById('taskEndDateInput').value = '2027-01-01';
  doc.getElementById('taskColumnSelect').value = Array.from(doc.getElementById('taskColumnSelect').options).find(o => o.textContent === 'Done').value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  doc.getElementById('timelineBtn').click();
  await wait(20);
  log('a completed task overrunning the end date does NOT trigger the alert', doc.getElementById('timelineAlertBanner').classList.contains('hidden'));
  doc.getElementById('timelineClose').click();
  await wait(10);

  designCard().click();
  await wait(10);
  doc.getElementById('taskEndDateInput').value = '2026-08-15';
  doc.getElementById('taskColumnSelect').value = Array.from(doc.getElementById('taskColumnSelect').options)[0].value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  // ── 11. A task with no dates at all shows a note, not a bar ──────────────
  // addTask defensively fills in default dates for brand-new tasks even if
  // the form was left blank; only editing an EXISTING task preserves an
  // explicit empty value as null, so clear the dates in a second pass.
  const addBtn2 = doc.querySelector('.kf-add-task-btn');
  addBtn2.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Totally dateless task';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const datelessCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Totally dateless task') !== -1);
  datelessCard.click();
  await wait(10);
  doc.getElementById('taskStartDateInput').value = '';
  doc.getElementById('taskEndDateInput').value = '';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);
  const datelessRow = Array.from(doc.querySelectorAll('.kf-timeline-row')).find(r => r.textContent.indexOf('Totally dateless task') !== -1);
  log('dateless task still appears as a row', !!datelessRow);
  log('dateless row shows a "No dates set" note instead of a bar', datelessRow.querySelector('.kf-timeline-no-dates-note') !== null && datelessRow.querySelector('.kf-timeline-bar') === null);
  log('dateless rows sort to the end', Array.from(doc.querySelectorAll('.kf-timeline-row')).indexOf(datelessRow) === doc.querySelectorAll('.kf-timeline-row').length - 1);

  datelessRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  log('clicking a dateless row still opens the task modal', doc.getElementById('taskTitleInput').value === 'Totally dateless task');
  log('and closes the timeline first', doc.getElementById('timelineOverlay').classList.contains('hidden'));
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 12. Clicking a normal bar opens its task and closes the timeline ─────
  doc.getElementById('timelineBtn').click();
  await wait(20);
  const someBar = doc.querySelector('.kf-timeline-bar');
  someBar.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  log('clicking a bar closes the timeline', doc.getElementById('timelineOverlay').classList.contains('hidden'));
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 13. Close behaviors ────────────────────────────────────────────────────
  doc.getElementById('timelineBtn').click();
  await wait(10);
  doc.getElementById('timelineOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await wait(10);
  log('clicking the backdrop closes the timeline', doc.getElementById('timelineOverlay').classList.contains('hidden'));

  doc.getElementById('timelineBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the timeline', doc.getElementById('timelineOverlay').classList.contains('hidden'));

  console.log('\nTimeline test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
