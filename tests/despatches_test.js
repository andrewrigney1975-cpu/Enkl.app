// Like tests/release_notes_test.js, this is a genuine isolated unit test (not the suite's usual
// jsdom-driven-dist black-box style) — despatches.js's pushDespatch/getMergedDespatches have no real
// DOM dependency of their own; only renderDespatchesPanel() (untested here) touches document.
// summarizeProjectAlerts() (session-alerts.js) does read the global `state.db`, so a minimal fake db
// is seeded first to avoid a null-deref, same as the app's own loadDB() would populate it.
import { state } from '../src/js/storage.js';
state.db = { projectOrder: [], projects: {}, currentProjectId: null };

const { pushDespatch, getMergedDespatches, resetDespatchLog, setDespatchesDeps } = await import('../src/js/features/despatches.js');

let failures = 0;
function log(label, ok, extra){
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
  if(!ok) failures++;
}

resetDespatchLog();

log('starts empty with no live conditions and nothing pushed yet', getMergedDespatches().length === 0);

pushDespatch({icon: 'ty_document', message: 'Task A updated', timestamp: 1000, taskKey: 'PROJ-1'});
pushDespatch({icon: 'chat', message: 'Bob mentioned you', timestamp: 2000, channelId: 'chan-1'});
pushDespatch({icon: 'ty_document', message: 'Task B updated', timestamp: 500, taskKey: 'PROJ-2'});

var rows = getMergedDespatches();
log('all three pushed despatches are present', rows.length === 3, rows.length);
log('newest-first ordering by timestamp, not insertion order', rows.map(r => r.message).join(',') === 'Bob mentioned you,Task A updated,Task B updated', rows.map(r => r.message).join(','));
log('a task despatch carries its taskKey for link construction', rows.find(r => r.message === 'Task A updated').taskKey === 'PROJ-1');
log('a chat despatch carries its channelId, not a taskKey', rows.find(r => r.message === 'Bob mentioned you').channelId === 'chan-1' && rows.find(r => r.message === 'Bob mentioned you').taskKey === null);

// Cap at 25: push 30 total (3 already pushed above + 27 more), confirm only the 25 newest survive.
for(var i = 0; i < 27; i++){
  pushDespatch({icon: 'ty_document', message: 'Filler ' + i, timestamp: 3000 + i, taskKey: null});
}
var capped = getMergedDespatches();
log('caps at 25 total despatches even after 30 pushes', capped.length === 25, capped.length);
log('the oldest entries (lowest timestamps) are the ones trimmed off, not the newest', capped.every(r => r.message !== 'Task B updated'), capped.map(r => r.message).slice(-3).join(','));
log('the newest entry (highest timestamp) is still present after trimming', capped[0].message === 'Filler 26');

// DI: onUpdate fires on every push.
var updateCount = 0;
setDespatchesDeps({onUpdate: function(){ updateCount++; }});
pushDespatch({icon: 'chat', message: 'One more', timestamp: 99999, channelId: 'chan-2'});
log('setDespatchesDeps\' onUpdate callback fires on push', updateCount === 1, updateCount);

resetDespatchLog();
log('resetDespatchLog() clears everything back to empty', getMergedDespatches().length === 0);

console.log(failures === 0 ? '\nAll despatches tests passed.' : '\n' + failures + ' test(s) FAILED.');
process.exit(failures === 0 ? 0 : 1);
