const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const { createMemoryStorage } = require('../services/storage');
const { createStore } = require('../services/app-store');

test('loads an empty local state and persists a new dish across store instances', () => {
  const storage = createMemoryStorage();
  const first = createStore({
    storage,
    initialState: createInitialState({ memberId: 'member-1', memberName: '小明' }),
  });

  first.addDish({ name: '红烧茄子' }, '2026-08-02T10:00:00.000Z');
  const reloaded = createStore({ storage });

  assert.equal(reloaded.getState().dishes.length, 1);
  assert.equal(reloaded.getState().dishes[0].name, '红烧茄子');
  assert.equal(reloaded.getState().cookingRecords.length, 1);
});

test('repairs an incomplete persisted state before the family page reads it', () => {
  const storage = createMemoryStorage({ version: 1 });
  const store = createStore({
    storage,
    initialState: createInitialState({
      familyId: 'family-repaired',
      familyName: '我们的家',
      memberId: 'member-repaired',
      memberName: '我',
    }),
  });

  assert.equal(store.getFamilySummary().id, 'family-repaired');
  assert.equal(store.getFamilySummary().name, '我们的家');
  assert.equal(store.getFamilySummary().memberCount, 1);
  assert.equal(store.getState().currentMemberId, 'member-repaired');
});

test('keeps a dinner selection after persistence reload', () => {
  const storage = createMemoryStorage();
  const store = createStore({
    storage,
    initialState: createInitialState({ memberId: 'member-1' }),
  });
  const dish = store.addDish({ name: '莲藕排骨汤' }, '2026-08-02T10:00:00.000Z');
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

  store.addDish({ name: '蒜蓉生菜' }, '2026-08-02T10:00:00.000Z');
  unsubscribe();
  store.addDish({ name: '冬瓜排骨汤' }, '2026-08-02T10:01:00.000Z');

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].dishes[0].name, '蒜蓉生菜');
});

test('updates the shared family profile through the same store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({ familyName: '旧名字' }),
  });

  store.updateFamily({ name: '周末饭桌' });

  assert.equal(store.getFamilySummary().name, '周末饭桌');
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
    initialState: createInitialState({ familyName: '本地家庭' }),
    cloudSync: {
      async load() {
        throw new Error('database permission denied');
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getFamilySummary().name, '本地家庭');
  assert.equal(store.getSyncStatus().status, 'error');
  assert.match(store.getSyncStatus().message, /本地数据/);
});

test('normalizes an incomplete cloud snapshot before replacing local state', async () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState({
      familyId: 'family-local-safe',
      familyName: '本地家庭',
      memberId: 'member-local-safe',
    }),
    cloudSync: {
      async load() {
        return { version: 1, family: { id: 'family-cloud-old', name: '云端家庭' } };
      },
      async save() {},
    },
  });

  await store.hydrateFromCloud();

  assert.equal(store.getFamilySummary().id, 'family-cloud-old');
  assert.equal(store.getFamilySummary().name, '云端家庭');
  assert.equal(store.getFamilySummary().memberCount, 1);
  assert.equal(store.getState().currentMemberId, 'member-local-safe');
  assert.equal(store.getSyncStatus().status, 'ready');
});

test('keeps the local member identity when hydrating a shared family', async () => {
  const remoteState = createInitialState({ familyId: 'family-shared', memberId: 'member-remote', memberName: '爸爸' });
  const localState = createInitialState({ familyId: 'family-shared', memberId: 'member-local', memberName: '小明' });
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
    initialState: createInitialState({ memberId: 'member-test', memberName: '我' }),
  });

  store.updateMember({ memberId: 'member-test', displayName: '小明' });

  assert.equal(store.getState().members[0].displayName, '小明');
});

test('updates an existing dish profile through the same store boundary', () => {
  const store = createStore({
    storage: createMemoryStorage(),
    initialState: createInitialState(),
  });
  const created = store.addDish({ name: '番茄炒蛋' }, '2026-08-02T10:00:00.000Z');
  const dishId = created.dishes[0].id;

  store.updateDish({ dishId, name: '少油番茄炒蛋', tags: ['家常'] });

  assert.equal(store.listDishes()[0].name, '少油番茄炒蛋');
  assert.deepEqual(store.listDishes()[0].tags, ['家常']);
  assert.equal(store.getState().cookingRecords.length, 1);
});

test('hydrates a family state from the optional cloud sync boundary', async () => {
  const remoteState = createInitialState({ familyId: 'family-cloud', familyName: '云端饭桌' });
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

  assert.equal(store.getFamilySummary().name, '云端饭桌');
  assert.equal(store.getState().family.id, 'family-cloud');
});

test('joins a remote family by adding the current member to the shared state', async () => {
  const remoteState = createInitialState({ familyId: 'family-shared', familyName: '共享饭桌' });
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

  await store.joinFamily('family-shared', { id: 'member-2', displayName: '爸爸' });

  assert.equal(store.getState().family.id, 'family-shared');
  assert.equal(store.getState().currentMemberId, 'member-2');
  assert.equal(store.getFamilySummary().memberCount, 2);
});
