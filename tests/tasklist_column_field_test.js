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

  doc.getElementById('taskListBtn').click();
  await wait(20);

  const headerCells = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell'));
  const headerLabels = headerCells.map(c => c.textContent.replace(/[↑↓]/g, '').trim());
  const titleIdx = headerLabels.indexOf('Title');
  const columnIdx = headerLabels.indexOf('Column');
  const assigneeIdx = headerLabels.indexOf('Assignee');
  log('a "Column" header exists', columnIdx !== -1, headerLabels.join(','));
  log('Column header appears immediately after Title', columnIdx === titleIdx + 1, headerLabels.join(','));
  log('Column header appears immediately before Assignee', assigneeIdx === columnIdx + 1, headerLabels.join(','));

  const row = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Create project board') !== -1);
  const columnCell = row.querySelector('.kf-tasklist-column');
  log('row shows a Column cell', !!columnCell);
  log('Column cell shows the correct column name for that task (seeded into Done)', columnCell.textContent.trim() === 'Done', columnCell.textContent);

  const rowCells = Array.from(row.children);
  const titleCellIdx = rowCells.findIndex(c => c.classList.contains('kf-tasklist-title'));
  const columnCellIdx = rowCells.findIndex(c => c.classList.contains('kf-tasklist-column'));
  const assigneeCellIdx = rowCells.findIndex(c => c.classList.contains('kf-tasklist-assignee'));
  log('in the actual row markup, Column sits between Title and Assignee', columnCellIdx === titleCellIdx + 1 && assigneeCellIdx === columnCellIdx + 1,
      `title=${titleCellIdx} column=${columnCellIdx} assignee=${assigneeCellIdx}`);

  const backlogRow = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Look at Project and App Settings') !== -1);
  const inProgressRow = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Set up Team members for this project') !== -1);
  log('a Backlog task shows "Backlog"', backlogRow.querySelector('.kf-tasklist-column').textContent.trim() === 'Backlog');
  log('an In Progress task shows "In Progress"', inProgressRow.querySelector('.kf-tasklist-column').textContent.trim() === 'In Progress');

  const columnHeaderCell = headerCells[columnIdx];
  columnHeaderCell.click();
  await wait(10);
  let visibleColumns = Array.from(doc.querySelectorAll('.kf-tasklist-row')).map(r => r.querySelector('.kf-tasklist-column').textContent.trim());
  log('sorting by Column (ascending) follows board order: Backlog, To Do, To Do, In Progress, Done',
      JSON.stringify(visibleColumns) === JSON.stringify(['Backlog','To Do','To Do','In Progress','Done']), visibleColumns.join(','));

  columnHeaderCell.click();
  await wait(10);
  visibleColumns = Array.from(doc.querySelectorAll('.kf-tasklist-row')).map(r => r.querySelector('.kf-tasklist-column').textContent.trim());
  log('sorting by Column descending reverses the board order', JSON.stringify(visibleColumns) === JSON.stringify(['Done','In Progress','To Do','To Do','Backlog']), visibleColumns.join(','));

  log('Column header shows a sort indicator once it is the active sort field',
      (() => {
        const freshColumnHeaderCell = Array.from(doc.querySelectorAll('.kf-tasklist-header-cell')).find(c => c.textContent.indexOf('Column') !== -1);
        return freshColumnHeaderCell.textContent.indexOf('↓') !== -1 || freshColumnHeaderCell.textContent.indexOf('↑') !== -1;
      })());

  const keyHeaderCell = headerCells.find(c => c.textContent.indexOf('Key') !== -1);
  keyHeaderCell.click();
  await wait(10);

  doc.getElementById('taskListClose').click();
  await wait(10);
  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Create project board') !== -1);
  card.click();
  await wait(10);
  const colSelect = doc.getElementById('taskColumnSelect');
  const todoOpt = Array.from(colSelect.options).find(o => o.textContent === 'To Do');
  colSelect.value = todoOpt.value;
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  doc.getElementById('taskListBtn').click();
  await wait(20);
  const movedRow = Array.from(doc.querySelectorAll('.kf-tasklist-row')).find(r => r.textContent.indexOf('Create project board') !== -1);
  log('after moving a task to a different column, the List View reflects the new column', movedRow.querySelector('.kf-tasklist-column').textContent.trim() === 'To Do',
      movedRow.querySelector('.kf-tasklist-column').textContent);

  doc.getElementById('taskListClose').click();
  await wait(10);

  console.log('\nTask List Column field test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
