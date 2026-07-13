const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  // ── 1. Fresh load (no saved preference) defaults to light theme ──────────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    log('no data-theme attribute on fresh load (light by default)',
        !doc.documentElement.hasAttribute('data-theme'));
    const btn = doc.getElementById('themeToggleBtn');
    log('toggle button shows moon icon (click to go dark) in light mode',
        btn.innerHTML.indexOf('M21 12.79') !== -1, btn.innerHTML.slice(0,60));
    log('toggle button title says "Switch to dark theme"', btn.title === 'Switch to dark theme', btn.title);
  }

  // ── 2. Clicking the toggle switches to dark and persists ─────────────────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('themeToggleBtn').click();
    await wait(20);
    log('clicking toggle sets data-theme="dark" on <html>', doc.documentElement.getAttribute('data-theme') === 'dark');
    log('preference persisted to localStorage', dom.window.localStorage.getItem('kanbanflow_theme') === 'dark');
    const btn = doc.getElementById('themeToggleBtn');
    log('toggle button now shows sun icon (click to go light)', btn.innerHTML.indexOf('cx="12" cy="12" r="4"') !== -1, btn.innerHTML.slice(0,60));
    log('toggle button title says "Switch to light theme"', btn.title === 'Switch to light theme', btn.title);

    // computed CSS variable should now reflect dark surface
    const rootStyles = dom.window.getComputedStyle(doc.documentElement);
    log('CSS variable --kf-surface resolves to the dark value', rootStyles.getPropertyValue('--kf-surface').trim() === '#22272b',
        rootStyles.getPropertyValue('--kf-surface'));

    // Toggle back to light
    doc.getElementById('themeToggleBtn').click();
    await wait(20);
    log('toggling again removes data-theme (back to light)', !doc.documentElement.hasAttribute('data-theme'));
    log('localStorage updated back to light', dom.window.localStorage.getItem('kanbanflow_theme') === 'light');
  }

  // ── 3. A saved "dark" preference is restored (and applied pre-paint) ─────
  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ window.localStorage.setItem('kanbanflow_theme', 'dark'); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('saved dark preference is applied on load', doc.documentElement.getAttribute('data-theme') === 'dark');
    const btn = doc.getElementById('themeToggleBtn');
    log('toggle button reflects dark theme on load (sun icon)', btn.innerHTML.indexOf('cx="12" cy="12" r="4"') !== -1);
  }

  // ── 4. Priority colors actually change between themes (not just chrome) ──
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;

    // Seeded project has a "critical" priority task ("Set up Team members for this project")
    const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Set up Team members for this project') !== -1);
    const pillLight = card.querySelector('.kf-priority-pill').getAttribute('style');
    log('light-mode critical-priority pill uses the light palette (white on red)', pillLight.indexOf('#ffffff') !== -1 && pillLight.indexOf('#c9372c') !== -1, pillLight);

    doc.getElementById('themeToggleBtn').click();
    await wait(20);

    const cardAfter = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Set up Team members for this project') !== -1);
    const pillDark = cardAfter.querySelector('.kf-priority-pill').getAttribute('style');
    log('dark-mode priority pill uses a DIFFERENT (dark-tuned) color set', pillDark !== pillLight, pillDark);
    log('dark-mode critical-priority pill uses the dark palette colors', pillDark.indexOf('#1d2125') !== -1 && pillDark.indexOf('#f87168') !== -1, pillDark);
  }

  // ── 5. Filter chip active-state color resolves per theme ─────────────────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    doc.querySelector('#priorityFilterChips .kf-chip-filter').click();
    await wait(10);
    // renderPriorityFilterChips() rebuilds the chip DOM nodes on click, so re-query rather than reuse the old reference
    const chipAfterClick = doc.querySelector('#priorityFilterChips .kf-chip-filter');
    log('priority chip can be activated in light mode', chipAfterClick.classList.contains('active'));

    doc.getElementById('themeToggleBtn').click();
    await wait(20);
    const chipsAfter = doc.querySelectorAll('#priorityFilterChips .kf-chip-filter');
    const stillActive = Array.from(chipsAfter).some(c => c.classList.contains('active'));
    log('active filter selection survives the theme toggle (state not lost)', stillActive);
  }

  // ── 6. Dependency map node chrome uses CSS vars (theme-reactive even without re-render) ──
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('depMapBtn').click();
    await wait(20);
    const nodeBox = doc.querySelector('.kf-depnode-box');
    const styleAttr = nodeBox.getAttribute('style');
    log('dependency map node box uses CSS variables for fill/stroke (not hardcoded hex)',
        styleAttr.indexOf('var(--kf-surface)') !== -1 && styleAttr.indexOf('var(--kf-border)') !== -1, styleAttr);

    // Toggle theme while map is open — should re-render and stay open
    doc.getElementById('themeToggleBtn').click();
    await wait(20);
    log('dependency map stays open and re-renders after a theme toggle',
        !doc.getElementById('depMapOverlay').classList.contains('hidden'));
    const nodesAfter = doc.querySelectorAll('.kf-depnode');
    log('dependency map still shows all nodes after theme toggle', nodesAfter.length === 5, nodesAfter.length);
  }

  // ── 7. Toggling theme doesn't affect underlying data ──────────────────────
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    const beforeRaw = dom.window.localStorage.getItem('kanbanflow_v1_db');
    doc.getElementById('themeToggleBtn').click();
    await wait(20);
    const afterRaw = dom.window.localStorage.getItem('kanbanflow_v1_db');
    log('toggling theme does not touch the app data in localStorage', beforeRaw === afterRaw);
    log('theme is stored under its own separate localStorage key', dom.window.localStorage.getItem('kanbanflow_theme') === 'dark');
  }

  console.log('\nDark theme test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
