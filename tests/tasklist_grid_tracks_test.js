const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function countGridTracks(value){
  const tracks = [];
  let depth = 0, current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (current) tracks.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tracks.push(current);
  return tracks.length;
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  function ruleFor(selector){
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[{};,])\\s*' + escaped + '\\{([^}]*)\\}', 'm');
    const m = style.match(re);
    return m ? m[2] : null;
  }

  doc.getElementById('taskListBtn').click();
  await wait(20);

  // Demo project has Time Tracking enabled (the default), so the Progress
  // column is present and both header/row pick up the ".kf-tasklist-has-progress"
  // modifier that widens their grid-template-columns by one track.
  const header = doc.getElementById('taskListHeader');
  const hasProgress = header.classList.contains('kf-tasklist-has-progress');
  const headerSelector = hasProgress ? '.kf-tasklist-header.kf-tasklist-has-progress' : '.kf-tasklist-header';
  const rowSelector = hasProgress ? '.kf-tasklist-row.kf-tasklist-has-progress' : '.kf-tasklist-row';

  const headerCellCount = doc.querySelectorAll('.kf-tasklist-header > div').length;
  const headerRule = ruleFor(headerSelector);
  const headerTemplateMatch = headerRule && headerRule.match(/grid-template-columns:\s*([^;}]+)/);
  const headerTrackCount = headerTemplateMatch ? countGridTracks(headerTemplateMatch[1].trim()) : -1;
  log('".kf-tasklist-header" grid-template-columns has exactly one track per header cell (no implicit-row wrapping)',
      headerTrackCount === headerCellCount, `tracks=${headerTrackCount} cells=${headerCellCount}`);

  const row = doc.querySelector('.kf-tasklist-row');
  const rowCellCount = row.children.length;
  const rowRule = ruleFor(rowSelector);
  const rowTemplateMatch = rowRule && rowRule.match(/grid-template-columns:\s*([^;}]+)/);
  const rowTrackCount = rowTemplateMatch ? countGridTracks(rowTemplateMatch[1].trim()) : -1;
  log('".kf-tasklist-row" grid-template-columns has exactly one track per actual cell in a row',
      rowTrackCount === rowCellCount, `tracks=${rowTrackCount} cells=${rowCellCount}`);

  log('header and row define the same number of tracks as each other', headerTrackCount === rowTrackCount,
      `header=${headerTrackCount} row=${rowTrackCount}`);

  const headerLabels = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).map(c => c.textContent.trim());
  const lastHeaderLabel = headerLabels[headerLabels.length - 1];
  const lastRowCell = row.children[row.children.length - 1];
  const expectedLastLabel = hasProgress ? 'Progress' : 'Value Prop.';
  const expectedLastCellClass = hasProgress ? 'kf-tasklist-progress' : 'kf-valueprop-pill';
  log(`the last header label is "${expectedLastLabel}"`, lastHeaderLabel === expectedLastLabel, lastHeaderLabel);
  log('the last cell in a row is the rightmost column (Progress if Time Tracking is on, else Value Proposition)',
      lastRowCell.classList.contains(expectedLastCellClass), lastRowCell.className);

  const deadRuleStillExists = ruleFor('.kf-tasklist-grid-cols') !== null;
  log('the old unused/duplicate .kf-tasklist-grid-cols rule has been removed (single source of truth)', !deadRuleStillExists);

  console.log('\nTask List grid-track regression test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
