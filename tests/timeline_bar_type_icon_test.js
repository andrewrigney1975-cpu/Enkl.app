const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

function rowForType(doc, typeName){
  return Array.from(doc.querySelectorAll('#taskTypeList .kf-member-row')).find(r => r.querySelector('.kf-member-name-input').value === typeName);
}
function assignIconViaPicker(doc, typeName, iconLabel){
  const row = rowForType(doc, typeName);
  row.querySelector('.kf-tasktype-icon-trigger').click();
  const opt = Array.from(row.querySelectorAll('.kf-tasktype-icon-option')).find(o => o.getAttribute('title') === iconLabel);
  opt.click();
}
function setTaskType(doc, taskTitle, typeName){
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf(taskTitle) !== -1);
  card.click();
  const opt = Array.from(doc.getElementById('taskTypeSelect').options).find(o => o.textContent === typeName);
  doc.getElementById('taskTypeSelect').value = opt ? opt.value : '';
  doc.getElementById('taskSaveBtn').click();
}

(async () => {
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

  doc.getElementById('taskTypesBtn').click();
  await wait(20);
  doc.getElementById('newTaskTypeNameInput').value = 'Chore';
  doc.getElementById('addTaskTypeBtn').click();
  await wait(10);
  assignIconViaPicker(doc, 'Feature', 'Investigate');
  await wait(10);
  doc.getElementById('taskTypesDoneBtn').click();
  await wait(10);

  setTaskType(doc, 'Configure project modules, columns and details', 'Feature');
  await wait(20);
  setTaskType(doc, 'Draft project objectives', 'Chore');
  await wait(20);

  doc.getElementById('timelineBtn').click();
  await wait(20);

  function rowFor(taskKeyOrTitle){
    return Array.from(doc.querySelectorAll('.kf-timeline-row')).find(r => r.textContent.indexOf(taskKeyOrTitle) !== -1);
  }

  const featureBar = rowFor('Configure project modules, columns and details').querySelector('.kf-timeline-bar');
  const typeIcon = featureBar.querySelector('.kf-timeline-bar-type-icon');
  log('a task whose type has an icon assigned shows the type icon on its bar', typeIcon !== null);
  log('type icon shows the correct tooltip (the type\u2019s name)', typeIcon && typeIcon.getAttribute('title') === 'Feature', typeIcon && typeIcon.getAttribute('title'));

  const choreBar = rowFor('Draft project objectives').querySelector('.kf-timeline-bar');
  log('a task whose type has NO icon assigned shows nothing, even though it has a type', choreBar.querySelector('.kf-timeline-bar-type-icon') === null);

  const noTypeBar = rowFor('Look at Project and App Settings').querySelector('.kf-timeline-bar');
  log('a task with no type at all shows nothing either', noTypeBar.querySelector('.kf-timeline-bar-type-icon') === null);

  log('type icon sits at the right-hand end of the bar (last child, pushed via margin-left:auto)',
      featureBar.lastElementChild === typeIcon);

  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  const rule = (style.match(/\.kf-timeline-bar-type-icon\{([^}]*)\}/) || [])[1] || '';
  log('CSS pushes the type icon to the end via margin-left:auto', /margin-left:\s*auto/.test(rule), rule);

  log('bar still shows the avatar (if assigned) AND the type icon together without conflict',
      featureBar.querySelector('.kf-avatar') !== null && featureBar.querySelector('.kf-timeline-bar-type-icon') !== null);

  doc.getElementById('timelineClose').click();
  await wait(10);

  console.log('\nTimeline bar type icon test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
