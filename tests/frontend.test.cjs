const { test: nodeTest } = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 5000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const listeners = new Map();
  const calls = [];
  const requests = [];
  const overrides = new Map();
  const clipboard = [];
  let archived = [];
  let input = { value: '' };
  const dock = { set innerHTML(value) { input = { value: '' }; } };
  const context = {
    exports: {}, console: {log() {}, warn() {}, error() {}}, setTimeout, clearTimeout,
    window: { __TAURI_INTERNALS__: {}, addEventListener() {} },
    document: { getElementById(id) {
      return id === 'quickSpeakInput' ? input : id === 'quickSpeakDockContainer' ? dock : null;
    } },
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
  };
  context.require = name => {
    if (name === '@tauri-apps/api/event') return { listen: async (event, handler) => listeners.set(event, handler) };
    if (name === './components/hud') return { renderQuickSpeakDockHtml: () => '' };
    if (name === '@tauri-apps/api/core') return { invoke: async (cmd, args) => {
      calls.push({cmd, args});
      if (overrides.has(cmd)) return overrides.get(cmd)(args);
      if (cmd === 'quick_speak_translate') return new Promise((resolve, reject) => requests.push({resolve, reject}));
      if (cmd === 'archive_subtitles') { archived.push(...args.items); return; }
      if (cmd === 'read_archived_subtitles') return structuredClone(archived);
      if (cmd === 'clear_archived_subtitles') { archived = []; return; }
      if (cmd === 'save_meeting_transcript') return '/tmp/test-meeting.txt';
    } };
    throw Error(`Unexpected module: ${name}`);
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8') + '\nexports.LiveHearApp = LiveHearApp;';
  vm.runInContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, context);
  const App = context.exports.LiveHearApp;
  const initListeners = App.prototype.initTauriListeners;
  for (const name of ['detectPlatform', 'bindGlobalHandlers', 'bindKeyboardShortcuts', 'bindSelectionLookupListener', 'initTauriListeners', 'initialRender', 'loadConfigAndAutoStart']) App.prototype[name] = () => {};
  const app = new App();
  app.showToast = () => {};
  app.refreshTopbarBadges = () => {};
  for (const name of ['finalizeLastCard', 'updateOrAppendPartial', 'refreshDisplayMode', 'clear']) app.streamManager[name] = () => {};
  return { app, calls, requests, clipboard, listeners, overrides, context,
    init: () => initListeners.call(app),
    input: value => value === undefined ? input.value : (input.value = value),
  };
}
const tick = () => new Promise(setImmediate);

function record(i) {
  return {id: String(i), original: `RECORD_${i}_END`, translated: '', speaker:'Speaker 1', timestamp:'10:00', isPartial:false};
}

test('export retains every record beyond the live subtitle cache', async () => {
  const h = harness();
  for (let i = 0; i < 1005; i++) h.app.pushSubtitleWithCap(record(i));
  await h.app.exportMeetingTranscript();
  const output = h.calls.find(c => c.cmd === 'save_meeting_transcript').args.content;
  assert.ok(output.includes('RECORD_0_END'));
  assert.ok(output.includes('RECORD_1004_END'));
  assert.equal((output.match(/RECORD_\d+_END/g) || []).length, 1005);
  assert.ok(h.app.hudState.subtitles.length <= 1000);
});

test('coalesced own-speaker sentences suppress suggestions while others still show', async () => {
  const h = harness();
  h.app.hudState.mySpeakerId = 1;
  await h.init();
  const final = (id, speaker, text) => h.listeners.get('asr-final')({payload:{segment:{id, text, translated_text:text, speaker:{id:speaker,display_name:`Speaker ${speaker}`}, detected_language:'en'}}});
  final('a', 1, 'Can we deploy?');
  final('b', 1, 'Can you confirm?');
  assert.equal(h.app.hudState.subtitles.length, 1);
  let opened = 0;
  h.app.renderSuggestionDrawer = () => opened++;
  h.listeners.get('asr-suggestions')({payload:{segment_id:'b', speaker_id:1, suggestions:[{id:1}]}});
  assert.equal(opened, 0);
  final('c', 2, 'What next?');
  h.listeners.get('asr-suggestions')({payload:{segment_id:'c', speaker_id:2, suggestions:[{id:1}]}});
  assert.equal(opened, 1);
});

test('late quick-speak response cannot replace the latest result or a new draft', async () => {
  const h = harness();
  h.input('first');
  const first = h.app.handleAction('submitQuickSpeakTranslate');
  await tick();
  h.input('second');
  const second = h.app.handleAction('submitQuickSpeakTranslate');
  await tick();
  h.requests[1].resolve({spoken:'SECOND', target_lang:'en'});
  await second;
  h.input('third draft');
  h.requests[0].resolve({spoken:'FIRST', target_lang:'en'});
  await first;
  assert.equal(h.app.hudState.quickSpeakCard.spoken, 'SECOND');
  assert.equal(h.clipboard.at(-1), 'SECOND');
  assert.equal(h.input(), 'third draft');
});

