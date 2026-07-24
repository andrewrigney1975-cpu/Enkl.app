const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers the Vendor Portal-controlled per-Organisation AI Assistant entitlement (root CLAUDE.md §9's
   entitlement section): the bubble's visibility now depends on BOTH isServerAuthoritative(project)
   (existing behavior) AND a fetched GET .../ai-assistant/availability result (new). Same
   seed-localStorage-directly technique as change_auditing_confirm_test.js for simulating a
   server-authoritative project without a live backend - loadDB() reads whatever's already in
   localStorage at init() time, so writing it in the gap between `new JSDOM()` and DOMContentLoaded
   works. The actual per-call server-side re-check (the real enforcement point) is covered by this
   session's own live curl-based verification against the docker-hosted stack, not here - this file
   only proves the frontend correctly reflects whatever the availability endpoint says. */

function seedServerAuthoritativeProject(dom){
  const raw = JSON.parse(dom.window.localStorage.getItem('kanbanflow_v1_db'));
  const proj = raw.projects[raw.currentProjectId];
  proj.serverProjectId = proj.id;
  dom.window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(raw));
  return proj.id;
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  /* ---- Local-only project: bubble stays hidden regardless of any availability response (no server project to check against) ---- */
  const domLocal = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  let localFetchCalled = false;
  domLocal.window.fetch = async function(url){
    if(String(url).indexOf('/ai-assistant/availability') !== -1) localFetchCalled = true;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await wait(400);
  log('local-only project: AI Assistant bubble hidden', domLocal.window.document.getElementById('aiAssistantBubbleBtn').classList.contains('kf-vis-hidden'));
  log('local-only project: availability endpoint never called (no server project to check)', !localFetchCalled);

  /* ---- Server-authoritative project, entitlement ENABLED ---- */
  const seedRaw = JSON.parse(domLocal.window.localStorage.getItem('kanbanflow_v1_db'));
  const domEnabled = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  domEnabled.window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(seedRaw));
  const projectId = seedServerAuthoritativeProject(domEnabled);
  let availabilityCallCount = 0;
  domEnabled.window.fetch = async function(url){
    var u = String(url);
    if(u.indexOf('/ai-assistant/availability') !== -1){
      availabilityCallCount++;
      return { ok: true, status: 200, json: async () => ({ enabled: true }) };
    }
    if(u === '/api/projects') return { ok: true, status: 200, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({ message: 'unhandled: ' + u }) };
  };
  await wait(400);
  const docEnabled = domEnabled.window.document;
  log('entitled org: availability endpoint was called on load', availabilityCallCount > 0);
  log('entitled org: AI Assistant bubble visible', !docEnabled.getElementById('aiAssistantBubbleBtn').classList.contains('kf-vis-hidden'));

  /* ---- Server-authoritative project, entitlement DISABLED ---- */
  const domDisabled = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  domDisabled.window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(seedRaw));
  seedServerAuthoritativeProject(domDisabled);
  domDisabled.window.fetch = async function(url){
    var u = String(url);
    if(u.indexOf('/ai-assistant/availability') !== -1) return { ok: true, status: 200, json: async () => ({ enabled: false }) };
    if(u === '/api/projects') return { ok: true, status: 200, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({ message: 'unhandled: ' + u }) };
  };
  await wait(400);
  const docDisabled = domDisabled.window.document;
  log('un-entitled org: AI Assistant bubble hidden despite a server-authoritative project', docDisabled.getElementById('aiAssistantBubbleBtn').classList.contains('kf-vis-hidden'));

  /* ---- Chat endpoint itself 403s (revoked mid-conversation) - the UI must not crash ---- */
  const domRevoked = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  domRevoked.window.localStorage.setItem('kanbanflow_v1_db', JSON.stringify(seedRaw));
  seedServerAuthoritativeProject(domRevoked);
  domRevoked.window.fetch = async function(url, options){
    var u = String(url);
    if(u.indexOf('/ai-assistant/availability') !== -1) return { ok: true, status: 200, json: async () => ({ enabled: true }) };
    if(u.indexOf('/ai-assistant/chat') !== -1) return { ok: false, status: 403, json: async () => ({ message: 'AI Assistant is not available for your organisation.' }) };
    if(u === '/api/projects') return { ok: true, status: 200, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({ message: 'unhandled: ' + u }) };
  };
  await wait(400);
  const docRevoked = domRevoked.window.document;
  log('revoked mid-session: bubble still visible (availability check hasn\'t polled again yet)', !docRevoked.getElementById('aiAssistantBubbleBtn').classList.contains('kf-vis-hidden'));
  docRevoked.getElementById('aiAssistantBubbleBtn').click();
  await wait(20);
  docRevoked.getElementById('aiAssistantInput').value = 'create a task called Test';
  docRevoked.getElementById('aiAssistantSendBtn').click();
  await wait(200);
  var messagesText = docRevoked.getElementById('aiAssistantMessages').textContent;
  log('revoked mid-session: a 403 from chat does not crash the panel (shows the standard failure message)', messagesText.indexOf("couldn't process that") !== -1, messagesText);

  console.log('\nAI Assistant entitlement test complete.');
  process.exit(0);
})().catch(e => {
  console.error('AI ASSISTANT ENTITLEMENT TEST CRASHED:', e);
  process.exit(1);
});
