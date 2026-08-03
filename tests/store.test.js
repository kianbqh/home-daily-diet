const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const { createMemoryStorage } = require('../services/storage');
const { createStore } = require('../services/app-store');

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
