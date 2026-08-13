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

function createRecorder() {
  const handlers = {};
  return {
    startCalls: [], stopCalls: 0, cancelCalls: 0,
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
