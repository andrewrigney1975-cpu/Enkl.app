const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;

  let lastCanvasWidth = null, lastCanvasHeight = null, drawImageCalled = false;
  window.HTMLCanvasElement.prototype.getContext = function(){
    return { drawImage: function(){ drawImageCalled = true; } };
  };
  window.HTMLCanvasElement.prototype.toBlob = function(callback){
    lastCanvasWidth = this.width;
    lastCanvasHeight = this.height;
    callback(new window.Blob(['fake-png-bytes'], { type: 'image/png' }));
  };
  class FakeImage {
    set src(v){ this._src = v; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
    get src(){ return this._src; }
  }
  window.Image = FakeImage;
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};

  let lastBlob = null, lastFilename = null;
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlob = { parts, opts }; return new OrigBlob(parts, opts); };
  const origCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = function(tag){
    const el = origCreateElement(tag);
    if (tag === 'a') {
      el.click = function(){ lastFilename = el.download; };
    }
    return el;
  };

  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  doc.getElementById('depMapBtn').click();
  await wait(20);
  log('Export As button exists in the Dependency Map header', !!doc.getElementById('depMapExportAsBtn'));
  log('Export As panel starts hidden', doc.getElementById('depMapExportAsPanel').classList.contains('hidden'));
  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  log('clicking the button opens the panel', !doc.getElementById('depMapExportAsPanel').classList.contains('hidden'));
  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  log('clicking again closes the panel (toggle)', doc.getElementById('depMapExportAsPanel').classList.contains('hidden'));

  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  const depSvgOption = doc.querySelector('#depMapExportAsPanel [data-export-type="svg"]');
  lastBlob = null; lastFilename = null;
  depSvgOption.click();
  await wait(10);
  log('SVG export produces a Blob of type image/svg+xml', lastBlob && lastBlob.opts.type === 'image/svg+xml', lastBlob && lastBlob.opts.type);
  log('SVG export filename ends in .svg and includes the project key', lastFilename && lastFilename.indexOf('DEMO') === 0 && lastFilename.endsWith('.svg'), lastFilename);
  const svgMarkup = lastBlob.parts[0];
  log('exported SVG markup has no leftover var(...) references (colors were baked)', svgMarkup.indexOf('var(--') === -1, svgMarkup.indexOf('var(--'));
  log('exported SVG text elements have an explicit font-family baked in (not left to inherit from a stylesheet that won\u2019t exist)',
      /<text[^>]*style="[^"]*font-family:/.test(svgMarkup), svgMarkup.match(/<text[^>]*style="[^"]*"/) && svgMarkup.match(/<text[^>]*style="[^"]*"/)[0]);
  log('baked font-family matches the app\u2019s actual font stack (Inter, with its system fallbacks) rather than a generic sans-serif default',
      svgMarkup.indexOf('Inter') !== -1, (svgMarkup.match(/font-family:[^;"]+/) || [])[0]);
  log('exported SVG markup includes an XML declaration', svgMarkup.indexOf('<?xml') === 0);
  log('exported SVG markup has explicit width/height attributes (not just viewBox)', /width="[0-9.]+"/.test(svgMarkup) && /height="[0-9.]+"/.test(svgMarkup));
  log('panel closes itself after choosing an export option', doc.getElementById('depMapExportAsPanel').classList.contains('hidden'));

  const liveSvg = doc.querySelector('#depMapInner svg');
  const nativeWidth = parseFloat(liveSvg.getAttribute('width'));
  const nativeHeight = parseFloat(liveSvg.getAttribute('height'));
  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  const depPngOption = doc.querySelector('#depMapExportAsPanel [data-export-type="png"]');
  lastBlob = null; lastFilename = null; drawImageCalled = false;
  depPngOption.click();
  await wait(30);
  log('PNG export draws onto the canvas', drawImageCalled);
  log('PNG canvas is exactly 4x the SVG\u2019s native width', lastCanvasWidth === Math.round(nativeWidth * 4), `${lastCanvasWidth} vs ${nativeWidth}*4`);
  log('PNG canvas is exactly 4x the SVG\u2019s native height', lastCanvasHeight === Math.round(nativeHeight * 4), `${lastCanvasHeight} vs ${nativeHeight}*4`);
  log('PNG export produces a Blob of type image/png', lastBlob && lastBlob.opts.type === 'image/png', lastBlob && lastBlob.opts.type);
  log('PNG export filename ends in .png', lastFilename && lastFilename.endsWith('.png'), lastFilename);
  doc.getElementById('depMapClose').click();
  await wait(10);

  doc.getElementById('costBenefitBtn').click();
  await wait(20);
  log('Export As button exists in the Cost/Benefit Chart header', !!doc.getElementById('costBenefitExportAsBtn'));
  doc.getElementById('costBenefitExportAsBtn').click();
  await wait(10);
  const cbSvgOption = doc.querySelector('#costBenefitExportAsPanel [data-export-type="svg"]');
  lastBlob = null; lastFilename = null;
  cbSvgOption.click();
  await wait(10);
  log('Cost/Benefit SVG export produces a Blob of type image/svg+xml', lastBlob && lastBlob.opts.type === 'image/svg+xml');
  log('Cost/Benefit SVG export filename includes "cost-benefit-chart"', lastFilename && lastFilename.indexOf('cost-benefit-chart') !== -1, lastFilename);
  log('Cost/Benefit exported SVG has no leftover var(...) references', lastBlob.parts[0].indexOf('var(--') === -1);

  doc.getElementById('costBenefitExportAsBtn').click();
  await wait(10);
  const cbPngOption = doc.querySelector('#costBenefitExportAsPanel [data-export-type="png"]');
  lastBlob = null; lastFilename = null;
  cbPngOption.click();
  await wait(30);
  log('Cost/Benefit PNG export produces a Blob of type image/png', lastBlob && lastBlob.opts.type === 'image/png');
  doc.getElementById('costBenefitClose').click();
  await wait(10);

  doc.getElementById('depMapBtn').click();
  await wait(20);
  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  doc.getElementById('depMapTitle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  log('clicking outside the panel closes it', doc.getElementById('depMapExportAsPanel').classList.contains('hidden'));

  doc.getElementById('depMapExportAsBtn').click();
  await wait(10);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(10);
  log('Escape closes an open Export As panel (without closing the whole modal)',
      doc.getElementById('depMapExportAsPanel').classList.contains('hidden') && !doc.getElementById('depMapOverlay').classList.contains('hidden'));
  doc.getElementById('depMapClose').click();
  await wait(10);

  doc.getElementById('taskListBtn').click();
  await wait(20);
  log('Export as CSV button exists in the List View toolbar', !!doc.getElementById('taskListExportCsvBtn'));

  lastBlob = null; lastFilename = null;
  doc.getElementById('taskListExportCsvBtn').click();
  await wait(10);
  log('CSV export produces a Blob of type text/csv', lastBlob && lastBlob.opts.type.indexOf('text/csv') === 0, lastBlob && lastBlob.opts.type);
  log('CSV export filename ends in .csv and includes the project key', lastFilename && lastFilename.indexOf('DEMO') === 0 && lastFilename.endsWith('.csv'), lastFilename);

  const csv = lastBlob.parts[0];
  const csvLines = csv.split('\r\n');
  log('CSV header row matches the List View\u2019s column labels', csvLines[0] === 'Key,Title,Column,Assignee,Priority,Start,End,Value Prop.,Progress', csvLines[0]);
  log('CSV has one data row per non-archived seeded task (5)', csvLines.length === 6, csvLines.length);
  log('CSV includes a row for a known seeded task', csv.indexOf('Research competitor boards') !== -1);

  doc.getElementById('taskListSearchInput').value = 'README';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  lastBlob = null;
  doc.getElementById('taskListExportCsvBtn').click();
  await wait(10);
  const filteredCsvLines = lastBlob.parts[0].split('\r\n');
  log('CSV export respects the active search filter (only matching rows)', filteredCsvLines.length === 2 && filteredCsvLines[1].indexOf('Write project README') !== -1,
      filteredCsvLines.join(' | '));

  doc.getElementById('taskListSearchInput').value = '';
  doc.getElementById('taskListSearchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  doc.getElementById('taskListClose').click();
  await wait(10);
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Write project README') !== -1);
  card.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Title, with a comma';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);
  doc.getElementById('taskListBtn').click();
  await wait(20);
  lastBlob = null;
  doc.getElementById('taskListExportCsvBtn').click();
  await wait(10);
  log('a title containing a comma is correctly quoted in the CSV', lastBlob.parts[0].indexOf('"Title, with a comma"') !== -1, lastBlob.parts[0]);

  console.log('\nExport As (SVG/PNG/CSV) test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
