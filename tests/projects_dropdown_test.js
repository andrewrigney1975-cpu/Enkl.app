const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

class FakeFile { constructor(text){ this._text = text; } }
function installFakeFileReader(window){
  window.FileReader = class {
    readAsText(f){ const s = this; setTimeout(() => { s.result = f._text; if (s.onload) s.onload(); }, 0); }
  };
}

(async () => {
  let lastBlobText = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  installFakeFileReader(window);
  window.URL.createObjectURL = () => 'blob://fake';
  window.URL.revokeObjectURL = () => {};
  const OrigBlob = window.Blob;
  window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };

  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra!==undefined?' :: '+extra:'')); }

  // ── 1. The three original buttons are hidden by default (desktop), Projects... shows instead ──
  log('New Project button exists in the DOM (still real, just hidden on desktop)', !!doc.getElementById('newProjectBtn'));
  log('Import Project button exists in the DOM', !!doc.getElementById('importProjectBtn'));
  log('Export Project button exists in the DOM', !!doc.getElementById('exportBtn'));
  log('"Projects..." button exists', !!doc.getElementById('projectsMenuBtn'));
  log('"Projects..." button reads exactly "Projects..."', doc.getElementById('projectsMenuBtn').textContent.trim() === 'Projects...');

  // ── 2. Panel starts closed, opens on click, lists exactly the 3 as text links ──
  log('Projects dropdown panel starts closed', doc.getElementById('projectsMenuPanel').classList.contains('hidden'));
  doc.getElementById('projectsMenuBtn').click();
  await wait(10);
  log('clicking "Projects..." opens the panel', !doc.getElementById('projectsMenuPanel').classList.contains('hidden'));

  // "Migrate to Server", "Project Management Report", and "Save as Template..." were added to
  // this panel later — it's 6 links now, not the original 3.
  const links = Array.from(doc.querySelectorAll('#projectsMenuPanel a'));
  const linkTexts = links.map(a => a.textContent);
  log('panel contains exactly 6 links', links.length === 6, linkTexts.join(','));
  log('links are New Project, Import Project, Export Project, Project Management Report, Migrate to Server, Save as Template..., as plain <a> text links (not buttons)',
      linkTexts.join(',') === 'New Project,Import Project,Export Project,Project Management Report,Migrate to Server,Save as Template...' && links.every(a => a.tagName === 'A'),
      linkTexts.join(','));
  log('links use the same text-link styling class as the other More-menu links (consistent visual language)',
      links.every(a => a.classList.contains('kf-header-more-link')));

  // ── 3. Clicking "New Project" actually triggers the real button and closes the panel ──
  const newProjLink = links.find(a => a.textContent === 'New Project');
  newProjLink.click();
  await wait(20);
  log('clicking "New Project" in the dropdown opens the real New Project modal', !doc.getElementById('projectOverlay').classList.contains('hidden'));
  log('the dropdown panel closes after the click', doc.getElementById('projectsMenuPanel').classList.contains('hidden'));
  doc.getElementById('projectModalClose').click();
  await wait(10);

  // ── 4. Clicking "Export Project" triggers a real export ──
  doc.getElementById('projectsMenuBtn').click();
  await wait(10);
  const exportLink = Array.from(doc.querySelectorAll('#projectsMenuPanel a')).find(a => a.textContent === 'Export Project');
  lastBlobText = null;
  exportLink.click();
  await wait(20);
  log('clicking "Export Project" in the dropdown produces a real export', !!lastBlobText && JSON.parse(lastBlobText).project && JSON.parse(lastBlobText).project.key !== undefined,
      lastBlobText && lastBlobText.slice(0, 60));

  // ── 5. Clicking "Import Project" triggers the real file input flow ──
  doc.getElementById('projectsMenuBtn').click();
  await wait(10);
  const importLink = Array.from(doc.querySelectorAll('#projectsMenuPanel a')).find(a => a.textContent === 'Import Project');
  const fileInput = doc.getElementById('importFileInput');
  Object.defineProperty(fileInput, 'files', { value: [new FakeFile(lastBlobText)], configurable: true });
  importLink.click();
  await wait(10);
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  if(!doc.getElementById('importConflictOverlay').classList.contains('hidden')){
    doc.getElementById('importConflictCopyBtn').click();
    await wait(20);
  }
  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  log('clicking "Import Project" in the dropdown actually imports a project (project count increased)',
      Object.keys(raw.projects).length >= 2, Object.keys(raw.projects).length);

  // ── 6. CSS: the 3 originals are hidden on desktop by default, restored on mobile; the dropdown is the reverse ──
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  // build.js minifies the inlined CSS (strips spaces around ':' and before '('), so this can't be a
  // literal substring search — style.indexOf() silently returning -1 here made style.slice(-1)
  // return just the stylesheet's LAST CHARACTER (not "nothing found"), breaking every check below.
  const mediaStartMatch = style.match(/@media\s*\(\s*max-width:\s*1024px\s*\)/);
  const mediaStart = mediaStartMatch ? mediaStartMatch.index : -1;
  const mobileBlock = mediaStart !== -1 ? style.slice(mediaStart) : '';
  // build.js's minifier merges separate rules sharing an identical body into one comma-separated
  // selector list (e.g. ".kf-header-nav-projectaction,.kf-drawer-section-label,...{display:none}"),
  // so "display:none" doesn't necessarily sit right after THIS selector — it's only at the end of
  // the whole group. Find where this selector starts, then check the body of whatever rule it
  // belongs to (up to the next '}'), rather than assuming the property immediately follows it.
  const projectActionSelectorMatch = style.match(/\.kf-header-nav-projectaction\s*[,{]/);
  const projectActionRuleBody = projectActionSelectorMatch
    ? style.slice(projectActionSelectorMatch.index, style.indexOf('}', projectActionSelectorMatch.index))
    : '';
  log('the 4 project-action buttons are hidden by default (desktop), BEFORE the media query (correct source order)',
      /display:none/.test(projectActionRuleBody) && projectActionSelectorMatch.index < mediaStart);
  log('mobile CSS restores the 4 original buttons to visible', /\.kf-header-nav-projectaction\{display:\s*flex/.test(mobileBlock));
  // #projectsMenuWrap's actual class is the shared, generic ".kf-desktop-menu-wrap" (also used by
  // the Account menu) — there's no dedicated ".kf-projects-menu-wrap" class anywhere in the markup.
  log('mobile CSS hides the desktop Projects dropdown', /\.kf-header-controls \.kf-desktop-menu-wrap\{display:\s*none/.test(mobileBlock));

  console.log('\nDesktop Projects dropdown test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
