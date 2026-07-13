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

  // ── 1. Opening / closing ──────────────────────────────────────────────────
  log('chart modal starts hidden', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));
  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  log('chart modal opens', !doc.getElementById('costBenefitOverlay').classList.contains('hidden'));
  log('modal title includes the project name', doc.getElementById('costBenefitTitle').textContent.indexOf('Sample Project') !== -1, doc.getElementById('costBenefitTitle').textContent);

  // ── 2. Chart structure: axes, quadrant lines, quadrant labels, ticks ─────
  const svg = doc.querySelector('#costBenefitInner svg');
  log('an SVG chart is rendered', svg !== null);
  const svgHTML = svg.innerHTML;
  log('chart includes axis title "Task Cost"', svgHTML.indexOf('Task Cost') !== -1);
  log('chart includes axis title "Business Value"', svgHTML.indexOf('Business Value') !== -1);
  log('chart includes all 4 quadrant labels', ['QUICK WINS','MAJOR PROJECTS','FILL-INS','REVIEW DEMAND'].every(l => svgHTML.indexOf(l) !== -1), svgHTML.match(/QUICK WINS|MAJOR PROJECTS|FILL-INS|REVIEW DEMAND/g));
  log('chart includes dashed quadrant divider lines', svgHTML.indexOf('stroke-dasharray') !== -1);
  log('chart includes axis tick labels (250, 500, 750, 1000)', ['250','500','750','1000'].every(v => svgHTML.indexOf('>' + v + '<') !== -1));

  // ── 3. One point plotted per non-archived task (5 seeded tasks) ──────────
  let points = doc.querySelectorAll('.kf-cb-point');
  log('5 points plotted for the 5 seeded tasks', points.length === 5, points.length);

  // ── 4. Point position reflects cost/value (SMPL-2: bv=800, cost=150) ─────
  const designPoint = Array.from(points).find(p => p.innerHTML.indexOf('SMPL-2') !== -1);
  const researchPoint = Array.from(points).find(p => p.innerHTML.indexOf('SMPL-1') !== -1);
  log('found the expected seeded points', !!designPoint && !!researchPoint);
  const designCx = parseFloat(designPoint.querySelector('circle').getAttribute('cx'));
  const researchCx = parseFloat(researchPoint.querySelector('circle').getAttribute('cx'));
  log('higher task cost places the point further right on the x-axis', designCx > researchCx, 'design=' + designCx + ' research=' + researchCx);

  const designCy = parseFloat(designPoint.querySelector('circle').getAttribute('cy'));
  const researchCy = parseFloat(researchPoint.querySelector('circle').getAttribute('cy'));
  log('higher business value places the point higher up (smaller cy)', designCy < researchCy, 'design=' + designCy + ' research=' + researchCy);

  // ── 5. Tooltip includes key, title, cost, and value ───────────────────────
  const designTitle = designPoint.querySelector('title').textContent;
  log('tooltip includes the task key', designTitle.indexOf('SMPL-2') !== -1, designTitle);
  log('tooltip includes the title', designTitle.indexOf('Configure project modules, columns and details') !== -1, designTitle);
  log('tooltip includes Cost and Value figures', designTitle.indexOf('Cost 150') !== -1 && designTitle.indexOf('Value 800') !== -1, designTitle);

  // ── 6. Point dots are colored by priority accent ──────────────────────────
  const designDot = designPoint.querySelector('circle');
  log('point fill color is set (priority accent)', designDot.getAttribute('fill') && designDot.getAttribute('fill').startsWith('#'), designDot.getAttribute('fill'));

  // ── 7. Legend lists all 5 priorities + the quadrant-split note ───────────
  const legendText = doc.getElementById('costBenefitLegend').textContent;
  ['Trivial','Low','Medium','High','Critical'].forEach(p => {
    log('legend includes priority "' + p + '"', legendText.indexOf(p) !== -1);
  });
  log('legend explains the quadrant split', legendText.indexOf('500') !== -1, legendText);

  // ── 8. Clicking a point opens the task modal and closes the chart ────────
  designPoint.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  log('clicking a point closes the chart modal', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));
  log('clicking a point opens the task modal for the right task', doc.getElementById('taskTitleInput').value === 'Configure project modules, columns and details', doc.getElementById('taskTitleInput').value);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 9. Close behaviors: × button, outside click, Escape ──────────────────
  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  doc.getElementById('costBenefitClose').click();
  await wait(10);
  log('× button closes the chart modal', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  doc.getElementById('costBenefitOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await wait(10);
  log('clicking the backdrop closes the chart modal', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes the chart modal', doc.getElementById('costBenefitOverlay').classList.contains('hidden'));

  // ── 10. Archived tasks are excluded from the chart ────────────────────────
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Look at Project and App Settings') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  points = doc.querySelectorAll('.kf-cb-point');
  log('archived task excluded from the chart (4 points remain)', points.length === 4, points.length);
  log('archived task does not appear among the plotted points', !Array.from(points).some(p => p.innerHTML.indexOf('SMPL-1') !== -1));
  doc.getElementById('costBenefitClose').click();
  await wait(10);

  // ── 11. Duplicate (cost, value) pairs get jittered into a visible ring ───
  const addBtn = doc.querySelector('.kf-add-task-btn');
  addBtn.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Default score task A';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const addBtn2 = doc.querySelector('.kf-add-task-btn');
  addBtn2.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Default score task B';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  const allPoints = doc.querySelectorAll('.kf-cb-point');
  const pointA = Array.from(allPoints).find(p => p.querySelector('title').textContent.indexOf('Default score task A') !== -1);
  const pointB = Array.from(allPoints).find(p => p.querySelector('title').textContent.indexOf('Default score task B') !== -1);
  log('both default-score tasks are plotted', !!pointA && !!pointB);
  const ax = parseFloat(pointA.querySelector('circle').getAttribute('cx'));
  const ay = parseFloat(pointA.querySelector('circle').getAttribute('cy'));
  const bx = parseFloat(pointB.querySelector('circle').getAttribute('cx'));
  const by = parseFloat(pointB.querySelector('circle').getAttribute('cy'));
  log('tasks sharing the exact same Cost/Value are jittered to distinct screen positions',
      (ax !== bx || ay !== by), 'A=(' + ax + ',' + ay + ') B=(' + bx + ',' + by + ')');
  log('tooltip still reports the TRUE (un-jittered) Cost/Value of 1', pointA.querySelector('title').textContent.indexOf('Cost 1,') !== -1, pointA.querySelector('title').textContent);
  doc.getElementById('costBenefitClose').click();
  await wait(10);

  // ── 12. Empty state when the project has zero (non-archived) tasks ───────
  doc.getElementById('newProjectBtn').click();
  await wait(10);
  doc.getElementById('projectNameInput').value = 'Empty Chart Project';
  doc.getElementById('projectKeyInput').value = 'ECP';
  doc.getElementById('projectSaveBtn').click();
  await wait(20);

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  log('empty project shows the empty state instead of a chart', doc.querySelector('.kf-depmap-empty') !== null);
  log('no chart points rendered for an empty project', doc.querySelectorAll('.kf-cb-point').length === 0);

  console.log('\nCost/Benefit Chart test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
