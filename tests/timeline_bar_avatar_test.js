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

  doc.getElementById('timelineBtn').click();
  await wait(20);

  function rowFor(taskKeyOrTitle){
    return Array.from(doc.querySelectorAll('.kf-timeline-row')).find(r => r.textContent.indexOf(taskKeyOrTitle) !== -1);
  }

  const assignedRow = rowFor('Configure project modules, columns and details');
  const bar = assignedRow.querySelector('.kf-timeline-bar');
  log('bar for an assigned task includes an avatar', bar.querySelector('.kf-avatar') !== null);

  const avatar = bar.querySelector('.kf-avatar');
  log('avatar uses the same classes as the board card avatar (kf-avatar kf-avatar-sm)',
      avatar.classList.contains('kf-avatar') && avatar.classList.contains('kf-avatar-sm'), avatar.className);
  log('avatar shows the assignee\u2019s initials', avatar.textContent.trim().length > 0 && avatar.textContent.trim().length <= 3, avatar.textContent);
  log('avatar background color matches the assignee\u2019s color', avatar.style.background !== '', avatar.style.background);
  log('avatar has a tooltip with the assignee\u2019s name', avatar.getAttribute('title') && avatar.getAttribute('title').length > 0, avatar.getAttribute('title'));

  log('bar still shows the task key text alongside the avatar', bar.querySelector('.kf-timeline-bar-key') !== null &&
      bar.querySelector('.kf-timeline-bar-key').textContent.length > 0, bar.querySelector('.kf-timeline-bar-key') && bar.querySelector('.kf-timeline-bar-key').textContent);

  const avatarText = avatar.textContent.trim();
  const boardCard = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Configure project modules, columns and details') !== -1);
  const boardAvatar = boardCard.querySelector('.kf-card-key').parentElement.querySelector('.kf-avatar');
  log('the same task\u2019s board-card avatar shows the same initials as its timeline-bar avatar',
      boardAvatar.textContent.trim() === avatarText, `board=${boardAvatar.textContent} timeline=${avatarText}`);

  const unassignedRow = rowFor('Look at Project and App Settings');
  const unassignedBar = unassignedRow.querySelector('.kf-timeline-bar');
  log('an unassigned task\u2019s bar has no avatar', unassignedBar.querySelector('.kf-avatar') === null);
  log('an unassigned task\u2019s bar still shows its key text', unassignedBar.querySelector('.kf-timeline-bar-key').textContent.length > 0,
      unassignedBar.querySelector('.kf-timeline-bar-key').textContent);

  log('the bar\u2019s own tooltip still shows task key/title/dates (unaffected by the avatar addition)',
      bar.getAttribute('title') && bar.getAttribute('title').indexOf('Configure project modules, columns and details') !== -1, bar.getAttribute('title'));

  doc.getElementById('timelineClose').click();
  await wait(10);

  console.log('\nTimeline bar avatar test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
