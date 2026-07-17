const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Black-box, driving the BUILT dist/index.html — same convention as every other test in this suite
   (see CLAUDE.md §10 / query_engine_test.js's own note). features/sql-intellisense.js has no
   standalone unit-test harness of its own; its behavior is exercised entirely through the Advanced
   Query tab's SQL textarea, same as query-engine.js. Pixel-position assertions are deliberately
   skipped throughout — jsdom performs no real layout, so getCaretPixelPosition()'s output is
   meaningless here; every assertion below targets suggestion content/filtering/insertion logic and
   dropdown open/close state instead. */

function makeFakeJwt(payload){
  var b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

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

  const sqlEl = doc.getElementById('projectQuerySql');
  const dropdownEl = doc.getElementById('projectQueryIntellisenseDropdown');

  function typeSql(value, caretIndex){
    sqlEl.value = value;
    sqlEl.selectionStart = sqlEl.selectionEnd = (caretIndex == null ? value.length : caretIndex);
    sqlEl.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  }

  function optionLabels(){
    return Array.prototype.map.call(dropdownEl.querySelectorAll('.kf-intellisense-option'), function(row){
      // row.lastElementChild (a DIRECT child), not querySelector('span:last-child') — the latter also
      // matches a badge's own nested icon <span> (itself the last child of ITS parent), which comes
      // first in document order and would win instead of the actual label span.
      return row.lastElementChild.textContent;
    });
  }

  function optionBadges(){
    return Array.prototype.map.call(dropdownEl.querySelectorAll('.kf-intellisense-option-type'), function(el){
      return el.textContent;
    });
  }

  // The badge's *kind* now lives in its class (kf-intellisense-type-<kind>) rather than always being
  // readable text — a table/PK/FK badge is an SVG icon with no text node at all.
  function optionKindAt(index){
    var el = dropdownEl.querySelectorAll('.kf-intellisense-option-type')[index];
    if(!el) return null;
    var cls = Array.prototype.find.call(el.classList, function(c){ return c.indexOf('kf-intellisense-type-') === 0; });
    return cls ? cls.slice('kf-intellisense-type-'.length) : null;
  }

  function findRowKind(label){
    var idx = optionLabels().indexOf(label);
    return idx === -1 ? null : optionKindAt(idx);
  }

  function keydown(key){
    var evt = new dom.window.KeyboardEvent('keydown', {key: key, bubbles: true, cancelable: true});
    sqlEl.dispatchEvent(evt);
  }

  // ── 1. Table context, multiple matches ──────────────────────────────────────────────────
  typeSql('SELECT * FROM ta');
  await wait(30);
  log('dropdown opens for a table-context prefix', !dropdownEl.classList.contains('hidden'));
  const tableLabels = optionLabels();
  log('offers both "tasks" and "taskTypes" for prefix "ta"', tableLabels.indexOf('tasks') !== -1 && tableLabels.indexOf('taskTypes') !== -1, tableLabels.join(','));
  log('table suggestions are badged with the table (grid) icon, not a letter', optionKindAt(0) === 'table' && dropdownEl.querySelectorAll('.kf-intellisense-type-table .kf-icon').length === tableLabels.length, optionBadges().join(','));

  // ── 2. Tab accepts a table suggestion, brackets it, moves the caret past it ────────────────
  typeSql('SELECT * FROM tasks');
  await wait(30);
  log('unique full-word prefix narrows to exactly one table option', optionLabels().length === 1 && optionLabels()[0] === 'tasks', optionLabels().join(','));
  keydown('Tab');
  log('Tab replaces the word with a bracketed table name plus trailing space', sqlEl.value === 'SELECT * FROM [tasks] ', sqlEl.value);
  log('caret lands right after the inserted text', sqlEl.selectionStart === sqlEl.value.length);
  log('dropdown closes after accepting', dropdownEl.classList.contains('hidden'));

  // ── 3. Field-or-keyword context, scoped to referenced tables, with disambiguation ─────────
  typeSql('SELECT * FROM tasks JOIN risks WHERE i');
  await wait(30);
  const scopedLabels = optionLabels();
  log('field ambiguous across referenced tables is offered as table.field for EACH owner', scopedLabels.indexOf('tasks.id') !== -1 && scopedLabels.indexOf('risks.id') !== -1, scopedLabels.join(','));
  log('the bare ambiguous field name itself is not offered', scopedLabels.indexOf('id') === -1, scopedLabels.join(','));
  log('a field unique to one referenced table is offered bare', scopedLabels.indexOf('isPrivate') !== -1 && scopedLabels.indexOf('impact') !== -1, scopedLabels.join(','));
  log('matching keywords are offered alongside fields', scopedLabels.indexOf('IN') !== -1 && scopedLabels.indexOf('IS') !== -1, scopedLabels.join(','));
  log('a field from an unreferenced table is not offered (e.g. documents/principles never joined here)', scopedLabels.indexOf('documents.id') === -1);

  // ── 3b. Primary-key / foreign-key / plain-field badge kinds ────────────────────────────────
  typeSql('SELECT * FROM tasks JOIN risks WHERE ');
  await wait(30);
  log('a table\'s own "id" field is badged as a primary key (tasks.id)', findRowKind('tasks.id') === 'field-pk');
  log('a table\'s own "id" field is badged as a primary key (risks.id)', findRowKind('risks.id') === 'field-pk');
  log('a field that is some table\'s own FK to another table is badged as a foreign key', findRowKind('taskId') === 'field-fk');
  log('an ordinary non-key field is badged "field" with no icon and no text', (function(){
    if(findRowKind('impact') !== 'field') return false;
    var idx = optionLabels().indexOf('impact');
    var badgeEl = dropdownEl.querySelectorAll('.kf-intellisense-option-type')[idx];
    return badgeEl.textContent.trim() === '' && badgeEl.querySelector('.kf-icon') === null;
  })());

  // ── 4. Clicking a specific disambiguated option inserts BOTH segments bracketed ────────────
  const tasksIdIndex = optionLabels().indexOf('tasks.id');
  const tasksIdRow = dropdownEl.querySelectorAll('.kf-intellisense-option')[tasksIdIndex];
  tasksIdRow.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true, cancelable: true}));
  log('clicking "tasks.id" inserts [tasks].[id] with a trailing space', sqlEl.value === 'SELECT * FROM tasks JOIN risks WHERE [tasks].[id] ', sqlEl.value);

  // ── 5. Keyword suggestion at the very start of the query, inserted upper-cased & unbracketed ─
  typeSql('sel');
  await wait(30);
  const startLabels = optionLabels();
  log('typing "sel" with nothing before it offers the SELECT keyword', startLabels.indexOf('SELECT') !== -1, startLabels.join(','));
  log('a keyword suggestion is badged with the word "SQL"', dropdownEl.querySelectorAll('.kf-intellisense-option-type')[startLabels.indexOf('SELECT')].textContent.trim() === 'SQL');
  keydown('Tab');
  log('accepting a keyword inserts it upper-cased, unbracketed, with a trailing space', sqlEl.value === 'SELECT ', sqlEl.value);

  // ── 6. Suppressed inside an open string literal ────────────────────────────────────────────
  typeSql("SELECT * FROM tasks WHERE title = 'ta");
  await wait(30);
  log('no suggestions while the caret sits inside an open string literal', dropdownEl.classList.contains('hidden'));

  // ── 7. Suppressed immediately after a manually-typed open bracket ─────────────────────────
  typeSql('SELECT * FROM [ta');
  await wait(30);
  log('no suggestions immediately after a manually-opened [ (user is bracket-editing by hand)', dropdownEl.classList.contains('hidden'));

  // ── 8. Escape closes without altering the query text ──────────────────────────────────────
  typeSql('SELECT * FROM ta');
  await wait(30);
  log('dropdown open before Escape', !dropdownEl.classList.contains('hidden'));
  const beforeEscapeValue = sqlEl.value;
  keydown('Escape');
  log('Escape closes the dropdown', dropdownEl.classList.contains('hidden'));
  log('Escape does not modify the query text', sqlEl.value === beforeEscapeValue);

  // ── 9. Arrow keys move the active option ───────────────────────────────────────────────────
  typeSql('SELECT * FROM ta');
  await wait(30);
  const rows = dropdownEl.querySelectorAll('.kf-intellisense-option');
  log('first option starts active', rows[0].classList.contains('active') && !rows[1].classList.contains('active'));
  keydown('ArrowDown');
  const rowsAfter = dropdownEl.querySelectorAll('.kf-intellisense-option');
  log('ArrowDown moves the active option to the next one', !rowsAfter[0].classList.contains('active') && rowsAfter[1].classList.contains('active'));

  // ── 10. Mid-word acceptance replaces the WHOLE word, not just the typed prefix ────────────
  typeSql('SELECT * FROM tasks WHERE priority = 1', 'SELECT * FROM tasks WHERE '.length + 3);
  await wait(30);
  const midWordLabels = optionLabels();
  const priorityIndex = midWordLabels.indexOf('priority');
  log('a field match is offered while the caret sits mid-word', priorityIndex !== -1, midWordLabels.join(','));
  const priorityRow = dropdownEl.querySelectorAll('.kf-intellisense-option')[priorityIndex];
  priorityRow.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true, cancelable: true}));
  log('accepting mid-word replaces the ENTIRE word, not just the prefix up to the caret', sqlEl.value === 'SELECT * FROM tasks WHERE [priority]  = 1', sqlEl.value);

  // ── 11. Table JOIN intellisense: related tables rank before unrelated ones ────────────────
  typeSql('SELECT * FROM tasks JOIN ');
  await wait(30);
  const joinTableLabels = optionLabels();
  const columnsIdx = joinTableLabels.indexOf('columns');
  const risksIdx = joinTableLabels.indexOf('risks'); // related via risks.taskId -> tasks (reverse FK)
  const objectivesIdx = joinTableLabels.indexOf('objectives'); // no relationship to tasks at all
  log('a table related to an already-referenced table ranks before an unrelated one',
      columnsIdx !== -1 && objectivesIdx !== -1 && columnsIdx < objectivesIdx, joinTableLabels.join(','));
  log('a table related via a REVERSE foreign key (risks.taskId -> tasks) also ranks first',
      risksIdx !== -1 && objectivesIdx !== -1 && risksIdx < objectivesIdx, joinTableLabels.join(','));

  // ── 12. Table JOIN intellisense: smart ON-condition suggestion from TABLE_RELATIONSHIPS ────
  typeSql('SELECT * FROM tasks JOIN columns ON ');
  await wait(30);
  const onLabels = optionLabels();
  log('a join-condition suggestion appears right after ON, built from TABLE_RELATIONSHIPS', onLabels.indexOf('tasks.columnId = columns.id') !== -1, onLabels.join(','));
  const joinRows = dropdownEl.querySelectorAll('.kf-intellisense-option');
  log('the join-condition suggestion is first and badged "J"', joinRows[0].querySelector('.kf-intellisense-option-type').textContent === 'J' && joinRows[0].querySelector('.kf-intellisense-type-join') !== null);
  keydown('Tab');
  log('accepting it inserts the full bracketed condition on both sides', sqlEl.value === 'SELECT * FROM tasks JOIN columns ON [tasks].[columnId] = [columns].[id] ', sqlEl.value);

  // ── 13. No join-condition suggestion with fewer than two referenced tables ────────────────
  typeSql('SELECT * FROM tasks ON ');
  await wait(30);
  log('no join-condition suggestion offered after ON with only one table referenced', optionLabels().indexOf('tasks.columnId = columns.id') === -1, optionLabels().join(','));

  console.log('\nSQL Intellisense test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
