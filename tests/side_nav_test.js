const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// build.js's CSS minifier merges separate rules sharing an identical body into one comma-separated
// selector list (e.g. "#a,#b,#c{display:none}") — a selector's own rule body can start well after
// where the selector itself appears, once other merged selectors are chained in before the actual
// '{'. Find where the selector starts, then capture from ITS rule's real opening brace to the
// matching close, rather than assuming '{' immediately follows the selector.
function ruleFor(text, selector){
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[{};,])\\s*' + escaped + '\\s*[,{]', 'm');
  const m = text.match(re);
  if (!m) return null;
  const openBraceIdx = text.indexOf('{', m.index);
  if (openBraceIdx === -1) return null;
  const closeBraceIdx = text.indexOf('}', openBraceIdx);
  if (closeBraceIdx === -1) return null;
  return text.slice(openBraceIdx + 1, closeBraceIdx);
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  // build.js minifies the inlined CSS (strips spaces around ':' and before '('), so this can't be a
  // literal substring search — a silent -1 here previously fed into style.indexOf('{', -1) (treated
  // as 0, matching the stylesheet's very FIRST rule instead of the media query) and then into
  // style.slice(-1, ...)/style.slice(0,-1) (negative slice indices count from the end), corrupting
  // both mediaBlock (ended up empty) and beforeMedia (ended up a near-duplicate of the whole sheet)
  // silently rather than throwing — which is why only SOME of the checks below failed.
  const mediaStartMatch = style.match(/@media\s*\(\s*max-width:\s*1024px\s*\)/);
  const mediaStart = mediaStartMatch ? mediaStartMatch.index : -1;
  const openBraceIdx = style.indexOf('{', mediaStart);
  let depth = 1, i = openBraceIdx + 1;
  while (depth > 0 && i < style.length) {
    if (style[i] === '{') depth++;
    else if (style[i] === '}') depth--;
    i++;
  }
  const mediaCloseIdx = i; // index just after the media block's matching closing brace
  const mediaBlock = style.slice(mediaStart, mediaCloseIdx);
  const beforeMedia = style.slice(0, mediaStart) + style.slice(mediaCloseIdx);

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;

    log('side nav element exists', !!doc.getElementById('sideNav'));
    log('side nav starts collapsed (no .expanded class)', !doc.getElementById('sideNav').classList.contains('expanded'));
    log('toggle button starts with aria-expanded="false"', doc.getElementById('sideNavToggle').getAttribute('aria-expanded') === 'false');

    const navRule = ruleFor(beforeMedia, '.kf-side-nav');
    log('side nav has its own independent vertical scroll', navRule && navRule.includes('overflow-y:auto'), navRule);

    const collapsedWidthRule = ruleFor(beforeMedia, '.kf-side-nav');
    const expandedWidthRule = ruleFor(beforeMedia, '.kf-side-nav.expanded');
    log('collapsed width is a sensible icon-rail size', collapsedWidthRule && /width:\s*56px/.test(collapsedWidthRule), collapsedWidthRule);

    const appHeaderRule = ruleFor(beforeMedia, '.kf-header');
    const navToggleRule = ruleFor(beforeMedia, '.kf-side-nav-toggle');
    const appHeaderHeight = appHeaderRule && appHeaderRule.match(/height:\s*(\d+px)/);
    const navToggleHeight = navToggleRule && navToggleRule.match(/height:\s*(\d+px)/);
    log('side nav header height is 54px', navToggleHeight && navToggleHeight[1] === '54px',
        `nav toggle=${navToggleHeight && navToggleHeight[1]}`);
    log('expanded width is a sensible label-width size', expandedWidthRule && /width:\s*220px/.test(expandedWidthRule), expandedWidthRule);

    const sections = doc.querySelectorAll('.kf-side-nav-section');
    log('exactly two sections', sections.length === 2, sections.length);
    log('first section is labeled "Views"', sections[0].querySelector('.kf-side-nav-label').textContent.trim() === 'Views');
    log('second section is labeled "Tools"', sections[1].querySelector('.kf-side-nav-label').textContent.trim() === 'Tools');

    const viewsOrder = Array.from(sections[0].querySelectorAll('.kf-side-nav-item')).map(b => b.id);
    const toolsOrder = Array.from(sections[1].querySelectorAll('.kf-side-nav-item')).map(b => b.id);
    // Governance Map was added to Views later (replacing Workflow's old spot there — Workflow
    // itself moved to Tools), To-Do/Workflow/Portfolio Planner/Retrospectives/Strategy were all
    // added to Tools since this list was written, and API Endpoints (CLAUDE.md's API Endpoints
    // modal entry) landed between Project Storage and Workflow without this list being updated
    // for it.
    log('Views section: List View, Timeline, Dependency Map, Cost/Benefit Chart, Org Chart, Governance Map',
        viewsOrder.join(',') === 'navTaskListBtn,navTimelineBtn,navDepMapBtn,navCostBenefitBtn,navOrgChartBtn,navGovernanceMapBtn', viewsOrder.join(','));
    log('Tools section: Bulk Edit, To-Do, Archived, Task Types, Releases, Project Storage, API Endpoints, Workflow, Portfolio Planner, Retrospectives, Strategy',
        toolsOrder.join(',') === 'navBulkEditBtn,navTodoBtn,navArchivedBtn,navTaskTypesBtn,navReleasesBtn,navProjectStorageBtn,navApiEndpointsBtn,navWorkflowBtn,navPortfolioPlannerBtn,navRetrospectiveBtn,navStrategyBtn', toolsOrder.join(','));

    viewsOrder.concat(toolsOrder).forEach(id => {
      const el = doc.getElementById(id);
      log('"' + id + '" has a non-empty title attribute for its tooltip', !!(el.getAttribute('title') && el.getAttribute('title').trim()));
    });
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;

    doc.getElementById('sideNavToggle').click();
    await wait(10);
    log('clicking the toggle expands the nav', doc.getElementById('sideNav').classList.contains('expanded'));
    log('aria-expanded flips to true', doc.getElementById('sideNavToggle').getAttribute('aria-expanded') === 'true');
    log('toggle tooltip updates to "Collapse navigation"', doc.getElementById('sideNavToggle').getAttribute('title') === 'Collapse navigation');

    doc.getElementById('sideNavToggle').click();
    await wait(10);
    log('clicking again collapses it back', !doc.getElementById('sideNav').classList.contains('expanded'));
    log('aria-expanded flips back to false', doc.getElementById('sideNavToggle').getAttribute('aria-expanded') === 'false');
    log('toggle tooltip reverts to "Expand navigation"', doc.getElementById('sideNavToggle').getAttribute('title') === 'Expand navigation');
  }

  {
    const dom1 = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    dom1.window.document.getElementById('sideNavToggle').click();
    await wait(10);
    log('first session: nav is expanded after toggling', dom1.window.document.getElementById('sideNav').classList.contains('expanded'));

    const dom2 = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    log('a new session starts collapsed regardless of a previous session\u2019s state', !dom2.window.document.getElementById('sideNav').classList.contains('expanded'));
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;

    const cases = [
      ['navTaskListBtn', 'taskListOverlay', 'taskListClose'],
      ['navTimelineBtn', 'timelineOverlay', 'timelineClose'],
      ['navDepMapBtn', 'depMapOverlay', 'depMapClose'],
      ['navCostBenefitBtn', 'costBenefitOverlay', 'costBenefitClose'],
      ['navOrgChartBtn', 'orgChartOverlay', 'orgChartClose'],
      ['navWorkflowBtn', 'workflowOverlay', 'workflowClose'],
      ['navBulkEditBtn', 'bulkEditOverlay', 'bulkEditClose'],
      ['navArchivedBtn', 'archivedTasksOverlay', 'archivedTasksClose'],
      ['navTaskTypesBtn', 'taskTypesOverlay', 'taskTypesDoneBtn'],
      ['navReleasesBtn', 'releasesOverlay', 'releasesModalClose']
    ];
    for (const [navId, overlayId, closeId] of cases) {
      doc.getElementById(navId).click();
      await wait(20);
      log('"' + navId + '" opens the correct modal', !doc.getElementById(overlayId).classList.contains('hidden'));
      doc.getElementById(closeId).click();
      await wait(10);
    }
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;
    log('nav Archived badge starts hidden', doc.getElementById('navArchivedCountBadge').classList.contains('kf-vis-hidden'));

    const card = doc.querySelector('.kf-card');
    card.click();
    await wait(10);
    doc.getElementById('taskArchivedCheckbox').checked = true;
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
    log('nav Archived badge shows the count once a task is archived',
        !doc.getElementById('navArchivedCountBadge').classList.contains('kf-vis-hidden') && doc.getElementById('navArchivedCountBadge').textContent === '1',
        doc.getElementById('navArchivedCountBadge').textContent);
    log('toolbar\u2019s own Archived badge stays in sync with the same value',
        doc.getElementById('archivedCountBadge').textContent === doc.getElementById('navArchivedCountBadge').textContent);
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;

    log('#toolbarViewButtons is still present in the DOM', !!doc.getElementById('toolbarViewButtons'));
    log('#toolbarRow2Buttons is still present in the DOM', !!doc.getElementById('toolbarRow2Buttons'));
    log('all original toolbar button ids still exist and are intact',
        ['taskListBtn','timelineBtn','depMapBtn','costBenefitBtn','bulkEditBtn','archivedTasksBtn','taskTypesBtn','releasesBtn'].every(id => !!doc.getElementById(id)));
    log('original toolbar buttons still have their click listeners (still functional)', (() => {
      doc.getElementById('depMapBtn').click();
      const opened = !doc.getElementById('depMapOverlay').classList.contains('hidden');
      doc.getElementById('depMapClose').click();
      return opened;
    })());
  }
  {
    const hideRule1 = ruleFor(beforeMedia, '#toolbarViewButtons,#toolbarRow2Buttons');
    const hideRule2 = ruleFor(beforeMedia, '#toolbarRow2');
    log('CSS hides (not removes) the Views/Tools toolbar wrappers on desktop', hideRule1 && hideRule1.includes('display:none'), hideRule1);
    log('CSS hides the now-empty row 2 entirely on desktop', hideRule2 && hideRule2.includes('display:none'), hideRule2);

    const restoreRule1 = ruleFor(mediaBlock, '#toolbarViewButtons,#toolbarRow2Buttons');
    const restoreRule2 = ruleFor(mediaBlock, '#toolbarRow2');
    log('mobile override restores the toolbar wrappers\u2019 visibility', restoreRule1 && restoreRule1.includes('display:flex'), restoreRule1);
    log('mobile override restores row 2\u2019s visibility', restoreRule2 && restoreRule2.includes('display:flex'), restoreRule2);
  }

  {
    const navMobileRule = ruleFor(mediaBlock, '.kf-side-nav');
    log('side nav is hidden via CSS at mobile/tablet widths', navMobileRule && navMobileRule.includes('display:none'), navMobileRule);
  }
  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    log('default jsdom width is mobile/tablet range', dom.window.innerWidth <= 1024);
    log('mobile: Views/Tools still relocate into the drawer sections exactly as before',
        doc.getElementById('drawerViewButtonsSlot').contains(doc.getElementById('taskListBtn')) &&
        doc.getElementById('drawerToolsButtonsSlot').contains(doc.getElementById('bulkEditBtn')));
    log('mobile: Column stays in its normal row 2 position (unaffected by the side nav feature)',
        doc.getElementById('toolbarRow2').contains(doc.getElementById('addColumnTopBtn')));
  }

  console.log('\nSide nav test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
