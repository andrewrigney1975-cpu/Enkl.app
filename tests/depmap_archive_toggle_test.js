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

  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Create project board') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskArchivedCheckbox').checked = true;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  // ── 1. Toggle defaults to off; archived task hidden from the graph ────────
  doc.getElementById('depMapBtn').click();
  await wait(20);
  log('toggle button is not active by default', !doc.getElementById('depMapArchiveToggle').classList.contains('active'));
  log('toggle label reads "Show archived" by default', doc.getElementById('depMapArchiveToggleLabel').textContent === 'Show archived', doc.getElementById('depMapArchiveToggleLabel').textContent);
  let nodes = doc.querySelectorAll('.kf-depnode');
  log('archived task hidden from the graph by default', nodes.length === 4, nodes.length);
  log('no archived-styled node present while hidden', doc.querySelectorAll('.kf-depnode-archived').length === 0);

  // ── 2. Turning the toggle on reveals the archived task, greyed out ───────
  doc.getElementById('depMapArchiveToggle').click();
  await wait(20);
  log('toggle button becomes active', doc.getElementById('depMapArchiveToggle').classList.contains('active'));
  log('toggle label flips to "Hide archived"', doc.getElementById('depMapArchiveToggleLabel').textContent === 'Hide archived', doc.getElementById('depMapArchiveToggleLabel').textContent);
  nodes = doc.querySelectorAll('.kf-depnode');
  log('archived task now appears in the graph (5 nodes)', nodes.length === 5, nodes.length);

  const archivedNodes = doc.querySelectorAll('.kf-depnode-archived');
  log('exactly one node gets the archived (greyed-out) class', archivedNodes.length === 1, archivedNodes.length);
  log('the archived node corresponds to the right task', archivedNodes[0].innerHTML.indexOf('Create project board') !== -1, archivedNodes[0].innerHTML.slice(0,200));

  const nonArchivedCount = Array.from(nodes).filter(n => !n.classList.contains('kf-depnode-archived')).length;
  log('the other 4 nodes are not greyed out', nonArchivedCount === 4, nonArchivedCount);

  // ── 3. Legend mentions archived tasks only while toggle is on ────────────
  let legendText = doc.getElementById('depMapLegend').textContent.toLowerCase();
  log('legend mentions "archived" while toggle is on', legendText.indexOf('archived') !== -1, legendText);

  // ── 4. Archived node still opens the task modal on click (for easy reactivation) ──
  const archivedNode = doc.querySelector('.kf-depnode-archived');
  archivedNode.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  log('clicking the archived node closes the dependency map', doc.getElementById('depMapOverlay').classList.contains('hidden'));
  log('clicking the archived node opens the task modal for it', doc.getElementById('taskTitleInput').value === 'Create project board', doc.getElementById('taskTitleInput').value);
  log('task modal shows it as archived', doc.getElementById('taskArchivedCheckbox').checked === true);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  // ── 5. Toggling off again hides it and removes the legend mention ─────────
  doc.getElementById('depMapBtn').click();
  await wait(20);
  log('toggle state persisted across close/reopen (still on)', doc.getElementById('depMapArchiveToggle').classList.contains('active'));
  doc.getElementById('depMapArchiveToggle').click();
  await wait(20);
  log('toggle turns off', !doc.getElementById('depMapArchiveToggle').classList.contains('active'));
  nodes = doc.querySelectorAll('.kf-depnode');
  log('archived task hidden again after toggling off', nodes.length === 4, nodes.length);
  legendText = doc.getElementById('depMapLegend').textContent.toLowerCase();
  log('legend no longer mentions "archived" once toggled off', legendText.indexOf('archived') === -1, legendText);

  // ── 6. Empty-state handles "only archived tasks exist" case correctly ────
  doc.getElementById('depMapClose').click();
  await wait(10);
  const allCards = Array.from(doc.querySelectorAll('.kf-card'));
  for (const c of allCards) {
    c.click();
    await wait(10);
    doc.getElementById('taskArchivedCheckbox').checked = true;
    doc.getElementById('taskSaveBtn').click();
    await wait(15);
  }
  log('board is now empty (all tasks archived)', doc.querySelectorAll('.kf-card').length === 0);

  doc.getElementById('depMapBtn').click();
  await wait(20);
  log('dependency map shows the empty state when toggle is off and everything is archived',
      doc.querySelector('.kf-depmap-empty') !== null);

  doc.getElementById('depMapArchiveToggle').click();
  await wait(20);
  log('turning the toggle on reveals all archived tasks instead of the empty state',
      doc.querySelector('.kf-depmap-empty') === null && doc.querySelectorAll('.kf-depnode').length === 5,
      doc.querySelectorAll('.kf-depnode').length);
  log('all visible nodes are greyed out since all tasks are archived',
      doc.querySelectorAll('.kf-depnode-archived').length === 5, doc.querySelectorAll('.kf-depnode-archived').length);

  console.log('\nDependency map archived-toggle test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
