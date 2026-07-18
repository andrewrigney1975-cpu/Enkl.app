const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

/* No prior test coverage exists for the Portfolio Planner or Dashboard charts at all (portfolio-
   bars.js, modals/portfolio-planner.js) — this covers just the two new behaviors added on top of
   them: an on-bar project-key label (shown only when the bar is wide enough to fit it, with
   WCAG-contrast text) and double-click opening the Resources modal instead of the Dates modal. Same
   mock-fetch-dispatcher convention as tests/api_endpoints_test.js. */
function makeMockFetch(projects, categories){
  return async function(url, options){
    var method = (options && options.method) || 'GET';
    if(url === '/health') return {ok: true, status: 200, json: async () => ({status: 'ok'})};
    // pullServerProjectsIntoLocal() fires automatically at boot for any logged-in session (unrelated
    // to the Portfolio Planner itself) — an empty list keeps it a harmless no-op for this test.
    if(url === '/api/projects' && method === 'GET') return {ok: true, status: 200, json: async () => ([])};
    if(url === '/api/organisations/me/portfolio/projects' && method === 'GET'){
      return {ok: true, status: 200, json: async () => projects};
    }
    if(url === '/api/organisations/me/portfolio/categories' && method === 'GET'){
      return {ok: true, status: 200, json: async () => categories};
    }
    var resourcesMatch = url.match(/^\/api\/organisations\/me\/portfolio\/projects\/[^/]+\/resources$/);
    if(resourcesMatch && method === 'GET') return {ok: true, status: 200, json: async () => ([])};
    if(url === '/api/organisations/me/portfolio/roles' && method === 'GET') return {ok: true, status: 200, json: async () => ([])};
    if(url === '/api/organisations/me' && method === 'GET') return {ok: true, status: 200, json: async () => ({name: 'Org', users: []})};
    return {ok: false, status: 404, json: async () => ({message: 'not found (unhandled mock url in test): ' + method + ' ' + url})};
  };
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  var year = new Date().getFullYear();
  var projects = [
    // Spans the whole default year range shown by the chart — wide enough for a 3-char key label
    // alongside the priority marker under any reasonable zoom.
    {id: 'wide1', key: 'WID', name: 'Wide Project', categoryId: null, priority: 'high', isActive: true,
      startDate: year + '-01-01', endDate: year + '-12-31'},
    // A single day — narrow enough that no reasonable font/marker combination fits a label in it.
    {id: 'narrow1', key: 'NRW', name: 'Narrow Project', categoryId: null, priority: 'high', isActive: true,
      startDate: year + '-06-15', endDate: year + '-06-15'}
  ];
  var categories = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){
      w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({orgAdmin: 'true'}));
      w.fetch = makeMockFetch(projects, categories);
    }
  });
  await wait(800);
  const doc = dom.window.document;

  doc.getElementById('navPortfolioPlannerBtn').click();
  await wait(400);
  log('Portfolio Planner overlay opens for an org admin', !doc.getElementById('portfolioPlannerOverlay').classList.contains('hidden'));

  const svg = doc.querySelector('#portfolioPlannerChart svg');
  log('chart renders an SVG', svg !== null);

  const wideBarGroup = doc.querySelector('.kf-portfolio-timeline-bar[data-project-id="wide1"]');
  log('wide project bar rendered', wideBarGroup !== null);
  const wideRow = wideBarGroup && wideBarGroup.closest('.kf-portfolio-timeline-row');
  const wideLabel = wideRow && wideRow.querySelector('text');
  log('wide project bar shows its key label', !!wideLabel && wideLabel.textContent === 'WID', wideLabel && wideLabel.textContent);
  if(wideLabel){
    log('key label uses dominant-baseline centering', wideLabel.getAttribute('dominant-baseline') === 'central');
    var fill = wideLabel.getAttribute('fill');
    log('key label fill is pure black or white (WCAG contrast pick)', fill === '#ffffff' || fill === '#000000', fill);
  }

  const narrowBarGroup = doc.querySelector('.kf-portfolio-timeline-bar[data-project-id="narrow1"]');
  log('narrow project bar rendered', narrowBarGroup !== null);
  const narrowRow = narrowBarGroup && narrowBarGroup.closest('.kf-portfolio-timeline-row');
  log('narrow project bar has no key label (not enough room)', !!narrowRow && narrowRow.querySelector('text') === null);

  // ── Single click still opens the Dates modal (after the new click-delay debounce) ──────────
  wideBarGroup.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true, clientX: 0, clientY: 0}));
  wideBarGroup.dispatchEvent(new dom.window.MouseEvent('mouseup', {bubbles: true, clientX: 0, clientY: 0}));
  await wait(350);
  log('a plain single click opens the Dates modal', !doc.getElementById('portfolioPlannerProjectDatesOverlay').classList.contains('hidden'));
  log('a plain single click does NOT open the Resources modal', doc.getElementById('portfolioPlannerResourcesOverlay').classList.contains('hidden'));
  doc.getElementById('portfolioPlannerProjectDatesCancelBtn') && doc.getElementById('portfolioPlannerProjectDatesCancelBtn').click();
  await wait(20);

  // ── Double click opens Resources, and the single-click Dates modal never appears first ──────
  const narrowBarGroup2 = doc.querySelector('.kf-portfolio-timeline-bar[data-project-id="narrow1"]');
  narrowBarGroup2.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true, clientX: 0, clientY: 0}));
  narrowBarGroup2.dispatchEvent(new dom.window.MouseEvent('mouseup', {bubbles: true, clientX: 0, clientY: 0}));
  narrowBarGroup2.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true, clientX: 0, clientY: 0}));
  narrowBarGroup2.dispatchEvent(new dom.window.MouseEvent('mouseup', {bubbles: true, clientX: 0, clientY: 0}));
  narrowBarGroup2.dispatchEvent(new dom.window.MouseEvent('dblclick', {bubbles: true, clientX: 0, clientY: 0}));
  await wait(350);
  log('double-clicking a bar opens the Resources modal', !doc.getElementById('portfolioPlannerResourcesOverlay').classList.contains('hidden'));
  log('double-clicking a bar does NOT leave the Dates modal open', doc.getElementById('portfolioPlannerProjectDatesOverlay').classList.contains('hidden'));

  console.log('\nPortfolio Planner bars test complete.');
  process.exit(0);
})();
