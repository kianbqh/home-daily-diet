const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addCookingRecord,
  addDish,
  createInitialState,
  deleteDish,
  purgeDish,
  rateDish,
  upsertRecordReview,
} = require('../services/domain');
const { createCloudBaseSync, mergeFamilyStates } = require('../services/cloudbase-sync');

function createFakeCloudApi(options = {}) {
  const documents = new Map();
  const events = [];
  const calls = { init: null, collection: null, functions: [] };
  const api = {
    cloud: {
      init(options) {
        calls.init = options;
      },
      database() {
        return {
          collection(name) {
            if (!calls.collections) calls.collections = [];
            calls.collections.push(name);
            if (name.endsWith('_events')) {
              return {
                where(filter) {
                  return {
                    async get() {
                      return { data: events.filter((event) => event.familyId === filter.familyId) };
                    },
                  };
                },
                async add(payload) {
                  events.push(payload.data);
                },
              };
            }
            calls.collection = name;
            return {
              doc(id) {
                return {
                  async get() {
                    const data = documents.get(id);
                    if (!data && options.throwWhenMissing) {
                      const error = new Error('document not found');
                      error.errCode = -1;
                      error.errMsg = 'document not found';
                      throw error;
                    }
                    return data ? { data } : { data: null };
                  },
                  async set(payload) {
                    documents.set(id, payload.data);
                  },
                };
              },
            };
          },
        };
      },
      async uploadFile({ cloudPath }) {
        return { fileID: `cloud://${cloudPath}` };
      },
      async callFunction({ name, data }) {
        calls.functions.push({ name, data });
        if (data.action === 'bootstrap') {
          return { result: { ok: true, data: { member: { memberId: data.memberId } } } };
        }
        if (data.action === 'load') {
          let state = documents.get(data.familyId) || null;
          events
            .filter((event) => event.familyId === data.familyId)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .forEach((event) => {
              state = mergeFamilyStates(state, event.state);
            });
          return { result: { ok: true, data: { state } } };
        }
        if (data.action === 'save') {
          const state = mergeFamilyStates(documents.get(data.familyId) || null, data.state);
          events.push({
            familyId: data.familyId,
            state,
            createdAt: '2026-08-04T10:00:00.000Z',
          });
          documents.set(data.familyId, state);
          return { result: { ok: true, data: { state } } };
        }
        if (data.action === 'acceptInvite') {
          return {
            result: {
              ok: true,
              data: {
                state: documents.get('family-joined') || null,
                member: { memberId: data.memberId, displayName: data.displayName },
              },
            },
          };
        }
        if (['createInvite', 'getInvite', 'revokeInvite'].includes(data.action)) {
          return {
            result: {
              ok: true,
              data: {
                invite: {
                  code: 'A7K9Q2',
                  expiresAt: '2026-09-03T10:00:00.000Z',
                  status: 'active',
                },
              },
            },
          };
        }
        return { result: { ok: true, data: {} } };
      },
    },
  };
  return { api, calls, documents, events };
}

test('cloudbase sync saves and loads a family state through the configured collection', async () => {
  const fake = createFakeCloudApi();
  const sync = createCloudBaseSync(fake.api, { envId: 'env-test', collection: 'family_states' });
  const state = createInitialState({ familyId: 'family-1', familyName: '测试家庭' });

  await sync.save(state);
  const loaded = await sync.load('family-1');

  assert.deepEqual(fake.calls.init, { env: 'env-test', traceUser: true });
  assert.equal(fake.calls.collection, null);
  assert.deepEqual(fake.calls.collections || [], []);
  assert.equal(loaded.family.name, '测试家庭');
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, 'currentMemberId'), false);
});

test('cloudbase sync is disabled without an environment id', () => {
  assert.equal(createCloudBaseSync(null, { envId: '' }), null);
});

test('cloud-enabled image upload never falls back to a device-local path', async () => {
  const api = {
    cloud: {
      init() {},
      async callFunction() {
        return { result: { ok: true, data: {} } };
      },
    },
  };
  const sync = createCloudBaseSync(api, { envId: 'env-test' });

  await assert.rejects(
    sync.uploadImage('wxfile://tmp/photo.jpg', 'family-1'),
    (error) => error && error.code === 'IMAGE_UPLOAD_UNAVAILABLE'
  );
});

