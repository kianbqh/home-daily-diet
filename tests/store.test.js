const test = require('node:test');
const assert = require('node:assert/strict');

const { addDish, createInitialState } = require('../services/domain');
const { createMemoryStorage } = require('../services/storage');
const { createStore, normalizePersistedState } = require('../services/app-store');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('loads an empty local state and persists a new dish across store instances', () => {
  const storage = createMemoryStorage();
  const first = createStore({
    storage,
    initialState: createInitialState({ memberId: 'member-1', memberName: 'Xiaoming' }),
  });

  first.addDish({ name: 'Tomato eggs' }, '2026-08-02T10:00:00.000Z');
  const reloaded = createStore({ storage });

  assert.equal(reloaded.getState().dishes.length, 1);
  assert.equal(reloaded.getState().dishes[0].name, 'Tomato eggs');
  assert.equal(reloaded.getState().cookingRecords.length, 1);
});

test('addCookingRecordAndWait resolves only after its exact family save completes', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  let savedSnapshot = null;
  const initialState = addDish(
    createInitialState({ familyId: 'family-record-save' }),
    { id: 'dish-record-save', name: 'Tomato eggs' },
    '2026-08-18T10:00:00.000Z'
  );
  const store = createStore({
    storage: createMemoryStorage(),
    initialState,
    cloudSync: {
      async save(snapshot) {
        savedSnapshot = JSON.parse(JSON.stringify(snapshot));
        saveStarted.resolve();
        await saveGate.promise;
      },
    },
  });
  assert.equal(typeof store.addCookingRecordAndWait, 'function');

  let settled = false;
  const pending = store.addCookingRecordAndWait({
    id: 'record-awaited-save',
    dishId: 'dish-record-save',
    recordedAt: '2026-08-18T11:00:00.000Z',
  }).then((result) => {
    settled = true;
    return result;
  });
  await saveStarted.promise;

  assert.equal(settled, false);
  assert.equal(store.getState().cookingRecords.some((item) => item.id === 'record-awaited-save'), true);
  assert.equal(savedSnapshot.cookingRecords.some((item) => item.id === 'record-awaited-save'), true);

  saveGate.resolve();
  const result = await pending;
  assert.equal(result.cookingRecords.some((item) => item.id === 'record-awaited-save'), true);
});

test('addCookingRecordAndWait surfaces the exact cloud save failure', async () => {
  const initialState = addDish(
    createInitialState({ familyId: 'family-record-failure' }),
    { id: 'dish-record-failure', name: 'Tomato eggs' },
    '2026-08-18T10:00:00.000Z'
  );
  const store = createStore({
    storage: createMemoryStorage(),
    initialState,
    cloudSync: {
      async save() {
        throw new Error('family state save rejected');
      },
    },
  });
  assert.equal(typeof store.addCookingRecordAndWait, 'function');

  await assert.rejects(
    () => store.addCookingRecordAndWait({
      id: 'record-cloud-failure',
      dishId: 'dish-record-failure',
      recordedAt: '2026-08-18T11:00:00.000Z',
    }),
    /family state save rejected/
  );
  assert.equal(store.getState().cookingRecords.some((item) => item.id === 'record-cloud-failure'), true);
});

test('addCookingRecordAndWait rejects when its family changes during the save', async () => {
  const saveStarted = deferred();
  const saveGate = deferred();
  const familyB = createInitialState({
    familyId: 'family-record-b', memberId: 'member-b', memberName: 'Family B member',
  });
  const initialState = addDish(
    createInitialState({ familyId: 'family-record-a', memberId: 'member-a' }),
    { id: 'dish-record-a', name: 'Tomato eggs' },
    '2026-08-18T10:00:00.000Z'
  );
  const store = createStore({
    storage: createMemoryStorage(),
    initialState,
    cloudSync: {
      async save() {
        saveStarted.resolve();
        await saveGate.promise;
      },
      async acceptInvite() {
        return {
          state: familyB,
          member: { memberId: 'member-b', displayName: 'Family B member' },
        };
      },
    },
  });
  assert.equal(typeof store.addCookingRecordAndWait, 'function');

  const pending = store.addCookingRecordAndWait({
    id: 'record-stale-family',
    dishId: 'dish-record-a',
    recordedAt: '2026-08-18T11:00:00.000Z',
  });
  await saveStarted.promise;
  const joining = store.joinFamilyByInvite('BBBBBB', {
    id: 'member-b', displayName: 'Family B member',
  });
  saveGate.resolve();

  await assert.rejects(
    () => pending,
    (error) => error && error.code === 'FAMILY_CONTEXT_STALE'
  );
  await joining;
  assert.equal(store.getState().family.id, 'family-record-b');
});

