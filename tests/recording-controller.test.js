const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecordingController } = require('../services/recording-controller');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createClock(initial = 1_700_000_000_000) {
  let now = initial;
  return { now: () => now, advanceBy: (ms) => { now += ms; } };
}

function createTimer(clock) {
  let nextId = 1;
  const timers = new Map();
  return {
    setInterval(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, nextAt: clock.now() + delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    advanceBy(ms) {
      const target = clock.now() + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.nextAt <= target)
          .sort((left, right) => left[1].nextAt - right[1].nextAt)[0];
        if (!due) break;
        clock.advanceBy(due[1].nextAt - clock.now());
        due[1].nextAt += due[1].delay;
        due[1].callback();
      }
      clock.advanceBy(target - clock.now());
    },
    activeCount: () => timers.size,
  };
}

function createRecorder(options = {}) {
  const handlers = {};
  const recorder = {
    startCalls: [], stopCalls: 0, cancelCalls: 0,
    offCalls: [],
    onStart(callback) { handlers.start = callback; },
    onStop(callback) { handlers.stop = callback; },
    onError(callback) { handlers.error = callback; },
    onInterruptionBegin(callback) { handlers.interruption = callback; },
    start(options) { this.startCalls.push(clone(options)); handlers.start?.(); },
    stop() { this.stopCalls += 1; },
    cancel() { this.cancelCalls += 1; },
    finish(result) { return handlers.stop?.(result); },
    fail(error) { return handlers.error?.(error); },
    interrupt(result) { return handlers.interruption?.(result); },
  };
  if (options.withoutCancel) delete recorder.cancel;
  if (options.withOff) {
    recorder.offStart = (callback) => { recorder.offCalls.push('start'); if (handlers.start === callback) delete handlers.start; };
    recorder.offStop = (callback) => { recorder.offCalls.push('stop'); if (handlers.stop === callback) delete handlers.stop; };
    recorder.offError = (callback) => { recorder.offCalls.push('error'); if (handlers.error === callback) delete handlers.error; };
    recorder.offInterruptionBegin = (callback) => { recorder.offCalls.push('interruption'); if (handlers.interruption === callback) delete handlers.interruption; };
  }
  return recorder;
}

function createStorage(initialEntries = []) {
  let entries = clone(initialEntries);
  const writes = [];
  return {
    read() { return clone(entries); },
    write(nextEntries) { entries = clone(nextEntries); writes.push(clone(entries)); },
    entries: () => clone(entries),
    writes,
  };
}

