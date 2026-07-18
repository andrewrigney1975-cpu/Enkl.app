const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Covers Task Comments (CLAUDE.md's Comments section) for the local-only path (no login concept, so
   no server round trip to mock): sort toggle defaults ASC (oldest first) and flips correctly, and the
   add/edit/delete flow including the local-only "posting as" member-picker (server-authoritative
   auto-stamping via getCurrentUserId() isn't exercisable in this harness — no login flow — same gap
   every other server-path test in this suite already has, see change_auditing_confirm_test.js's own
   note on that). */

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  await wait(300);
  const doc = window.document;
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  // ── Setup: a local-only project needs at least one member before a comment can be "posted as" ──
  doc.getElementById('manageTeamBtn').click();
  await wait(10);
  doc.getElementById('newMemberNameInput').value = 'Alice';
  doc.getElementById('addMemberBtn').click();
  await wait(10);
  doc.getElementById('newMemberNameInput').value = 'Bob';
  doc.getElementById('addMemberBtn').click();
  await wait(10);
  doc.getElementById('teamModalClose').click();

  // ── Create a task, then reopen it (Comments only render for an existing task) ──
  const addTaskBtn = doc.querySelector('.kf-add-task-btn');
  addTaskBtn.click();
  await wait(10);
  doc.getElementById('taskTitleInput').value = 'Comment test task';
  doc.getElementById('taskSaveBtn').click();
  await wait(20);

  const card = Array.from(doc.querySelectorAll('.kf-card')).find(c => c.textContent.indexOf('Comment test task') !== -1);
  card.click();
  await wait(10);

  log('Comments section is visible for an existing task', !doc.getElementById('taskCommentsSection').classList.contains('kf-vis-hidden'));
  log('Comments list starts empty', doc.getElementById('taskCommentsList').textContent.indexOf('No comments yet.') !== -1);
  log('local-only project shows the "posting as" author picker', !doc.getElementById('taskCommentAuthorRow').classList.contains('kf-vis-hidden'));
  log('sort defaults to "Oldest first" (ASC)', doc.getElementById('taskCommentsSortLabel').textContent === 'Oldest first');

  // ── Add two comments as different authors ──
  const authorSelect = doc.getElementById('taskCommentAuthorSelect');
  const aliceOption = Array.from(authorSelect.options).find(o => o.textContent === 'Alice');
  authorSelect.value = aliceOption.value;
  doc.getElementById('taskCommentInput').value = 'First comment';
  doc.getElementById('taskCommentSubmitBtn').click();
  await wait(10);

  const bobOption = Array.from(authorSelect.options).find(o => o.textContent === 'Bob');
  authorSelect.value = bobOption.value;
  doc.getElementById('taskCommentInput').value = 'Second comment';
  doc.getElementById('taskCommentSubmitBtn').click();
  await wait(10);

  let entries = Array.from(doc.querySelectorAll('.kf-comment-entry'));
  log('both comments were added', entries.length === 2, entries.length);
  log('composer clears after adding', doc.getElementById('taskCommentInput').value === '');
  log('button label stays "Add Comment" (not editing)', doc.getElementById('taskCommentSubmitBtn').textContent === 'Add Comment');

  // ── Oldest-first order (default ASC): "First comment" should come before "Second comment" ──
  let texts = entries.map(e => e.querySelector('.kf-comment-entry-text').textContent);
  log('ASC order shows oldest (First comment) before newest (Second comment)', texts[0] === 'First comment' && texts[1] === 'Second comment', texts.join(' | '));

  // ── Toggle sort to DESC (newest first) ──
  doc.getElementById('taskCommentsSortBtn').click();
  await wait(10);
  log('sort label flips to "Newest first"', doc.getElementById('taskCommentsSortLabel').textContent === 'Newest first');
  entries = Array.from(doc.querySelectorAll('.kf-comment-entry'));
  texts = entries.map(e => e.querySelector('.kf-comment-entry-text').textContent);
  log('DESC order shows newest (Second comment) before oldest (First comment)', texts[0] === 'Second comment' && texts[1] === 'First comment', texts.join(' | '));

  // ── Edit the first comment found (currently "Second comment" in DESC order) ──
  let editBtn = entries[0].querySelector('.kf-comment-action-btn[data-action="edit"]');
  editBtn.click();
  await wait(10);
  log('editing pre-fills the textarea', doc.getElementById('taskCommentInput').value === 'Second comment');
  log('button relabels to "Update Comment"', doc.getElementById('taskCommentSubmitBtn').textContent === 'Update Comment');
  log('Cancel button appears while editing', !doc.getElementById('taskCommentCancelEditBtn').classList.contains('kf-vis-hidden'));

  doc.getElementById('taskCommentInput').value = 'Second comment (edited)';
  doc.getElementById('taskCommentSubmitBtn').click();
  await wait(10);
  entries = Array.from(doc.querySelectorAll('.kf-comment-entry'));
  texts = entries.map(e => e.querySelector('.kf-comment-entry-text').textContent);
  log('comment text was updated in place', texts.indexOf('Second comment (edited)') !== -1, texts.join(' | '));
  log('composer resets back to "Add Comment" after update', doc.getElementById('taskCommentSubmitBtn').textContent === 'Add Comment');

  // ── Delete a comment ──
  let raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  let proj = raw.projects[raw.currentProjectId];
  let task = Object.values(proj.tasks).find(t => t.title === 'Comment test task');
  log('both comments persisted to storage before delete', task.comments.length === 2, task.comments.length);

  entries = Array.from(doc.querySelectorAll('.kf-comment-entry'));
  const deleteBtn = entries[0].querySelector('.kf-comment-action-btn[data-action="delete"]');
  deleteBtn.click();
  await wait(10);
  // confirmDialog requires an explicit confirm click, same pattern as deleteTaskFromModal's own test coverage.
  doc.getElementById('confirmOkBtn').click();
  await wait(10);

  entries = Array.from(doc.querySelectorAll('.kf-comment-entry'));
  log('one comment remains after delete', entries.length === 1, entries.length);
  log('comment count badge updates', doc.getElementById('taskCommentsCount').textContent === '(1)', doc.getElementById('taskCommentsCount').textContent);

  raw = JSON.parse(window.localStorage.getItem('kanbanflow_v1_db'));
  proj = raw.projects[raw.currentProjectId];
  task = Object.values(proj.tasks).find(t => t.title === 'Comment test task');
  log('deletion persisted to storage', task.comments.length === 1, task.comments.length);

  // ── Reopening the modal resets the sort order and composer state ──
  doc.getElementById('taskCancelBtn').click();
  await wait(10);
  card.click();
  await wait(10);
  log('reopening the task modal resets sort back to "Oldest first"', doc.getElementById('taskCommentsSortLabel').textContent === 'Oldest first');
  log('reopening the task modal resets the composer button label', doc.getElementById('taskCommentSubmitBtn').textContent === 'Add Comment');

  console.log('\nTask Comments test complete.');
  process.exit(0);
})().catch(e => {
  console.error('TASK COMMENTS TEST CRASHED:', e);
  process.exit(1);
});