test('does not persist a device-local image path when cloud image upload is unavailable', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
  });

  await assert.rejects(
    () => store.uploadImage('wxfile://tmp/photo.jpg'),
    (error) => error && error.code === 'IMAGE_UPLOAD_UNAVAILABLE'
  );
  assert.equal(await store.uploadImage('https://cdn.example/photo.jpg'), 'https://cdn.example/photo.jpg');
});

test('reuses a successful resolved image URL from the thirty-minute memory cache', async () => {
  let clockMs = 0;
  let resolveCalls = 0;
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    clock: () => clockMs,
    cloudSync: {
      async resolveFiles(familyId, fileIds) {
        resolveCalls += 1;
        assert.equal(familyId, 'family-images');
        assert.deepEqual(fileIds, ['cloud://env/family-meals/family-images/photo.jpg']);
        return [{
          fileID: 'cloud://env/family-meals/family-images/photo.jpg',
          tempFileURL: 'https://cdn.example/photo.jpg',
        }];
      },
    },
  });
  const fileId = 'cloud://env/family-meals/family-images/photo.jpg';

  const first = await store.resolveImageUrls([fileId, fileId]);
  clockMs = (30 * 60 * 1000) - 1;
  const second = await store.resolveImageUrls([fileId]);

  assert.equal(first.get(fileId), 'https://cdn.example/photo.jpg');
  assert.equal(second.get(fileId), 'https://cdn.example/photo.jpg');
  assert.equal(resolveCalls, 1);
});

test('refetches a resolved image URL at the exact thirty-minute expiration boundary', async () => {
  let clockMs = 0;
  let resolveCalls = 0;
  const fileId = 'cloud://env/family-meals/family-images/photo.jpg';
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    clock: () => clockMs,
    cloudSync: {
      async resolveFiles() {
        resolveCalls += 1;
        return [{ fileID: fileId, tempFileURL: `https://cdn.example/photo-${resolveCalls}.jpg` }];
      },
    },
  });

  const first = await store.resolveImageUrls([fileId]);
  clockMs = 30 * 60 * 1000;
  const second = await store.resolveImageUrls([fileId]);

  assert.equal(first.get(fileId), 'https://cdn.example/photo-1.jpg');
  assert.equal(second.get(fileId), 'https://cdn.example/photo-2.jpg');
  assert.equal(resolveCalls, 2);
});

test('splits more than fifty unresolved image IDs into bounded cloud requests', async () => {
  const batches = [];
  const fileIds = Array.from({ length: 51 }, (_, index) => `cloud://env/family-meals/family-images/${index}.jpg`);
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    cloudSync: {
      async resolveFiles(familyId, ids) {
        assert.equal(familyId, 'family-images');
        batches.push(ids);
        return ids.map((fileID) => ({ fileID, tempFileURL: `https://cdn.example/${fileID.split('/').pop()}` }));
      },
    },
  });

  const urls = await store.resolveImageUrls(fileIds);

  assert.deepEqual(batches.map((batch) => batch.length), [50, 1]);
  assert.equal(urls.size, 51);
  assert.equal(urls.get(fileIds[50]), 'https://cdn.example/50.jpg');
});

test('does not cache an authorized file that the cloud function failed to resolve', async () => {
  let resolveCalls = 0;
  const fileId = 'cloud://env/family-meals/family-images/missing.jpg';
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    cloudSync: {
      async resolveFiles() {
        resolveCalls += 1;
        return [{ fileID: fileId, tempFileURL: '', code: 'FILE_RESOLVE_FAILED' }];
      },
    },
  });

  const first = await store.resolveImageUrls([fileId]);
  const second = await store.resolveImageUrls([fileId]);

  assert.equal(first.has(fileId), false);
  assert.equal(second.has(fileId), false);
  assert.equal(resolveCalls, 2);
});

