const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeProject(id, key, name, extraDescription){
  return {
    id: id, name: name, key: key, taskCounter: 1,
    columns: [{ id: 'col1', name: 'To Do', done: false, order: [] }],
    tasks: {}, members: [], releases: [], taskTypes: [],
    startDate: null, endDate: null, description: extraDescription || '',
    dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null
  };
}
function makeDB(projects){
  var byId = {};
  var order = [];
  projects.forEach(function(p){ byId[p.id] = p; order.push(p.id); });
  return { projects: byId, projectOrder: order, currentProjectId: order[0] };
}

// Minimal fake JWT — just needs a base64url-encoded JSON middle segment, matching api.js's
// decodeTokenPayload(); header/signature segments are never validated client-side.
function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Small DB: list renders both projects, largest first, warning hidden ──
  {
    var small = makeProject('p1', 'SML', 'Small Project', 'short');
    var big = makeProject('p2', 'BIG', 'Bigger Project', 'x'.repeat(50000));
    var db = makeDB([small, big]); // deliberately seeded smaller-first, so sort order is actually verified
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;

    doc.getElementById('projectStorageBtn').click();
    await wait(20);

    log('modal opens', !doc.getElementById('projectStorageOverlay').classList.contains('hidden'));

    const rows = Array.from(doc.querySelectorAll('#projectStorageList .kf-storage-project-row'));
    log('lists both projects', rows.length === 2, rows.length);

    const firstRowKey = rows[0] && rows[0].querySelector('.kf-about-project-key').textContent;
    log('largest project (BIG) listed first', firstRowKey === 'BIG', firstRowKey);

    const firstRowBadge = rows[0] && rows[0].querySelector('.kf-storage-project-badge').textContent;
    log('local-only project labeled "Local"', firstRowBadge === 'Local', firstRowBadge);

    log('warning banner hidden for a small DB', doc.getElementById('projectStorageWarning').classList.contains('hidden'));

    const escEvent = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    doc.dispatchEvent(escEvent);
    await wait(20);
    log('Escape closes the modal', doc.getElementById('projectStorageOverlay').classList.contains('hidden'));
  }

  // ── 2. A project padded well past the 4MB warning threshold ──────────────
  {
    var huge = makeProject('p1', 'HUGE', 'Huge Project', 'x'.repeat(4.5 * 1024 * 1024));
    var db = makeDB([huge]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db)); }
    });
    await wait(300);
    const doc = dom.window.document;

    doc.getElementById('projectStorageBtn').click();
    await wait(20);

    const warningEl = doc.getElementById('projectStorageWarning');
    log('warning banner shown once total usage crosses the threshold', !warningEl.classList.contains('hidden'));
    log('warning mentions storage getting full', warningEl.textContent.indexOf('getting full') !== -1, warningEl.textContent);
    log('warning advises moving local-only projects to a server account', warningEl.textContent.indexOf('server account') !== -1);

    const totalText = doc.getElementById('projectStorageTotal').textContent;
    log('total readout mentions MB', /MB/.test(totalText), totalText);
  }

  // ── 3. Logged in but NOT an org admin: entry points hidden, open blocked ─
  {
    var p = makeProject('p1', 'PRJ', 'A Project');
    var db = makeDB([p]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){
        w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db));
        w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'false'}));
      }
    });
    await wait(300);
    const doc = dom.window.document;

    log('toolbar button hidden for a logged-in non-admin',
        doc.getElementById('projectStorageBtn').classList.contains('kf-vis-hidden'));
    log('side-nav button hidden for a logged-in non-admin',
        doc.getElementById('navProjectStorageBtn').classList.contains('kf-vis-hidden'));

    doc.getElementById('projectStorageBtn').click();
    await wait(20);
    log('modal does not open for a logged-in non-admin (defense in depth, not just a hidden button)',
        doc.getElementById('projectStorageOverlay').classList.contains('hidden'));
  }

  // ── 4. Logged in AND an org admin: fully accessible ───────────────────────
  {
    var p2 = makeProject('p1', 'PRJ', 'A Project');
    var db2 = makeDB([p2]);
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){
        w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db2));
        w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'true'}));
      }
    });
    await wait(300);
    const doc = dom.window.document;

    log('toolbar button visible for a logged-in org admin',
        !doc.getElementById('projectStorageBtn').classList.contains('kf-vis-hidden'));

    doc.getElementById('projectStorageBtn').click();
    await wait(20);
    log('modal opens for a logged-in org admin',
        !doc.getElementById('projectStorageOverlay').classList.contains('hidden'));
  }

  console.log('\nProject Storage test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
