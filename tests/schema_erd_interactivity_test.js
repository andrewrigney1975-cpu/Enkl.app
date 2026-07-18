const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

// Tables & Columns ERD relationship highlighting (features/schema-erd.js's data-table/data-from/
// data-to attributes + modals/project-search.js's handleSchemaErdClick). Covers the three
// interactions: click a table, click a connector, click whitespace to reset.
(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'true'})); }
  });
  await wait(800);
  const doc = dom.window.document;
  doc.getElementById('projectSearchBtn').click();
  await wait(50);
  doc.getElementById('projectSearchTabQueryBtn').click();
  await wait(50);

  const inner = doc.getElementById('projectQuerySchemaErdInner');
  log('ERD SVG rendered with table/edge markup', inner.querySelectorAll('.kf-erd-table').length > 0 && inner.querySelectorAll('.kf-erd-edge').length > 0);

  function dimmedTables(){
    return Array.from(inner.querySelectorAll('.kf-erd-table')).filter(function(t){ return t.classList.contains('kf-erd-dimmed'); }).map(function(t){ return t.getAttribute('data-table'); });
  }
  function visibleTables(){
    return Array.from(inner.querySelectorAll('.kf-erd-table')).filter(function(t){ return !t.classList.contains('kf-erd-dimmed'); }).map(function(t){ return t.getAttribute('data-table'); });
  }

  // ── Click a table: only tables connected to it (by any relationship) stay full-opacity ──
  // "columns" has exactly one relationship in TABLE_RELATIONSHIPS (tasks.columnId -> columns.id),
  // so clicking it should leave only tasks+columns visible.
  const columnsTable = inner.querySelector('.kf-erd-table[data-table="columns"]');
  columnsTable.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
  await wait(20);
  const visibleAfterTableClick = visibleTables().sort();
  log('clicking the "columns" table leaves only itself + "tasks" (its one relationship) visible',
      visibleAfterTableClick.length === 2 && visibleAfterTableClick.indexOf('tasks') !== -1 && visibleAfterTableClick.indexOf('columns') !== -1,
      JSON.stringify(visibleAfterTableClick));
  log('an unrelated table (e.g. "members") is dimmed', dimmedTables().indexOf('members') !== -1);

  const dimmedEdgesAfterTableClick = Array.from(inner.querySelectorAll('.kf-erd-edge')).filter(function(e){ return e.classList.contains('kf-erd-dimmed'); });
  const visibleEdgesAfterTableClick = Array.from(inner.querySelectorAll('.kf-erd-edge')).filter(function(e){ return !e.classList.contains('kf-erd-dimmed'); });
  log('exactly one edge (tasks -> columns) stays visible after the table click',
      visibleEdgesAfterTableClick.length === 1 && visibleEdgesAfterTableClick[0].getAttribute('data-from') === 'tasks' && visibleEdgesAfterTableClick[0].getAttribute('data-to') === 'columns');
  log('every other edge is dimmed', dimmedEdgesAfterTableClick.length === inner.querySelectorAll('.kf-erd-edge').length - 1);

  // ── Click whitespace: fully resets ──────────────────────────────────────────────────────
  const scroll = doc.getElementById('projectQueryErdScroll');
  scroll.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
  await wait(20);
  log('clicking whitespace clears all dimming (tables)', inner.querySelectorAll('.kf-erd-table.kf-erd-dimmed').length === 0);
  log('clicking whitespace clears all dimming (edges)', inner.querySelectorAll('.kf-erd-edge.kf-erd-dimmed').length === 0);

  // ── Click a connector: only its own two tables + that one edge stay visible, including when
  //    OTHER edges also touch the same two tables (tasks<->tasks self-loops don't apply here, so
  //    use tasks->releases, which is releases' only relationship, same shape as the table-click
  //    case above but exercised via the edge itself). ─────────────────────────────────────────
  const releasesEdge = Array.from(inner.querySelectorAll('.kf-erd-edge')).find(function(e){ return e.getAttribute('data-from') === 'tasks' && e.getAttribute('data-to') === 'releases'; });
  log('found the tasks -> releases edge to click', !!releasesEdge);
  // Click on the edge's own hitbox path (the first, fat, invisible one), not just the <g> wrapper —
  // matches how a real pointer event would target it.
  const hitboxPath = releasesEdge.querySelector('path');
  hitboxPath.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
  await wait(20);
  const visibleAfterEdgeClick = visibleTables().sort();
  log('clicking the tasks -> releases connector leaves only "tasks" and "releases" visible',
      visibleAfterEdgeClick.length === 2 && visibleAfterEdgeClick.indexOf('tasks') !== -1 && visibleAfterEdgeClick.indexOf('releases') !== -1,
      JSON.stringify(visibleAfterEdgeClick));
  const visibleEdgesAfterEdgeClick = Array.from(inner.querySelectorAll('.kf-erd-edge')).filter(function(e){ return !e.classList.contains('kf-erd-dimmed'); });
  log('exactly one edge (the clicked one) stays visible, even though "tasks" has other relationships',
      visibleEdgesAfterEdgeClick.length === 1 && visibleEdgesAfterEdgeClick[0] === releasesEdge);

  // ── Whitespace click resets again after an edge click ──────────────────────────────────
  scroll.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
  await wait(20);
  log('whitespace click after an edge click clears all dimming (tables)', inner.querySelectorAll('.kf-erd-table.kf-erd-dimmed').length === 0);
  log('whitespace click after an edge click clears all dimming (edges)', inner.querySelectorAll('.kf-erd-edge.kf-erd-dimmed').length === 0);

  console.log('Schema ERD interactivity test complete.');
})();
