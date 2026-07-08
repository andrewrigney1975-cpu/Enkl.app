const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function daysAgoISO(days){ return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(); }
function daysFromNowISO(days){ return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(); }

function makeTask(id, key, title, overrides){
  return Object.assign({
    id: id, key: key, title: title,
    description: '', priority: 'medium', columnId: 'col1', dependencies: [],
    assigneeId: null, releaseId: null, typeId: null,
    startDate: null, endDate: null,
    businessValue: 1, taskCost: 1, archived: false,
    progress: 0, estimatedEffort: 0, actualEffort: 0,
    dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
  }, overrides || {});
}
function makeDB(projectId, tasks, projectOverrides){
  var taskMap = {};
  var order = [];
  tasks.forEach(function(t){ taskMap[t.id] = t; order.push(t.id); });
  var proj = Object.assign({
    id: projectId, name: 'Test Project', key: 'TST', taskCounter: tasks.length + 1,
    columns: [
      { id: 'col1', name: 'To Do', done: false, order: order },
      { id: 'col2', name: 'Done', done: true, order: [] }
    ],
    tasks: taskMap,
    members: [], releases: [], taskTypes: [], startDate: null, endDate: null,
    headerButtonVisibility: { timeTracking: true },
    dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: daysAgoISO(1)
  }, projectOverrides || {});
  var projects = {};
  projects[projectId] = proj;
  return { projects: projects, projectOrder: [projectId], currentProjectId: projectId };
}
async function loadWithDB(db){
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(window){ window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
  });
  await wait(600);
  return dom;
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  // ── 1. Effort-only predicted overrun: orange card + startup row with effort reason ──
  {
    const db = makeDB('p1', [
      makeTask('t1', 'TST-1', 'Effort at risk', { progress: 25, estimatedEffort: 8, actualEffort: 4 })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('card gets the at-risk (orange) class', card.classList.contains('kf-card-atrisk'), card.className);
    log('card does NOT get the over (red) class', !card.classList.contains('kf-card-over'));
    log('overrun alert shows on load', !doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
    const rows = doc.querySelectorAll('.kf-overrun-alert-row');
    log('exactly one row listed', rows.length === 1, rows.length);
    log('row mentions the projected effort vs estimate', rows[0].textContent.indexOf('8h estimated') !== -1, rows[0].textContent);
  }

  // ── 2. Date-only predicted overrun: orange card + startup row with date reason ──
  {
    const db = makeDB('p2', [
      makeTask('t1', 'TST-1', 'Date at risk', { progress: 10, startDate: daysAgoISO(9), endDate: daysFromNowISO(1) })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('card gets the at-risk (orange) class for a date-based prediction', card.classList.contains('kf-card-atrisk'), card.className);
    const rows = doc.querySelectorAll('.kf-overrun-alert-row');
    log('row mentions being on pace to finish late', rows[0].textContent.indexOf('On pace to finish') !== -1, rows[0].textContent);
  }

  // ── 3. Already over on effort (logged hours exceed estimate): red card, absent from startup list ──
  {
    const db = makeDB('p3', [
      makeTask('t1', 'TST-1', 'Over on effort', { progress: 50, estimatedEffort: 8, actualEffort: 10 })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('card gets the over (red) class', card.classList.contains('kf-card-over'), card.className);
    log('card does NOT get the at-risk (orange) class', !card.classList.contains('kf-card-atrisk'));
    log('overrun alert does NOT show for an already-over task', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  // ── 4. Already overdue by date: red card (existing isTaskOverdue reused) ──
  {
    const db = makeDB('p4', [
      makeTask('t1', 'TST-1', 'Overdue task', { progress: 50, startDate: daysAgoISO(20), endDate: daysAgoISO(3) })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('an overdue task gets the over (red) class', card.classList.contains('kf-card-over'), card.className);
  }

  // ── 5. progress === 0 never predicts, regardless of elapsed time or logged effort ──
  {
    const db = makeDB('p5', [
      makeTask('t1', 'TST-1', 'Zero progress', { progress: 0, estimatedEffort: 8, actualEffort: 0, startDate: daysAgoISO(9), endDate: daysFromNowISO(1) })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('0% progress triggers no prediction (no orange, no red)', !card.classList.contains('kf-card-atrisk') && !card.classList.contains('kf-card-over'), card.className);
    log('overrun alert does not show', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  // ── 6. progress === 100 never predicts (nothing left to project) ──
  {
    const db = makeDB('p6', [
      makeTask('t1', 'TST-1', 'Fully progressed but still in To Do', { progress: 100, startDate: daysAgoISO(9), endDate: daysFromNowISO(1) })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('100% progress triggers no date-based prediction', !card.classList.contains('kf-card-atrisk'), card.className);
  }

  // ── 7. Time Tracking disabled: no borders, no startup modal, even with triggering data ──
  {
    const db = makeDB('p7', [
      makeTask('t1', 'TST-1', 'Would be at risk if TT were on', { progress: 25, estimatedEffort: 8, actualEffort: 4 })
    ], { headerButtonVisibility: { timeTracking: false } });
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    const card = doc.querySelector('.kf-card');
    log('no border classes when Time Tracking is disabled', !card.classList.contains('kf-card-atrisk') && !card.classList.contains('kf-card-over'), card.className);
    log('no overrun alert when Time Tracking is disabled', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  // ── 8. Archived tasks and done-column tasks are excluded even with triggering data ──
  {
    const db = makeDB('p8', [
      makeTask('t1', 'TST-1', 'Archived but would be at risk', { progress: 25, estimatedEffort: 8, actualEffort: 4, archived: true }),
      makeTask('t2', 'TST-2', 'Done column but would be at risk', { progress: 25, estimatedEffort: 8, actualEffort: 4, columnId: 'col2' })
    ]);
    db.projects.p8.columns[1].order = ['t2'];
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    log('overrun alert does not show (both excluded)', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  // ── 9. Chain ordering: Overdue Alert shows first, then Overrun Alert, then Default Score Alert ──
  {
    const db = makeDB('p9', [
      makeTask('t1', 'TST-1', 'Overdue task', { businessValue: 500, taskCost: 100, startDate: daysAgoISO(20), endDate: daysAgoISO(3) }),
      makeTask('t2', 'TST-2', 'At-risk task', { businessValue: 500, taskCost: 100, progress: 25, estimatedEffort: 8, actualEffort: 4 }),
      makeTask('t3', 'TST-3', 'Unscored task', { businessValue: 1, taskCost: 1 })
    ]);
    const dom = await loadWithDB(db);
    const doc = dom.window.document;
    log('Overdue alert shows first', !doc.getElementById('overdueAlertOverlay').classList.contains('hidden'));
    log('Overrun alert not shown yet', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
    log('Default score alert not shown yet', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));

    doc.getElementById('overdueAlertOkBtn').click();
    await wait(10);
    log('dismissing Overdue alert reveals the Overrun alert next', !doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
    log('Default score alert still not shown', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));

    doc.getElementById('overrunAlertOkBtn').click();
    await wait(10);
    log('dismissing Overrun alert reveals the Default Score alert next', !doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 10. Current-project-only scoping: an at-risk task in another project doesn't trigger the modal ──
  {
    const dbP1 = makeDB('p10', [makeTask('t1', 'TST-1', 'Fine task', {})]);
    const otherProj = Object.assign({}, dbP1.projects.p10, {
      id: 'p11', key: 'OTH',
      tasks: { t1: makeTask('t1', 'OTH-1', 'At risk in other project', { progress: 25, estimatedEffort: 8, actualEffort: 4 }) }
    });
    dbP1.projects.p11 = otherProj;
    dbP1.projectOrder.push('p11');
    // currentProjectId stays p10 — the fine one.
    const dom = await loadWithDB(dbP1);
    const doc = dom.window.document;
    log('viewing an unaffected project does not trigger the overrun alert for a different project\'s at-risk task',
        doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  // ── 11. Close behaviors: backdrop click and Escape ──
  {
    const db = makeDB('p12', [
      makeTask('t1', 'TST-1', 'At risk', { progress: 25, estimatedEffort: 8, actualEffort: 4 })
    ]);
    const dom = await loadWithDB(db);
    const { window } = dom;
    const doc = window.document;
    log('overrun alert is open initially', !doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
    doc.getElementById('overrunAlertOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await wait(10);
    log('clicking the backdrop closes the overrun alert', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }
  {
    const db = makeDB('p13', [
      makeTask('t1', 'TST-1', 'At risk', { progress: 25, estimatedEffort: 8, actualEffort: 4 })
    ]);
    const dom = await loadWithDB(db);
    const { window } = dom;
    const doc = window.document;
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(10);
    log('Escape closes the overrun alert', doc.getElementById('overrunAlertOverlay').classList.contains('hidden'));
  }

  console.log('\nPer-task overrun prediction test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
