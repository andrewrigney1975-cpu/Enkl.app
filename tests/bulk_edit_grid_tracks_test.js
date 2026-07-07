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

  doc.getElementById('bulkEditBtn').click();
  await wait(20);

  // Demo project has Time Tracking enabled (the default), so the Progress
  // column is present and both header/row pick up the ".kf-bulkedit-has-progress"
  // modifier that widens their grid-template-columns by one track.
  const header = doc.getElementById('bulkEditHeader');
  const hasProgress = header.classList.contains('kf-bulkedit-has-progress');
  const headerSelector = hasProgress ? '.kf-bulkedit-header.kf-bulkedit-has-progress' : '.kf-bulkedit-header';
  const rowSelector = hasProgress ? '.kf-bulkedit-row.kf-bulkedit-has-progress' : '.kf-bulkedit-row';

  const headerLabelCount = doc.querySelectorAll('.kf-bulkedit-header > div').length;
  const headerRule = ruleFor(headerSelector);
  const headerTemplateMatch = headerRule && headerRule.match(/grid-template-columns:\s*([^;}]+)/);
  const headerTrackCount = headerTemplateMatch ? countGridTracks(headerTemplateMatch[1].trim()) : -1;
  log('".kf-bulkedit-header" grid-template-columns has exactly one track per header label (no implicit-row wrapping)',
      headerTrackCount === headerLabelCount, `tracks=${headerTrackCount} labels=${headerLabelCount}`);

  const row = doc.querySelector('.kf-bulkedit-row');
  const rowCellCount = row.children.length;
  const rowRule = ruleFor(rowSelector);
  const rowTemplateMatch = rowRule && rowRule.match(/grid-template-columns:\s*([^;}]+)/);
  const rowTrackCount = rowTemplateMatch ? countGridTracks(rowTemplateMatch[1].trim()) : -1;
  log('".kf-bulkedit-row" grid-template-columns has exactly one track per actual cell in a row',
      rowTrackCount === rowCellCount, `tracks=${rowTrackCount} cells=${rowCellCount}`);

  log('header and row define the same number of tracks as each other', headerTrackCount === rowTrackCount,
      `header=${headerTrackCount} row=${rowTrackCount}`);

  const lastHeaderLabel = Array.from(doc.querySelectorAll('.kf-bulkedit-header > div')).pop().textContent.trim();
  const lastRowCell = row.children[row.children.length - 1];
  log('the last header label is "Status"', lastHeaderLabel === 'Status', lastHeaderLabel);
  log('the last cell in a row is the status badge (rightmost column)', lastRowCell.classList.contains('kf-bulkedit-status-badge'),
      lastRowCell.className);

  const deadRuleStillExists = ruleFor('.kf-bulkedit-grid-cols') !== null;
  log('the old unused/duplicate .kf-bulkedit-grid-cols rule has been removed (single source of truth)', !deadRuleStillExists);

  console.log('\nBulk Edit grid-track regression test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