test('family transition rejects a late image resolution and does not reuse it in the joined family', async () => {
  const fileId = 'cloud://env/family-meals/shared/photo.jpg';
  const familyB = createInitialState({
    familyId: 'family-b',
    memberId: 'member-b',
    memberName: 'Family B member',
  });
  let signalFamilyAResolution;
  let releaseFamilyAResolution;
  const familyAResolutionStarted = new Promise((resolve) => { signalFamilyAResolution = resolve; });
  const familyAResolutionGate = new Promise((resolve) => { releaseFamilyAResolution = resolve; });
  const calls = [];
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-a', memberId: 'member-a' }),
    cloudSync: {
      async resolveFiles(familyId, fileIds) {
        calls.push({ familyId, fileIds });
        if (familyId === 'family-a') {
          signalFamilyAResolution();
          await familyAResolutionGate;
          return [{ fileID: fileId, tempFileURL: 'https://cdn.example/family-a-private.jpg' }];
        }
        return [{ fileID: fileId, tempFileURL: 'https://cdn.example/family-b-authorized.jpg' }];
      },
      async acceptInvite() {
        return {
          state: familyB,
          member: { memberId: 'member-b', displayName: 'Family B member' },
        };
      },
    },
  });

  const familyARequest = store.resolveImageUrls([fileId]);
  await familyAResolutionStarted;
  await store.joinFamilyByInvite('B22222', { id: 'member-b', displayName: 'Family B member' });
  releaseFamilyAResolution();

  const staleUrls = await familyARequest;
  const familyBUrls = await store.resolveImageUrls([fileId]);

  assert.equal(staleUrls.has(fileId), false);
  assert.equal(familyBUrls.get(fileId), 'https://cdn.example/family-b-authorized.jpg');
  assert.deepEqual(calls.map((call) => call.familyId), ['family-a', 'family-b']);
});

test('image resolver ignores response entries outside the request batch', async () => {
  const requestedId = 'cloud://env/family-meals/family-images/requested.jpg';
  const injectedId = 'cloud://env/family-meals/family-images/injected.jpg';
  let resolveCalls = 0;
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    cloudSync: {
      async resolveFiles(familyId, fileIds) {
        resolveCalls += 1;
        assert.equal(familyId, 'family-images');
        if (fileIds.includes(requestedId)) {
          return [
            { fileID: requestedId, tempFileURL: 'https://cdn.example/requested.jpg' },
            { fileID: injectedId, tempFileURL: 'https://cdn.example/injected.jpg' },
          ];
        }
        return [{ fileID: injectedId, tempFileURL: 'https://cdn.example/authorized-injected.jpg' }];
      },
    },
  });

  const first = await store.resolveImageUrls([requestedId]);
  const second = await store.resolveImageUrls([injectedId]);

  assert.deepEqual([...first.entries()], [[requestedId, 'https://cdn.example/requested.jpg']]);
  assert.equal(second.get(injectedId), 'https://cdn.example/authorized-injected.jpg');
  assert.equal(resolveCalls, 2);
});

test('image cache prunes its oldest family-scoped entry when the configured bound is exceeded', async () => {
  const ids = [
    'cloud://env/family-meals/family-images/one.jpg',
    'cloud://env/family-meals/family-images/two.jpg',
    'cloud://env/family-meals/family-images/three.jpg',
  ];
  let resolveCalls = 0;
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-images' }),
    imageCacheMaxEntries: 2,
    cloudSync: {
      async resolveFiles(familyId, fileIds) {
        resolveCalls += 1;
        return fileIds.map((fileID) => ({
          fileID,
          tempFileURL: `https://cdn.example/${fileID.split('/').pop()}`,
        }));
      },
    },
  });

  await store.resolveImageUrls([ids[0]]);
  await store.resolveImageUrls([ids[1]]);
  await store.resolveImageUrls([ids[2]]);
  await store.resolveImageUrls([ids[0]]);

  assert.equal(resolveCalls, 4);
});

test('repairs an incomplete persisted state before the family page reads it', () => {
  const storage = createMemoryStorage({ version: 1 });
  const store = createStore({
    storage,
    initialState: createInitialState({
      familyId: 'family-repaired',
      familyName: 'Our family',
      memberId: 'member-repaired',
      memberName: 'Me',
    }),
  });

  assert.equal(store.getFamilySummary().id, 'family-repaired');
  assert.equal(store.getFamilySummary().name, 'Our family');
  assert.equal(store.getFamilySummary().memberCount, 1);
  assert.equal(store.getState().currentMemberId, 'member-repaired');
});

