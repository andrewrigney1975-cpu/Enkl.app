const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

/* Black-box, driving the BUILT dist/index.html (see CLAUDE.md §10) — no live backend, so window.fetch
   is stubbed to answer chat-shaped requests from an in-memory fake, same convention
   change_auditing_confirm_test.js established for a server-authoritative-only feature. SSE-dependent
   behavior (live message arrival, presence) isn't exercised here — verified live against the
   docker-hosted stack instead (see this session's own curl-based verification pass). */

function makeFakeJwt(payload){
  var body = Object.assign({sub: 'user-me', displayName: 'Me', orgId: 'org-1', orgAdmin: 'false'}, payload);
  var b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'header.' + b64 + '.signature';
}

function makeChatBackend(){
  var channels = [];
  var messagesByChannel = {};
  var nextId = 1;

  function newId(prefix){ return prefix + '-' + (nextId++); }

  var orgUsers = [
    {id: 'user-me', displayName: 'Me', isOnline: true},
    {id: 'user-bob', displayName: 'Bob Smith', isOnline: false},
    {id: 'user-carol', displayName: 'Carol Jones', isOnline: true}
  ];

  return {
    orgUsers: orgUsers,
    channels: channels,
    messagesByChannel: messagesByChannel,
    handle: function(url, options){
      var method = (options && options.method) || 'GET';
      var body = options && options.body ? JSON.parse(options.body) : null;

      // Not chat-related — app.js's init() also pulls server projects on login; answered benignly
      // here purely to keep the test's console output free of an unrelated, expected 404's noise.
      if(url === '/api/projects') return {status: 200, json: []};

      if(url === '/api/chat/org-users') return {status: 200, json: orgUsers};

      if(url === '/api/chat/channels' && method === 'GET'){
        var mine = channels.filter(function(c){ return c.members.some(function(m){ return m.userId === 'user-me'; }); });
        return {status: 200, json: {channels: mine, adminVisibleChannels: []}};
      }
      if(url === '/api/chat/channels' && method === 'POST'){
        var memberIds = (body.memberUserIds || []).concat(['user-me']);
        var uniqueIds = memberIds.filter(function(id, i){ return memberIds.indexOf(id) === i; });
        var members = uniqueIds.map(function(id){
          var u = orgUsers.find(function(x){ return x.id === id; }) || {id: id, displayName: id, isOnline: false};
          return {userId: u.id, displayName: u.displayName, isOnline: u.isOnline};
        });
        var channel = {id: newId('ch'), name: body.isDirectMessage ? null : body.name, isDirectMessage: !!body.isDirectMessage, dateCreated: new Date().toISOString(), members: members};
        channels.push(channel);
        messagesByChannel[channel.id] = [];
        return {status: 200, json: channel};
      }

      var msgMatch = url.match(/^\/api\/chat\/channels\/([^/]+)\/messages(\/([^/?]+))?/);
      if(msgMatch){
        var channelId = msgMatch[1];
        var messageId = msgMatch[3];
        var list = messagesByChannel[channelId] || [];

        if(method === 'GET'){
          return {status: 200, json: {messages: list, nextCursor: null}};
        }
        if(method === 'POST' && !messageId){
          var mentioned = orgUsers.filter(function(u){ return u.id !== 'user-me' && body.text.indexOf('@' + u.displayName) !== -1; }).map(function(u){ return u.id; });
          var message = {
            id: newId('msg'), channelId: channelId, authorUserId: 'user-me', authorName: 'Me',
            text: body.text, dateCreated: new Date().toISOString(), isDeleted: false, dateDeleted: null,
            mentionedUserIds: mentioned
          };
          list.push(message);
          return {status: 200, json: message};
        }
        if(method === 'PUT' && messageId){
          var m = list.find(function(x){ return x.id === messageId; });
          if(!m) return {status: 404, json: {message: 'Not found.'}};
          m.text = body.text;
          return {status: 200, json: m};
        }
        if(method === 'DELETE' && messageId){
          var d = list.find(function(x){ return x.id === messageId; });
          if(!d) return {status: 404, json: {message: 'Not found.'}};
          d.isDeleted = true;
          d.dateDeleted = new Date().toISOString();
          return {status: 200, json: d};
        }
      }

      return {status: 404, json: {message: 'Not found (unhandled in test fake): ' + method + ' ' + url}};
    }
  };
}

