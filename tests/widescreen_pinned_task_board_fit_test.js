const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Exercises fitBoardForTaskModal/restoreBoardAfterTaskModal/refitBoardForOpenTaskModal (views/board.js)
   — the JS half of the widescreen (>=2560px) Task-modal-docks-right feature; widescreen_task_modal_
   test.js covers the CSS half (the docking + the no-backdrop/click-passthrough pane behavior). jsdom
   has no real layout engine (every rect is 0x0 and window.matchMedia doesn't even exist in this jsdom
   version — see board.js's defensive `if(!window.matchMedia)` guard, added after this exact gap
   crashed every task-modal-opening test in the suite), so every geometry input here is hand-mocked
   rather than relying on real layout. .kf-header and .kf-main-content are the two elements actually
   resized (not .kf-board-wrap directly) — board-wrap is a flex:1 child of main-content, so it tracks
   main-content's flex-basis on its own; narrowing board-wrap alone left the toolbar rows (siblings
   of board-wrap inside main-content) and the header stranded at their old full width.

   This used to also scroll the board to center the task's own column and animate the width change —
   both were removed as annoying UX (see board.js/styles.css's own comments), so this test only
   covers the instant width narrowing/restoring that's left. */

function mockRect(el, rect){ el.getBoundingClientRect = () => rect; }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  let widescreen = false;
  window.matchMedia = function(q){ return { matches: widescreen && q.indexOf('2560') !== -1 }; };
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  const header = doc.querySelector('.kf-header');
  const mainContent = doc.querySelector('.kf-main-content');
  const modalEl = doc.querySelector('#taskOverlay .kf-modal');

  // Viewport 3000px wide, a 56px side nav pushing main-content's left edge in; the header spans the
  // full viewport width above it.
  mockRect(header, { left: 0, right: 3000, width: 3000, top: 0, bottom: 52, height: 52 });
  mockRect(mainContent, { left: 56, right: 3000, width: 2944, top: 52, bottom: 800, height: 748 });
  mockRect(modalEl, { left: 2300, right: 3000, width: 700, top: 0, bottom: 800, height: 800 });

  const raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  const task = Object.values(proj.tasks)[0];
  const card = () => doc.querySelector('.kf-card[data-task-id="' + task.id + '"]');

  /* ---- Below the breakpoint: opening the Task modal leaves the header/board completely untouched ---- */
  card().click();
  await wait(10);
  log('below 2560px, opening the Task modal does not resize the header', header.style.width === '', header.style.width);
  log('below 2560px, opening the Task modal does not resize the board area', mainContent.style.flexBasis === '', mainContent.style.flexBasis);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  /* ---- At/above the breakpoint: header + board area both narrow to end flush at the modal's left
     edge (each from its own starting x) ---- */
  widescreen = true;
  card().click();
  await wait(10);
  log('at 2560px+, the header narrows to end flush at the modal\'s left edge (3000 - 0 -> 2300px)', header.style.width === '2300px', header.style.width);
  log('the board area (toolbars + board together) narrows to end flush at the same edge (2300 - 56 -> 2244px)', mainContent.style.flexBasis === '2244px', mainContent.style.flexBasis);
  log('the board area is fixed at that width (not left to flex:1 grow/shrink back)', mainContent.style.flexGrow === '0' && mainContent.style.flexShrink === '0', mainContent.style.flexGrow + '/' + mainContent.style.flexShrink);

  /* ---- Closing the modal hands both back to their normal CSS-driven width ---- */
  doc.getElementById('taskCancelBtn').click();
  await wait(10);
  log('closing the modal clears the header\'s inline width override', header.style.width === '', header.style.width);
  log('closing the modal clears the board area\'s inline flex overrides', mainContent.style.flexBasis === '' && mainContent.style.flexGrow === '' && mainContent.style.flexShrink === '', mainContent.style.flexBasis);

  /* ---- Resize while open: dropping below the breakpoint restores both; resizing while still above
     it re-fits both to the new available width ---- */
  card().click();
  await wait(10);
  widescreen = false;
  window.dispatchEvent(new window.Event('resize'));
  await wait(10);
  log('resizing below the breakpoint while the modal is open restores the header', header.style.width === '', header.style.width);
  log('resizing below the breakpoint while the modal is open restores the board area', mainContent.style.flexBasis === '', mainContent.style.flexBasis);

  widescreen = true;
  mockRect(header, { left: 0, right: 3300, width: 3300, top: 0, bottom: 52, height: 52 });
  mockRect(mainContent, { left: 56, right: 3300, width: 3244, top: 52, bottom: 800, height: 748 });
  mockRect(modalEl, { left: 2600, right: 3300, width: 700, top: 0, bottom: 800, height: 800 });
  window.dispatchEvent(new window.Event('resize'));
  await wait(10);
  log('resizing a wider viewport while still docked re-fits the header to the new available width', header.style.width === '2600px', header.style.width);
  log('re-fits the board area to the new available width too', mainContent.style.flexBasis === '2544px', mainContent.style.flexBasis);

  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  console.log('\nWidescreen pinned Task modal board-fit test complete.');
  process.exit(0);
})().catch(e => {
  console.error('WIDESCREEN BOARD FIT TEST CRASHED:', e);
  process.exit(1);
});