test('normalizes old family and member profiles with stable timestamps', () => {
  const normalized = normalizePersistedState({
    version: 1,
    family: {
      id: 'family-profile',
      name: '旧家庭',
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    currentMemberId: 'member-profile',
    members: [{
      id: 'member-profile',
      displayName: '旧成员',
      joinedAt: '2026-08-02T00:00:00.000Z',
    }],
  });

  assert.equal(normalized.family.updatedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(normalized.members[0].updatedAt, '2026-08-02T00:00:00.000Z');
});

test('keeps a dinner selection after persistence reload', () => {
  const storage = createMemoryStorage();
  const store = createStore({
    storage,
    initialState: createInitialState({ memberId: 'member-1' }),
  });
  const dish = store.addDish({ name: 'Pork soup' }, '2026-08-02T10:00:00.000Z');
  const meal = store.ensureMeal({ date: '2026-08-02', mealType: 'dinner' }, '2026-08-02T10:01:00.000Z');

  store.selectDish({ sessionId: meal.id, dishId: dish.dishes[0].id }, '2026-08-02T10:02:00.000Z');
  const reloaded = createStore({ storage });

  assert.equal(reloaded.getSelectedDishes(meal.id).length, 1);
  assert.equal(reloaded.getSelectedDishes(meal.id)[0].dishId, dish.dishes[0].id);
});

test('notifies subscribers after a persisted change', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
  });
  const snapshots = [];
  const unsubscribe = store.subscribe((state) => snapshots.push(state));

  store.addDish({ name: 'Garlic vegetables' }, '2026-08-02T10:00:00.000Z');
  unsubscribe();
  store.addDish({ name: 'Winter melon soup' }, '2026-08-02T10:01:00.000Z');

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].dishes[0].name, 'Garlic vegetables');
});

test('updates the shared family profile through the same store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyName: 'Old name' }),
  });

  store.updateFamily({ name: 'Weekend dinner' });

  assert.equal(store.getFamilySummary().name, 'Weekend dinner');
  assert.equal(store.getFamilySummary().memberCount, 1);
  assert.equal(store.getFamilySummary().cloudEnabled, false);
  assert.equal(store.getFamilySummary().syncStatus, 'local');
});

test('reports a ready cloud connection after hydration succeeds', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
    cloudSync: {
      async load() {
        return null;
      },
      async save() {},
    },
  });

  assert.equal(store.getSyncStatus().status, 'connecting');
  await store.hydrateFromCloud();

  assert.equal(store.getSyncStatus().status, 'ready');
  assert.equal(store.getFamilySummary().cloudEnabled, true);
});

test('coalesces concurrent cloud sync and lets forced refresh bypass the cooldown', async () => {
  let clockMs = 10000;
  let loadCalls = 0;
  let releaseLoad;
  const gate = new Promise((resolve) => { releaseLoad = resolve; });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-sync' }),
    clock: () => clockMs,
    syncIntervalMs: 5000,
    cloudSync: {
      async load() { loadCalls += 1; await gate; return null; },
      async save() {},
    },
  });

  const first = store.syncFromCloud();
  const second = store.syncFromCloud();
  const forcedWhileLoading = store.syncFromCloud({ force: true });
  assert.strictEqual(second, first);
  assert.strictEqual(forcedWhileLoading, first);
  releaseLoad();
  await Promise.all([first, second, forcedWhileLoading]);
  assert.equal(loadCalls, 1);

  await store.syncFromCloud();
  assert.equal(loadCalls, 1);
  await store.syncFromCloud({ force: true });
  assert.equal(loadCalls, 2);
});

test('throttles automatic cloud sync from clock zero through the five-second boundary', async () => {
  let clockMs = 0;
  let loadCalls = 0;
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-sync-zero' }),
    clock: () => clockMs,
    syncIntervalMs: 5000,
    cloudSync: {
      async load() { loadCalls += 1; return null; },
      async save() {},
    },
  });

  await store.syncFromCloud();
  assert.equal(loadCalls, 1);

  clockMs = 4999;
  await store.syncFromCloud();
  assert.equal(loadCalls, 1);

  clockMs = 5000;
  await store.syncFromCloud();
  assert.equal(loadCalls, 2);
});

test('does not save equivalent shared state when current member identity is device-local', async () => {
  const initialState = createInitialState({ familyId: 'family-no-write', memberId: 'member-local' });
  const remoteMember = {
    id: 'member-remote',
    displayName: 'Remote member',
    joinedAt: initialState.family.createdAt,
    updatedAt: initialState.family.createdAt,
  };
  const localState = {
    ...initialState,
    members: [...initialState.members, remoteMember],
    currentMemberId: 'member-local',
  };
  const remoteState = {
    ...localState,
    members: localState.members.map((member) => ({ ...member })),
    currentMemberId: 'member-remote',
  };
  let saveCalls = 0;
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: localState,
    cloudSync: {
      async load() { return remoteState; },
      async save() { saveCalls += 1; },
    },
  });

  await store.syncFromCloud();

  assert.equal(saveCalls, 0);
  assert.equal(store.getState().currentMemberId, 'member-local');
});