test('quick-speak completion preserves text typed while waiting', async () => {
  const h = harness();
  h.input('first');
  const job = h.app.handleAction('submitQuickSpeakTranslate');
  await tick();
  h.input('next draft');
  h.requests[0].resolve({spoken:'FIRST', target_lang:'en'});
  await job;
  assert.equal(h.input(), 'next draft');
});

for (const mode of ['two_way', 'one_way']) test(`cycling the speak language synchronizes ${mode} ASR`, async () => {
  const h = harness();
  h.app.appConfig.soniox.translation_type = mode;
  h.app.hudState.isStreaming = true;
  const lifecycle = [];
  h.app.stopLiveStream = async save => { lifecycle.push(['stop', save]); h.app.hudState.isStreaming = false; };
  h.app.startLiveStream = async () => { lifecycle.push(['start']); h.app.hudState.isStreaming = true; };
  await h.app.handleAction('cycleSpeakTargetLang');
  assert.equal(h.app.appConfig.soniox.speak_target_language, 'ja');
  assert.deepEqual(lifecycle, mode === 'two_way' ? [['stop', false], ['start']] : []);
});

test('archive failure retains records and a later batch retries without duplication', async () => {
  const h = harness();
  h.overrides.set('archive_subtitles', async () => { throw Error('disk full'); });
  for (let i = 0; i < 1002; i++) h.app.pushSubtitleWithCap(record(i));
  await h.app.exportMeetingTranscript();
  let output = h.calls.filter(c => c.cmd === 'save_meeting_transcript').at(-1).args.content;
  assert.equal((output.match(/RECORD_\d+_END/g) || []).length, 1002);
  h.overrides.delete('archive_subtitles');
  h.app.pushSubtitleWithCap(record(1002));
  await h.app.exportMeetingTranscript();
  output = h.calls.filter(c => c.cmd === 'save_meeting_transcript').at(-1).args.content;
  assert.equal((output.match(/RECORD_\d+_END/g) || []).length, 1003);
  assert.ok(output.includes('RECORD_0_END'));
});

test('clearing subtitles also clears archived records before the next meeting', async () => {
  const h = harness();
  for (let i = 0; i < 1002; i++) h.app.pushSubtitleWithCap(record(i));
  await h.app.handleAction('clearSubtitles');
  h.app.pushSubtitleWithCap(record(2000));
  await h.app.exportMeetingTranscript();
  const output = h.calls.find(c => c.cmd === 'save_meeting_transcript').args.content;
  assert.ok(!output.includes('RECORD_0_END'));
  assert.ok(output.includes('RECORD_2000_END'));
});

test('an export snapshot stays stable while new speech arrives during AI summarization', async () => {
  const h = harness();
  h.app.appConfig.openrouter.api_key = 'test';
  let finishSummary;
  h.overrides.set('generate_ai_minutes', () => new Promise(resolve => { finishSummary = resolve; }));
  for (let i = 0; i < 1002; i++) h.app.pushSubtitleWithCap(record(i));
  const exportJob = h.app.exportMeetingTranscript();
  while (!finishSummary) await tick();
  h.app.pushSubtitleWithCap(record(1002));
  finishSummary('Summary');
  await exportJob;
  const output = h.calls.find(c => c.cmd === 'save_meeting_transcript').args.content;
  assert.equal((output.match(/RECORD_\d+_END/g) || []).length, 1002);
  assert.ok(output.includes('RECORD_0_END'));
  assert.ok(!output.includes('RECORD_1002_END'));
});

test('failed language persistence leaves the active stream and selected language unchanged', async () => {
  const h = harness();
  h.app.appConfig.soniox.translation_type = 'two_way';
  h.app.hudState.isStreaming = true;
  h.overrides.set('save_config', async () => { throw Error('disk full'); });
  let stopped = false;
  h.app.stopLiveStream = async () => { stopped = true; };
  await h.app.handleAction('cycleSpeakTargetLang');
  assert.equal(h.app.appConfig.soniox.speak_target_language, 'en');
  assert.equal(stopped, false);
});

test('closing a quick-speak card ignores its pending response', async () => {
  const h = harness();
  h.input('first');
  const job = h.app.handleAction('submitQuickSpeakTranslate');
  await tick();
  await h.app.handleAction('closeQuickSpeakCard');
  h.requests[0].resolve({spoken:'FIRST', target_lang:'en'});
  await job;
  assert.equal(h.app.hudState.quickSpeakCard, null);
  assert.equal(h.clipboard.length, 0);
});


test('browser preview keeps a complete export snapshot without native storage', async () => {
  const h = harness();
  delete h.context.window.__TAURI_INTERNALS__;
  for (let i = 0; i < 1002; i++) h.app.pushSubtitleWithCap(record(i));
  const snapshot = await h.app.snapshotTranscript();
  assert.equal(snapshot.length, 1002);
  assert.equal(snapshot[0].original, 'RECORD_0_END');
  await h.app.handleAction('clearSubtitles');
  h.app.pushSubtitleWithCap(record(2000));
  assert.equal((await h.app.snapshotTranscript()).length, 1);
});