test('restores an event-backed family when the base document was initially missing', async () => {
  const fake = createFakeCloudApi({ throwWhenMissing: true });
  const sync = createCloudBaseSync(fake.api, { envId: 'env-test' });
  const state = createInitialState({ familyId: 'family-first-save' });

  await sync.save(state);
  const loaded = await sync.load('family-first-save');

  assert.equal(loaded.family.id, 'family-first-save');
  assert.equal(fake.events.length, 1);
  assert.equal(fake.documents.has('family-first-save'), true);
});

test('cloudbase sync merges append-only family changes before saving', async () => {
  const fake = createFakeCloudApi();
  const sync = createCloudBaseSync(fake.api, { envId: 'env-test' });
  let remote = createInitialState({ familyId: 'family-merge' });
  remote = addDish(remote, { name: '红烧肉' }, '2026-08-02T10:00:00.000Z');
  let local = createInitialState({ familyId: 'family-merge' });
  local = addDish(local, { name: '番茄炒蛋' }, '2026-08-02T10:01:00.000Z');
  fake.documents.set('family-merge', remote);

  await sync.save(local);
  const merged = await sync.load('family-merge');

  assert.deepEqual(merged.dishes.map((dish) => dish.name).sort(), ['番茄炒蛋', '红烧肉']);
  assert.equal(merged.cookingRecords.length, 2);
});