test('saves one merged cloud state when a local dish is absent remotely', async () => {
  const storage = createMemoryStorage();
  const initialState = createInitialState({ familyId: 'family-merge-save' });
  const localStore = createStore({ storage, initialState });
  localStore.addDish({ name: 'Unsynced local dish' }, '2026-08-09T10:00:00.000Z');
  let saveCalls = 0;
  const store = createStore({
    storage,
    cloudSync: {
      async load() { return initialState; },
      async save() { saveCalls += 1; },
    },
  });

  await store.syncFromCloud();

  assert.equal(saveCalls, 1);
});

test('keeps local family data usable when cloud hydration fails', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyName: 'Local family' }),
    cloudSync: {
      async load() {
        throw new Error('database permission denied');
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getFamilySummary().name, 'Local family');
  assert.equal(store.getSyncStatus().status, 'error');
  assert.match(store.getSyncStatus().message, /本地数据/);
});

test('keeps an in-flight local edit when cloud loading rejects', async () => {
  let signalLoadStarted;
  let rejectLoad;
  const loadStarted = new Promise((resolve) => { signalLoadStarted = resolve; });
  const loadGate = new Promise((resolve, reject) => { rejectLoad = reject; });
  const storage = createMemoryStorage();
  const store = createStore({
    storage,
    initialState: createInitialState({ familyId: 'family-error-flight' }),
    cloudSync: {
      async load() {
        signalLoadStarted();
        await loadGate;
      },
      async save() {},
    },
  });

  const sync = store.syncFromCloud();
  await loadStarted;
  store.addDish({ name: 'Edit retained after failure' }, '2026-08-09T10:00:00.000Z');
  rejectLoad(new Error('database permission denied'));
  await sync;

  assert.equal(store.listDishes().some((dish) => dish.name === 'Edit retained after failure'), true);
  assert.equal(createStore({ storage }).listDishes().some((dish) => dish.name === 'Edit retained after failure'), true);
  assert.equal(store.getSyncStatus().status, 'error');
});

test('explains a cloud function call failure without exposing backend details', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
    cloudSync: {
      async load() {
        const error = new Error('request timeout');
        error.code = 'CLOUD_CALL_FAILED';
        throw error;
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.match(store.getSyncStatus().message, /family-access/);
  assert.doesNotMatch(store.getSyncStatus().message, /request timeout/);
});

test('rejects a cloud snapshot for a different family while keeping local data', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({
      familyId: 'family-local-safe',
      familyName: 'Local family',
      memberId: 'member-local-safe',
    }),
    cloudSync: {
      async load() {
        return { version: 1, family: { id: 'family-cloud-old', name: 'Cloud family' } };
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getFamilySummary().id, 'family-local-safe');
  assert.equal(store.getFamilySummary().name, 'Local family');
  assert.equal(store.getFamilySummary().memberCount, 1);
  assert.equal(store.getState().currentMemberId, 'member-local-safe');
  assert.equal(store.getSyncStatus().status, 'error');
});

test('keeps the local member identity when hydrating a shared family', async () => {
  const remoteState = createInitialState({ familyId: 'family-shared', memberId: 'member-remote', memberName: 'Dad' });
  const localState = createInitialState({ familyId: 'family-shared', memberId: 'member-local', memberName: 'Me' });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: localState,
    cloudSync: {
      async load() {
        return remoteState;
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getState().currentMemberId, 'member-local');
  assert.equal(store.getFamilySummary().memberCount, 2);
});

test('updates the current member name through the same store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ memberId: 'member-test', memberName: 'Me' }),
  });

  store.updateMember({ memberId: 'member-test', displayName: 'Xiaoming' });

  assert.equal(store.getState().members[0].displayName, 'Xiaoming');
});

test('updates an existing dish profile through the same store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
  });
  const created = store.addDish({ name: 'Tomato eggs' }, '2026-08-02T10:00:00.000Z');
  const dishId = created.dishes[0].id;

  store.updateDish({ dishId, name: 'Low-oil tomato eggs', tags: ['home'] });

  assert.equal(store.listDishes()[0].name, 'Low-oil tomato eggs');
  assert.deepEqual(store.listDishes()[0].tags, ['home']);
  assert.equal(store.getState().cookingRecords.length, 1);
});