function createFileSystem(options = {}) {
  const calls = [];
  return {
    calls,
    async saveFile({ tempFilePath }) {
      calls.push(['saveFile', tempFilePath]);
      if (options.saveFails) throw new Error('save failed');
      return { savedFilePath: `wxfile://saved/${tempFilePath.split('/').pop()}` };
    },
    async getFileInfo({ filePath }) {
      calls.push(['getFileInfo', filePath]);
      if (options.infoFails) throw new Error('unavailable');
      return { size: 321 };
    },
    async removeSavedFile({ filePath }) {
      calls.push(['removeSavedFile', filePath]);
      if (options.removeFails) throw new Error('remove failed');
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createController(options = {}) {
  const clock = options.clock || createClock();
  const timerApi = options.timerApi || createTimer(clock);
  const recorderManager = options.recorderManager || createRecorder();
  const storage = options.storage || createStorage(options.entries);
  const fileSystem = options.fileSystem || createFileSystem(options.fileOptions);
  return {
    controller: createRecordingController({ recorderManager, fileSystem, storage, clock, timerApi }),
    clock, timerApi, recorderManager, storage, fileSystem,
  };
}

test('starts an mp3 recording, publishes elapsed state, and stops at 180 seconds', () => {
  const { controller, timerApi, recorderManager } = createController();
  const states = [];
  controller.on('state', (state) => states.push(state));

  controller.start('family-1|dish-1|record-1');

  assert.deepEqual(recorderManager.startCalls[0], {
    duration: 180000,
    sampleRate: 16000,
    numberOfChannels: 1,
    encodeBitRate: 48000,
    format: 'mp3',
  });
  assert.deepEqual(states.at(-1), {
    status: 'recording', elapsedMs: 0, remainingMs: 180000, localClip: null, errorCode: null,
  });
  timerApi.advanceBy(1000);
  assert.deepEqual(states.at(-1), {
    status: 'recording', elapsedMs: 1000, remainingMs: 179000, localClip: null, errorCode: null,
  });
  timerApi.advanceBy(179000);
  assert.equal(recorderManager.stopCalls, 1);
  controller.destroy();
});

test('persists completed clips as controller-only metadata and exposes workspace recovery', async () => {
  const { controller, recorderManager, storage, fileSystem } = createController();
  controller.start('family-1|dish-1|record-1');
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/clip.mp3', duration: 1200 });

  const [clip] = storage.entries();
  assert.deepEqual(clip, {
    localId: '1700000000000-1',
    workspaceKey: 'family-1|dish-1|record-1',
    savedFilePath: 'wxfile://saved/clip.mp3',
    durationMs: 1200,
    format: 'mp3',
    byteLength: 321,
    createdAt: 1700000000000,
    uploadStatus: 'pending',
  });
  assert.deepEqual(controller.listRecoverable('family-1|dish-1|record-1'), [clip]);
  assert.deepEqual(controller.findWorkspace({ familyId: 'family-1', dishId: 'dish-1' }), {
    recordId: 'record-1', workspaceKey: 'family-1|dish-1|record-1',
  });
  assert.deepEqual(fileSystem.calls, [
    ['saveFile', 'wxfile://tmp/clip.mp3'],
    ['getFileInfo', 'wxfile://saved/clip.mp3'],
  ]);
  controller.destroy();
});

test('retains a session-only temporary clip when saving it fails', async () => {
  const { controller, recorderManager, storage } = createController({ fileOptions: { saveFails: true } });
  controller.start('family-1|dish-1|record-1');
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/clip.mp3', duration: 1200, fileSize: 45 });

  assert.deepEqual(storage.entries(), [{
    localId: '1700000000000-1',
    workspaceKey: 'family-1|dish-1|record-1',
    savedFilePath: null,
    tempFilePath: 'wxfile://tmp/clip.mp3',
    durationMs: 1200,
    format: 'mp3',
    byteLength: 45,
    createdAt: 1700000000000,
    uploadStatus: 'pending',
    sessionOnly: true,
  }]);
  assert.equal(controller.listRecoverable('family-1|dish-1|record-1').length, 1);
  controller.destroy();
});

test('keeps a supplied interrupted file and otherwise emits RECORDING_INTERRUPTED', async () => {
  const preserved = createController();
  preserved.controller.start('family-1|dish-1|record-1');
  await preserved.recorderManager.interrupt({ tempFilePath: 'wxfile://tmp/interrupted.mp3', duration: 400 });
  assert.equal(preserved.storage.entries()[0].durationMs, 400);
  assert.equal(preserved.storage.entries()[0].savedFilePath, 'wxfile://saved/interrupted.mp3');
  preserved.controller.destroy();

  const missing = createController();
  const states = [];
  missing.controller.on('state', (state) => states.push(state));
  missing.controller.start('family-1|dish-1|record-1');
  missing.recorderManager.interrupt({});
  assert.deepEqual(states.at(-1), {
    status: 'error', elapsedMs: 0, remainingMs: 180000, localClip: null, errorCode: 'RECORDING_INTERRUPTED',
  });
  assert.deepEqual(missing.storage.entries(), []);
  missing.controller.destroy();
});

test('retains a valid stop clip that arrives after a pathless interruption notification', async () => {
  const { controller, recorderManager, storage } = createController();
  controller.start('family-1|dish-1|record-1');
  await recorderManager.interrupt({});
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/late-interrupted.mp3', duration: 400 });
  assert.equal(storage.entries()[0].savedFilePath, 'wxfile://saved/late-interrupted.mp3');
  controller.destroy();
});

test('emits MICROPHONE_DENIED for recorder permission failures', () => {
  const { controller, recorderManager } = createController();
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  recorderManager.fail({ errMsg: 'operateRecorder:fail auth deny' });
  assert.equal(states.at(-1).errorCode, 'MICROPHONE_DENIED');
  controller.destroy();
});

test('maps non-permission recorder failures to the stable interruption code only', () => {
  const { controller, recorderManager } = createController();
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  recorderManager.fail({ code: 'DEVICE_BUSY', errMsg: 'hardware returned an internal code' });
  assert.deepEqual(states.at(-1), {
    status: 'error', elapsedMs: 0, remainingMs: 180000, localClip: null, errorCode: 'RECORDING_INTERRUPTED',
  });
  controller.destroy();
});

test('enforces recording limits from all retained workspace metadata, including uploaded clips', () => {
  const uploadedEntries = Array.from({ length: 10 }, (_, index) => ({
    localId: `old-${index}`, workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: 10, format: 'mp3', byteLength: 1, createdAt: index, uploadStatus: 'uploaded',
  }));
  const countLimited = createController({ entries: uploadedEntries });
  const countStates = [];
  countLimited.controller.on('state', (state) => countStates.push(state));
  countLimited.controller.start('family-1|dish-1|record-1');
  assert.equal(countLimited.recorderManager.startCalls.length, 0);
  assert.equal(countStates.at(-1).errorCode, 'RECORDING_LIMIT_EXCEEDED');
  assert.deepEqual(countLimited.controller.findWorkspace({ familyId: 'family-1', dishId: 'dish-1' }), {
    recordId: 'record-1', workspaceKey: 'family-1|dish-1|record-1',
  });
  countLimited.controller.destroy();

  const durationLimited = createController({ entries: [{
    localId: 'old-duration', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: 900000, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  }] });
  const durationStates = [];
  durationLimited.controller.on('state', (state) => durationStates.push(state));
  durationLimited.controller.start('family-1|dish-1|record-1');
  assert.equal(durationLimited.recorderManager.startCalls.length, 0);
  assert.equal(durationStates.at(-1).errorCode, 'RECORDING_LIMIT_EXCEEDED');
  durationLimited.controller.destroy();
});

test('caps a recording to its remaining workspace duration and refuses an over-cap completed clip', async () => {
  const retained = {
    localId: 'old-duration', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: 780000, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  };
  const { controller, recorderManager, timerApi, storage } = createController({ entries: [retained] });
  controller.start('family-1|dish-1|record-1');
  assert.equal(recorderManager.startCalls[0].duration, 120000);
  timerApi.advanceBy(120000);
  assert.equal(recorderManager.stopCalls, 1);
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/too-long.mp3', duration: 120001 });
  assert.equal(storage.entries().length, 1);
  controller.destroy();
});

test('findWorkspace selects the newest retained workspace for a family and dish', () => {
  const { controller } = createController({ entries: [
    {
      localId: 'old', workspaceKey: 'family-1|dish-1|record-old', savedFilePath: null,
      durationMs: 20, format: 'mp3', byteLength: 1, createdAt: 10, uploadStatus: 'uploaded',
    },
    {
      localId: 'new', workspaceKey: 'family-1|dish-1|record-new', savedFilePath: null,
      durationMs: 20, format: 'mp3', byteLength: 1, createdAt: 20, uploadStatus: 'pending',
    },
  ] });
  assert.deepEqual(controller.findWorkspace({ familyId: 'family-1', dishId: 'dish-1' }), {
    recordId: 'record-new', workspaceKey: 'family-1|dish-1|record-new',
  });
  controller.destroy();
});

test('marks uploaded before deleting its saved file and excludes uploaded entries from local recovery', async () => {
  const entry = {
    localId: 'clip-1', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/clip.mp3',
    durationMs: 1000, format: 'mp3', byteLength: 321, createdAt: 1, uploadStatus: 'pending',
  };
  const { controller, storage, fileSystem } = createController({ entries: [entry] });
  await controller.markUploaded('clip-1');
  assert.equal(storage.writes[0][0].uploadStatus, 'uploaded');
  assert.deepEqual(fileSystem.calls, [['removeSavedFile', 'wxfile://saved/clip.mp3']]);
  assert.deepEqual(controller.listRecoverable('family-1|dish-1|record-1'), []);
  assert.equal(storage.entries()[0].uploadStatus, 'uploaded');
  controller.destroy();
});

test('removes metadata only after its local file is removed and reports unavailable files', async () => {
  const entry = {
    localId: 'clip-1', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/clip.mp3',
    durationMs: 1000, format: 'mp3', byteLength: 321, createdAt: 1, uploadStatus: 'pending',
  };
  const unavailable = createController({ entries: [entry], fileOptions: { removeFails: true } });
  const states = [];
  unavailable.controller.on('state', (state) => states.push(state));
  await unavailable.controller.remove('clip-1');
  assert.equal(states.at(-1).errorCode, 'LOCAL_FILE_UNAVAILABLE');
  assert.equal(unavailable.storage.entries().length, 1);
  unavailable.controller.destroy();

  const removable = createController({ entries: [entry] });
  await removable.controller.remove('clip-1');
  assert.deepEqual(removable.storage.entries(), []);
  removable.controller.destroy();
});

test('stops timers and ignores late recorder callbacks after destruction or cancellation', () => {
  const { controller, timerApi, recorderManager, storage } = createController();
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  controller.cancel();
  recorderManager.finish({ tempFilePath: 'wxfile://tmp/cancelled.mp3', duration: 100 });
  assert.deepEqual(storage.entries(), []);
  controller.destroy();
  recorderManager.fail({ errMsg: 'permission denied' });
  timerApi.advanceBy(180000);
  assert.equal(timerApi.activeCount(), 0);
  assert.equal(states.at(-1).status, 'idle');
});

test('cancelling without RecorderManager.cancel stops and discards the eventual stop file', async () => {
  const recorderManager = createRecorder({ withoutCancel: true });
  const { controller, storage } = createController({ recorderManager });
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  controller.cancel();
  assert.equal(recorderManager.stopCalls, 1);
  assert.equal(states.at(-1).status, 'idle');
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/discarded.mp3', duration: 500 });
  assert.deepEqual(storage.entries(), []);
  controller.destroy();
});

test('destroying during deferred saveFile prevents late metadata writes', async () => {
  const deferredSave = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async ({ tempFilePath }) => {
    fileSystem.calls.push(['saveFile', tempFilePath]);
    return deferredSave.promise;
  };
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const finish = recorderManager.finish({ tempFilePath: 'wxfile://tmp/deferred.mp3', duration: 500 });
  await Promise.resolve();
  controller.destroy();
  deferredSave.resolve({ savedFilePath: 'wxfile://saved/deferred.mp3' });
  await finish;
  assert.deepEqual(storage.entries(), []);
  assert.deepEqual(storage.writes, []);
});

test('destroy unbinds RecorderManager handlers when off methods exist', () => {
  const recorderManager = createRecorder({ withOff: true });
  const { controller } = createController({ recorderManager });
  controller.destroy();
  assert.deepEqual(recorderManager.offCalls.sort(), ['error', 'interruption', 'stop']);
});

test('allocates a unique local id at an existing clock timestamp', async () => {
  const { controller, recorderManager, storage } = createController({ entries: [{
    localId: '1700000000000-1', workspaceKey: 'family-1|dish-1|record-old', savedFilePath: null,
    durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  }] });
  controller.start('family-1|dish-1|record-1');
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/unique.mp3', duration: 500 });
  assert.equal(storage.entries().at(-1).localId, '1700000000000-2');
  controller.destroy();
});

test('derives a positive elapsed duration when RecorderManager reports a non-positive duration', async () => {
  const retained = {
    localId: 'retained', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: 780000, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  };
  const { controller, recorderManager, storage, clock } = createController({ entries: [retained] });
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  clock.advanceBy(500);
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/invalid-duration.mp3', duration: 0 });
  assert.equal(storage.entries().at(-1).durationMs, 500);
  assert.equal(states.at(-1).errorCode, null);
  controller.destroy();
});

test('rejects a non-positive reported duration when no positive elapsed time exists', async () => {
  const { controller, recorderManager, storage } = createController();
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/zero-duration.mp3', duration: -1 });
  assert.deepEqual(storage.entries(), []);
  assert.equal(states.at(-1).errorCode, 'LOCAL_FILE_UNAVAILABLE');
  controller.destroy();
});

test('loaded negative durations count as zero and cannot increase workspace allowance', () => {
  const { controller, recorderManager } = createController({ entries: [{
    localId: 'bad-duration', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: -100, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  }] });
  controller.start('family-1|dish-1|record-1');
  assert.equal(recorderManager.startCalls[0].duration, 180000);
  controller.destroy();
});

test('cancelling with no active recording invalidates only the most recent pending capture', async () => {
  const deferredSave = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async () => deferredSave.promise;
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const finish = recorderManager.finish({ tempFilePath: 'wxfile://tmp/cancel-pending.mp3', duration: 500 });
  await Promise.resolve();
  controller.cancel();
  deferredSave.resolve({ savedFilePath: 'wxfile://saved/cancel-pending.mp3' });
  await finish;
  assert.deepEqual(storage.entries(), []);
  assert.deepEqual(storage.writes, []);
  controller.destroy();
});

test('markUploaded keeps uploaded metadata and clears its saved path after deletion', async () => {
  const entry = {
    localId: 'clip-1', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/clip.mp3',
    durationMs: 1000, format: 'mp3', byteLength: 321, createdAt: 1, uploadStatus: 'pending',
  };
  const { controller, storage, fileSystem } = createController({ entries: [entry] });
  await controller.markUploaded('clip-1');
  assert.equal(storage.writes[0][0].uploadStatus, 'uploaded');
  assert.deepEqual(fileSystem.calls, [['removeSavedFile', 'wxfile://saved/clip.mp3']]);
  assert.deepEqual(storage.entries(), [{ ...entry, savedFilePath: null, uploadStatus: 'uploaded' }]);
  assert.equal(storage.writes.length, 2);
  controller.destroy();
});

test('markUploaded retains the saved path when deletion fails but still keeps uploaded status', async () => {
  const entry = {
    localId: 'clip-1', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/clip.mp3',
    durationMs: 1000, format: 'mp3', byteLength: 321, createdAt: 1, uploadStatus: 'pending',
  };
  const { controller, storage } = createController({ entries: [entry], fileOptions: { removeFails: true } });
  await controller.markUploaded('clip-1');
  assert.deepEqual(storage.entries(), [{ ...entry, uploadStatus: 'uploaded' }]);
  controller.destroy();
});

test('markUploaded only updates the colliding-timestamp entry selected by localId', async () => {
  const entries = [
    { localId: '1700000000000-1', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null, durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'pending' },
    { localId: '1700000000000-2', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null, durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'pending' },
  ];
  const { controller, storage } = createController({ entries });
  await controller.markUploaded('1700000000000-2');
  assert.deepEqual(storage.entries().map((entry) => entry.uploadStatus), ['pending', 'uploaded']);
  controller.destroy();
});

test('workspace cap remains enforced after a derived invalid duration', async () => {
  const retained = {
    localId: 'retained', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null,
    durationMs: 780000, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'uploaded',
  };
  const { controller, recorderManager, clock, storage } = createController({ entries: [retained] });
  controller.start('family-1|dish-1|record-1');
  clock.advanceBy(120000);
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/derived-cap.mp3', duration: 0 });
  controller.start('family-1|dish-1|record-1');
  assert.equal(storage.entries().length, 2);
  assert.equal(recorderManager.startCalls.length, 1);
  controller.destroy();
});

test('destroy stops an active recorder without cancel and leaves no timer, callback, or storage effect', async () => {
  const recorderManager = createRecorder({ withoutCancel: true });
  const { controller, timerApi, storage } = createController({ recorderManager });
  const states = [];
  controller.on('state', (state) => states.push(state));
  controller.start('family-1|dish-1|record-1');
  controller.destroy();
  assert.equal(recorderManager.stopCalls, 1);
  assert.equal(timerApi.activeCount(), 0);
  await recorderManager.finish({ tempFilePath: 'wxfile://tmp/destroyed.mp3', duration: 500 });
  assert.deepEqual(storage.entries(), []);
  assert.equal(states.length, 1);
});

test('destroy cleans up even when recorder shutdown throws', () => {
  const recorderManager = createRecorder({ withoutCancel: true, withOff: true });
  recorderManager.stop = () => { recorderManager.stopCalls += 1; throw new Error('shutdown failure'); };
  const { controller, timerApi } = createController({ recorderManager });
  controller.start('family-1|dish-1|record-1');
  assert.doesNotThrow(() => controller.destroy());
  assert.equal(recorderManager.stopCalls, 1);
  assert.equal(timerApi.activeCount(), 0);
  assert.deepEqual(recorderManager.offCalls.sort(), ['error', 'interruption', 'stop']);
});

test('destroy removes a saved file when deferred saveFile resolves after invalidation', async () => {
  const deferredSave = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async ({ tempFilePath }) => {
    fileSystem.calls.push(['saveFile', tempFilePath]);
    return deferredSave.promise;
  };
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const finish = recorderManager.finish({ tempFilePath: 'wxfile://tmp/orphan-save.mp3', duration: 500 });
  await Promise.resolve();
  controller.destroy();
  deferredSave.resolve({ savedFilePath: 'wxfile://saved/orphan-save.mp3' });
  await finish;
  assert.deepEqual(fileSystem.calls, [
    ['saveFile', 'wxfile://tmp/orphan-save.mp3'],
    ['removeSavedFile', 'wxfile://saved/orphan-save.mp3'],
  ]);
  assert.deepEqual(storage.writes, []);
});

test('destroy removes a saved file when invalidated after deferred getFileInfo', async () => {
  const deferredInfo = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.getFileInfo = async ({ filePath }) => {
    fileSystem.calls.push(['getFileInfo', filePath]);
    return deferredInfo.promise;
  };
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const finish = recorderManager.finish({ tempFilePath: 'wxfile://tmp/orphan-info.mp3', duration: 500 });
  await Promise.resolve();
  controller.destroy();
  deferredInfo.resolve({ size: 321 });
  await finish;
  assert.deepEqual(fileSystem.calls, [
    ['saveFile', 'wxfile://tmp/orphan-info.mp3'],
    ['getFileInfo', 'wxfile://saved/orphan-info.mp3'],
    ['removeSavedFile', 'wxfile://saved/orphan-info.mp3'],
  ]);
  assert.deepEqual(storage.writes, []);
});

test('reserves distinct local ids for overlapping saves at the same clock timestamp', async () => {
  const firstSave = createDeferred();
  const secondSave = createDeferred();
  const saves = [firstSave, secondSave];
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async ({ tempFilePath }) => {
    fileSystem.calls.push(['saveFile', tempFilePath]);
    return saves.shift().promise;
  };
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const first = recorderManager.finish({ tempFilePath: 'wxfile://tmp/first.mp3', duration: 500 });
  await Promise.resolve();
  controller.start('family-1|dish-1|record-1');
  const second = recorderManager.finish({ tempFilePath: 'wxfile://tmp/second.mp3', duration: 500 });
  await Promise.resolve();
  secondSave.resolve({ savedFilePath: 'wxfile://saved/second.mp3' });
  firstSave.resolve({ savedFilePath: 'wxfile://saved/first.mp3' });
  await Promise.all([first, second]);
  assert.deepEqual(storage.entries().map((entry) => entry.localId).sort(), ['1700000000000-1', '1700000000000-2']);
});

test('cancelling active clip B does not discard earlier pending clip A', async () => {
  const deferredA = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async ({ tempFilePath }) => {
    fileSystem.calls.push(['saveFile', tempFilePath]);
    return deferredA.promise;
  };
  const { controller, recorderManager, storage } = createController({ fileSystem });
  controller.start('family-1|dish-1|record-1');
  const finishA = recorderManager.finish({ tempFilePath: 'wxfile://tmp/a.mp3', duration: 500 });
  await Promise.resolve();
  controller.start('family-1|dish-1|record-1');
  controller.cancel();
  deferredA.resolve({ savedFilePath: 'wxfile://saved/a.mp3' });
  await finishA;
  assert.deepEqual(storage.entries().map((entry) => entry.savedFilePath), ['wxfile://saved/a.mp3']);
  controller.destroy();
});

test('pending captures count toward the ten-clip workspace limit before their saves resolve', async () => {
  const pendingSaves = [];
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async () => {
    const deferred = createDeferred();
    pendingSaves.push(deferred);
    return deferred.promise;
  };
  const { controller, recorderManager } = createController({ fileSystem });
  const states = [];
  controller.on('state', (state) => states.push(state));
  for (let index = 0; index < 10; index += 1) {
    controller.start('family-1|dish-1|record-1');
    recorderManager.finish({ tempFilePath: `wxfile://tmp/pending-${index}.mp3`, duration: 1000 });
    await Promise.resolve();
  }
  controller.start('family-1|dish-1|record-1');
  assert.equal(recorderManager.startCalls.length, 10);
  assert.equal(states.at(-1).errorCode, 'RECORDING_LIMIT_EXCEEDED');
  controller.destroy();
});

test('pending capture duration reduces the next workspace recording duration', async () => {
  const pendingSaves = [];
  const fileSystem = createFileSystem();
  fileSystem.saveFile = async () => {
    const deferred = createDeferred();
    pendingSaves.push(deferred);
    return deferred.promise;
  };
  const { controller, recorderManager } = createController({ fileSystem });
  for (let index = 0; index < 4; index += 1) {
    controller.start('family-1|dish-1|record-1');
    recorderManager.finish({ tempFilePath: `wxfile://tmp/long-${index}.mp3`, duration: 180000 });
    await Promise.resolve();
  }
  controller.start('family-1|dish-1|record-1');
  recorderManager.finish({ tempFilePath: 'wxfile://tmp/short.mp3', duration: 100000 });
  await Promise.resolve();
  controller.start('family-1|dish-1|record-1');
  assert.equal(recorderManager.startCalls.at(-1).duration, 80000);
  controller.destroy();
});

test('markUploaded re-finds its entry after deferred deletion when another entry is removed', async () => {
  const removeA = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.removeSavedFile = async ({ filePath }) => {
    fileSystem.calls.push(['removeSavedFile', filePath]);
    if (filePath === 'wxfile://saved/a.mp3') return removeA.promise;
  };
  const entries = [
    { localId: 'b', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null, durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'pending' },
    { localId: 'a', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/a.mp3', durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 2, uploadStatus: 'pending' },
  ];
  const { controller, storage } = createController({ entries, fileSystem });
  const uploading = controller.markUploaded('a');
  await Promise.resolve();
  await controller.remove('b');
  removeA.resolve();
  await uploading;
  assert.deepEqual(storage.entries(), [{ ...entries[1], savedFilePath: null, uploadStatus: 'uploaded' }]);
  controller.destroy();
});

test('remove re-finds its entry after deferred deletion when another entry is removed', async () => {
  const removeA = createDeferred();
  const fileSystem = createFileSystem();
  fileSystem.removeSavedFile = async ({ filePath }) => {
    fileSystem.calls.push(['removeSavedFile', filePath]);
    if (filePath === 'wxfile://saved/a.mp3') return removeA.promise;
  };
  const entries = [
    { localId: 'b', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: null, durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 1, uploadStatus: 'pending' },
    { localId: 'a', workspaceKey: 'family-1|dish-1|record-1', savedFilePath: 'wxfile://saved/a.mp3', durationMs: 1, format: 'mp3', byteLength: 1, createdAt: 2, uploadStatus: 'pending' },
  ];
  const { controller, storage } = createController({ entries, fileSystem });
  const removing = controller.remove('a');
  await Promise.resolve();
  await controller.remove('b');
  removeA.resolve();
  await removing;
  assert.deepEqual(storage.entries(), []);
  controller.destroy();
});