test('newer remote family and member profiles beat stale local defaults', () => {
  const remote = createInitialState({
    familyId: 'family-profile',
    familyName: '新的家庭名',
    memberId: 'member-1',
    memberName: '妈妈',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  remote.family.updatedAt = '2026-08-09T10:00:00.000Z';
  remote.members[0].updatedAt = '2026-08-09T10:00:00.000Z';

  const local = createInitialState({
    familyId: 'family-profile',
    familyName: '我的家庭',
    memberId: 'member-1',
    memberName: '我',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  local.family.updatedAt = '2026-08-01T00:00:00.000Z';
  local.members[0].updatedAt = '2026-08-01T00:00:00.000Z';

  const merged = mergeFamilyStates(remote, local);
  assert.equal(merged.family.name, '新的家庭名');
  assert.equal(merged.members[0].displayName, '妈妈');
});

test('cloudbase sync uses family-access for load and never reads the state collection directly', async () => {
  const fake = createFakeCloudApi();
  const sync = createCloudBaseSync(fake.api, { envId: 'env-test', accessFunction: 'family-access' });

  await sync.load('family-1');

  assert.deepEqual(fake.calls.functions[0], {
    name: 'family-access',
    data: { action: 'load', familyId: 'family-1' },
  });
  assert.equal((fake.calls.collections || []).length, 0);
});

test('cloudbase sync labels transport failures with the action that failed', async () => {
  const api = {
    cloud: {
      init() {},
      async callFunction() {
        const error = new Error('request timeout');
        error.errCode = -1;
        error.errMsg = 'request timeout';
        throw error;
      },
    },
  };
  const sync = createCloudBaseSync(api, { envId: 'env-test' });

  await assert.rejects(
    sync.load('family-1'),
    (error) => error.code === 'CLOUD_CALL_FAILED' && error.action === 'load'
  );
});

test('acceptInvite sends only the short code and member profile', async () => {
  const fake = createFakeCloudApi();
  const sync = createCloudBaseSync(fake.api, { envId: 'env-test' });

  await sync.acceptInvite('A7K9Q2', { id: 'member-2', displayName: 'Xiaoming' });

  assert.deepEqual(fake.calls.functions[0], {
    name: 'family-access',
    data: {
      action: 'acceptInvite',
      code: 'A7K9Q2',
      memberId: 'member-2',
      displayName: 'Xiaoming',
    },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(fake.calls.functions[0].data, 'familyId'), false);
});

test('cloudbase sync uploads an image and returns a family-scoped file id', async () => {
  const fake = createFakeCloudApi();
  const sync = createCloudBaseSync(fake.api, {
    envId: 'env-test',
    fileStoragePrefix: 'family-meals/',
  });

  const fileId = await sync.uploadImage('wxfile://dish-photo', 'family-1');

  assert.match(fileId, /^cloud:\/\/family-meals\/family-1\//);
});

test('cloudbase sync keeps both concurrent device snapshots through immutable events', async () => {
  const fake = createFakeCloudApi();
  const syncA = createCloudBaseSync(fake.api, { envId: 'env-test' });
  const syncB = createCloudBaseSync(fake.api, { envId: 'env-test' });
  let stateA = createInitialState({ familyId: 'family-race' });
  stateA = addDish(stateA, { name: '清蒸鱼' }, '2026-08-02T10:00:00.000Z');
  let stateB = createInitialState({ familyId: 'family-race' });
  stateB = addDish(stateB, { name: '冬瓜汤' }, '2026-08-02T10:01:00.000Z');

  await Promise.all([syncA.save(stateA), syncB.save(stateB)]);
  const finalState = await syncA.load('family-race');

  assert.deepEqual(finalState.dishes.map((dish) => dish.name).sort(), ['冬瓜汤', '清蒸鱼']);
});

test('cloudbase merge preserves the newest rating and a soft deletion marker', () => {
  let remote = createInitialState({ familyId: 'family-rating' });
  remote = addDish(remote, { name: '清蒸鱼' }, '2026-08-02T10:00:00.000Z');
  const dishId = remote.dishes[0].id;
  remote = rateDish(remote, { dishId, memberId: 'member-local', rating: 'like' }, '2026-08-02T10:01:00.000Z');

  let local = createInitialState({ familyId: 'family-rating' });
  local = addDish(local, { id: dishId, name: '清蒸鱼' }, '2026-08-02T10:00:00.000Z');
  local = rateDish(local, { dishId, memberId: 'member-local', rating: 'dislike' }, '2026-08-03T10:01:00.000Z');
  local = deleteDish(local, { dishId }, '2026-08-04T10:01:00.000Z');

  const merged = mergeFamilyStates(remote, local);

  assert.equal(merged.dishRatings.length, 1);
  assert.equal(merged.dishRatings[0].rating, 'dislike');
  assert.equal(merged.dishes[0].status, 'deleted');
});

test('cloudbase merge never resurrects a soft-deleted dish from a stale active snapshot', () => {
  let remote = createInitialState({ familyId: 'family-durian' });
  remote = addDish(remote, {
    id: 'dish-durian',
    name: '榴莲',
  }, '2026-08-08T12:00:00.000Z');

  let local = createInitialState({ familyId: 'family-durian' });
  local = addDish(local, {
    id: 'dish-durian',
    name: '榴莲',
  }, '2026-08-01T12:00:00.000Z');
  local = deleteDish(local, { dishId: 'dish-durian' }, '2026-08-08T11:00:00.000Z');

  const merged = mergeFamilyStates(remote, local);

  assert.equal(merged.dishes[0].status, 'deleted');
  assert.equal(merged.dishes[0].deletedAt, '2026-08-08T11:00:00.000Z');
});

test('an explicit restore can win over a previously recorded deletion', () => {
  let remote = createInitialState({ familyId: 'family-restore' });
  remote = addDish(remote, {
    id: 'dish-restore',
    name: 'Dish',
  }, '2026-08-01T12:00:00.000Z');
  remote = deleteDish(remote, { dishId: 'dish-restore' }, '2026-08-08T10:00:00.000Z');

  let local = remote;
  local = require('../services/domain').restoreDish(
    local,
    { dishId: 'dish-restore' },
    '2026-08-08T11:00:00.000Z'
  );

  const merged = mergeFamilyStates(remote, local);

  assert.equal(merged.dishes[0].status, 'active');
  assert.equal(merged.dishes[0].restoredAt, '2026-08-08T11:00:00.000Z');
});

test('cloudbase merge keeps record reviews and does not resurrect a purged dish', () => {
  let remote = createInitialState({ familyId: 'family-review-merge' });
  remote = addDish(remote, { name: 'Tomato eggs' }, '2026-08-02T10:00:00.000Z');
  const dishId = remote.dishes[0].id;
  const recordId = remote.cookingRecords[0].id;
  remote = upsertRecordReview(remote, {
    dishId,
    recordId,
    memberId: 'member-local',
    stars: 3.5,
    text: 'remote',
  }, '2026-08-02T10:01:00.000Z');

  let local = remote;
  local = upsertRecordReview(local, {
    dishId,
    recordId,
    memberId: 'member-local',
    stars: 4.5,
    text: 'local latest',
  }, '2026-08-03T10:01:00.000Z');
  local = deleteDish(local, { dishId }, '2026-08-04T10:01:00.000Z');
  local = purgeDish(local, { dishId }, '2026-08-05T10:01:00.000Z');

  const merged = mergeFamilyStates(remote, local);

  assert.equal(merged.dishes.some((dish) => dish.id === dishId), false);
  assert.equal(merged.cookingRecords.some((record) => record.dishId === dishId), false);
  assert.equal(merged.recordReviews.some((review) => review.dishId === dishId), false);
  assert.equal(merged.purgedDishes[0].dishId, dishId);
});
