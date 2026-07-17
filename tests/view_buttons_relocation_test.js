const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// Governance Map was added to Views later (replacing Workflow's old spot there — Workflow itself
// moved to Tools), and To-Do was added to Tools since these lists were written.
const VIEWS_BTN_IDS = ['taskListBtn', 'timelineBtn', 'depMapBtn', 'costBenefitBtn', 'orgChartBtn', 'governanceMapBtn'];
const TOOLS_BTN_IDS = ['bulkEditBtn', 'todoBtn', 'archivedTasksBtn', 'taskTypesBtn', 'releasesBtn', 'projectStorageBtn', 'workflowBtn'];
const ALL_RELOCATING_IDS = VIEWS_BTN_IDS.concat(TOOLS_BTN_IDS);

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    log('default jsdom width is within the mobile/tablet range', dom.window.innerWidth <= 1024, dom.window.innerWidth);

    const viewsSlot = doc.getElementById('drawerViewButtonsSlot');
    const toolsSlot = doc.getElementById('drawerToolsButtonsSlot');
    VIEWS_BTN_IDS.forEach(id => {
      log('"' + id + '" is inside the drawer Views section at mobile/tablet width', viewsSlot.contains(doc.getElementById(id)));
    });
    TOOLS_BTN_IDS.forEach(id => {
      log('"' + id + '" is inside the drawer Tools section at mobile/tablet width', toolsSlot.contains(doc.getElementById(id)));
    });
    log('"addColumnTopBtn" stays in row 2 at mobile/tablet width (its normal position there)', doc.getElementById('toolbarRow2').contains(doc.getElementById('addColumnTopBtn')));
    log('exactly one of each relocating button exists (no duplication)',
        ALL_RELOCATING_IDS.concat('addColumnTopBtn').every(id => doc.querySelectorAll('#' + id).length === 1));

    const viewsSectionLabel = doc.getElementById('drawerViewsSection').querySelector('.kf-drawer-section-label');
    const toolsSectionLabel = doc.getElementById('drawerToolsSection').querySelector('.kf-drawer-section-label');
    log('Views section is labeled "Views"', viewsSectionLabel.textContent.trim() === 'Views');
    log('Tools section is labeled "Tools"', toolsSectionLabel.textContent.trim() === 'Tools');

    const drawerContent = doc.getElementById('headerControls');
    const viewsSectionEl = doc.getElementById('drawerViewsSection');
    const toolsSectionEl = doc.getElementById('drawerToolsSection');
    const childArray = Array.from(drawerContent.children);
    log('Tools section appears AFTER (below) the Views section in the drawer',
        childArray.indexOf(toolsSectionEl) > childArray.indexOf(viewsSectionEl));

    const viewsOrder = Array.from(viewsSlot.querySelectorAll('button')).map(b => b.id).filter(Boolean);
    const toolsOrder = Array.from(toolsSlot.querySelectorAll('button')).map(b => b.id).filter(Boolean);
    log('Views section lists List View, Timeline, Dependency Map, Cost/Benefit Chart, Org Chart, Governance Map in order',
        viewsOrder.join(',') === VIEWS_BTN_IDS.join(','), viewsOrder.join(','));
    log('Tools section lists Bulk Edit, To-Do, Archived, Task Types, Releases, Workflow in order',
        toolsOrder.join(',') === TOOLS_BTN_IDS.join(','), toolsOrder.join(','));
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const doc = dom.window.document;
    const row1 = doc.getElementById('toolbarRow1');
    const row2 = doc.getElementById('toolbarRow2');

    TOOLS_BTN_IDS.forEach(id => {
      log('"' + id + '" (Tools) is now in row 1 at desktop width', row1.contains(doc.getElementById(id)));
    });
    VIEWS_BTN_IDS.forEach(id => {
      log('"' + id + '" (Views) is now in row 2 at desktop width', row2.contains(doc.getElementById(id)));
    });
    log('"addColumnTopBtn" is now in row 1 at desktop width (Views/Tools moved to the side nav)', row1.contains(doc.getElementById('addColumnTopBtn')));
    log('drawer Views slot is empty at desktop width', doc.getElementById('drawerViewButtonsSlot').children.length === 0);
    log('drawer Tools slot is empty at desktop width', doc.getElementById('drawerToolsButtonsSlot').children.length === 0);

    const row1Order = Array.from(row1.querySelectorAll('button')).map(b => b.id).filter(Boolean);
    const row1RelevantOrder = row1Order.filter(id => TOOLS_BTN_IDS.includes(id) || id === 'addColumnTopBtn');
    log('row 1 order: Bulk Edit, To-Do, Archived, Task Types, Releases, Workflow, then Column',
        row1RelevantOrder.join(',') === TOOLS_BTN_IDS.concat('addColumnTopBtn').join(','), row1Order.join(','));
    log('Column sticks to the right-hand end of row 1',
        row1RelevantOrder.indexOf('addColumnTopBtn') === row1RelevantOrder.length - 1);

    const row2Order = Array.from(row2.querySelectorAll('button')).map(b => b.id).filter(Boolean);
    log('row 2 order: List View, Timeline, Dependency Map, Cost/Benefit Chart, Org Chart, Governance Map (no Column — it moved to row 1)',
        row2Order.join(',') === VIEWS_BTN_IDS.join(','), row2Order.join(','));
  }

  {
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
      beforeParse(window){ Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true }); }
    });
    await wait(300);
    const { window } = dom;
    const doc = window.document;
    log('starts with Tools in row 1, Views in row 2 at desktop width',
        doc.getElementById('toolbarRow1').contains(doc.getElementById('bulkEditBtn')) &&
        doc.getElementById('toolbarRow2').contains(doc.getElementById('depMapBtn')));
    log('Column starts in row 1 at desktop width', doc.getElementById('toolbarRow1').contains(doc.getElementById('addColumnTopBtn')));

    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    window.dispatchEvent(new window.Event('resize'));
    await wait(10);
    log('resizing down to mobile moves Tools into its drawer section', doc.getElementById('drawerToolsButtonsSlot').contains(doc.getElementById('bulkEditBtn')));
    log('resizing down to mobile moves Views into its drawer section', doc.getElementById('drawerViewButtonsSlot').contains(doc.getElementById('depMapBtn')));
    log('Column moves to row 2 at mobile width (its normal mobile position)', doc.getElementById('toolbarRow2').contains(doc.getElementById('addColumnTopBtn')));
    log('Column does NOT move to the drawer at mobile width', !doc.getElementById('drawerToolsButtonsSlot').contains(doc.getElementById('addColumnTopBtn')) && !doc.getElementById('drawerViewButtonsSlot').contains(doc.getElementById('addColumnTopBtn')));

    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
    window.dispatchEvent(new window.Event('resize'));
    await wait(10);
    log('resizing back up to desktop restores Tools to row 1', doc.getElementById('toolbarRow1').contains(doc.getElementById('bulkEditBtn')));
    log('resizing back up to desktop restores Views to row 2', doc.getElementById('toolbarRow2').contains(doc.getElementById('depMapBtn')));
    log('resizing back up to desktop restores Column to row 1', doc.getElementById('toolbarRow1').contains(doc.getElementById('addColumnTopBtn')));
    const restoredRow1Order = Array.from(doc.getElementById('toolbarRow1').querySelectorAll('button')).map(b => b.id).filter(Boolean);
    log('restored row 1 order still has Column at the end', restoredRow1Order.indexOf('addColumnTopBtn') === restoredRow1Order.length - 1, restoredRow1Order.join(','));
    log('exactly one of each button after a full round trip (no duplication)',
        ALL_RELOCATING_IDS.concat('addColumnTopBtn').every(id => doc.querySelectorAll('#' + id).length === 1));
  }

  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;

    doc.getElementById('depMapBtn').click();
    await wait(20);
    log('Dependency Map still opens correctly when its button lives in the Views drawer section',
        !doc.getElementById('depMapOverlay').classList.contains('hidden'));
    doc.getElementById('depMapClose').click();
    await wait(10);

    doc.getElementById('taskListBtn').click();
    await wait(20);
    log('List View still opens correctly', !doc.getElementById('taskListOverlay').classList.contains('hidden'));
    doc.getElementById('taskListClose').click();
    await wait(10);

    doc.getElementById('costBenefitBtn').click();
    await wait(20);
    log('Cost/Benefit Chart still opens correctly', !doc.getElementById('costBenefitOverlay').classList.contains('hidden'));
    doc.getElementById('costBenefitClose').click();
    await wait(10);

    doc.getElementById('archivedTasksBtn').click();
    await wait(20);
    log('Archived Tasks modal still opens correctly when its button lives in the Tools drawer section',
        !doc.getElementById('archivedTasksOverlay').classList.contains('hidden'));
    doc.getElementById('archivedTasksClose').click();
    await wait(10);

    doc.getElementById('bulkEditBtn').click();
    await wait(20);
    log('Bulk Edit still opens correctly', !doc.getElementById('bulkEditOverlay').classList.contains('hidden'));
    doc.getElementById('bulkEditClose').click();
    await wait(10);

    doc.getElementById('taskTypesBtn').click();
    await wait(20);
    log('Task Types still opens correctly', !doc.getElementById('taskTypesOverlay').classList.contains('hidden'));
    doc.getElementById('taskTypesDoneBtn').click();
    await wait(10);

    doc.getElementById('releasesBtn').click();
    await wait(20);
    log('Releases still opens correctly', !doc.getElementById('releasesOverlay').classList.contains('hidden'));
    doc.getElementById('releasesModalClose').click();
    await wait(10);

    doc.getElementById('timelineBtn').click();
    await wait(20);
    log('Timeline still opens correctly', !doc.getElementById('timelineOverlay').classList.contains('hidden'));
    doc.getElementById('timelineClose').click();
    await wait(10);
  }

  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    doc.getElementById('mobileMenuBtn').click();
    await wait(10);
    log('drawer is open', doc.getElementById('headerControls').classList.contains('open'));
    doc.getElementById('depMapBtn').click();
    await wait(20);
    log('clicking a relocated Views button auto-closes the drawer', !doc.getElementById('headerControls').classList.contains('open'));
    log('...while still opening the Dependency Map modal underneath', !doc.getElementById('depMapOverlay').classList.contains('hidden'));
    doc.getElementById('depMapClose').click();
    await wait(10);

    doc.getElementById('mobileMenuBtn').click();
    await wait(10);
    doc.getElementById('bulkEditBtn').click();
    await wait(20);
    log('clicking a relocated Tools button also auto-closes the drawer', !doc.getElementById('headerControls').classList.contains('open'));
    doc.getElementById('bulkEditClose').click();
    await wait(10);
  }

  {
    const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
    await wait(300);
    const doc = dom.window.document;
    log('archived badge starts hidden (nothing archived)', doc.getElementById('archivedCountBadge').classList.contains('kf-vis-hidden'));

    const card = doc.querySelector('.kf-card');
    card.click();
    await wait(10);
    doc.getElementById('taskArchivedCheckbox').checked = true;
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
    log('archived badge updates to show count even while relocated to the Tools drawer section',
        !doc.getElementById('archivedCountBadge').classList.contains('kf-vis-hidden') && doc.getElementById('archivedCountBadge').textContent === '1',
        doc.getElementById('archivedCountBadge').textContent);
  }

  console.log('\nView-buttons relocation (Views/Tools swap) test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
