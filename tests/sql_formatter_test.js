const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Black-box, driving the BUILT dist/index.html — same convention as every other test in this suite
   (see CLAUDE.md §10). features/sql-formatter.js has no standalone unit-test harness of its own; its
   formatting output is asserted directly (exact expected strings for representative queries), and its
   correctness — that reformatting never changes what the query actually MEANS — is verified by
   actually running both the original and the formatted query through the real Advanced Query pipeline
   (Format SQL button -> Run button -> rendered results table) and comparing the rendered results,
   rather than just trusting the formatter's own output. */

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

  function setSql(value){
    sqlEl.value = value;
    sqlEl.selectionStart = sqlEl.selectionEnd = value.length;
    sqlEl.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  }

  function runAndCaptureTable(){
    doc.getElementById('projectQueryRunBtn').click();
    var rows = Array.prototype.map.call(doc.querySelectorAll('#projectQueryResultsWrap tbody tr'), function(tr){
      return Array.prototype.map.call(tr.querySelectorAll('td'), function(td){ return td.textContent; });
    });
    var cols = Array.prototype.map.call(doc.querySelectorAll('#projectQueryResultsWrap thead th'), function(th){ return th.textContent; });
    return {columns: cols, rows: rows};
  }

  // ── 1. Exact formatted output — SELECT list + WHERE + ORDER BY, all bare identifiers wrapped ─
  setSql("select id,title,priority from tasks where priority='high' order by title");
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const expected1 = "SELECT [id],\n  [title],\n  [priority]\nFROM [tasks]\nWHERE [priority] = 'high'\nORDER BY [title]";
  log('SELECT-list + WHERE + ORDER BY formats exactly as expected, every bare identifier bracketed', sqlEl.value === expected1, JSON.stringify(sqlEl.value));

  // ── 2. Exact formatted output — aggregate + GROUP BY + ORDER BY; alias also gets bracketed ──
  setSql('select priority, count(*) as taskCount from tasks group by priority order by taskCount desc');
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const expected2 = 'SELECT [priority],\n  COUNT(*) AS [taskCount]\nFROM [tasks]\nGROUP BY [priority]\nORDER BY [taskCount] DESC';
  log('aggregate + GROUP BY + ORDER BY formats exactly as expected, COUNT unwrapped (keyword) but its alias IS wrapped', sqlEl.value === expected2, JSON.stringify(sqlEl.value));

  // ── 3. Exact formatted output — JOIN/ON; bare table names wrapped, already-bracketed ON
  //      condition left untouched (not double-wrapped) ──────────────────────────────────────
  setSql('SELECT * FROM tasks JOIN columns ON [tasks].[columnId] = [columns].[id]');
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const expected3 = 'SELECT *\nFROM [tasks]\nJOIN [columns]\n  ON [tasks].[columnId] = [columns].[id]';
  log('JOIN/ON formats with ON indented under its JOIN; bare FROM/JOIN table names get bracketed, already-bracketed ON condition is not double-wrapped', sqlEl.value === expected3, JSON.stringify(sqlEl.value));

  // ── 4. AND/OR chain breaks one condition per line; content inside parens stays inline;
  //      identifiers inside parens still get bracketed even though the parens aren't broken ───
  setSql("select * from tasks where (priority = 'high' or priority = 'critical') and archived = 'false'");
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const expected4 = "SELECT *\nFROM [tasks]\nWHERE ([priority] = 'high' OR [priority] = 'critical')\n  AND [archived] = 'false'";
  log('AND breaks to a new indented line; OR inside parens stays inline; identifiers inside the parens are still bracketed', sqlEl.value === expected4, JSON.stringify(sqlEl.value));

  // ── 4b. Bracket-wrapping specifics: no double-wrapping, numbers/literals untouched ─────────
  setSql("SELECT id FROM tasks WHERE businessValue > 5 AND title = 'the great [escape]'");
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  log('a numeric literal (5) is never bracketed', sqlEl.value.indexOf('[5]') === -1 && sqlEl.value.indexOf(' 5') !== -1, JSON.stringify(sqlEl.value));
  log('a string literal is left completely untouched, even one that itself contains bracket-looking text', sqlEl.value.indexOf("'the great [escape]'") !== -1, JSON.stringify(sqlEl.value));

  // ── 5. Spaces only, never tabs, and 2-space indentation specifically ──────────────────────
  log('formatted output contains no tab characters', sqlEl.value.indexOf('\t') === -1);
  const indentedLine = sqlEl.value.split('\n').find(function(l){ return l.indexOf('AND') !== -1; });
  log('continuation lines are indented exactly 2 spaces', indentedLine.slice(0, 2) === '  ' && indentedLine[2] !== ' ', JSON.stringify(indentedLine));

  // ── 6. Keywords drawn from the SAME list intellisense uses are upper-cased regardless of
  //      how the user typed them; non-keyword identifiers keep their original casing (just
  //      bracketed, not upper-cased) ──────────────────────────────────────────────────────────
  setSql('SeLeCt Id FrOm tasks WhErE priority = \'high\'');
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  log('mixed-case keywords are normalized to upper case', sqlEl.value.indexOf('SELECT') !== -1 && sqlEl.value.indexOf('FROM') !== -1 && sqlEl.value.indexOf('WHERE') !== -1);
  log('a non-keyword identifier (Id) keeps its original casing, bracketed but not upper-cased', sqlEl.value.split('\n')[0] === 'SELECT [Id]', sqlEl.value);

  // ── 7. Idempotent — formatting an already-formatted query is a no-op ──────────────────────
  const alreadyFormatted = sqlEl.value;
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  log('formatting an already-formatted query changes nothing', sqlEl.value === alreadyFormatted);

  // ── 8. Round-trip correctness — the ORIGINAL and FORMATTED query return IDENTICAL results
  //      when actually run through the real Advanced Query pipeline, not just visually similar ──
  const original8 = "select id,title,priority from tasks where priority='high' order by title";
  setSql(original8);
  const beforeFormat = runAndCaptureTable();
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const afterFormat = runAndCaptureTable();
  log('running the original vs the formatted query returns the same columns', JSON.stringify(beforeFormat.columns) === JSON.stringify(afterFormat.columns), JSON.stringify(afterFormat.columns));
  log('running the original vs the formatted query returns the same rows', JSON.stringify(beforeFormat.rows) === JSON.stringify(afterFormat.rows) && beforeFormat.rows.length > 0, beforeFormat.rows.length);

  const original9 = 'select priority, count(*) as taskCount from tasks group by priority order by taskCount desc';
  setSql(original9);
  const beforeFormat9 = runAndCaptureTable();
  doc.getElementById('projectQueryFormatBtn').click();
  await wait(20);
  const afterFormat9 = runAndCaptureTable();
  log('round-trip holds for an aggregate/GROUP BY query too', JSON.stringify(beforeFormat9.rows) === JSON.stringify(afterFormat9.rows) && beforeFormat9.rows.length > 0, beforeFormat9.rows.length);

  // ── 10. Empty query is handled without throwing ────────────────────────────────────────────
  setSql('');
  let formatCrashed = false;
  try { doc.getElementById('projectQueryFormatBtn').click(); } catch(e){ formatCrashed = true; }
  await wait(20);
  log('formatting an empty query does not throw', !formatCrashed);

  console.log('\nSQL Formatter test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
