const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
const DAY = 24*60*60*1000;

function makeProject(overrides){
  const now = Date.now();
  return Object.assign({
    id: 'p1', serverProjectId: 'p1', name: 'Fixture', key: 'FIX', taskCounter: 100,
    columns: [
      { id: 'col_todo', name: 'To Do', done: false, order: [] },
      { id: 'col_done', name: 'Done', done: true, order: [] }
    ],
    tasks: {}, members: [], releases: [], taskTypes: [],
    documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1,
    principles: [], prinCounter: 1, objectives: [], objCounter: 1,
    approvers: [], roles: [],
    headerButtonVisibility: { documents: true, risks: true, decisions: true, health: true, principles: true, objectives: true },
    startDate: null, endDate: null,
    dateCreated: new Date(now - 100*DAY).toISOString(), dateLastModified: new Date().toISOString(), dateLastExported: null
  }, overrides || {});
}
function makeDB(project){
  return JSON.stringify({ projects: { p1: project }, projectOrder: ['p1'], currentProjectId: 'p1' });
}
// Minimal fake JWT — just needs a base64url-encoded JSON middle segment, matching api.js's
// decodeTokenPayload(); header/signature segments are never validated client-side.
function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

// Builds a jsdom instance with a server-authoritative project seeded, a fake JWT (orgAdmin true/false),
// and window.fetch stubbed so nothing in the app's normal startup network calls ever throws — any
// call NOT explicitly listed in `handlers` gets a generic empty-ish success response.
// Minimal, valid server GetProjectDetailAsync response shape — buildLocalProjectFromServerDetail
// (features/migration.js) requires tasks/columns/members as real arrays (not the client-side
// object-keyed shape project.tasks/project.columns already are), or it throws synchronously.
function serverDetailFor(project){
  return {
    id: project.id, name: project.name, key: project.key,
    startDate: null, endDate: null, description: project.description || '',
    columns: [{id: 'col_todo', name: 'To Do', done: false, order: 0, color: null, cap: null}],
    tasks: [], members: []
  };
}

// isOrgAdminUser === null means "not signed in at all" (no JWT set) — used for the local-only tests,
// where isServerLoggedIn()/isServerAuthoritative() must both read false.
function loadFixture(project, isOrgAdminUser, handlers){
  return new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){
      w.localStorage.setItem('kanbanflow_v1_db', makeDB(project));
      if(isOrgAdminUser !== null){
        w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({ sub: 'u1', orgId: 'o1', orgAdmin: isOrgAdminUser ? 'true' : 'false' }));
      }
      w.fetch = function(url, opts){
        var u = String(url);
        for(var i = 0; i < (handlers || []).length; i++){
          if(handlers[i].match.test(u)) return handlers[i].respond(u, opts);
        }
        if(/\/api\/projects\/p1$/.test(u) && (!opts || opts.method === 'GET' || !opts.method)){
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(serverDetailFor(project)) });
        }
        // Everything else (health, telemetry, chat, org-users, project list) — quiet, harmless failure.
        return Promise.reject(new Error('network disabled in test'));
      };
    }
  });
}

