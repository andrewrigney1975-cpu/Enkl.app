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

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
  };
}

(async () => {
  let lastBlobText = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  installFakeFileReader(window);
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };
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

  /* ---- App Setting: off (hidden) by default, unlike every other module ---- */
  log('Workflow toolbar button hidden by default', doc.getElementById('workflowBtn').classList.contains('kf-vis-hidden'));
  log('Workflow side-nav item hidden by default', doc.getElementById('navWorkflowBtn').classList.contains('kf-vis-hidden'));

  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  log('Workflow checkbox in App Settings starts UNCHECKED (fail-closed, unlike Documents/Risks/etc.)',
      !doc.getElementById('settingsShowWorkflowBtn').checked);

  doc.getElementById('settingsShowWorkflowBtn').checked = true;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('checking it live-shows the toolbar icon', !doc.getElementById('workflowBtn').classList.contains('kf-vis-hidden'));
  log('checking it live-shows the side-nav icon', !doc.getElementById('navWorkflowBtn').classList.contains('kf-vis-hidden'));
  log('the setting persisted to the project', currentProject().headerButtonVisibility.workflow === true);
  doc.getElementById('appSettingsClose').click();
  await wait(10);

  /* ---- Default workflow: one node per column, forward-only Allowed edges ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  log('opening Workflow shows the modal', !doc.getElementById('workflowOverlay').classList.contains('hidden'));
  log('modal uses the large modal size', doc.querySelector('#workflowOverlay .kf-modal').classList.contains('kf-modal-lg'));

  let proj = currentProject();
  const backlogCol = colByName('Backlog'), todoCol = colByName('To Do'), progressCol = colByName('In Progress'), doneCol = colByName('Done');

  let nodeEls = Array.from(doc.querySelectorAll('#workflowInner .kf-wfnode'));
  log('one node rendered per column', nodeEls.length === proj.columns.length, nodeEls.length);
  log('workflow materialized with one node per column in storage', Object.keys(proj.workflow.nodes).length === proj.columns.length);
  log('first-materialization seeds forward-only Allowed edges between adjacent columns (3 for 4 columns)',
      proj.workflow.edges.length === 3, proj.workflow.edges.length);
  log('all default edges are type allowed with no message', proj.workflow.edges.every(e => e.type === 'allowed' && e.message === null));
  const backlogToTodo = proj.workflow.edges.find(e => e.fromColumnId === backlogCol.id && e.toColumnId === todoCol.id);
  log('Backlog -> To Do is one of the default allowed edges', !!backlogToTodo);
  log('editor renders one green (allowed) edge line per default edge', doc.querySelectorAll('#workflowInner .kf-wfedge').length === 3);

  doc.getElementById('workflowClose').click();
  await wait(10);
  log('closing the modal hides it', doc.getElementById('workflowOverlay').classList.contains('hidden'));

  /* ---- Drag-and-drop enforcement: blocked (no edge defined) ---- */
  proj = currentProject();
  const t1 = Object.values(proj.tasks).find(t => t.columnId === backlogCol.id);
  let backlogCard = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  let progressTasksWrap = doc.querySelector('.kf-tasks[data-column-id="' + progressCol.id + '"]');
  let progressSection = progressTasksWrap.closest('.kf-column');

  const dt1 = fakeDataTransfer();
  const dragStart1 = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragStart1.dataTransfer = dt1;
  backlogCard.dispatchEvent(dragStart1);

  const dragOver1 = new window.Event('dragover', { bubbles: true, cancelable: true });
  dragOver1.dataTransfer = dt1;
  progressTasksWrap.dispatchEvent(dragOver1);
  await wait(5);
  log('dragging a Backlog task over In Progress (no edge defined, skips a step) shows a blocked (red) border',
      progressSection.classList.contains('kf-dragover-blocked'));
  const banner1 = progressSection.querySelector('.kf-workflow-block-banner');
  log('the blocked banner shows the default deny message', banner1 && !banner1.classList.contains('hidden') && banner1.textContent.indexOf('not allowed') !== -1, banner1 && banner1.textContent);

  const drop1 = new window.Event('drop', { bubbles: true, cancelable: true });
  drop1.dataTransfer = dt1;
  progressTasksWrap.dispatchEvent(drop1);
  await wait(20);
  log('the rejected drop leaves the task in its original column', currentProject().tasks[t1.id].columnId === backlogCol.id);
  log('a toast with the block message is shown', !!doc.querySelector('.kf-toast') && doc.querySelector('.kf-toast').textContent.indexOf('not allowed') !== -1);

  /* ---- Drag-and-drop enforcement: allowed (adjacent, default edge) ---- */
  backlogCard = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  let todoTasksWrap = doc.querySelector('.kf-tasks[data-column-id="' + todoCol.id + '"]');
  let todoSection = todoTasksWrap.closest('.kf-column');

  const dt2 = fakeDataTransfer();
  const dragStart2 = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragStart2.dataTransfer = dt2;
  backlogCard.dispatchEvent(dragStart2);

  const dragOver2 = new window.Event('dragover', { bubbles: true, cancelable: true });
  dragOver2.dataTransfer = dt2;
  todoTasksWrap.dispatchEvent(dragOver2);
  await wait(5);
  log('dragging over To Do (adjacent, default-allowed) shows a green border', todoSection.classList.contains('kf-dragover-allowed'));

  const drop2 = new window.Event('drop', { bubbles: true, cancelable: true });
  drop2.dataTransfer = dt2;
  todoTasksWrap.dispatchEvent(drop2);
  await wait(20);
  log('the allowed drop succeeds; task moved to To Do', currentProject().tasks[t1.id].columnId === todoCol.id);

  /* ---- Edit Task modal: Column selector only lists reachable columns ---- */
  const movedCard = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  movedCard.click();
  await wait(10);
  let optionIds = Array.from(doc.querySelectorAll('#taskColumnSelect option')).map(o => o.value);
  log('Edit Task Column selector lists exactly the current column plus reachable ones (To Do, In Progress)',
      optionIds.length === 2 && optionIds.indexOf(todoCol.id) !== -1 && optionIds.indexOf(progressCol.id) !== -1,
      optionIds.join(','));
  log('Done and Backlog are excluded (not reachable from To Do)',
      optionIds.indexOf(doneCol.id) === -1 && optionIds.indexOf(backlogCol.id) === -1);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  /* ---- Workflow editor: drawing a Disallowed connector with a custom message ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  doc.getElementById('workflowModeDisallowedBtn').click();
  await wait(10);
  log('Draw Disallowed mode button becomes active', doc.getElementById('workflowModeDisallowedBtn').classList.contains('active'));
  log('Select mode button is no longer active', !doc.getElementById('workflowModeSelectBtn').classList.contains('active'));

  const doneNodeEl = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + doneCol.id + '"]');
  const todoNodeEl = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + todoCol.id + '"]');
  doc.elementFromPoint = function(){ return todoNodeEl; };

  doneNodeEl.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 100, button: 0 }));
  await wait(5);
  log('starting a drag from a node creates a draft (in-progress) connector line', !!doc.getElementById('workflowDraftEdge'));
  doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 100 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 150, clientY: 100 }));
  await wait(20);

  proj = currentProject();
  let doneToTodo = proj.workflow.edges.find(e => e.fromColumnId === doneCol.id && e.toColumnId === todoCol.id);
  log('releasing over another node creates a Disallowed edge Done -> To Do', !!doneToTodo && doneToTodo.type === 'disallowed', JSON.stringify(doneToTodo));
  log('creating a Disallowed connector auto-opens the message popover', !doc.getElementById('workflowEdgePopover').classList.contains('hidden'));
  const popoverTitle = doc.getElementById('workflowEdgePopoverTitle').textContent;
  log('popover title names both columns', popoverTitle.indexOf('Done') !== -1 && popoverTitle.indexOf('To Do') !== -1, popoverTitle);

  const customMessage = 'Needs sign-off before returning to To Do.';
  doc.getElementById('workflowEdgeMessageInput').value = customMessage;
  doc.getElementById('workflowEdgeSaveBtn').click();
  await wait(10);
  proj = currentProject();
  let savedEdge = proj.workflow.edges.find(e => e.id === doneToTodo.id);
  log('saving the popover persists the custom message', savedEdge.message === customMessage, savedEdge.message);
  log('popover closes after Save', doc.getElementById('workflowEdgePopover').classList.contains('hidden'));

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Drag-and-drop enforcement: Disallowed edge shows its custom message ---- */
  proj = currentProject();
  const t5 = Object.values(proj.tasks).find(t => t.columnId === doneCol.id);
  const doneCard = doc.querySelector('.kf-card[data-task-id="' + t5.id + '"]');
  todoTasksWrap = doc.querySelector('.kf-tasks[data-column-id="' + todoCol.id + '"]');
  todoSection = todoTasksWrap.closest('.kf-column');

  const dt3 = fakeDataTransfer();
  const dragStart3 = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragStart3.dataTransfer = dt3;
  doneCard.dispatchEvent(dragStart3);
  const dragOver3 = new window.Event('dragover', { bubbles: true, cancelable: true });
  dragOver3.dataTransfer = dt3;
  todoTasksWrap.dispatchEvent(dragOver3);
  await wait(5);
  log('dragging a Done task back to To Do (explicit Disallowed edge) shows a blocked border', todoSection.classList.contains('kf-dragover-blocked'));
  const banner3 = todoSection.querySelector('.kf-workflow-block-banner');
  log('the banner shows the custom message, not the generic default', banner3 && banner3.textContent === customMessage, banner3 && banner3.textContent);

  const drop3 = new window.Event('drop', { bubbles: true, cancelable: true });
  drop3.dataTransfer = dt3;
  todoTasksWrap.dispatchEvent(drop3);
  await wait(20);
  log('the drop is rejected; task stays in Done', currentProject().tasks[t5.id].columnId === doneCol.id);

  /* ---- Workflow editor: click an edge (Select mode) to edit/delete it ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  doc.getElementById('workflowModeSelectBtn').click();
  await wait(10);
  const edgeHit = doc.querySelector('#workflowInner .kf-wfedge-hit[data-edge-id="' + savedEdge.id + '"]');
  edgeHit.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(10);
  log('clicking an edge in Select mode reopens its popover, pre-filled',
      !doc.getElementById('workflowEdgePopover').classList.contains('hidden') &&
      doc.getElementById('workflowEdgeTypeSelect').value === 'disallowed' &&
      doc.getElementById('workflowEdgeMessageInput').value === customMessage);

  doc.getElementById('workflowEdgeDeleteBtn').click();
  await wait(10);
  proj = currentProject();
  log('Delete removes the edge from storage', !proj.workflow.edges.find(e => e.id === savedEdge.id));
  log('the edge is gone from the SVG too', !doc.querySelector('#workflowInner .kf-wfedge-hit[data-edge-id="' + savedEdge.id + '"]'));
  log('popover closes after delete', doc.getElementById('workflowEdgePopover').classList.contains('hidden'));

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Connectors: orthogonal with rounded (filleted) corners, matching the Dependency Graph's
     own edge style (roundedOrthogonalPathD, shared from dependency-map.js) — no cubic bezier ("C")
     commands at all; a "Q" fillet only appears where the route actually bends, so an already-level
     pair of nodes legitimately renders a plain straight "L" segment with no "Q". */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  const samplePath = doc.querySelector('#workflowInner .kf-wfedge');
  log('connector paths are orthogonal with rounded corners ("L"/"Q"), not a cubic bezier ("C")',
      samplePath && samplePath.getAttribute('d').indexOf(' L ') !== -1 && samplePath.getAttribute('d').indexOf(' C ') === -1,
      samplePath && samplePath.getAttribute('d'));
  log('connectors carry both a start marker and an end marker (dot style)',
      samplePath && !!samplePath.getAttribute('marker-start') && !!samplePath.getAttribute('marker-end'),
      samplePath && (samplePath.getAttribute('marker-start') + ' / ' + samplePath.getAttribute('marker-end')));

  /* ---- Conditional Allow: creating a connector, condition builder UI ---- */
  doc.getElementById('workflowModeConditionalBtn').click();
  await wait(10);
  log('Draw Conditional mode button becomes active', doc.getElementById('workflowModeConditionalBtn').classList.contains('active'));

  const todoNode2 = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + todoCol.id + '"]');
  const doneNode2 = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + doneCol.id + '"]');
  doc.elementFromPoint = function(){ return doneNode2; };
  todoNode2.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 50, clientY: 50, button: 0 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 60 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 60 }));
  await wait(20);

  proj = currentProject();
  let todoToDone = proj.workflow.edges.find(e => e.fromColumnId === todoCol.id && e.toColumnId === doneCol.id);
  log('releasing creates a Conditional Allow edge To Do -> Done', !!todoToDone && todoToDone.type === 'conditional', JSON.stringify(todoToDone));
  log('the new edge gets the default condition (Assignee is set)',
      todoToDone.condition && todoToDone.condition.field === 'assigneeId' && todoToDone.condition.operator === 'is_set', JSON.stringify(todoToDone.condition));
  log('creating a Conditional connector auto-opens the popover', !doc.getElementById('workflowEdgePopover').classList.contains('hidden'));
  log('popover shows Conditional Allow selected as the type', doc.getElementById('workflowEdgeTypeSelect').value === 'conditional');
  log('the condition builder row is visible for a Conditional edge', !doc.getElementById('workflowEdgeConditionRow').classList.contains('hidden'));
  log('the value field is hidden for "is set" (that operator needs no value)', doc.getElementById('workflowEdgeConditionValueField').classList.contains('hidden'));

  doc.getElementById('workflowEdgeConditionFieldSelect').value = 'businessValue';
  doc.getElementById('workflowEdgeConditionFieldSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  const numericOps = Array.from(doc.querySelectorAll('#workflowEdgeConditionOperatorSelect option')).map(o => o.value);
  log('switching to a numeric field (Business Value) repopulates operators with numeric comparisons',
      numericOps.indexOf('greater_than') !== -1 && numericOps.indexOf('is_set') === -1, numericOps.join(','));
  log('the value field becomes visible with a number input for a numeric field',
      !doc.getElementById('workflowEdgeConditionValueField').classList.contains('hidden') &&
      !doc.getElementById('workflowEdgeConditionValueInput').classList.contains('hidden') &&
      doc.getElementById('workflowEdgeConditionValueInput').type === 'number');

  doc.getElementById('workflowEdgeConditionFieldSelect').value = 'priority';
  doc.getElementById('workflowEdgeConditionFieldSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  log('switching to an enum field (Priority) shows a value <select> populated with priority options',
      !doc.getElementById('workflowEdgeConditionValueSelect').classList.contains('hidden') &&
      doc.getElementById('workflowEdgeConditionValueInput').classList.contains('hidden') &&
      doc.querySelectorAll('#workflowEdgeConditionValueSelect option').length === 5);

  doc.getElementById('workflowEdgeConditionFieldSelect').value = 'assigneeId';
  doc.getElementById('workflowEdgeConditionFieldSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  const conditionalMessage = 'Assign this task before it can move to Done.';
  doc.getElementById('workflowEdgeMessageInput').value = conditionalMessage;
  doc.getElementById('workflowEdgeSaveBtn').click();
  await wait(10);
  proj = currentProject();
  let savedConditionalEdge = proj.workflow.edges.find(e => e.id === todoToDone.id);
  log('saving persists the Assignee-is-set condition and the message',
      savedConditionalEdge.condition.field === 'assigneeId' && savedConditionalEdge.condition.operator === 'is_set' && savedConditionalEdge.message === conditionalMessage,
      JSON.stringify(savedConditionalEdge));

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Conditional Allow enforcement: fails while unassigned ---- */
  proj = currentProject();
  log('sanity check: t1 is still unassigned', !proj.tasks[t1.id].assigneeId);
  let t1Card = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  let doneTasksWrap2 = doc.querySelector('.kf-tasks[data-column-id="' + doneCol.id + '"]');
  let doneSection2 = doneTasksWrap2.closest('.kf-column');

  const dtC1 = fakeDataTransfer();
  const dragStartC1 = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragStartC1.dataTransfer = dtC1;
  t1Card.dispatchEvent(dragStartC1);
  const dragOverC1 = new window.Event('dragover', { bubbles: true, cancelable: true });
  dragOverC1.dataTransfer = dtC1;
  doneTasksWrap2.dispatchEvent(dragOverC1);
  await wait(5);
  log('dragging an unassigned task along the "Assignee is set" Conditional edge is blocked (red)', doneSection2.classList.contains('kf-dragover-blocked'));
  const conditionalBanner = doneSection2.querySelector('.kf-workflow-block-banner');
  log('the banner shows the connector\'s configured message', conditionalBanner && conditionalBanner.textContent === conditionalMessage, conditionalBanner && conditionalBanner.textContent);

  const dropC1 = new window.Event('drop', { bubbles: true, cancelable: true });
  dropC1.dataTransfer = dtC1;
  doneTasksWrap2.dispatchEvent(dropC1);
  await wait(20);
  log('the drop is rejected while the condition fails', currentProject().tasks[t1.id].columnId === todoCol.id);

  /* ---- Edit Task Column dropdown reflects the same Conditional rule ---- */
  t1Card = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  t1Card.click();
  await wait(10);
  let colOptionIds = Array.from(doc.querySelectorAll('#taskColumnSelect option')).map(o => o.value);
  log('while unassigned, Done is excluded from the Column dropdown (condition currently fails)', colOptionIds.indexOf(doneCol.id) === -1, colOptionIds.join(','));

  // Seed data no longer includes any members (see storage.js's createSeedDB() comment) — add one so
  // there's a real assignee option to pick here.
  doc.getElementById('taskCancelBtn').click();
  await wait(10);
  doc.getElementById('manageTeamBtn').click();
  await wait(50);
  doc.getElementById('newMemberNameInput').value = 'Test Member';
  doc.getElementById('addMemberBtn').click();
  await wait(50);
  doc.getElementById('teamDoneBtn').click();
  await wait(50);
  t1Card = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  t1Card.click();
  await wait(10);

  const assigneeOptions = Array.from(doc.querySelectorAll('#taskAssigneeSelect option'));
  const firstRealAssignee = assigneeOptions.find(o => o.value);
  doc.getElementById('taskAssigneeSelect').value = firstRealAssignee.value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  log('the assignee was saved and the task stayed in To Do (column selection unchanged)',
      currentProject().tasks[t1.id].assigneeId === firstRealAssignee.value && currentProject().tasks[t1.id].columnId === todoCol.id);

  t1Card = doc.querySelector('.kf-card[data-task-id="' + t1.id + '"]');
  t1Card.click();
  await wait(10);
  colOptionIds = Array.from(doc.querySelectorAll('#taskColumnSelect option')).map(o => o.value);
  log('once assigned, Done is included in the Column dropdown (condition now passes)', colOptionIds.indexOf(doneCol.id) !== -1, colOptionIds.join(','));
  doc.getElementById('taskColumnSelect').value = doneCol.id;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  log('saving the Column change via the modal succeeds once the condition passes', currentProject().tasks[t1.id].columnId === doneCol.id);

  /* ---- Deleting a Conditional connector removes it (rule + connector together) ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  doc.getElementById('workflowModeSelectBtn').click();
  await wait(10);
  const conditionalEdgeHit = doc.querySelector('#workflowInner .kf-wfedge-hit[data-edge-id="' + savedConditionalEdge.id + '"]');
  conditionalEdgeHit.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(10);
  log('clicking the Conditional edge reopens its popover, pre-filled',
      !doc.getElementById('workflowEdgePopover').classList.contains('hidden') &&
      doc.getElementById('workflowEdgeTypeSelect').value === 'conditional' &&
      doc.getElementById('workflowEdgeConditionFieldSelect').value === 'assigneeId' &&
      doc.getElementById('workflowEdgeMessageInput').value === conditionalMessage);
  doc.getElementById('workflowEdgeDeleteBtn').click();
  await wait(10);
  proj = currentProject();
  log('Delete removes the Conditional edge (rule + connector) from storage', !proj.workflow.edges.find(e => e.id === savedConditionalEdge.id));
  log('the connector is gone from the SVG too', !doc.querySelector('#workflowInner .kf-wfedge-hit[data-edge-id="' + savedConditionalEdge.id + '"]'));

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Workflow customization round-trips through export/import ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);
  doc.getElementById('workflowModeDisallowedBtn').click();
  await wait(10);
  const backlogNodeRT = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + backlogCol.id + '"]');
  const doneNodeRT = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + doneCol.id + '"]');
  doc.elementFromPoint = function(){ return doneNodeRT; };
  backlogNodeRT.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 20 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 80, clientY: 20 }));
  await wait(20);
  const exportRoundTripMessage = 'Cannot skip straight to Done from Backlog.';
  doc.getElementById('workflowEdgeMessageInput').value = exportRoundTripMessage;
  doc.getElementById('workflowEdgeSaveBtn').click();
  await wait(10);
  doc.getElementById('workflowClose').click();
  await wait(10);

  proj = currentProject();
  const originalWorkflowSnapshot = JSON.parse(JSON.stringify(proj.workflow));

  doc.getElementById('exportBtn').click();
  await wait(20);
  const exportedDoc = JSON.parse(lastBlobText);
  log('export includes a workflow field with nodes and edges', !!exportedDoc.workflow && !!exportedDoc.workflow.nodes && Array.isArray(exportedDoc.workflow.edges));
  log('exported columns carry their id (needed to remap workflow references on re-import)',
      exportedDoc.columns.every(c => typeof c.id === 'string' && !!c.id));
  log('the exported workflow edge count matches the live project',
      exportedDoc.workflow.edges.length === originalWorkflowSnapshot.edges.length,
      exportedDoc.workflow.edges.length + ' vs ' + originalWorkflowSnapshot.edges.length);

  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  const importedProj = currentProject();
  log('the imported project has its own workflow object (not shared/aliased with the original)',
      !!importedProj.workflow && importedProj.workflow !== proj.workflow);
  log('the imported workflow has the same number of nodes and edges as the original',
      Object.keys(importedProj.workflow.nodes).length === Object.keys(originalWorkflowSnapshot.nodes).length &&
      importedProj.workflow.edges.length === originalWorkflowSnapshot.edges.length,
      Object.keys(importedProj.workflow.nodes).length + '/' + importedProj.workflow.edges.length);

  const importedColumnIdByName = {};
  importedProj.columns.forEach(c => { importedColumnIdByName[c.name] = c.id; });
  const importedBacklogToDone = importedProj.workflow.edges.find(e =>
    e.fromColumnId === importedColumnIdByName['Backlog'] && e.toColumnId === importedColumnIdByName['Done']);
  log('the Disallowed Backlog -> Done edge round-tripped with its message, remapped to the new column ids',
      !!importedBacklogToDone && importedBacklogToDone.type === 'disallowed' && importedBacklogToDone.message === exportRoundTripMessage,
      JSON.stringify(importedBacklogToDone));

  const importedToDoToInProgress = importedProj.workflow.edges.find(e =>
    e.fromColumnId === importedColumnIdByName['To Do'] && e.toColumnId === importedColumnIdByName['In Progress']);
  log('a plain default Allowed edge also round-tripped correctly', !!importedToDoToInProgress && importedToDoToInProgress.type === 'allowed');

  log('imported node positions carry over for a column present in both exports (Backlog)',
      !!importedProj.workflow.nodes[importedColumnIdByName['Backlog']] &&
      importedProj.workflow.nodes[importedColumnIdByName['Backlog']].x === originalWorkflowSnapshot.nodes[backlogCol.id].x,
      JSON.stringify(importedProj.workflow.nodes[importedColumnIdByName['Backlog']]));

  /* Importing switched the active project to the new copy — switch back
     to the original so every assertion below (which references its
     column/task ids) keeps working. */
  doc.getElementById('projectSelect').value = proj.id;
  doc.getElementById('projectSelect').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(20);
  log('switched back to the original project for the remaining assertions', currentProject().id === proj.id);

  /* ---- Reflow: rearranges nodes to reduce connector overlap ---- */
  doc.getElementById('workflowBtn').click();
  await wait(20);

  proj = currentProject();
  const beforeCancelNodes = JSON.parse(JSON.stringify(proj.workflow.nodes));
  doc.getElementById('workflowReflowBtn').click();
  await wait(10);
  log('clicking Reflow opens a confirm dialog before changing anything', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
  const confirmZ = parseInt(window.getComputedStyle(doc.getElementById('confirmOverlay')).zIndex, 10);
  const workflowZ = parseInt(window.getComputedStyle(doc.getElementById('workflowOverlay')).zIndex, 10);
  log('the confirm dialog stacks above the still-open Workflow editor (z-index)', confirmZ > workflowZ, confirmZ + ' vs ' + workflowZ);
  doc.getElementById('confirmCancelBtn').click();
  await wait(10);
  log('canceling the confirm leaves node positions untouched',
      JSON.stringify(currentProject().workflow.nodes) === JSON.stringify(beforeCancelNodes));

  doc.getElementById('workflowReflowBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);

  proj = currentProject();
  const backlogPos = proj.workflow.nodes[backlogCol.id];
  const todoPos = proj.workflow.nodes[todoCol.id];
  const progressPos = proj.workflow.nodes[progressCol.id];
  const donePos = proj.workflow.nodes[doneCol.id];
  log('Reflow preserves left-to-right column order (x strictly increasing, Backlog < To Do < In Progress < Done)',
      backlogPos.x < todoPos.x && todoPos.x < progressPos.x && progressPos.x < donePos.x,
      [backlogPos.x, todoPos.x, progressPos.x, donePos.x].join(','));
  log('the columns skipped by the Backlog -> Done connector move to a different row than Backlog/Done',
      todoPos.y !== backlogPos.y && progressPos.y !== backlogPos.y && backlogPos.y === donePos.y,
      JSON.stringify({backlog: backlogPos.y, todo: todoPos.y, progress: progressPos.y, done: donePos.y}));
  log('the two skipped columns land on the same detour row as each other', todoPos.y === progressPos.y);

  const afterFirstReflow = JSON.parse(JSON.stringify(proj.workflow.nodes));
  doc.getElementById('workflowReflowBtn').click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  log('Reflow is idempotent — running it again produces the same positions',
      JSON.stringify(currentProject().workflow.nodes) === JSON.stringify(afterFirstReflow));

  /* ---- Regression: clicking a connector still works after dragging a node ---- */
  doc.getElementById('workflowModeSelectBtn').click();
  await wait(10);
  proj = currentProject();
  const dragTargetNode = doc.querySelector('#workflowInner .kf-wfnode[data-column-id="' + todoCol.id + '"]');
  dragTargetNode.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 200, clientY: 200, button: 0 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 240 }));
  await wait(5);
  doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 260, clientY: 240 }));
  await wait(60); // past the dragMoved reset delay

  const anyEdgeHit = doc.querySelector('#workflowInner .kf-wfedge-hit');
  anyEdgeHit.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait(10);
  log('clicking a connector still opens its popover after a node has been dragged',
      !doc.getElementById('workflowEdgePopover').classList.contains('hidden'));
  doc.getElementById('workflowEdgeCancelBtn').click();
  await wait(10);

  doc.getElementById('workflowClose').click();
  await wait(10);

  /* ---- Column deletion cleans up its workflow node + referencing edges ---- */
  const doneSection = doc.querySelector('.kf-column[data-column-id="' + doneCol.id + '"]');
  const doneDeleteBtn = doneSection.querySelector('.kf-column-actions button[title="Delete column"]');
  doneDeleteBtn.click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(20);
  proj = currentProject();
  log('deleting a column removes its workflow node', !proj.workflow.nodes[doneCol.id]);
  log('deleting a column removes edges referencing it (In Progress -> Done)',
      !proj.workflow.edges.some(e => e.fromColumnId === doneCol.id || e.toColumnId === doneCol.id));

  /* ---- Turning the setting back off restores fully unrestricted behavior ---- */
  doc.getElementById('appSettingsBtn').click();
  await wait(10);
  doc.getElementById('settingsShowWorkflowBtn').checked = false;
  doc.getElementById('settingsShowWorkflowBtn').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(10);
  doc.getElementById('appSettingsClose').click();
  await wait(10);
  log('disabling the setting hides the toolbar icon again', doc.getElementById('workflowBtn').classList.contains('kf-vis-hidden'));
  log('disabling the setting hides the side-nav icon again', doc.getElementById('navWorkflowBtn').classList.contains('kf-vis-hidden'));

  proj = currentProject();
  const t4 = Object.values(proj.tasks).find(t => t.columnId === progressCol.id);
  progressTasksWrap = doc.querySelector('.kf-tasks[data-column-id="' + progressCol.id + '"]');
  progressSection = progressTasksWrap.closest('.kf-column');
  const progressCard = doc.querySelector('.kf-card[data-task-id="' + t4.id + '"]');
  const backlogTasksWrap2 = doc.querySelector('.kf-tasks[data-column-id="' + backlogCol.id + '"]');
  const backlogSection2 = backlogTasksWrap2.closest('.kf-column');

  const dt4 = fakeDataTransfer();
  const dragStart4 = new window.Event('dragstart', { bubbles: true, cancelable: true });
  dragStart4.dataTransfer = dt4;
  progressCard.dispatchEvent(dragStart4);
  const dragOver4 = new window.Event('dragover', { bubbles: true, cancelable: true });
  dragOver4.dataTransfer = dt4;
  backlogTasksWrap2.dispatchEvent(dragOver4);
  await wait(5);
  log('with the workflow disabled, dragover uses the plain (blue) indicator, not green/red',
      backlogSection2.classList.contains('kf-dragover') && !backlogSection2.classList.contains('kf-dragover-allowed') && !backlogSection2.classList.contains('kf-dragover-blocked'));
  const drop4 = new window.Event('drop', { bubbles: true, cancelable: true });
  drop4.dataTransfer = dt4;
  backlogTasksWrap2.dispatchEvent(drop4);
  await wait(20);
  log('with the workflow disabled, any transition succeeds (In Progress -> Backlog, backward)', currentProject().tasks[t4.id].columnId === backlogCol.id);

  const anyCard = doc.querySelector('.kf-card');
  anyCard.click();
  await wait(10);
  const allColOptionIds = Array.from(doc.querySelectorAll('#taskColumnSelect option')).map(o => o.value);
  proj = currentProject();
  log('with the workflow disabled, Edit Task Column selector lists every column again',
      allColOptionIds.length === proj.columns.length, allColOptionIds.length + ' vs ' + proj.columns.length);
  doc.getElementById('taskCancelBtn').click();
  await wait(10);

  /* ---- Migration: absent workflow stays absent; corrupted workflow is sanitized ---- */
  const legacyDB = {
    projects: {
      p_no_wf: {
        id: 'p_no_wf', name: 'No Workflow Project', key: 'NWF', taskCounter: 1,
        columns: [{ id: 'col1', name: 'To Do', done: false, order: [] }],
        tasks: {}, members: [], releases: [], taskTypes: [], startDate: null, endDate: null,
        dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null,
        documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1, approvers: []
      },
      p_corrupt_wf: {
        id: 'p_corrupt_wf', name: 'Corrupt Workflow Project', key: 'CWF', taskCounter: 1,
        columns: [{ id: 'colA', name: 'A', done: false, order: [] }, { id: 'colB', name: 'B', done: false, order: [] }],
        tasks: {}, members: [], releases: [], taskTypes: [], startDate: null, endDate: null,
        dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null,
        documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1, approvers: [],
        workflow: {
          nodes: { colA: { x: 0, y: 0 }, colB: { x: 200, y: 0 }, colGONE: { x: 400, y: 0 } },
          edges: [
            { id: 'e1', fromColumnId: 'colA', toColumnId: 'colB', type: 'allowed', message: null },
            { id: 'e2', fromColumnId: 'colB', toColumnId: 'colGONE', type: 'allowed', message: null },
            { id: 'e4', fromColumnId: 'colB', toColumnId: 'colA', type: 'not-a-real-type', message: 123 }
          ]
        }
      }
    },
    projectOrder: ['p_no_wf', 'p_corrupt_wf'], currentProjectId: 'p_no_wf'
  };
  const dom2 = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(legacyDB)); }
  });
  await wait(350);
  const raw2 = JSON.parse(dom2.window.localStorage.getItem('kanbanflow_v1_db'));
  log('a project with no workflow field at all stays without one after migration (preserves first-materialization detection)',
      raw2.projects.p_no_wf.workflow === undefined);

  const cwf = raw2.projects.p_corrupt_wf.workflow;
  log('migration drops the node referencing a deleted column, keeps valid ones',
      !cwf.nodes.colGONE && !!cwf.nodes.colA && !!cwf.nodes.colB);
  log('migration drops edges referencing a deleted column (e2), keeps valid ones (e1, e4)',
      cwf.edges.length === 2 && !cwf.edges.find(e => e.id === 'e2'), JSON.stringify(cwf.edges));
  const e4after = cwf.edges.find(e => e.id === 'e4');
  log('migration coerces an invalid edge type to "allowed"', e4after && e4after.type === 'allowed', e4after && e4after.type);
  log('migration coerces a non-string message to null', e4after && e4after.message === null, e4after && e4after.message);

  const doc2 = dom2.window.document;
  log('a legacy project with no workflow setting keeps the Workflow icon hidden (fail-closed default)',
      doc2.getElementById('workflowBtn').classList.contains('kf-vis-hidden'));

  console.log('\nWorkflow test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
