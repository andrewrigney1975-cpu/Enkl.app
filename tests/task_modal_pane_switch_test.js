const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers the "act like a pane, not a modal" behavior added alongside the widescreen (>=2560px)
   docked Task panel: clicking a different task card while one is already open should switch
   straight to the new task, never closing the panel in between — see styles.css's #taskOverlay
   pointer-events:none (which lets clicks pass through the backdrop to the board underneath in a
   real browser) and app.js's "mousedown on #taskOverlay itself closes it" handler, which that
   pointer-events change stops from ever firing over the backdrop area. jsdom doesn't enforce CSS
   pointer-events for synthetic events (a dispatched click always hits whatever target it's given,
   regardless of any overlapping element's pointer-events), so the click-passthrough mechanism itself
   is covered by widescreen_task_modal_test.js's CSS-source assertions instead — what THIS test
   verifies is the application-logic half: that opening a second task while the first is still open
   correctly re-populates the panel (title, description, etc.) with the new task's data without the
   overlay ever toggling back to hidden in between. */

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const tasks = Object.values(proj.tasks);
  const taskA = tasks[0];
  const taskB = tasks.find(t => t.id !== taskA.id);
  const cardA = () => doc.querySelector('.kf-card[data-task-id="' + taskA.id + '"]');
  const cardB = () => doc.querySelector('.kf-card[data-task-id="' + taskB.id + '"]');

  cardA().click();
  await wait(10);
  log('opening task A shows the Task modal', !doc.getElementById('taskOverlay').classList.contains('hidden'));
  log('the form shows task A\'s title', doc.getElementById('taskTitleInput').value === taskA.title, doc.getElementById('taskTitleInput').value);

  // Deliberately no Cancel/Close in between — this is exactly what board.js's card click handler
  // does in a real browser once the backdrop stops intercepting the click (see the doc comment
  // above): open the newly-clicked task directly over the top of whatever's already showing.
  cardB().click();
  await wait(10);
  log('clicking a second task never closes the panel in between', !doc.getElementById('taskOverlay').classList.contains('hidden'));
  log('the form now shows task B\'s title instead', doc.getElementById('taskTitleInput').value === taskB.title, doc.getElementById('taskTitleInput').value);
  log('editingTaskId switched to task B (Save would update B, not A)', doc.getElementById('taskModalTitle').textContent.indexOf(taskB.key) !== -1, doc.getElementById('taskModalTitle').textContent);

  doc.getElementById('taskCancelBtn').click();
  await wait(10);
  log('closing afterward still works normally', doc.getElementById('taskOverlay').classList.contains('hidden'));

  console.log('\nTask modal pane-switch test complete.');
  process.exit(0);
})().catch(e => {
  console.error('TASK MODAL PANE SWITCH TEST CRASHED:', e);
  process.exit(1);
});
