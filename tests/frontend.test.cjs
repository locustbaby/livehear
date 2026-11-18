const { test: nodeTest } = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 5000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let iconsModule = null;
function loadIcons() {
  if (iconsModule) return iconsModule;
  const exportsObj = {};
  const src = fs.readFileSync(path.join(__dirname, '../src/components/icons.ts'), 'utf8');
  vm.runInContext(
    ts.transpileModule(src, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText,
    vm.createContext({ exports: exportsObj, module: { exports: exportsObj } })
  );
  return (iconsModule = exportsObj);
}

function harness() {
  const listeners = new Map();
  const windowListeners = new Map();
  const elements = new Map();
  const calls = [];
  const requests = [];
  const overrides = new Map();
  const clipboard = [];
  let archived = [];
  let input = { value: '' };
  const dock = { set innerHTML(value) { input = { value: '' }; } };
  const context = {
    structuredClone,
    exports: {}, console: {log() {}, warn() {}, error() {}}, setTimeout, clearTimeout,
    window: {
      __TAURI_INTERNALS__: {},
      addEventListener(event, handler) {
        if (!windowListeners.has(event)) windowListeners.set(event, []);
        windowListeners.get(event).push(handler);
      },
    },
    document: {
      getElementById(id) {
        if (elements.has(id)) return elements.get(id);
        return id === 'quickSpeakInput' ? input : id === 'quickSpeakDockContainer' ? dock : null;
      },
      getElementsByName() { return []; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
  };
  let loadedHud = null;
  context.require = name => {
    if (name === '@tauri-apps/api/event') return { listen: async (event, handler) => listeners.set(event, handler) };
    if (name === './components/icons') return loadIcons();
    if (name === './components/hud') {
      const hudExports = {};
      const hudSource = fs.readFileSync(path.join(__dirname, '../src/components/hud.ts'), 'utf8');
      vm.runInContext(
        ts.transpileModule(hudSource, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText,
        vm.createContext({ exports: hudExports, module: { exports: hudExports }, require: n => {
          if (n === './icons') return loadIcons();
          throw Error(`Unexpected hud module: ${n}`);
        } })
      );
      loadedHud = hudExports;
      return { ...hudExports, renderQuickSpeakDockHtml: () => '' };
    }
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
  const bindShortcuts = App.prototype.bindKeyboardShortcuts;
  for (const name of ['detectPlatform', 'bindGlobalHandlers', 'bindKeyboardShortcuts', 'bindSelectionLookupListener', 'initTauriListeners', 'initialRender', 'loadConfigAndAutoStart']) App.prototype[name] = () => {};
  const app = new App();
  app.showToast = () => {};
  app.refreshTopbarBadges = () => {};
  for (const name of ['finalizeLastCard', 'updateOrAppendPartial', 'refreshDisplayMode', 'updateLastFinalTurn', 'clear']) app.streamManager[name] = () => {};
  return { app, calls, requests, clipboard, listeners, windowListeners, elements, overrides, context,
    hud: loadedHud,
    init: () => initListeners.call(app),
    bindKeyboardShortcuts: () => bindShortcuts.call(app),
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
  h.app.stopLiveStreamNow = async save => { lifecycle.push(['stop', save]); h.app.hudState.isStreaming = false; };
  h.app.startLiveStreamNow = async () => { lifecycle.push(['start']); h.app.hudState.isStreaming = true; };
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
  h.app.stopLiveStreamNow = async () => { stopped = true; };
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

test('binding my speaker leaves live Chinese translation to Soniox and manual EN still works', async () => {
  const h = harness();
  h.app.appConfig.openrouter.api_key = 'test';
  h.app.appConfig.openrouter.enable_polish = false;
  await h.init();
  const final = (id, text, translated) => h.listeners.get('asr-final')({payload: {segment: {
    id, text, translated_text: translated, asr_translation: translated, detected_language: 'zh',
    speaker: {id: 2, display_name: 'Speaker 2'},
  }}});
  final('first', '你好', '');
  await h.app.handleAction('toggleMySpeaker', 2);
  final('second', '我们明天开会', "We'll meet tomorrow.");
  assert.ok(h.app.hudState.subtitles.at(-1).translated.includes("We'll meet tomorrow."));
  assert.equal(h.calls.filter(call => call.cmd === 'polish_transcript').length, 0);
  h.overrides.set('polish_transcript', async () => ({translated: "Hello, we'll meet tomorrow."}));
  h.app.streamManager.updateLastFinalTurn = () => {};
  await h.app.handleAction('translateTurnToForeign', h.app.hudState.subtitles.at(-1).id);
  const requests = h.calls.filter(call => call.cmd === 'polish_transcript');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].args.speakMode, true);
  assert.equal(requests[0].args.targetLang, 'en');
  assert.equal(h.clipboard.at(-1), "Hello, we'll meet tomorrow.");
});

test('saveAllConfig synchronizes AI models and preserves endpoint delay, vad_threshold, and ollama config', async () => {
  const h = harness();
  h.elements.set('cfgAsrProvider', { value: 'ollama' });
  h.elements.set('cfgOllamaUrl', { value: 'http://127.0.0.1:11435' });
  h.elements.set('cfgOllamaModel', { value: 'qwen3-asr-custom' });
  h.elements.set('cfgEndpointDelay', { value: '600' });
  h.elements.set('cfgVadThreshold', { value: '3.2' });
  h.elements.set('cfgOpenRouterModel', { value: 'deepseek-v4.1-flash' });
  await h.app.handleAction('saveAllConfig');
  assert.equal(h.app.appConfig.asr_backend.provider, 'ollama');
  assert.equal(h.app.appConfig.asr_backend.ollama_url, 'http://127.0.0.1:11435');
  assert.equal(h.app.appConfig.asr_backend.ollama_model, 'qwen3-asr-custom');
  assert.equal(h.app.appConfig.soniox.max_endpoint_delay_ms, 600);
  assert.equal(h.app.appConfig.soniox.vad_threshold, 3.2);
  assert.equal(h.app.appConfig.openrouter.translate_model, 'deepseek-v4.1-flash');
  assert.equal(h.app.appConfig.openrouter.predict_model, 'deepseek-v4.1-flash');
  assert.equal(h.app.appConfig.jev.model, 'deepseek-v4.1-flash');
});

test('coalescing merges same-speaker turns within 6.5s even after earlier polish and repolishes combined turn', async () => {
  const h = harness();
  h.app.appConfig.openrouter.api_key = 'test';
  h.app.appConfig.openrouter.enable_polish = true;
  await h.init();
  const polishWaiters = [];
  h.overrides.set('polish_transcript', async (args) => {
    const res = { original: `${args.original}!`, translated: `${args.draft}!` };
    if (polishWaiters.length > 0) polishWaiters.shift()(args);
    return res;
  });
  const waitNextPolish = () => new Promise((resolve) => polishWaiters.push(resolve));
  const final = (id, text, translated) => h.listeners.get('asr-final')({payload: {segment: {
    id, text, translated_text: translated, asr_translation: translated, detected_language: 'en',
    speaker: {id: 1, display_name: 'Speaker 1'},
  }}});

  const firstPolishDone = waitNextPolish();
  final('a', 'First sentence.', '第一句。');
  await firstPolishDone;
  await tick();
  assert.equal(h.app.hudState.subtitles[0].aiOriginal, 'First sentence.!');

  const secondPolishDone = waitNextPolish();
  final('b', 'Second sentence.', '第二句。');
  assert.equal(h.app.hudState.subtitles.length, 1);
  assert.ok(h.app.hudState.subtitles[0].original.includes('Second sentence.'));
  const secondArgs = await secondPolishDone;
  await tick();
  assert.ok(secondArgs.original.includes('First sentence.!'));
  assert.ok(secondArgs.original.includes('Second sentence.'));
});

test('two_way mode with enable_polish true polishes bound speaker Chinese turn', async () => {
  const h = harness();
  h.app.appConfig.openrouter.api_key = 'test';
  h.app.appConfig.openrouter.enable_polish = true;
  h.app.appConfig.soniox.translation_type = 'two_way';
  await h.init();
  await h.app.handleAction('toggleMySpeaker', 2);
  let polishArgs = null;
  let resolvePolish;
  const polishDone = new Promise((resolve) => { resolvePolish = resolve; });
  h.overrides.set('polish_transcript', async (args) => {
    polishArgs = args;
    return { original: '我们明天开会', translated: 'Let us meet tomorrow.' };
  });
  h.listeners.get('asr-final')({payload: {segment: {
    id: 'zh-1', text: '我们明天开会', translated_text: "We'll meet tomorrow.", asr_translation: "We'll meet tomorrow.",
    detected_language: 'zh', speaker: {id: 2, display_name: 'Speaker 2'},
  }}});
  const origInvoke = h.overrides.get('polish_transcript');
  h.overrides.set('polish_transcript', async (args) => {
    const out = await origInvoke(args);
    resolvePolish();
    return out;
  });
  await polishDone;
  await tick();
  assert.equal(polishArgs.speakMode, false);
  assert.equal(polishArgs.targetLang, 'en');
  assert.equal(h.app.hudState.subtitles[0].translated, 'Let us meet tomorrow.');
});

test('click-through mode restores interaction on Escape or window blur then focus', async () => {
  const h = harness();
  h.bindKeyboardShortcuts();
  await h.app.handleAction('toggleClickThrough');
  assert.equal(h.app.hudState.isClickThrough, true);

  for (const fn of h.windowListeners.get('blur') || []) fn();
  for (const fn of h.windowListeners.get('focus') || []) fn();
  await tick();
  assert.equal(h.app.hudState.isClickThrough, false);

  await h.app.handleAction('toggleClickThrough');
  assert.equal(h.app.hudState.isClickThrough, true);
  for (const fn of h.windowListeners.get('keydown') || []) {
    fn({ key: 'Escape', metaKey: false, ctrlKey: false, shiftKey: false, preventDefault() {} });
  }
  await tick();
  assert.equal(h.app.hudState.isClickThrough, false);
  const ctCalls = h.calls.filter(c => c.cmd === 'set_click_through').map(c => c.args.enabled);
  assert.deepEqual(ctCalls, [true, false, true, false]);
});

test('mic permission failure updates state and requestMicPermission opens system privacy settings', async () => {
  const h = harness();
  h.overrides.set('start_soniox_live', async () => {
    throw new Error('麦克风访问被拒绝，请在系统隐私设置中允许访问后重试');
  });
  await h.app.startLiveStream();
  assert.equal(h.app.hudState.hasMicPermission, false);
  assert.ok(h.app.hudState.permissionError.includes('麦克风访问被拒绝'));

  await h.app.handleAction('requestMicPermission');
  assert.equal(h.calls.filter(c => c.cmd === 'open_mic_privacy_settings').length, 1);

  h.overrides.set('start_soniox_live', async () => {});
  await h.app.startLiveStream();
  assert.equal(h.app.hudState.hasMicPermission, true);
  assert.equal(h.app.hudState.permissionError, undefined);
});

test('unavailable audio hardware does not prompt for microphone access', async () => {
  const h = harness();
  h.overrides.set('start_soniox_live', async () => {
    throw new Error('音频驱动异常: 未检测到可用的音频输入设备，请检查麦克风或内录设备连接');
  });
  await h.app.handleAction('requestMicPermission');
  assert.equal(h.app.hudState.isStreaming, false);
  assert.equal(h.app.hudState.hasMicPermission, true);
  assert.ok(!h.calls.some(({ cmd }) => cmd === 'open_mic_privacy_settings'));
});

test('Windows playback sources persist as output IDs and label the live meter', async () => {
  const h = harness();
  const output = { id: 'wasapi-loopback:wasapi:headphones', name: 'Headphones' };
  h.overrides.set('list_audio_devices', async () => ({ inputs: ['Built-in Microphone'], system_outputs: [output] }));
  const settings = {};
  h.elements.set('settingsOverlayContainer', settings);
  await h.app.handleAction('toggleSettings');
  assert.match(settings.innerHTML, /Windows 系统声音/);
  assert.ok(settings.innerHTML.includes(output.id));

  h.elements.set('cfgInputDevice', { value: output.id });
  await h.app.handleAction('saveAllConfig');
  const saved = h.calls.find(({ cmd }) => cmd === 'save_config');
  assert.equal(saved.args.newConfig.soniox.input_device, output.id);

  await h.init();
  const meter = {};
  h.elements.set('micVolumeText', meter);
  h.listeners.get('audio-level')({ payload: { volume: 20 } });
  assert.equal(meter.textContent, '系统声音: 20%');
  assert.match(h.hud.renderTopbarMicStatusHtml(h.app.hudState, h.app.appConfig), /系统声音: 20%/);
});

test('formatShortcut adapts macOS symbols to Ctrl on Windows and keeps macOS intact', () => {
  const h = harness();
  assert.equal(h.hud.formatShortcut('⌘ + K', 'windows'), 'Ctrl + K');
  assert.equal(h.hud.formatShortcut('⌘ + Shift + H', 'windows'), 'Ctrl + Shift + H');
  assert.equal(h.hud.formatShortcut('Cmd+1', 'windows'), 'Ctrl+1');
  assert.equal(h.hud.formatShortcut('⌘ + K', 'macos'), '⌘ + K');
});

test('async translations reach sentences that were coalesced into an earlier card', async () => {
  const h = harness();
  h.app.appConfig.openrouter.enable_polish = false;
  await h.init();
  const final = (id, text) => h.listeners.get('asr-final')({payload: {segment: {
    id, text, translated_text: '', translation_status: 'pending', detected_language: 'ja',
    speaker: {id: 3, display_name: 'Speaker 3'},
  }}});
  const translation = (segment_id, original, translated) =>
    h.listeners.get('asr-translation')({payload: {segment_id, original, translated}});
  final('a', 'こんにちは');
  final('b', '明日会議です');
  assert.equal(h.app.hudState.subtitles.length, 1);
  translation('b', '明日会議です', '明天开会');
  translation('a', 'こんにちは', '你好');
  const card = h.app.hudState.subtitles[0];
  assert.ok(card.translated.includes('明天开会'), card.translated);
  assert.ok(card.translated.includes('你好'), card.translated);
  assert.ok(!card.translated.includes('こんにちは'));
});

test('dismissing the quick-lang popover discards unapplied edits', async () => {
  const h = harness();
  const before = [...h.app.appConfig.soniox.language_hints];
  await h.app.handleAction('toggleQuickLangPopover');
  await h.app.handleAction('selectLangPreset', 'ja,ko');
  assert.deepEqual([...h.app.appConfig.soniox.language_hints], ['ja', 'ko']);
  await h.app.handleAction('toggleQuickLangPopover');
  assert.deepEqual([...h.app.appConfig.soniox.language_hints], before);
  assert.equal(h.calls.filter(c => c.cmd === 'save_config').length, 0);
});

test('a start issued while a stop is draining runs after the stop instead of being dropped', async () => {
  const h = harness();
  h.app.hudState.isStreaming = true;
  const order = [];
  let finishStop;
  h.app.stopLiveStreamNow = () => new Promise(resolve => {
    order.push('stop');
    finishStop = () => { h.app.hudState.isStreaming = false; resolve(); };
  });
  h.app.startLiveStreamNow = async () => { order.push(h.app.hudState.isStreaming ? 'start-skipped' : 'start'); };
  const stop = h.app.stopLiveStream();
  const start = h.app.startLiveStream();
  await tick();
  assert.deepEqual(order, ['stop']);
  finishStop();
  await Promise.all([stop, start]);
  assert.deepEqual(order, ['stop', 'start']);
});
