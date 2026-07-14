const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers the two "show the cap" surfaces added on top of the Column WIP Cap feature:
   1. The Workflow Manager's column node shows a second line ("Maximum capacity: N") once a cap is
      set, with its hover title switching to the fuller "<name> - Maximum capacity : <cap>" wording.
   2. The board's per-column task count badge shows "<current> of <cap>" instead of a bare count once
      a cap is set — independent of the Workflow toggle, same as cap enforcement itself. */

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  function currentProject(){
    var raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
    return raw.projects[raw.currentProjectId];
  }
  function colByName(name){
    return currentProject().columns.find(c => c.name === name);
  }
  function clickWorkflowNode(colId){
    var nodeEl = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + colId + '"]');
    nodeEl.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    nodeEl.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    nodeEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  }
  function countBadgeText(colId){
    var section = doc.querySelector('.kf-column[data-column-id="' + colId + '"]');
    return section.querySelector('.kf-count-badge').textContent;
  }

  /* ---- Enable Workflow so the Manager is reachable ---- */
  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  doc.getElementById('settingsShowWorkflowBtn').checked = true;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);

  var todoCol = colByName('To Do'); // seed data: 2 active tasks in this column

  /* ---- Board badge, before any cap is set: plain count, no "of" ---- */
  log('uncapped column shows a plain count on the board', countBadgeText(todoCol.id) === '2', countBadgeText(todoCol.id));

  /* ---- Workflow Manager node, before any cap is set: no second "Maximum capacity" line ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  var nodeText = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + todoCol.id + '"]').textContent;
  log('uncapped column\'s node has no "Maximum capacity" line', nodeText.indexOf('Maximum capacity') === -1, nodeText);

  /* ---- Set a cap of 2 via the popover ---- */
  clickWorkflowNode(todoCol.id);
  await wait(10);
  doc.getElementById('workflowColumnCapInput').value = '2';
  doc.getElementById('workflowColumnCapSaveBtn').click();
  await wait(10);
  log('cap persisted to the column', colByName('To Do').cap === 2, colByName('To Do').cap);

  /* ---- Workflow Manager node now shows the cap, on-canvas and in its hover title ---- */
  var nodeEl = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + todoCol.id + '"]');
  log('capped column\'s node shows "Maximum capacity: 2"', nodeEl.textContent.indexOf('Maximum capacity: 2') !== -1, nodeEl.textContent);
  var titleEl = nodeEl.querySelector('title');
  log('node\'s hover title reads "<name> - Maximum capacity : <cap>"', titleEl && titleEl.textContent === 'To Do - Maximum capacity : 2', titleEl && titleEl.textContent);

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Board badge now shows "2 of 2" ---- */
  log('capped column shows "<current> of <cap>" on the board', countBadgeText(todoCol.id) === '2 of 2', countBadgeText(todoCol.id));

  /* ---- Cap display stays even with Workflow disabled (same independence as enforcement itself) ---- */
  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  doc.getElementById('settingsShowWorkflowBtn').checked = false;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);
  log('the board badge still shows "of <cap>" with Workflow disabled', countBadgeText(todoCol.id) === '2 of 2', countBadgeText(todoCol.id));

  console.log('\nColumn cap display test complete.');
  process.exit(0);
})().catch(e => {
  console.error('COLUMN CAP DISPLAY TEST CRASHED:', e);
  process.exit(1);
});