function task(id, columnId, opts){
  return Object.assign({
    id: id, key: 'LOC1-' + id, title: 'Task ' + id, description: '', priority: 'medium',
    columnId: columnId, dependencies: [], assigneeId: null, releaseId: null, typeId: null,
    documentationUrl: null, startDate: null, endDate: null,
    businessValue: 1, taskCost: 1, archived: false,
    dateCreated: new Date(Date.now() - 50*DAY).toISOString(), dateLastModified: new Date().toISOString()
  }, opts || {});
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra!==undefined?' :: '+extra:'')); }

  // ── 1. Non-Org-Admin editing an existing server project: key input is locked read-only ──
  {
    const project = makeProject();
    const dom = loadFixture(project, false, []);
    await wait(300);
    const doc = dom.window.document;

    doc.getElementById('editProjectBtn').click();
    await wait(30);

    const keyInput = doc.getElementById('projectKeyInput');
    log('project modal opened', !doc.getElementById('projectOverlay').classList.contains('hidden'));
    log('key input value is the current key', keyInput.value === 'FIX', keyInput.value);
    log('key input is readOnly for a non-Org-Admin', keyInput.readOnly === true);
    log('key input has the readonly visual class', keyInput.classList.contains('kf-readonly-field'));

    dom.window.close();
  }

  // ── 2. Org Admin editing an existing server project: key input stays fully editable ──
  {
    const project = makeProject();
    const dom = loadFixture(project, true, []);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);

    const keyInput = doc.getElementById('projectKeyInput');
    log('key input is editable for an Org Admin', keyInput.readOnly === false);
    log('key input has no readonly visual class', !keyInput.classList.contains('kf-readonly-field'));

    dom.window.close();
  }

  // ── 3. Org Admin changes the key to one that's already taken: blocked, forced to re-enter ──
  {
    const project = makeProject();
    let changeKeyCalled = false;
    const dom = loadFixture(project, true, [
      { match: /\/key-availability\?key=TAKEN/, respond: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: false, normalizedKey: 'TAKEN' }) }) },
      { match: /\/projects\/p1\/key$/, respond: () => { changeKeyCalled = true; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'p1', name: project.name, key: 'TAKEN' }) }); } }
    ]);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);

    const keyInput = doc.getElementById('projectKeyInput');
    keyInput.value = 'TAKEN';
    const saveBtn = doc.getElementById('projectSaveBtn');
    saveBtn.click();
    await wait(200);

    log('modal stays open on a taken key', !doc.getElementById('projectOverlay').classList.contains('hidden'));
    log('confirm dialog never shown for a taken key', doc.getElementById('confirmOverlay').classList.contains('hidden'));
    log('change-key endpoint never called for a taken key', !changeKeyCalled);

    dom.window.close();
  }

  // ── 4. Org Admin changes the key to a free one: confirm dialog appears; confirming calls both endpoints ──
  {
    const project = makeProject();
    let updateCalled = false, changeKeyCalled = false, changeKeyBody = null;
    const dom = loadFixture(project, true, [
      { match: /\/key-availability\?key=NEWK/, respond: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: true, normalizedKey: 'NEWK' }) }) },
      { match: /\/api\/projects\/p1$/, respond: (u, opts) => {
          if(opts && opts.method === 'PUT'){ updateCalled = true; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'p1', name: project.name, key: project.key }) }); }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(serverDetailFor(project)) });
        } },
      { match: /\/projects\/p1\/key$/, respond: (u, opts) => { changeKeyCalled = true; changeKeyBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'p1', name: project.name, key: 'NEWK' }) }); } }
    ]);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);

    const keyInput = doc.getElementById('projectKeyInput');
    keyInput.value = 'NEWK';
    const saveBtn = doc.getElementById('projectSaveBtn');
    saveBtn.click();
    await wait(200);

    log('confirm dialog appears for a free key change', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
    const msg = doc.getElementById('confirmMessage').textContent;
    log('confirm message mentions "cannot be undone"', msg.indexOf('cannot be undone') !== -1, msg);
    log('confirm message mentions the old key prefix breaking', msg.indexOf('FIX-') !== -1, msg);

    doc.getElementById('confirmOkBtn').click();
    await wait(200);

    log('normal update endpoint called (name/dates/description)', updateCalled);
    log('change-key endpoint called', changeKeyCalled);
    log('change-key endpoint sent the normalized new key', changeKeyBody && changeKeyBody.newKey === 'NEWK', JSON.stringify(changeKeyBody));

    dom.window.close();
  }

  // ── 5. Signed-in user creating a NEW project: taken key blocked, create endpoint never called ──
  {
    const project = makeProject();
    let createCalled = false;
    const dom = loadFixture(project, true, [
      { match: /\/projects\/key-availability\?key=TAKEN2/, respond: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: false, normalizedKey: 'TAKEN2' }) }) },
      // Method check matters here — an unguarded match on this URL would also (wrongly) intercept the
      // unrelated GET /api/projects project-list refresh that fires during normal app init.
      { match: /\/api\/projects$/, respond: (u, opts) => {
          if(opts && opts.method === 'POST'){ createCalled = true; return Promise.reject(new Error('should not be called')); }
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        } }
    ]);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('newProjectBtn').click();
    await wait(30);
    doc.getElementById('projectNameInput').value = 'Brand New';
    doc.getElementById('projectKeyInput').value = 'TAKEN2';
    doc.getElementById('projectSaveBtn').click();
    await wait(200);

    log('new-project modal stays open on a taken key', !doc.getElementById('projectOverlay').classList.contains('hidden'));
    log('create endpoint never called for a taken key', !createCalled);

    dom.window.close();
  }

  // ── 6. Signed-in user creating a NEW project: free key — created directly, with the normalized key ──
  {
    const project = makeProject();
    let createBody = null;
    const fakeToken = makeFakeJwt({ sub: 'u1', orgId: 'o1', orgAdmin: 'true' });
    const dom = loadFixture(project, true, [
      { match: /\/projects\/key-availability\?key=NEWPROJ/, respond: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: true, normalizedKey: 'NEWPROJ' }) }) },
      { match: /\/api\/projects$/, respond: (u, opts) => {
          if(!opts || opts.method !== 'POST'){
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
          }
          createBody = JSON.parse(opts.body);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
            project: { id: 'p2', name: 'Brand New', key: 'NEWPROJ', startDate: null, endDate: null, description: '',
              columns: [{ id: 'c1', name: 'To Do', done: false, order: 0, color: null, cap: null }], tasks: [], members: [] },
            token: fakeToken, tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), warning: null
          }) });
        } }
    ]);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('newProjectBtn').click();
    await wait(30);
    doc.getElementById('projectNameInput').value = 'Brand New';
    doc.getElementById('projectKeyInput').value = 'NEWPROJ';
    doc.getElementById('projectSaveBtn').click();
    await wait(200);

    log('create endpoint called with the normalized key', createBody && createBody.key === 'NEWPROJ', JSON.stringify(createBody));
    log('modal closes after successful creation', doc.getElementById('projectOverlay').classList.contains('hidden'));

    dom.window.close();
  }

  // ── 7. Local-only NEW project: taken key (matches another local project) blocked ──
  {
    const existing = makeProject({ id: 'p1', key: 'LOC1', serverProjectId: null });
    const dom = loadFixture(existing, null, []);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('newProjectBtn').click();
    await wait(30);
    doc.getElementById('projectNameInput').value = 'Second Local';
    doc.getElementById('projectKeyInput').value = 'LOC1';
    doc.getElementById('projectSaveBtn').click();
    await wait(50);

    const db = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
    log('local new-project modal stays open on a taken key', !doc.getElementById('projectOverlay').classList.contains('hidden'));
    log('no second local project was created', Object.keys(db.projects).length === 1, Object.keys(db.projects).length);

    dom.window.close();
  }

  // ── 8. Local-only NEW project: free key — created, normalized the same way renameProject would ──
  {
    const existing = makeProject({ id: 'p1', key: 'LOC1', serverProjectId: null });
    const dom = loadFixture(existing, null, []);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('newProjectBtn').click();
    await wait(30);
    doc.getElementById('projectNameInput').value = 'Second Local';
    doc.getElementById('projectKeyInput').value = 'loc2free'; // lowercase on purpose — verify normalization
    doc.getElementById('projectSaveBtn').click();
    await wait(50);

    const db = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
    const ids = Object.keys(db.projects);
    log('a second local project was created', ids.length === 2, ids.length);
    const created = ids.map(function(id){ return db.projects[id]; }).filter(function(p){ return p.name === 'Second Local'; })[0];
    log('new local project key normalized to uppercase, 6-char cap', created && created.key === 'LOC2FR', created && created.key);

    dom.window.close();
  }

  // ── 9. Local-only EDIT, key unchanged: normal save, no confirm dialog, no cascade needed ──
  {
    const existing = makeProject({
      id: 'p1', key: 'LOC1', serverProjectId: null,
      tasks: { t1: task('t1', 'col_todo', { key: 'LOC1-1' }) }
    });
    const dom = loadFixture(existing, null, []);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);
    doc.getElementById('projectNameInput').value = 'Renamed Local';
    // key input left as-is ("LOC1")
    doc.getElementById('projectSaveBtn').click();
    await wait(50);

    log('confirm dialog never shown when the key is unchanged', doc.getElementById('confirmOverlay').classList.contains('hidden'));
    const db = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
    log('name change saved locally', db.projects.p1.name === 'Renamed Local', db.projects.p1.name);
    log('task key untouched', db.projects.p1.tasks.t1.key === 'LOC1-1', db.projects.p1.tasks.t1.key);

    dom.window.close();
  }

  // ── 10. Local-only EDIT, key changed to one already used by ANOTHER local project: blocked ──
  {
    const editing = makeProject({ id: 'p1', key: 'LOC1', serverProjectId: null });
    const other = makeProject({ id: 'p2', key: 'LOC2', serverProjectId: null });
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){
        w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify({ projects: { p1: editing, p2: other }, projectOrder: ['p1', 'p2'], currentProjectId: 'p1' }));
        w.fetch = function(){ return Promise.reject(new Error('network disabled in test')); };
      }
    });
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);
    doc.getElementById('projectKeyInput').value = 'LOC2';
    doc.getElementById('projectSaveBtn').click();
    await wait(50);

    log('local edit modal stays open on a key taken by another local project', !doc.getElementById('projectOverlay').classList.contains('hidden'));
    log('confirm dialog never shown for a taken key', doc.getElementById('confirmOverlay').classList.contains('hidden'));
    const db = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
    log('project key unchanged', db.projects.p1.key === 'LOC1', db.projects.p1.key);

    dom.window.close();
  }

  // ── 11. Local-only EDIT, key changed to a free one: confirm dialog, then cascades to EVERY task's
  //         key — active and archived alike, matching the cloud Org-Admin flow's own guarantee ──
  {
    const existing = makeProject({
      id: 'p1', key: 'LOC1', serverProjectId: null,
      tasks: {
        t1: task('t1', 'col_todo', { key: 'LOC1-1', archived: false }),
        t2: task('t2', 'col_done', { key: 'LOC1-2', archived: true })
      }
    });
    const dom = loadFixture(existing, null, []);
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('editProjectBtn').click();
    await wait(30);
    doc.getElementById('projectKeyInput').value = 'LOC9';
    doc.getElementById('projectSaveBtn').click();
    await wait(50);

    log('confirm dialog appears for a free local key change', !doc.getElementById('confirmOverlay').classList.contains('hidden'));
    const msg = doc.getElementById('confirmMessage').textContent;
    log('confirm message mentions "cannot be undone"', msg.indexOf('cannot be undone') !== -1, msg);
    log('confirm message mentions active and archived tasks', msg.indexOf('active and archived') !== -1, msg);

    doc.getElementById('confirmOkBtn').click();
    await wait(50);

    const db = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
    const p = db.projects.p1;
    log('project key updated locally', p.key === 'LOC9', p.key);
    log('active task key cascaded', p.tasks.t1.key === 'LOC9-1', p.tasks.t1.key);
    log('archived task key cascaded too', p.tasks.t2.key === 'LOC9-2', p.tasks.t2.key);

    dom.window.close();
  }
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
