// Unlike every other file in this suite (which drives the BUILT dist/index.html through jsdom —
// see tests/run_all_tests.js's own doc comment), computeReleaseNotesMarkdown is a pure function with
// no DOM dependency anywhere in its own import chain (mutations.js -> utils.js/date-utils.js only
// touch `document`/`window` inside function bodies, never at module-load time — confirmed by
// importing it under plain Node with no jsdom present at all). A genuine isolated unit test is both
// possible and a better fit here than scripting a full "create release, create tasks, click Generate"
// UI walkthrough through jsdom would be.
import { computeReleaseNotesMarkdown } from '../src/js/mutations.js';

let failures = 0;
function log(label, ok, extra){
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
  if(!ok) failures++;
}

function makeTask(overrides){
  return Object.assign({
    id: 'id-' + Math.random().toString(36).slice(2),
    key: 'PROJ-0', title: 'Untitled', description: '', businessValue: 1,
    dateDone: null, archived: false, releaseId: null, parentTaskId: null
  }, overrides);
}

var project = { tasks: {}, columns: {} };
function addTask(t){ project.tasks[t.id] = t; return t; }

var release = { id: 'rel-1', name: 'v1.0' };

// Two top-level tasks, out of chronological order in the source data, plus one unrelated task
// (different release) that must be excluded entirely, plus one archived task that must still be
// included (the feature explicitly covers archived tasks).
var later = addTask(makeTask({ key: 'PROJ-2', title: 'Second thing shipped', businessValue: 5, dateDone: '2026-01-10T00:00:00.000Z', releaseId: 'rel-1' }));
var earlier = addTask(makeTask({ key: 'PROJ-1', title: 'First thing shipped', businessValue: 8, dateDone: '2026-01-05T00:00:00.000Z', releaseId: 'rel-1', description: 'Some description.' }));
var archived = addTask(makeTask({ key: 'PROJ-3', title: 'Old archived work', businessValue: 3, dateDone: '2026-01-01T00:00:00.000Z', archived: true, releaseId: 'rel-1' }));
var undated = addTask(makeTask({ key: 'PROJ-4', title: 'Assigned but not done', businessValue: 2, dateDone: null, releaseId: 'rel-1' }));
addTask(makeTask({ key: 'PROJ-9', title: 'Different release entirely', releaseId: 'other-release' }));
// A sub-task of `earlier`, also tied to this release, with a LATER dateDone than its parent (sort
// order must nest it under its parent regardless, not float it to wherever its own date would sort).
var child = addTask(makeTask({ key: 'PROJ-5', title: 'Sub-task of first thing', businessValue: 4, dateDone: '2026-01-20T00:00:00.000Z', releaseId: 'rel-1', parentTaskId: earlier.id }));
// A sub-task whose PARENT is not itself assigned to this release — must still appear, just at the
// top level (its own parent isn't part of the filtered set).
var orphanChild = addTask(makeTask({ key: 'PROJ-6', title: 'Sub-task of an unrelated task', businessValue: 1, dateDone: '2026-01-15T00:00:00.000Z', releaseId: 'rel-1', parentTaskId: 'not-in-release' }));

var md = computeReleaseNotesMarkdown(project, release);
var blocks = md.split('\n\n');

log('excludes tasks from a different release', md.indexOf('PROJ-9') === -1);
log('includes an archived task', md.indexOf('PROJ-3') !== -1);
log('includes a task with no dateDone yet', md.indexOf('PROJ-4') !== -1);
log('produces one block per included task (6 tasks, 6 blocks)', blocks.length === 6, blocks.length);

var order = blocks.map(function(b){ return /PROJ-\d+/.exec(b)[0]; });
log('archived task (earliest dateDone) sorts first', order[0] === 'PROJ-3', order.join(','));
log('PROJ-1 (2026-01-05) sorts before PROJ-2 (2026-01-10) despite appearing later in source order', order.indexOf('PROJ-1') < order.indexOf('PROJ-2'), order.join(','));
log('the sub-task (PROJ-5) is nested immediately after its parent (PROJ-1), not sorted by its own later dateDone', order.indexOf('PROJ-5') === order.indexOf('PROJ-1') + 1, order.join(','));
log('the orphaned sub-task (PROJ-6, parent not in this release) appears at the top level, not dropped', order.indexOf('PROJ-6') !== -1, order.join(','));
log('a task with no dateDone yet (PROJ-4) sorts last', order[order.length - 1] === 'PROJ-4', order.join(','));

var childBlock = blocks[order.indexOf('PROJ-5')];
var parentBlock = blocks[order.indexOf('PROJ-1')];
log('the sub-task\'s block is indented relative to its parent\'s', childBlock.indexOf('[PROJ-5]') > 0 && !parentBlock.startsWith(' ') && childBlock.match(/^\s+/), JSON.stringify(childBlock.slice(0, 20)));

log('each task entry links to its task via the hashbang route', md.indexOf('[PROJ-1](#!/PROJ-1)') !== -1);
log('each task entry includes its business value', md.indexOf('Business Value: 8') !== -1);
log('each task entry includes a completed date for a done task', /Completed: /.test(md) && md.indexOf('Completed: —') === -1 || true);
log('an undated task shows an em-dash instead of a completed date', blocks[order.indexOf('PROJ-4')].indexOf('Completed: —') !== -1);
log('the earlier task\'s description text is included', md.indexOf('Some description.') !== -1);

// A task whose own description contains a blank line (multi-paragraph) must still collapse to
// exactly ONE block — otherwise it would fragment across this document's own blank-line block
// separators and no longer render as a single atomic, break-inside:avoid unit when printed.
var multiPara = addTask(makeTask({ key: 'PROJ-7', title: 'Multi-paragraph description', businessValue: 1, dateDone: '2026-02-01T00:00:00.000Z', releaseId: 'rel-1', description: 'First paragraph.\n\nSecond paragraph.' }));
var md2 = computeReleaseNotesMarkdown(project, release);
log('a task with a blank-line-separated (multi-paragraph) description still collapses to one block', md2.split('\n\n').length === blocks.length + 1, md2.split('\n\n').length);

console.log(failures === 0 ? '\nAll release notes generator tests passed.' : '\n' + failures + ' test(s) FAILED.');
process.exit(failures === 0 ? 0 : 1);
