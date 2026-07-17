const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  // ── 1. Local-only project (never logged in): tab visible, defaults to Search view ──────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(800);
    const doc = dom.window.document;
    doc.getElementById('projectSearchBtn').click();
    await wait(50);
    log('opens on the Search tab by default', doc.getElementById('projectSearchTabSearchBtn').classList.contains('active'));
    log('Advanced Query tab visible for a local-only session', !doc.getElementById('projectSearchTabQueryBtn').classList.contains('kf-vis-hidden'));
  }

  // ── 2. A SERVER-AUTHORITATIVE project, logged in but NOT an admin: tab hidden, switch
  //      blocked. (A local-only project is unrestricted for everyone regardless of login state —
  //      canCurrentUserManageProject()'s documented exemption, same as every other permission gate
  //      in this app — so this scenario needs a project that's actually server-linked to be
  //      meaningful; the seeded default Sample Project is local-only.) ─────────────────────────
  {
    const proj = {
      id: 'p1', serverProjectId: 'p1', name: 'Server Project', key: 'SRV', taskCounter: 1,
      columns: [{ id: 'col1', name: 'To Do', done: false, order: [] }],
      tasks: {}, members: [], releases: [], taskTypes: [],
      startDate: null, endDate: null, description: '',
      dateCreated: '2025-01-01T00:00:00.000Z', dateLastModified: '2025-01-01T00:00:00.000Z', dateLastExported: null
    };
    const db = { projects: { p1: proj }, projectOrder: ['p1'], currentProjectId: 'p1' };
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){
        w.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(db));
        w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'false', projects: '[]'}));
      }
    });
    await wait(800);
    const doc = dom.window.document;
    doc.getElementById('projectSearchBtn').click();
    await wait(50);
    log('Advanced Query tab hidden for a logged-in non-admin on a server project', doc.getElementById('projectSearchTabQueryBtn').classList.contains('kf-vis-hidden'));

    doc.getElementById('projectSearchTabQueryBtn').click();
    await wait(50);
    log('switching to Query view is blocked (defense in depth, not just a hidden button)',
        doc.getElementById('projectSearchQueryView').classList.contains('hidden'));
  }

  // ── 3. Logged in AND an org admin: full flow, including tab switching back ──────────────
  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(w){ w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'true'})); }
    });
    await wait(800);
    const doc = dom.window.document;
    doc.getElementById('projectSearchBtn').click();
    await wait(50);
    log('Advanced Query tab visible for a logged-in org admin', !doc.getElementById('projectSearchTabQueryBtn').classList.contains('kf-vis-hidden'));

    doc.getElementById('projectSearchTabQueryBtn').click();
    await wait(50);
    log('Query view shown', !doc.getElementById('projectSearchQueryView').classList.contains('hidden'));
    log('Simple view hidden', doc.getElementById('projectSearchSimpleView').classList.contains('hidden'));
    log('Query footer shown (Export CSV / Print / Done)', !doc.getElementById('projectSearchQueryFooter').classList.contains('hidden'));
    log('Simple footer hidden', doc.getElementById('projectSearchSimpleFooter').classList.contains('hidden'));

    log('Export CSV button exists and is wired', doc.getElementById('projectQueryExportCsvBtn') !== null);
    log('Print button exists and is wired', doc.getElementById('projectQueryPrintBtn') !== null);

    // Schema reference panel (sits beside the query textarea in .kf-query-top-row)
    log('schema panel is shown by default when the Advanced Query view opens', !doc.getElementById('projectQuerySchemaPanel').classList.contains('hidden') &&
        doc.getElementById('projectQuerySchemaPanel').textContent.indexOf('tasks') !== -1);
    log('schema panel lives inside .kf-query-top-row alongside the SQL textarea',
        doc.getElementById('projectQuerySchemaPanel').closest('.kf-query-top-row') !== null &&
        doc.getElementById('projectQuerySchemaPanel').closest('.kf-query-top-row').contains(doc.getElementById('projectQuerySql')));
    doc.getElementById('projectQuerySchemaToggleBtn').click();
    await wait(50);
    log('Tables & Columns toggle button closes the panel', doc.getElementById('projectQuerySchemaPanel').classList.contains('hidden'));
    doc.getElementById('projectQuerySchemaToggleBtn').click();
    await wait(50);
    log('clicking it again reopens the panel and lists the tasks table', !doc.getElementById('projectQuerySchemaPanel').classList.contains('hidden') &&
        doc.getElementById('projectQuerySchemaPanel').textContent.indexOf('tasks') !== -1);

    // ── ERD pan/zoom/export ───────────────────────────────────────────────────────────────
    log('ERD zoom starts at 100%', doc.getElementById('projectQueryErdZoomLabel').textContent === '100%');
    const erdSvgBefore = doc.querySelector('#projectQuerySchemaErdInner svg');
    const erdWidthBefore = parseFloat(erdSvgBefore.getAttribute('width'));
    doc.getElementById('projectQueryErdZoomInBtn').click();
    await wait(20);
    log('zoom in increases the zoom label and the rendered SVG width',
        doc.getElementById('projectQueryErdZoomLabel').textContent === '110%' &&
        parseFloat(doc.querySelector('#projectQuerySchemaErdInner svg').getAttribute('width')) > erdWidthBefore);
    doc.getElementById('projectQueryErdResetBtn').click();
    await wait(20);
    log('reset view returns zoom to 100%', doc.getElementById('projectQueryErdZoomLabel').textContent === '100%');

    log('ERD Export As panel starts hidden', doc.getElementById('projectQueryErdExportAsPanel').classList.contains('hidden'));
    doc.getElementById('projectQueryErdExportAsBtn').click();
    await wait(20);
    log('ERD Export As panel opens', !doc.getElementById('projectQueryErdExportAsPanel').classList.contains('hidden'));

    let erdDownloadedFilename = null;
    dom.window.URL.createObjectURL = () => 'blob://fake';
    dom.window.URL.revokeObjectURL = () => {};
    const erdOrigCreateElement = doc.createElement.bind(doc);
    doc.createElement = function(tag){
      const el = erdOrigCreateElement(tag);
      if(tag === 'a'){ el.click = function(){ erdDownloadedFilename = el.download; }; }
      return el;
    };
    doc.querySelector('#projectQueryErdExportAsPanel [data-export-type="svg"]').click();
    await wait(20);
    log('Export as SVG triggers a download with a .svg filename', !!erdDownloadedFilename && /\.svg$/.test(erdDownloadedFilename), erdDownloadedFilename);

    // Run a real query against the seeded sample project and export it
    doc.getElementById('projectQuerySql').value = 'SELECT * FROM tasks';
    doc.getElementById('projectQueryRunBtn').click();
    await wait(100);
    const rowCount = doc.querySelectorAll('#projectQueryResultsWrap tbody tr').length;
    log('running a real query against the seeded project returns rows', rowCount > 0, rowCount);

    // CSV export uses Blob/createObjectURL/anchor-click, none of which jsdom implements fully —
    // stub them the same way this suite already handles browser APIs jsdom lacks, and just confirm
    // the export path runs without throwing and produces a download attempt.
    let downloadedFilename = null;
    dom.window.URL.createObjectURL = () => 'blob://fake';
    dom.window.URL.revokeObjectURL = () => {};
    const origCreateElement = doc.createElement.bind(doc);
    doc.createElement = function(tag){
      const el = origCreateElement(tag);
      if(tag === 'a'){
        const origClick = el.click.bind(el);
        el.click = function(){ downloadedFilename = el.download; };
      }
      return el;
    };
    doc.getElementById('projectQueryExportCsvBtn').click();
    await wait(50);
    log('Export CSV triggers a download with a .csv filename', !!downloadedFilename && /\.csv$/.test(downloadedFilename), downloadedFilename);

    // window.print isn't implemented in jsdom — stub it and confirm the button calls it.
    let printCalled = false;
    dom.window.print = function(){ printCalled = true; };
    doc.getElementById('projectQueryPrintBtn').click();
    log('Print button calls window.print()', printCalled);

    // ── Table / JSON result view toggle ──────────────────────────────────────────────────
    log('Table view active by default', doc.getElementById('projectQueryViewTableBtn').classList.contains('active'));
    log('results table visible, JSON pre hidden by default',
        !doc.getElementById('projectQueryResultsWrap').classList.contains('hidden') &&
        doc.getElementById('projectQueryResultsJson').classList.contains('hidden'));
    doc.getElementById('projectQueryViewJsonBtn').click();
    await wait(20);
    log('switching to JSON view hides table, shows JSON pre',
        doc.getElementById('projectQueryResultsWrap').classList.contains('hidden') &&
        !doc.getElementById('projectQueryResultsJson').classList.contains('hidden'));
    log('JSON pre contains parseable JSON matching the row count', (function(){
      try {
        var parsed = JSON.parse(doc.getElementById('projectQueryResultsJson').textContent);
        return Array.isArray(parsed) && parsed.length === rowCount;
      } catch(e){ return false; }
    })());
    log('Export CSV hidden, Copy/Export JSON shown in JSON mode',
        doc.getElementById('projectQueryExportCsvBtn').classList.contains('hidden') &&
        !doc.getElementById('projectQueryCopyJsonBtn').classList.contains('hidden') &&
        !doc.getElementById('projectQueryExportJsonBtn').classList.contains('hidden'));

    // Clipboard copy — jsdom has no Clipboard API, stub it.
    let clipboardText = null;
    dom.window.navigator.clipboard = { writeText: function(text){ clipboardText = text; return Promise.resolve(); } };
    doc.getElementById('projectQueryCopyJsonBtn').click();
    await wait(20);
    log('Copy JSON writes results JSON to the clipboard', !!clipboardText && JSON.parse(clipboardText).length === rowCount);

    // JSON export uses the same Blob/anchor-download stubbing as the CSV export above.
    downloadedFilename = null;
    doc.getElementById('projectQueryExportJsonBtn').click();
    await wait(50);
    log('Export JSON triggers a download with a .json filename', !!downloadedFilename && /\.json$/.test(downloadedFilename), downloadedFilename);

    doc.getElementById('projectQueryViewTableBtn').click();
    await wait(20);

    // ── Saved Query library: save, appears in panel, load into textarea, delete ──────────
    log('Saved Queries panel starts hidden', doc.getElementById('projectQuerySavedPanel').classList.contains('hidden'));
    log('Save row starts hidden', doc.getElementById('projectQuerySaveRow').classList.contains('hidden'));

    doc.getElementById('projectQuerySaveBtn').click();
    await wait(20);
    log('Save Query reveals the name-input row', !doc.getElementById('projectQuerySaveRow').classList.contains('hidden'));

    doc.getElementById('projectQuerySaveNameInput').value = 'All tasks';
    doc.getElementById('projectQuerySaveConfirmBtn').click();
    await wait(50);
    log('Save row hides after confirming save', doc.getElementById('projectQuerySaveRow').classList.contains('hidden'));

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    log('Saved Queries panel opens and lists the saved query',
        !doc.getElementById('projectQuerySavedPanel').classList.contains('hidden') &&
        doc.getElementById('projectQuerySavedList').textContent.indexOf('All tasks') !== -1);

    doc.getElementById('projectQuerySql').value = '';
    const savedRow = doc.querySelector('#projectQuerySavedList [data-query-id]');
    savedRow.click();
    await wait(20);
    log('clicking a saved query loads its SQL into the textarea', doc.getElementById('projectQuerySql').value === 'SELECT * FROM tasks');
    log('Saved Queries panel closes after loading', doc.getElementById('projectQuerySavedPanel').classList.contains('hidden'));

    // ── Update Query: loading a saved query flips the button label and overwrites in place ──
    log('Save Query button becomes Update Query once a saved query is loaded', doc.getElementById('projectQuerySaveBtn').textContent === 'Update Query');

    doc.getElementById('projectQuerySql').value = "SELECT * FROM tasks WHERE priority = 'high'";
    doc.getElementById('projectQuerySaveBtn').click();
    await wait(20);
    log('clicking Update Query does NOT reveal the create-new name row', doc.getElementById('projectQuerySaveRow').classList.contains('hidden'));
    log('clicking Update Query opens a confirm dialog instead of saving immediately',
        !doc.getElementById('confirmOverlay').classList.contains('hidden'));
    doc.getElementById('confirmOkBtn').click();
    await wait(50);

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    log('confirming the update still lists exactly one saved query under the SAME name, not a new one',
        doc.querySelectorAll('#projectQuerySavedList [data-query-id]').length === 1 &&
        doc.getElementById('projectQuerySavedList').textContent.indexOf('All tasks') !== -1);

    doc.getElementById('projectQuerySql').value = '';
    doc.querySelector('#projectQuerySavedList [data-query-id]').click();
    await wait(20);
    log('reloading it shows the UPDATED sql, confirming it overwrote in place rather than creating a second entry',
        doc.getElementById('projectQuerySql').value === "SELECT * FROM tasks WHERE priority = 'high'", doc.getElementById('projectQuerySql').value);

    // ── New button: clears immediately when clean, confirms save-or-discard when dirty ───────
    doc.getElementById('projectQueryNewBtn').click();
    await wait(20);
    log('New clears the textarea when the loaded query has no unsaved edits', doc.getElementById('projectQuerySql').value === '');
    log('New with nothing dirty does not open a confirm dialog', doc.getElementById('confirmOverlay').classList.contains('hidden'));
    log('New resets the button back to "Save Query" (no query loaded anymore)', doc.getElementById('projectQuerySaveBtn').textContent === 'Save Query');

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    doc.querySelector('#projectQuerySavedList [data-query-id]').click();
    await wait(20);
    doc.getElementById('projectQuerySql').value = "SELECT * FROM tasks WHERE priority = 'high' AND archived = false";

    doc.getElementById('projectQueryNewBtn').click();
    await wait(20);
    log('New on a DIRTY loaded query opens a confirm dialog instead of clearing immediately',
        !doc.getElementById('confirmOverlay').classList.contains('hidden') && doc.getElementById('projectQuerySql').value !== '');

    doc.getElementById('confirmModalClose').click();
    await wait(20);
    log('closing the dialog via the X aborts New entirely — the edited text is untouched',
        doc.getElementById('projectQuerySql').value === "SELECT * FROM tasks WHERE priority = 'high' AND archived = false");

    doc.getElementById('projectQueryNewBtn').click();
    await wait(20);
    doc.getElementById('confirmCancelBtn').click();
    await wait(20);
    log('the dialog\'s Cancel button discards the edit and clears the textarea anyway', doc.getElementById('projectQuerySql').value === '');

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    doc.querySelector('#projectQuerySavedList [data-query-id]').click();
    await wait(20);
    log('discarding via New\'s Cancel did NOT persist the edit — reloading shows the ORIGINAL sql',
        doc.getElementById('projectQuerySql').value === "SELECT * FROM tasks WHERE priority = 'high'", doc.getElementById('projectQuerySql').value);

    doc.getElementById('projectQuerySql').value = "SELECT * FROM tasks WHERE priority = 'critical'";
    doc.getElementById('projectQueryNewBtn').click();
    await wait(20);
    doc.getElementById('confirmOkBtn').click();
    await wait(50);
    log('Confirm on New\'s dialog saves the edit first, then clears the textarea',
        doc.getElementById('projectQuerySql').value === '' && doc.getElementById('projectQuerySaveBtn').textContent === 'Save Query');

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    doc.querySelector('#projectQuerySavedList [data-query-id]').click();
    await wait(20);
    log('Confirm on New\'s dialog really did persist the edit before clearing',
        doc.getElementById('projectQuerySql').value === "SELECT * FROM tasks WHERE priority = 'critical'", doc.getElementById('projectQuerySql').value);

    doc.getElementById('projectQuerySavedToggleBtn').click();
    await wait(20);
    const deleteBtn = doc.querySelector('#projectQuerySavedList [data-query-delete-id]');
    deleteBtn.click();
    await wait(20);
    doc.getElementById('confirmOkBtn') ? doc.getElementById('confirmOkBtn').click() : null;
    await wait(50);
    log('deleting the currently-loaded saved query reverts the button back to Save Query', doc.getElementById('projectQuerySaveBtn').textContent === 'Save Query');
    log('deleting a saved query removes it from the panel', doc.getElementById('projectQuerySavedList').textContent.indexOf('All tasks') === -1);

    // Switching back to Search restores the original view
    doc.getElementById('projectSearchTabSearchBtn').click();
    await wait(50);
    log('switching back to Search tab restores the simple view', !doc.getElementById('projectSearchSimpleView').classList.contains('hidden'));
  }

  console.log('\nProject Search Advanced Query test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
