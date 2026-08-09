const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const { createMemoryStorage } = require('../services/storage');
const { createStore, normalizePersistedState } = require('../services/app-store');

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

test('keeps local family identity while normalizing an incomplete cloud snapshot', async () => {
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
  assert.equal(store.getSyncStatus().status, 'ready');
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