test('hydrates a family state without changing the local family identity', async () => {
  const remoteState = createInitialState({ familyId: 'family-local', familyName: 'Cloud dinner' });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-local' }),
    cloudSync: {
      async load() {
        return remoteState;
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getState().family.id, 'family-local');
});

test('deferred family A sync cannot merge, save, or notify after joining family B', async () => {
  const familyARemote = addDish(
    createInitialState({ familyId: 'family-a', memberId: 'member-a' }),
    { id: 'dish-a', name: 'Family A private dish' },
    '2026-08-09T10:00:00.000Z'
  );
  const familyBRemote = addDish(
    createInitialState({ familyId: 'family-b', memberId: 'member-b', memberName: 'Family B member' }),
    { id: 'dish-b', name: 'Family B dish' },
    '2026-08-09T11:00:00.000Z'
  );
  let signalFamilyALoad;
  let releaseFamilyALoad;
  const familyALoadStarted = new Promise((resolve) => { signalFamilyALoad = resolve; });
  const familyALoadGate = new Promise((resolve) => { releaseFamilyALoad = resolve; });
  const loads = [];
  const saves = [];
  const notifications = [];
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-a', memberId: 'member-a' }),
    cloudSync: {
      async load(familyId) {
        loads.push(familyId);
        if (familyId === 'family-a') {
          signalFamilyALoad();
          await familyALoadGate;
          return familyARemote;
        }
        return familyBRemote;
      },
      async save(snapshot) {
        saves.push({
          familyId: snapshot.family.id,
          dishIds: snapshot.dishes.map((dish) => dish.id).sort(),
        });
      },
      async acceptInvite() {
        return {
          state: familyBRemote,
          member: { memberId: 'member-b', displayName: 'Family B member' },
        };
      },
    },
  });
  store.subscribe((snapshot) => {
    notifications.push({
      familyId: snapshot.family.id,
      dishIds: snapshot.dishes.map((dish) => dish.id).sort(),
    });
  });

  const familyASync = store.syncFromCloud({ force: true });
  await familyALoadStarted;
  await store.joinFamilyByInvite('B22222', { id: 'member-b', displayName: 'Family B member' });
  const familyBSync = store.syncFromCloud({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const loadsBeforeFamilyACompletes = [...loads];
  const notificationCountBeforeFamilyACompletes = notifications.length;

  releaseFamilyALoad();
  await Promise.all([familyASync, familyBSync]);

  assert.deepEqual(loadsBeforeFamilyACompletes, ['family-a', 'family-b']);
  assert.equal(store.getState().family.id, 'family-b');
  assert.deepEqual(store.getState().dishes.map((dish) => dish.id), ['dish-b']);
  assert.deepEqual(saves, []);
  assert.equal(notifications.length, notificationCountBeforeFamilyACompletes);
  assert.equal(notifications.some((snapshot) => snapshot.dishIds.includes('dish-a')), false);
});

test('joining a family resets the automatic-sync cooldown for the new family', async () => {
  let clockMs = 10000;
  const loads = [];
  const familyB = createInitialState({ familyId: 'family-b', memberId: 'member-b' });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-a', memberId: 'member-a' }),
    clock: () => clockMs,
    syncIntervalMs: 5000,
    cloudSync: {
      async load(familyId) {
        loads.push(familyId);
        return familyId === 'family-b' ? familyB : null;
      },
      async save() {},
      async acceptInvite() {
        return { state: familyB, member: { memberId: 'member-b', displayName: 'Family B member' } };
      },
    },
  });

  await store.syncFromCloud();
  await store.joinFamilyByInvite('B22222', { id: 'member-b', displayName: 'Family B member' });
  await store.syncFromCloud();

  assert.deepEqual(loads, ['family-a', 'family-b']);
});

test('joins a remote family through the invite code boundary', async () => {
  const remoteState = createInitialState({ familyId: 'family-shared', familyName: 'Shared dinner' });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-local' }),
    cloudSync: {
      async acceptInvite(code, member) {
        assert.equal(code, 'A7K9Q2');
        assert.equal(member.id, 'member-2');
        return { state: remoteState, member: { memberId: 'member-2', displayName: 'Dad' } };
      },
      async save() {},
    },
  });

  await store.joinFamilyByInvite('A7K9Q2', { id: 'member-2', displayName: 'Dad' });

  assert.equal(store.getState().family.id, 'family-shared');
  assert.equal(store.getState().currentMemberId, 'member-2');
  assert.equal(store.getFamilySummary().memberCount, 2);
});

