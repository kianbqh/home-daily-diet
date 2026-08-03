const test = require('node:test');
const assert = require('node:assert/strict');

const { addDish, createInitialState } = require('../services/domain');
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
