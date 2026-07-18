const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers the board toolbar's "Search tasks..." box: the clear ("x") button appears once there's a
   value and actually clears the search + re-shows every task, and the "#" hashtag intellisense
   dropdown (features/hashtags.js) offers the project's existing tags when the WHOLE search term
   starts with "#" — Tab accepts the highlighted suggestion into the search box (filtering the board
   for real, since a hashtag is just "#name" text inside a task's stored description), and Escape
   closes the dropdown without changing the input. */

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  function visibleCardTitles(){
    return Array.from(doc.querySelectorAll('.kf-card')).map(c => c.textContent);
  }
  async function addTask(title, setDescription){
    doc.querySelectorAll('.kf-add-task-btn')[0].click();
    await wait(20);
    doc.getElementById('taskTitleInput').value = title;
    if(setDescription) setDescription(doc.getElementById('taskDescEditor'));
    doc.getElementById('taskSaveBtn').click();
    await wait(20);
  }

  // Seed a task tagged "#urgent" so there's an existing project hashtag to suggest.
  await addTask('Tagged task', el => { el.textContent = 'Ship this #urgent'; });
  await addTask('Plain task', null);

  const searchInput = doc.getElementById('searchInput');
  const clearBtn = doc.getElementById('searchClearBtn');
  const panel = doc.getElementById('searchHashtagPanel');

  // ── 1. Clear button starts hidden, appears once typing, disappears once cleared ──
  log('clear button starts hidden (empty search box)', clearBtn.classList.contains('kf-vis-hidden'));

  searchInput.value = 'Plain';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('clear button appears once there is a search term', !clearBtn.classList.contains('kf-vis-hidden'));
  log('typing a plain term filters the board to matching tasks only', JSON.stringify(visibleCardTitles().some(t => t.indexOf('Plain task') !== -1)) === 'true' && !visibleCardTitles().some(t => t.indexOf('Tagged task') !== -1));

  clearBtn.click();
  await wait(10);
  log('clicking clear empties the search box', searchInput.value === '');
  log('clicking clear hides the clear button again', clearBtn.classList.contains('kf-vis-hidden'));
  log('clicking clear re-shows every task', visibleCardTitles().some(t => t.indexOf('Plain task') !== -1) && visibleCardTitles().some(t => t.indexOf('Tagged task') !== -1));

  // ── 2. Typing "#" opens the hashtag dropdown with the existing project tag ──
  searchInput.value = '#';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('dropdown opens on a bare "#"', !panel.classList.contains('hidden'));
  log('dropdown offers the existing "#urgent" tag', panel.textContent.indexOf('#urgent') !== -1, panel.textContent);

  // ── 3. Tab accepts the highlighted suggestion and filters the board for real ──
  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await wait(10);
  log('Tab fills the search box with the accepted tag', searchInput.value === '#urgent', searchInput.value);
  log('dropdown closes after accepting', panel.classList.contains('hidden'));
  log('accepting the tag actually filters the board to the tagged task only', visibleCardTitles().some(t => t.indexOf('Tagged task') !== -1) && !visibleCardTitles().some(t => t.indexOf('Plain task') !== -1), JSON.stringify(visibleCardTitles()));

  clearBtn.click();
  await wait(10);

  // ── 4. A "#" followed by a non-matching prefix closes the dropdown (nothing to suggest) ──
  searchInput.value = '#nomatch';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('no suggestions for a prefix that matches nothing stays closed', panel.classList.contains('hidden'));

  clearBtn.click();
  await wait(10);

  // ── 5. A search term merely CONTAINING "#" (not starting with it) never opens the dropdown ──
  searchInput.value = 'release #urgent';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('a "#" that does not start the search term does not open the dropdown', panel.classList.contains('hidden'));

  clearBtn.click();
  await wait(10);

  // ── 6. Escape closes the dropdown without touching the input text ──
  searchInput.value = '#urg';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(10);
  log('dropdown is open before Escape', !panel.classList.contains('hidden'));
  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(10);
  log('Escape closes the dropdown', panel.classList.contains('hidden'));
  log('Escape does not modify the search text', searchInput.value === '#urg', searchInput.value);

  console.log('\nBoard search test complete.');
  process.exit(0);
})().catch(e => {
  console.error('BOARD SEARCH TEST CRASHED:', e);
  process.exit(1);
});
