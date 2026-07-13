const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeTask(id, key, title, overrides){
  return Object.assign({
    id: id, key: key, title: title,
    description: '', priority: 'medium', columnId: 'col1', dependencies: [],
    assigneeId: null, releaseId: null, typeId: null,
    startDate: null, endDate: null,
    businessValue: 1, taskCost: 1, archived: false,
    dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z'
  }, overrides || {});
}
function makeDB(projectId, tasks, projectOverrides){
  var taskMap = {};
  var order = [];
  tasks.forEach(function(t){ taskMap[t.id] = t; order.push(t.id); });
  var proj = Object.assign({
    id: projectId, name: 'Test Project', key: 'TST', taskCounter: tasks.length + 1,
    columns: [{ id: 'col1', name: 'To Do', done: false, order: order }],
    tasks: taskMap,
    members: [], releases: [], taskTypes: [], startDate: null, endDate: null,
    dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null
  }, projectOverrides || {});
  var projects = {};
  projects[projectId] = proj;
  return { projects: projects, projectOrder: [projectId], currentProjectId: projectId };
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. The default seeded Sample Project never triggers this alert ───────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    log('seeded Sample Project (all tasks meaningfully scored) does not show the alert on load',
        doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 2. A project with one unscored (1,1) task triggers the alert on load ──
  {
    const db = makeDB('p1', [
      makeTask('t1', 'TST-1', 'Totally unscored task', { businessValue: 1, taskCost: 1 }),
      makeTask('t2', 'TST-2', 'Properly scored task', { businessValue: 500, taskCost: 100 })
    ]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('alert shows automatically on load when an unscored task exists', !doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
    log('message mentions exactly 1 task', doc.getElementById('defaultScoreAlertMessage').textContent.indexOf('1 task') !== -1,
        doc.getElementById('defaultScoreAlertMessage').textContent);
    log('singular message uses correct grammar ("hasn\u2019t", not "haven\u2019t")', doc.getElementById('defaultScoreAlertMessage').textContent.indexOf('hasn\u2019t been scored') !== -1,
        doc.getElementById('defaultScoreAlertMessage').textContent);
    log('message explains the default-of-1 condition', doc.getElementById('defaultScoreAlertMessage').textContent.indexOf('default of 1') !== -1);
    const rows = doc.querySelectorAll('.kf-defaultscore-alert-row');
    log('exactly one row listed (the unscored task, not the scored one)', rows.length === 1, rows.length);
    log('row shows the correct task key', rows[0].textContent.indexOf('TST-1') !== -1);
    log('row shows the current BV/Cost values', rows[0].textContent.indexOf('BV 1') !== -1 && rows[0].textContent.indexOf('Cost 1') !== -1, rows[0].textContent);

    doc.getElementById('defaultScoreAlertOkBtn').click();
    await wait(10);
    log('"Got it" dismisses the alert', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 3. A task scored 1 in only ONE field does NOT trigger the alert ──────
  {
    const db = makeDB('p2', [
      makeTask('t1', 'TST-1', 'Deliberately cheap but valuable', { businessValue: 1, taskCost: 50 }),
      makeTask('t2', 'TST-2', 'Deliberately costly but low value', { businessValue: 900, taskCost: 1 })
    ]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('a task with only ONE field at 1 (not both) does not count as unscored',
        doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 4. Archived unscored tasks are excluded from the count ────────────────
  {
    const db = makeDB('p3', [
      makeTask('t1', 'TST-1', 'Archived and unscored', { businessValue: 1, taskCost: 1, archived: true }),
      makeTask('t2', 'TST-2', 'Active and scored', { businessValue: 200, taskCost: 50 })
    ]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('an archived task at (1,1) does not trigger the alert', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 5. Plural message wording and list cap at 6 with "+more" ─────────────
  {
    const tasks = [];
    for (let i = 1; i <= 8; i++) {
      tasks.push(makeTask('t' + i, 'TST-' + i, 'Unscored task ' + i, { businessValue: 1, taskCost: 1 }));
    }
    const db = makeDB('p4', tasks);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('message uses plural "tasks" for more than one', doc.getElementById('defaultScoreAlertMessage').textContent.indexOf('8 tasks') !== -1,
        doc.getElementById('defaultScoreAlertMessage').textContent);
    log('list caps at 6 rows', doc.querySelectorAll('.kf-defaultscore-alert-row').length === 6,
        doc.querySelectorAll('.kf-defaultscore-alert-row').length);
    log('shows a "+2 more" indicator for the remainder', doc.querySelector('.kf-defaultscore-alert-more').textContent.indexOf('+ 2 more') !== -1,
        doc.querySelector('.kf-defaultscore-alert-more').textContent);

    doc.getElementById('defaultScoreAlertClose').click();
    await wait(10);
    log('closing does not get stuck (overlay actually hides)', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  // ── 6. Chain ordering: Overdue Alert (if any) shows BEFORE the score alert ──
  {
    const pastDate = '2020-01-01T00:00:00.000Z';
    const db = makeDB('p5', [
      makeTask('t1', 'TST-1', 'Overdue AND unscored', { businessValue: 1, taskCost: 1, startDate: pastDate, endDate: pastDate })
    ]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('the Overdue alert shows FIRST when a task is both overdue and unscored', !doc.getElementById('overdueAlertOverlay').classList.contains('hidden'));
    log('the score alert is not shown yet, behind the overdue alert', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));

    doc.getElementById('overdueAlertOkBtn').click();
    await wait(10);
    log('closing the overdue alert reveals the score alert next', !doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
    log('overdue alert itself is now closed', doc.getElementById('overdueAlertOverlay').classList.contains('hidden'));
  }

  // ── 7. Close behaviors: backdrop click and Escape ─────────────────────────
  {
    const db = makeDB('p6', [makeTask('t1', 'TST-1', 'Unscored', { businessValue: 1, taskCost: 1 })]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const { window } = dom;
    const doc = window.document;
    log('alert is open initially', !doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
    doc.getElementById('defaultScoreAlertOverlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await wait(10);
    log('clicking the backdrop closes the alert', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }
  {
    const db = makeDB('p7', [makeTask('t1', 'TST-1', 'Unscored', { businessValue: 1, taskCost: 1 })]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const { window } = dom;
    const doc = window.document;
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(10);
    log('Escape closes the alert', doc.getElementById('defaultScoreAlertOverlay').classList.contains('hidden'));
  }

  console.log('\nUnscored-tasks session-start alert test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
