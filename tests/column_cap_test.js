const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function fakeDataTransfer(){
  var store = {};
  var types = [];
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    get types(){ return types; },
    setData: function(type, val){ store[type] = val; if(types.indexOf(type) === -1) types.push(type); },
    getData: function(type){ return store[type] || ''; }
  };
}

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

  function dragCardOverTasksWrap(cardTaskId, targetColId){
    var dt = fakeDataTransfer();
    var card = doc.querySelector('.kf-card[data-task-id="' + cardTaskId + '"]');
    var dragStart = new window.Event('dragstart', { bubbles: true, cancelable: true });
    dragStart.dataTransfer = dt;
    card.dispatchEvent(dragStart);
    var tasksWrap = doc.querySelector('.kf-tasks[data-column-id="' + targetColId + '"]');
    var dragOver = new window.Event('dragover', { bubbles: true, cancelable: true });
    dragOver.dataTransfer = dt;
    tasksWrap.dispatchEvent(dragOver);
    return {dt: dt, tasksWrap: tasksWrap, section: tasksWrap.closest('.kf-column')};
  }
  function dropOn(tasksWrap, dt){
    var drop = new window.Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = dt;
    tasksWrap.dispatchEvent(drop);
  }
  /* Real mousedown -> mouseup -> click sequence on the SAME node reference (no movement in
     between) — deliberately not a bare synthetic 'click', since that would skip
     handleWorkflowScrollMouseDown/handleWorkflowPointerUp entirely and miss any bug where those
     handlers interfere with the click that follows (e.g. a re-render that detaches the node
     before the click fires). */
  function clickWorkflowNode(colId){
    var nodeEl = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + colId + '"]');
    nodeEl.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    nodeEl.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    nodeEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
  }

  /* ---- Enable Workflow so the Manager (and its column-click Cap popover) is reachable ---- */
  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  doc.getElementById('settingsShowWorkflowBtn').checked = true;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);

  var proj = currentProject();
  var backlogCol = colByName('Backlog'), todoCol = colByName('To Do'), progressCol = colByName('In Progress');
  log('new column defaults to cap -1 (uncapped)', todoCol.cap === -1, todoCol.cap);

  /* ---- Workflow Manager: click a column node opens the Cap popover ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  clickWorkflowNode(todoCol.id);
  await wait(10);
  log('clicking a column node opens the Cap popover', !doc.getElementById('workflowColumnCapPopover').classList.contains('hidden'));
  log('popover title names the column', doc.getElementById('workflowColumnCapPopoverTitle').textContent === 'To Do', doc.getElementById('workflowColumnCapPopoverTitle').textContent);
  log('cap input starts blank ("No limit") for an uncapped column', doc.getElementById('workflowColumnCapInput').value === '');

  doc.getElementById('workflowColumnCapInput').value = '2';
  doc.getElementById('workflowColumnCapSaveBtn').click();
  await wait(10);
  log('popover closes after Save', doc.getElementById('workflowColumnCapPopover').classList.contains('hidden'));
  log('cap of 2 persisted to the column', colByName('To Do').cap === 2, colByName('To Do').cap);

  clickWorkflowNode(todoCol.id);
  await wait(10);
  log('reopening the popover shows the previously-saved cap', doc.getElementById('workflowColumnCapInput').value === '2', doc.getElementById('workflowColumnCapInput').value);
  doc.getElementById('workflowColumnCapCancelBtn').click();
  await wait(10);
  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Drag-and-drop: To Do already has 2 tasks (seed data) -> at cap, breach is blocked ---- */
  proj = currentProject();
  var backlogTask = Object.values(proj.tasks).find(t => t.columnId === backlogCol.id);
  var over1 = dragCardOverTasksWrap(backlogTask.id, todoCol.id);
  await wait(5);
  log('dragging into a column already at its cap shows a blocked (red) border', over1.section.classList.contains('kf-dragover-blocked'));
  var banner1 = over1.section.querySelector('.kf-workflow-block-banner');
  log('the blocked banner shows the cap message', banner1 && !banner1.classList.contains('hidden') && banner1.textContent.indexOf('limit') !== -1, banner1 && banner1.textContent);
  dropOn(over1.tasksWrap, over1.dt);
  await wait(20);
  log('the rejected drop leaves the task in its original column', currentProject().tasks[backlogTask.id].columnId === backlogCol.id);
  log('a toast with the cap message is shown', !!doc.querySelector('.kf-toast') && doc.querySelector('.kf-toast').textContent.indexOf('limit') !== -1);

  /* ---- Cap enforcement is independent of the Workflow toggle ---- */
  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  doc.getElementById('settingsShowWorkflowBtn').checked = false;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);

  var over2 = dragCardOverTasksWrap(backlogTask.id, todoCol.id);
  await wait(5);
  log('with Workflow disabled, a cap breach STILL shows the blocked (red) border', over2.section.classList.contains('kf-dragover-blocked'));
  dropOn(over2.tasksWrap, over2.dt);
  await wait(20);
  log('with Workflow disabled, the cap breach STILL rejects the drop', currentProject().tasks[backlogTask.id].columnId === backlogCol.id);

  /* ---- Boundary: freeing a slot lets exactly one more task in, then blocks again ---- */
  proj = currentProject();
  var todoTasks = Object.values(proj.tasks).filter(t => t.columnId === todoCol.id);
  var freedTask = todoTasks[0];
  var over3 = dragCardOverTasksWrap(freedTask.id, progressCol.id);
  await wait(5);
  log('moving a task OUT of To Do (uncapped target) is plain-allowed', over3.section.classList.contains('kf-dragover') && !over3.section.classList.contains('kf-dragover-blocked'));
  dropOn(over3.tasksWrap, over3.dt);
  await wait(20);
  log('To Do now has 1 of its 2 slots free', currentProject().columns.find(c => c.id === todoCol.id).order.filter(id => !currentProject().tasks[id].archived).length === 1);

  var over4 = dragCardOverTasksWrap(backlogTask.id, todoCol.id);
  await wait(5);
  log('with Workflow disabled and under the cap, the move is allowed but shown as the plain (blue) indicator, not green', over4.section.classList.contains('kf-dragover') && !over4.section.classList.contains('kf-dragover-allowed') && !over4.section.classList.contains('kf-dragover-blocked'));
  dropOn(over4.tasksWrap, over4.dt);
  await wait(20);
  log('the allowed drop succeeds; To Do is back at exactly its cap (2)', currentProject().tasks[backlogTask.id].columnId === todoCol.id);

  proj = currentProject();
  var anotherTask = Object.values(proj.tasks).find(t => t.columnId === progressCol.id);
  var over5 = dragCardOverTasksWrap(anotherTask.id, todoCol.id);
  await wait(5);
  log('one more than the cap is blocked again (boundary: at-cap allows, over-cap blocks)', over5.section.classList.contains('kf-dragover-blocked'));

  /* ---- Task modal Column dropdown: same cap block, not just drag-and-drop ---- */
  var progressCard = doc.querySelector('.kf-card[data-task-id="' + anotherTask.id + '"]');
  progressCard.click();
  await wait(10);
  doc.getElementById('taskColumnSelect').value = todoCol.id;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  log('saving a blocked Column-dropdown change shows the cap toast', !!doc.querySelector('.kf-toast') && doc.querySelector('.kf-toast').textContent.indexOf('limit') !== -1, doc.querySelector('.kf-toast') && doc.querySelector('.kf-toast').textContent);
  log('the task modal path leaves the task in its original column too', currentProject().tasks[anotherTask.id].columnId === progressCol.id);

  /* ---- Clearing the cap (blank) uncaps the column again ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  clickWorkflowNode(todoCol.id);
  await wait(10);
  doc.getElementById('workflowColumnCapInput').value = '';
  doc.getElementById('workflowColumnCapSaveBtn').click();
  await wait(10);
  log('saving a blank cap reverts the column to uncapped (-1)', colByName('To Do').cap === -1, colByName('To Do').cap);
  doc.getElementById('workflowClose').click();
  await wait(10);

  var over6 = dragCardOverTasksWrap(anotherTask.id, todoCol.id);
  await wait(5);
  log('an uncapped column accepts a move that was blocked moments ago', !over6.section.classList.contains('kf-dragover-blocked'));

  console.log('\nColumn Cap test complete.');
  process.exit(0);
})().catch(e => {
  console.error('COLUMN CAP TEST CRASHED:', e);
  process.exit(1);
});