test('merges remote dishes with local dishes during cloud hydration', async () => {
  const localState = createInitialState({ familyId: 'family-merge' });
  const remoteStore = createStore({ storage: createMemoryStorage(), initialState: createInitialState({ familyId: 'family-merge' }) });
  remoteStore.addDish({ name: 'Remote dish' }, '2026-08-04T10:01:00.000Z');
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: localState,
    cloudSync: {
      async load() {
        return remoteStore.getState();
      },
      async save() {},
    },
  });
  store.addDish({ name: 'Local dish' }, '2026-08-04T10:00:00.000Z');

  await store.hydrateFromCloud();

  assert.deepEqual(store.listDishes().map((dish) => dish.name).sort(), ['Local dish', 'Remote dish']);
});

test('keeps a local change made while cloud hydration is in flight', async () => {
  let releaseLoad;
  const loading = new Promise((resolve) => { releaseLoad = resolve; });
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-flight' }),
    cloudSync: {
      async load() {
        await loading;
        return createInitialState({ familyId: 'family-flight' });
      },
      async save() {},
    },
  });

  const hydration = store.hydrateFromCloud();
  store.addDish({ name: 'Change during hydration' }, '2026-08-04T10:02:00.000Z');
  releaseLoad();
  await hydration;

  assert.equal(store.listDishes().some((dish) => dish.name === 'Change during hydration'), true);
});

test('loads and clears short invite metadata through the store boundary', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyId: 'family-invite' }),
    cloudSync: {
      async getInvite() {
        return { code: 'A7K9Q2', expiresAt: '2026-09-03T10:00:00.000Z', status: 'active' };
      },
      async revokeInvite() {
        return { revoked: true };
      },
    },
  });

  await store.getInvite();
  assert.equal(store.getFamilySummary().inviteCode, 'A7K9Q2');
  await store.revokeInvite();
  assert.equal(store.getFamilySummary().inviteCode, '');
});

test('exposes record reviews and recycle-bin actions through the store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ memberId: 'member-1', memberName: 'Me' }),
  });
  const created = store.addDish({ name: 'Tomato eggs', category: '荤菜' }, '2026-08-02T10:00:00.000Z');
  const dishId = created.dishes[0].id;
  const recordId = created.cookingRecords[0].id;

  store.rateRecord({ dishId, recordId, stars: 4.5, text: '很好吃' }, '2026-08-03T10:00:00.000Z');
  assert.equal(store.getState().recordReviews[0].stars, 4.5);
  assert.equal(store.getState().recordReviews[0].memberId, 'member-1');

  store.deleteDish({ dishId }, '2026-08-04T10:00:00.000Z');
  assert.equal(store.listDeletedDishes()[0].id, dishId);
  store.restoreDish({ dishId }, '2026-08-05T10:00:00.000Z');
  assert.equal(store.listDishes()[0].id, dishId);

  store.deleteDish({ dishId }, '2026-08-06T10:00:00.000Z');
  store.purgeDish({ dishId }, '2026-08-07T10:00:00.000Z');
  assert.equal(store.getState().dishes.length, 0);
  assert.equal(store.getState().recordReviews.length, 0);
  assert.equal(store.listDeletedDishes().length, 0);
});

test('normalizes a persisted purge tombstone before local screens can render the old dish', () => {
  const base = createInitialState({ familyId: 'family-purged' });
  base.dishes = [{ id: 'dish-purged', name: 'Old dish', status: 'active' }];
  base.cookingRecords = [{ id: 'record-purged', dishId: 'dish-purged' }];
  base.recordReviews = [{ id: 'review-purged', dishId: 'dish-purged' }];
  base.purgedDishes = [{ dishId: 'dish-purged', purgedAt: '2026-08-07T10:00:00.000Z' }];

  const normalized = normalizePersistedState(base, createInitialState({ familyId: 'family-purged' }));

  assert.equal(normalized.dishes.length, 0);
  assert.equal(normalized.cookingRecords.length, 0);
  assert.equal(normalized.recordReviews.length, 0);
  assert.equal(normalized.purgedDishes.length, 1);
});

