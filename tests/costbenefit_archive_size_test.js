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

  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  // ── 1. Default: archived hidden, toggle off ───────────────────────────────
  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  log('toggle is not active by default', !doc.getElementById('costBenefitArchiveToggle').classList.contains('active'));
  log('toggle label reads "Show archived" by default', doc.getElementById('costBenefitArchiveToggleLabel').textContent === 'Show archived', doc.getElementById('costBenefitArchiveToggleLabel').textContent);
  let points = doc.querySelectorAll('.kf-cb-point');
  log('archived task hidden from the chart by default (4 points)', points.length === 4, points.length);

  // ── 2. Turning the toggle on reveals it, greyed out ───────────────────────
  doc.getElementById('costBenefitArchiveToggle').click();
  await wait(20);
  log('toggle becomes active', doc.getElementById('costBenefitArchiveToggle').classList.contains('active'));
  log('toggle label flips to "Hide archived"', doc.getElementById('costBenefitArchiveToggleLabel').textContent === 'Hide archived');
  points = doc.querySelectorAll('.kf-cb-point');
  log('archived task now appears (5 points)', points.length === 5, points.length);
  const archivedPoints = doc.querySelectorAll('.kf-cb-point-archived');
  log('exactly one point gets the archived (greyed-out) class', archivedPoints.length === 1, archivedPoints.length);
  log('the archived point is the right task', archivedPoints[0].innerHTML.indexOf('Look at Project and App Settings') !== -1, archivedPoints[0].innerHTML.slice(0,150));
  log('tooltip marks it as [Archived]', archivedPoints[0].querySelector('title').textContent.indexOf('[Archived]') !== -1, archivedPoints[0].querySelector('title').textContent);

  // ── 3. Legend reflects toggle state ───────────────────────────────────────
  let legendText = doc.getElementById('costBenefitLegend').textContent.toLowerCase();
  log('legend mentions "archived" while toggle is on', legendText.indexOf('archived') !== -1, legendText);

  // ── 4. Clicking the archived point still opens the task modal ────────────
  archivedPoints[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  log('clicking the archived point closes the chart', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));
  log('and opens the task modal for it', doc.getElementById('taskTitleInput').value === 'Look at Project and App Settings');
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 5. Toggle persists across close/reopen; toggling off hides it again ──
  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  log('toggle state persisted across close/reopen', doc.getElementById('costBenefitArchiveToggle').classList.contains('active'));
  doc.getElementById('costBenefitArchiveToggle').click();
  await wait(20);
  points = doc.querySelectorAll('.kf-cb-point');
  log('toggling off hides the archived task again (4 points)', points.length === 4, points.length);
  legendText = doc.getElementById('costBenefitLegend').textContent.toLowerCase();
  log('legend no longer mentions "archived" once toggled off', legendText.indexOf('archived') === -1, legendText);
  doc.getElementById('costBenefitClose').click();
  await wait(10);

  // ── 6. Marker sizes scale exactly with priority ───────────────────────────
  const priorityScores = { trivial: 100, low: 200, medium: 300, high: 400, critical: 500 };
  for (const [priority, score] of Object.entries(priorityScores)) {
    const addBtn = doc.querySelector('.kf-add-task-btn');
    addBtn.click();
    await wait(10);
    doc.getElementById('taskTitleInput').value = 'Size test ' + priority;
    doc.getElementById('taskPrioritySelect').value = priority;
    doc.getElementById('taskBusinessValueInput').value = String(score);
    doc.getElementById('taskCostInput').value = String(score);
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
  }

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  const radiusByPriority = {};
  Object.keys(priorityScores).forEach(priority => {
    const pt = Array.from(doc.querySelectorAll('.kf-cb-point')).find(p => p.querySelector('title').textContent.indexOf('Size test ' + priority) !== -1);
    radiusByPriority[priority] = parseFloat(pt.querySelector('circle').getAttribute('r'));
  });
  console.log('  (radii observed: ' + JSON.stringify(radiusByPriority) + ')');

  log('Trivial marker uses the base size (r=7)', radiusByPriority.trivial === 7, radiusByPriority.trivial);
  log('Critical marker is exactly 4x the Trivial (base) size', radiusByPriority.critical === radiusByPriority.trivial * 4,
      radiusByPriority.critical + ' vs ' + (radiusByPriority.trivial * 4));
  log('Low marker is bigger than Trivial', radiusByPriority.low > radiusByPriority.trivial, radiusByPriority.low);
  log('Medium marker is bigger than Low', radiusByPriority.medium > radiusByPriority.low, radiusByPriority.medium);
  log('High marker is bigger than Medium', radiusByPriority.high > radiusByPriority.medium, radiusByPriority.high);
  log('Critical marker is bigger than High', radiusByPriority.critical > radiusByPriority.high, radiusByPriority.critical);
  log('sizes increase by an even/linear step between each level',
      Math.abs((radiusByPriority.low - radiusByPriority.trivial) - (radiusByPriority.medium - radiusByPriority.low)) < 0.01 &&
      Math.abs((radiusByPriority.medium - radiusByPriority.low) - (radiusByPriority.high - radiusByPriority.medium)) < 0.01 &&
      Math.abs((radiusByPriority.high - radiusByPriority.medium) - (radiusByPriority.critical - radiusByPriority.high)) < 0.01,
      JSON.stringify(radiusByPriority));

  // ── 7. Legend dot sizes also scale with priority, previewing the chart ───
  const legendDots = doc.querySelectorAll('#costBenefitLegend .kf-legend-dot');
  const legendSizes = Array.from(legendDots).map(d => parseInt(d.style.width));
  log('legend dot sizes increase monotonically across priorities', legendSizes.every((v, i) => i === 0 || legendSizes[i-1] < v), legendSizes.join(','));
  log('legend mentions "Marker size = priority"', doc.getElementById('costBenefitLegend').textContent.indexOf('Marker size') !== -1);

  // ── 8. Jitter ring scales with marker size (critical markers need more spread) ──
  const addBtnA = doc.querySelector('.kf-add-task-btn');
  addBtnA.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Cluster critical A';
  doc.getElementById('taskPrioritySelect').value = 'critical';
  doc.getElementById('taskBusinessValueInput').value = '777';
  doc.getElementById('taskCostInput').value = '777';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const addBtnB = doc.querySelector('.kf-add-task-btn');
  addBtnB.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Cluster critical B';
  doc.getElementById('taskPrioritySelect').value = 'critical';
  doc.getElementById('taskBusinessValueInput').value = '777';
  doc.getElementById('taskCostInput').value = '777';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('costBenefitClose').click();
  await wait(10);
  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  const ptA = Array.from(doc.querySelectorAll('.kf-cb-point')).find(p => p.querySelector('title').textContent.indexOf('Cluster critical A') !== -1);
  const ptB = Array.from(doc.querySelectorAll('.kf-cb-point')).find(p => p.querySelector('title').textContent.indexOf('Cluster critical B') !== -1);
  const ax = parseFloat(ptA.querySelector('circle').getAttribute('cx')), ay = parseFloat(ptA.querySelector('circle').getAttribute('cy'));
  const bx = parseFloat(ptB.querySelector('circle').getAttribute('cx')), by = parseFloat(ptB.querySelector('circle').getAttribute('cy'));
  const dist = Math.hypot(ax - bx, ay - by);
  log('two large (critical) markers sharing a point are jittered apart enough not to fully overlap',
      dist > radiusByPriority.critical, 'distance=' + dist.toFixed(1) + ' criticalRadius=' + radiusByPriority.critical);

  console.log('\nCost/Benefit Chart archived-toggle + marker-size test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
