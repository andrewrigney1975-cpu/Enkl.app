const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Tab title and header logo ──────────────────────────────────────────
  // Renamed to "Enklr Task" after this test was written (a later, deliberate naming update — the
  // header logo's "Task" is also its own lighter-weight <span> now, see styles.css's .kf-logo-light).
  log('tab title is "Enklr Task"', doc.title === 'Enklr Task', doc.title);
  const logo = doc.querySelector('.kf-logo');
  log('header logo reads "Enklr Task"', logo.textContent.trim() === 'Enklr Task', logo.textContent.trim());

  // ── 2. No leftover references to either previous brand name ──────────────
  log('no "KanbanFlow" text remains anywhere in the file', html.indexOf('KanbanFlow') === -1);
  log('no "Kanba" text remains anywhere in the file (the previous rebrand)', !/Kanba[a-zA-Z]*/.test(html));

  // ── 3. User-facing brand mentions updated for consistency ────────────────
  log('Import Project tooltip references the new brand', doc.getElementById('importProjectBtn').getAttribute('title').indexOf('Enkl') !== -1,
      doc.getElementById('importProjectBtn').getAttribute('title'));

  // ── 4. Internal storage keys are UNCHANGED, for backward compatibility ───
  // build.js's JS minifier renames module-scoped variables (STORAGE_KEY/THEME_STORAGE_KEY become
  // short, unpredictable symbols) and switches to double quotes — a literal "STORAGE_KEY = '...'"
  // source search can never match the minified bundle. The actual, meaningful thing to verify is
  // that the app reads/writes localStorage under these exact literal key STRINGS, which is directly
  // checkable by asking the running app's own localStorage for them instead of grepping variable
  // names out of minified source.
  log('the localStorage data key is unchanged (kanbanflow_v1_db) so existing saved boards still load',
      window.localStorage.getItem('kanbanflow_v1_db') !== null);
  doc.getElementById('themeToggleBtn').click();
  await wait(10);
  log('the localStorage theme key is unchanged (kanbanflow_theme) so existing theme preference still loads',
      window.localStorage.getItem('kanbanflow_theme') === 'dark', window.localStorage.getItem('kanbanflow_theme'));

  // ── 5. Inter is loaded from Google Fonts and set as the default font ─────
  log('a Google Fonts stylesheet link for Inter is present', /fonts\.googleapis\.com\/css2\?family=Inter/.test(html));
  log('preconnect hints to the Google Fonts domains are present', html.indexOf('fonts.googleapis.com') !== -1 && html.indexOf('fonts.gstatic.com') !== -1);
  const fontVarMatch = html.match(/--kf-font:\s*([^;]+);/);
  // build.js's CSS minifier normalizes quote style (source uses 'Inter', the minified output uses
  // "Inter") — both are identical, valid CSS, so the quote character can't be part of the match.
  log('--kf-font lists Inter first', !!fontVarMatch && /^["']inter["']/.test(fontVarMatch[1].trim().toLowerCase()), fontVarMatch && fontVarMatch[1]);
  log('--kf-font keeps a system-font fallback chain after Inter (graceful degradation if the CDN is unreachable)',
      !!fontVarMatch && fontVarMatch[1].indexOf('sans-serif') !== -1 && fontVarMatch[1].indexOf('apple-system') !== -1);
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  log('body\u2019s font-family rule references the --kf-font variable (so the Inter-first value above actually applies)',
      /\bbody\s*\{[^}]*font-family:\s*var\(--kf-font\)/.test(style) || /body\{[^}]*font-family:var\(--kf-font\)/.test(style));

  // ── 6. Sanity: the app still works after the rebrand + font change ───────
  log('board still renders normally', doc.querySelectorAll('.kf-card').length === 5, doc.querySelectorAll('.kf-card').length);
  log('localStorage still loads the seeded demo data under the unchanged key',
      JSON.parse(window.localStorage.getItem('kanbanflow_v1_db')) !== null);

  console.log('\nEnkl rebrand + Inter font test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