test('permanent deletion commits its tombstone before remote cleanup and keeps a retryable failure state', async () => {
  const storage = createMemoryStorage();
  const setup = createStore({
    storage,
    initialState: createInitialState({ familyId: 'family-purge-order', memberId: 'member-1' }),
  });
  setup.addDish({ id: 'dish-purge', name: '待彻底删除' }, '2026-08-17T08:00:00.000Z');
  setup.deleteDish({ dishId: 'dish-purge' }, '2026-08-17T09:00:00.000Z');

  const events = [];
  let store;
  const cloudSync = {
    async save(snapshot) {
      events.push(['save', snapshot.purgedDishes.some((item) => item.dishId === 'dish-purge')]);
      return snapshot;
    },
    async load() {
      events.push(['load']);
      return null;
    },
  };
  const recipeArtifacts = {
    async purgeDish(payload) {
      events.push([
        'purge',
        payload,
        store.getState().purgedDishes.some((item) => item.dishId === payload.dishId),
      ]);
      throw Object.assign(new Error('temporary cleanup failure'), { code: 'CLOUD_CALL_FAILED' });
    },
  };
  store = createStore({ storage, cloudSync, recipeArtifacts });

  const outcome = await store.purgeDish({ dishId: 'dish-purge' }, '2026-08-18T08:00:00.000Z');

  assert.equal(store.getState().dishes.some((dish) => dish.id === 'dish-purge'), false);
  assert.equal(store.getState().purgedDishes.some((item) => item.dishId === 'dish-purge'), true);
  assert.deepEqual(events.slice(0, 2), [
    ['save', true],
    ['purge', { familyId: 'family-purge-order', dishId: 'dish-purge' }, true],
  ]);
  assert.equal(outcome.cleanupPending, true);
  assert.equal(outcome.message, '菜品已删除，云端附件将在联网后继续清理');
  assert.equal(store.getDishPurgeStatus('dish-purge').status, 'pending');
  assert.equal(createStore({ storage }).getState().purgedDishes[0].artifactCleanupStatus, 'pending');
});

test('malformed recipe cleanup responses remain pending instead of being marked complete', async () => {
  const storage = createMemoryStorage();
  const setup = createStore({
    storage,
    initialState: createInitialState({ familyId: 'family-purge-malformed', memberId: 'member-1' }),
  });
  setup.addDish({ id: 'dish-malformed', name: '待重试清理' }, '2026-08-17T08:00:00.000Z');
  setup.deleteDish({ dishId: 'dish-malformed' }, '2026-08-17T09:00:00.000Z');

  const store = createStore({
    storage,
    cloudSync: {
      async save(snapshot) { return snapshot; },
      async load() { return null; },
    },
    recipeArtifacts: {
      async purgeDish() { return {}; },
    },
  });

  const outcome = await store.purgeDish(
    { dishId: 'dish-malformed' },
    '2026-08-18T08:00:00.000Z'
  );

  assert.equal(outcome.cleanupPending, true);
  assert.equal(outcome.message, '菜品已删除，云端附件将在联网后继续清理');
  assert.equal(store.getDishPurgeStatus('dish-malformed').status, 'pending');
});

test('a successful cloud sync retries pending recipe cleanup and records completion', async () => {
  const storage = createMemoryStorage();
  const setup = createStore({
    storage,
    initialState: createInitialState({ familyId: 'family-purge-retry', memberId: 'member-1' }),
  });
  setup.addDish({ id: 'dish-retry', name: '待重试' }, '2026-08-17T08:00:00.000Z');
  setup.deleteDish({ dishId: 'dish-retry' }, '2026-08-17T09:00:00.000Z');

  let attempts = 0;
  let fail = true;
  const store = createStore({
    storage,
    cloudSync: {
      async save(snapshot) { return snapshot; },
      async load() { return null; },
    },
    recipeArtifacts: {
      async purgeDish() {
        attempts += 1;
        if (fail) throw new Error('offline');
        return { deletedDocuments: 2, deletedFiles: 1, pendingFiles: 0 };
      },
    },
  });

  const first = await store.purgeDish({ dishId: 'dish-retry' }, '2026-08-18T08:00:00.000Z');
  assert.equal(first.cleanupPending, true);
  assert.equal(attempts, 1);

  fail = false;
  await store.syncFromCloud({ force: true });

  assert.equal(attempts, 2);
  assert.equal(store.getDishPurgeStatus('dish-retry').status, 'complete');
  assert.deepEqual(store.getDishPurgeStatus('dish-retry').result, {
    deletedDocuments: 2,
    deletedFiles: 1,
    pendingFiles: 0,
  });
});