(async () => {
  function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra !== undefined ? ' :: ' + extra : '')); }

  /* ---- Bubble hidden when not logged in ---- */
  const domAnon = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true });
  await wait(400);
  log('chat bubble hidden for a not-logged-in session', domAnon.window.document.getElementById('chatBubbleBtn').classList.contains('kf-vis-hidden'));

  /* ---- Logged-in session, fake chat backend ---- */
  const backend = makeChatBackend();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/', pretendToBeVisual: true,
    beforeParse(w){ w.localStorage.setItem('kanbanflow_server_jwt', makeFakeJwt({})); }
  });
  dom.window.fetch = async function(url, options){
    var result = backend.handle(url, options);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async function(){ return result.json; }
    };
  };
  await wait(500);
  const doc = dom.window.document;

  log('chat bubble visible for a logged-in session', !doc.getElementById('chatBubbleBtn').classList.contains('kf-vis-hidden'));
  // Checks the actual computed style, not just class presence — this app has no generic
  // ".hidden { display:none }" utility (every component needs its own compound selector, see
  // CLAUDE.md), so a missing ".kf-chat-panel.hidden" rule previously left the panel visible-but-
  // empty from page load despite the "hidden" class already being present. Class-only assertions
  // below wouldn't have caught that; this one specifically would.
  log('panel is not actually rendered before ever being opened', dom.window.getComputedStyle(doc.getElementById('chatPanel')).display === 'none');

  doc.getElementById('chatBubbleBtn').click();
  await wait(50);
  log('panel opens on bubble click', !doc.getElementById('chatPanel').classList.contains('hidden'));
  log('panel is actually rendered once opened (not just class-toggled)', dom.window.getComputedStyle(doc.getElementById('chatPanel')).display !== 'none');
  log('channel list shows empty state with no channels yet', doc.getElementById('chatPanelBody').textContent.indexOf('No conversations yet') !== -1);

  /* ---- Create a group channel with Bob and Carol ---- */
  doc.getElementById('chatNewChannelBtn').click();
  await wait(20);
  doc.getElementById('chatNewChannelNameInput').value = 'General';
  var checkboxes = Array.from(doc.querySelectorAll('input[name="chatNewChatUser"]'));
  var bobCheckbox = checkboxes.find(function(c){ return c.value === 'user-bob'; });
  bobCheckbox.checked = true;
  bobCheckbox.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  doc.getElementById('chatCreateChatBtn').click();
  await wait(50);

  log('creating a channel navigates straight into its thread view', doc.getElementById('chatPanelTitle').textContent === 'General');
  log('back button visible inside a thread', !doc.getElementById('chatBackBtn').classList.contains('kf-vis-hidden'));

  /* ---- Send a message with a mention ---- */
  var compose = doc.getElementById('chatComposeInput');
  compose.value = 'Hey @Bob Smith, welcome!';
  doc.getElementById('chatSendBtn').click();
  await wait(50);

  log('sent message appears in the thread', doc.getElementById('chatPanelBody').textContent.indexOf('welcome!') !== -1);
  log('mention is rendered with the highlight span', !!doc.querySelector('.kf-chat-mention'));
  log('compose box clears after sending', doc.getElementById('chatComposeInput').value === '');

  /* ---- @mention autocomplete: typing "@" offers channel members ---- */
  var input2 = doc.getElementById('chatComposeInput');
  input2.value = '@Bob';
  input2.selectionStart = input2.selectionEnd = input2.value.length;
  input2.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  await wait(10);
  var dropdown = doc.getElementById('chatMentionDropdown');
  log('mention dropdown opens on "@Bob" and offers Bob Smith', !dropdown.classList.contains('hidden') && dropdown.textContent.indexOf('Bob Smith') !== -1, dropdown.textContent);

  input2.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}));
  await wait(10);
  log('accepting via Tab completes "@Bob" to the full "@Bob Smith " mention token with a trailing space', input2.value === '@Bob Smith ', JSON.stringify(input2.value));
  log('mention dropdown closes after accepting', doc.getElementById('chatMentionDropdown').classList.contains('hidden'));
  input2.value = '';

  /* ---- Edit the message ---- */
  var editBtn = doc.querySelector('[data-action="edit"]');
  editBtn.click();
  await wait(10);
  log('editing prefills the compose box with the original text', doc.getElementById('chatComposeInput').value.indexOf('welcome!') !== -1);
  doc.getElementById('chatComposeInput').value = 'Hey @Bob Smith, welcome aboard!';
  doc.getElementById('chatSendBtn').click();
  await wait(50);
  log('edited text is reflected in the thread', doc.getElementById('chatPanelBody').textContent.indexOf('welcome aboard!') !== -1);

  /* ---- Delete the message: soft-delete placeholder ---- */
  var deleteBtn = doc.querySelector('[data-action="delete"]');
  deleteBtn.click();
  await wait(10);
  doc.getElementById('confirmOkBtn').click();
  await wait(50);
  log('deleted message shows the placeholder text, not the original', doc.getElementById('chatPanelBody').textContent.indexOf('Message deleted') !== -1 && doc.getElementById('chatPanelBody').textContent.indexOf('welcome aboard!') === -1);
  log('deleted message shows the deleted icon', !!doc.querySelector('.kf-chat-deleted-icon'));

  /* ---- Export ---- */
  const OrigBlob = dom.window.Blob;
  var lastBlobText = null;
  dom.window.Blob = function(parts, opts){ lastBlobText = parts[0]; return new OrigBlob(parts, opts); };
  dom.window.URL.createObjectURL = function(){ return 'blob://fake'; };
  dom.window.URL.revokeObjectURL = function(){};
  doc.getElementById('chatExportBtn').click();
  await wait(10);
  log('export produces a real text blob containing the conversation', !!lastBlobText && lastBlobText.indexOf('Me:') !== -1, lastBlobText && lastBlobText.slice(0, 80));

  /* ---- Back navigation ---- */
  doc.getElementById('chatBackBtn').click();
  await wait(20);
  log('back button returns to the channel list', doc.getElementById('chatPanelTitle').textContent === 'Chat');
  log('the created channel now appears in the channel list', doc.getElementById('chatPanelBody').textContent.indexOf('General') !== -1);

  /* ---- Close ---- */
  doc.getElementById('chatCloseBtn').click();
  await wait(10);
  log('close button hides the panel', doc.getElementById('chatPanel').classList.contains('hidden'));
  log('close button actually hides the panel (computed style, not just the class)', dom.window.getComputedStyle(doc.getElementById('chatPanel')).display === 'none');

  console.log('\nChat test complete.');
  process.exit(0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
