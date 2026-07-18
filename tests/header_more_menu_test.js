const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
const DAY = 24*60*60*1000;

function baseProject(overrides){
  const now = Date.now();
  return Object.assign({
    id: 'p1', name: 'Fixture', key: 'FIX', taskCounter: 100,
    columns: [{ id: 'col_todo', name: 'To Do', done: false, order: [] }],
    tasks: {}, members: [], releases: [], taskTypes: [],
    documents: [], docCounter: 1, risks: [], riskCounter: 1, decisions: [], decCounter: 1,
    principles: [], prinCounter: 1, objectives: [], objCounter: 1,
    teamsCommittees: [], tcCounter: 1,
    approvers: [], roles: [],
    headerButtonVisibility: { documents: true, risks: true, decisions: true, health: true, principles: true, objectives: true, teamsCommittees: true },
    startDate: null, endDate: null,
    dateCreated: new Date(now - 100*DAY).toISOString(), dateLastModified: new Date().toISOString(), dateLastExported: null
  }, overrides || {});
}
function dbWith(project){
  return JSON.stringify({ projects: { p1: project }, projectOrder: ['p1'], currentProjectId: 'p1' });
}
function loadFixture(project){
  return new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_v1_db', dbWith(project)); }
  });
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra!==undefined?' :: '+extra:'')); }

  {
    const dom = loadFixture(baseProject());
    await wait(300);
    const doc = dom.window.document;
    const outer = Array.from(doc.getElementById('healthBtn').parentElement.children).map(el => el.id);
    log('Health Dashboard comes before the movable nav group', outer.indexOf('healthBtn') < outer.indexOf('headerMovableGroup'), outer.join(','));

    doc.getElementById('appSettingsBtn').click();
    await wait(20);
    // App Settings was later restructured into categorized ".kf-setting-row" rows — the old
    // ".kf-risk-doc-picker-row" class this looked for doesn't exist anymore. Not every row is a
    // plain checkbox toggle either (e.g. "Authentication and Provisioning" links out to SSO/SAML/
    // SCIM config instead), so rows with no <input> are filtered out rather than assumed away.
    const rowIds = Array.from(doc.querySelectorAll('#appSettingsOverlay .kf-setting-row'))
      .map(r => r.querySelector('input'))
      .filter(Boolean)
      .map(input => input.id);
    log('App Settings is ordered Health Dashboard first, matching the header',
        rowIds[0] === 'settingsShowHealthBtn', rowIds.join(','));
  }

  {
    const project = baseProject({ headerButtonVisibility: { documents: true, risks: true, decisions: false, health: true, principles: false, objectives: false, teamsCommittees: false } });
    const dom = loadFixture(project);
    await wait(300);
    const doc = dom.window.document;
    log('with only 2 of 6 movable modules enabled, the More menu is NOT active', doc.getElementById('headerMoreWrap').classList.contains('hidden'));
    log('Documents shows as its own standalone button', !doc.getElementById('documentsBtn').classList.contains('hidden'));
    log('Risks shows as its own standalone button', !doc.getElementById('risksBtn').classList.contains('hidden'));
    log('Decisions (disabled) is correctly hidden, not via More but via its own setting', doc.getElementById('decisionsBtn').classList.contains('hidden'));
  }

  {
    const project = baseProject({ headerButtonVisibility: { documents: true, risks: true, decisions: true, health: true, principles: false, objectives: false, teamsCommittees: false } });
    const dom = loadFixture(project);
    await wait(300);
    const doc = dom.window.document;
    log('with exactly 3 of 6 enabled, the More menu activates (3 meets the ">= 3" threshold)', !doc.getElementById('headerMoreWrap').classList.contains('hidden'));
    log('Documents is visually tucked into More on desktop (kf-header-consolidated, not .hidden)', doc.getElementById('documentsBtn').classList.contains('kf-header-consolidated'));
    log('Documents is still NOT .hidden (it\u2019s enabled — consolidation is a separate, desktop-only signal from feature visibility)', !doc.getElementById('documentsBtn').classList.contains('hidden'));
    log('Risks is also tucked into More via the same desktop-only class', doc.getElementById('risksBtn').classList.contains('kf-header-consolidated'));

    const links = Array.from(doc.querySelectorAll('#headerMorePanel .kf-header-more-link')).map(a => a.textContent);
    log('More panel contains exactly the 3 enabled items, by name', links.length === 3 && links.includes('Documents') && links.includes('Risks') && links.includes('Decisions'), links.join(','));
    log('More panel correctly excludes the disabled ones (Principles/Objectives/Teams & Committees)',
        !links.includes('Principles') && !links.includes('Objectives') && !links.includes('Teams & Committees'));

    doc.getElementById('headerMoreBtn').click();
    await wait(10);
    log('clicking "More..." opens the dropdown panel', !doc.getElementById('headerMorePanel').classList.contains('hidden'));
    const docsLink = Array.from(doc.querySelectorAll('.kf-header-more-link')).find(a => a.textContent === 'Documents');
    docsLink.click();
    await wait(20);
    log('clicking the "Documents" text link in the More panel actually opens the Documents modal', !doc.getElementById('documentsOverlay').classList.contains('hidden'));
    log('the More panel closes after the click', doc.getElementById('headerMorePanel').classList.contains('hidden'));
  }

  {
    const dom = loadFixture(baseProject());
    await wait(300);
    const doc = dom.window.document;
    log('with all 6 enabled, More menu is active', !doc.getElementById('headerMoreWrap').classList.contains('hidden'));
    const links = Array.from(doc.querySelectorAll('#headerMorePanel .kf-header-more-link')).map(a => a.textContent);
    log('all 6 movable items appear in the More panel', links.length === 6, links.join(','));
    const expected = ['Principles', 'Objectives', 'Documents', 'Risks', 'Decisions', 'Teams & Committees'];
    log('More panel lists items in the documented order', JSON.stringify(links) === JSON.stringify(expected), links.join(','));

    // The mobile menu has no collapsible sub-menu at all: every enabled
    // item is the same real, directly-clickable button, regardless of
    // how many are enabled or whether desktop is consolidating them.
    const allSixStillInDom = ['principlesBtn','objectivesBtn','documentsBtn','risksBtn','decisionsBtn','teamsCommitteesBtn']
      .every(id => !!doc.getElementById(id));
    log('all 6 items remain real, directly-clickable buttons (no separate mobile link list)', allSixStillInDom);
    log('there is no collapsible "More" toggle or list anywhere in the DOM anymore', !doc.getElementById('drawerMoreToggle') && !doc.getElementById('drawerMoreList'));

    doc.getElementById('mobileMenuBtn').click();
    await wait(10);
    doc.getElementById('risksBtn').click();
    await wait(20);
    log('clicking "Risks" directly in the mobile menu opens the real Risks modal', !doc.getElementById('risksOverlay').classList.contains('hidden'));
    log('it also closes the mobile drawer (via the existing generic "any button closes the drawer" behavior)', !doc.getElementById('headerControls').classList.contains('open'));
  }

  {
    const project = baseProject({ headerButtonVisibility: { documents: true, risks: false, decisions: false, health: true, principles: false, objectives: false, teamsCommittees: false } });
    const dom = loadFixture(project);
    await wait(300);
    const doc = dom.window.document;
    log('with only 1 of 6 enabled, Documents is NOT consolidated (mobile never consolidates, and 1 < 3 anyway on desktop)',
        !doc.getElementById('documentsBtn').classList.contains('kf-header-consolidated'));
    log('on desktop with only 1 enabled, the More menu is NOT used (below the 3+ threshold) \u2014 Documents shows standalone instead',
        doc.getElementById('headerMoreWrap').classList.contains('hidden') && !doc.getElementById('documentsBtn').classList.contains('hidden'));
  }

  {
    const richProject = baseProject(); // all 6 enabled -> desktop consolidates, mobile must NOT
    const dom = loadFixture(richProject);
    await wait(300);
    const doc = dom.window.document;
    log('even with all 6 enabled (desktop consolidating), none of the 6 carry the plain .hidden class — only the desktop-only consolidation class',
        ['principlesBtn','objectivesBtn','documentsBtn','risksBtn','decisionsBtn','teamsCommitteesBtn']
          .every(id => !doc.getElementById(id).classList.contains('hidden')));
  }

  {
    const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
    // build.js minifies the inlined CSS (strips spaces around ':' and before '('), so this can't be
    // a literal substring search — style.indexOf() silently returning -1 here made style.slice(-1)
    // return just the stylesheet's LAST CHARACTER (not "nothing found"), breaking every check below.
    const mediaStartMatch = style.match(/@media\s*\(\s*max-width:\s*1024px\s*\)/);
    const mediaStart = mediaStartMatch ? mediaStartMatch.index : -1;
    const mobileBlock = mediaStart !== -1 ? style.slice(mediaStart) : '';
    // The minifier also merges multiple selectors sharing identical declarations into one
    // comma-separated group (".kf-header-consolidated,.some-other-class{display:none}"), so
    // ".kf-header-consolidated" is not always immediately followed by "{" — only by "," or "{".
    log('mobile CSS restores consolidated items back to visible (display:flex), so the mobile menu always shows everything flat',
        /\.kf-header-consolidated[,{][^{]*\{display:\s*flex/.test(mobileBlock));
    // The minifier also drops the trailing ';' before a rule's closing '}' when it's the last (only)
    // declaration — ".kf-header-consolidated{display:none}" with no semicolon is equally valid.
    const consolidatedDefaultMatch = style.match(/\.kf-header-consolidated[,{][^{]*\{display:none;?[^}]*\}/);
    log('the consolidation class is display:none by default, BEFORE the media query (correct source order)',
        !!consolidatedDefaultMatch && consolidatedDefaultMatch.index < mediaStart);
    log('mobile CSS forces the desktop More wrap to display:none too (the dropdown mechanism is desktop-only)', /\.kf-header-more-wrap\{[^}]*display:\s*none/.test(mobileBlock));
    log('mobile CSS strips ALL header buttons\u2019 border (general simplification, not just Health Dashboard)',
        /\.kf-header-controls \.kf-header-btn\{border:\s*none/.test(mobileBlock));
  }

  console.log('\nHeader More menu test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
