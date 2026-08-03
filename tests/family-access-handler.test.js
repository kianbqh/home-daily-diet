const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const { handleAction } = require('../cloudfunctions/family-access');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}) {
  const collections = new Map();
  Object.entries(seed).forEach(([name, value]) => {
    collections.set(name, new Map(Object.entries(value).map(([id, data]) => [id, clone(data)])));
  });

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const records = collections.get(name);
    return {
      doc(id) {
        return {
          async get() {
            const data = records.get(id);
            return { data: data ? clone(data) : null };
          },
          async set({ data }) {
            records.set(id, clone(data));
            return { _id: id };
          },
          async update({ data }) {
            const next = { ...(records.get(id) || {}), ...clone(data) };
            records.set(id, next);
            return { _id: id };
          },
        };
      },
      async add({ data }) {
        const id = data._id || `${name}-${records.size + 1}`;
        records.set(id, { ...clone(data), _id: id });
        return { _id: id };
      },
      where(filter) {
        let query = [...records.values()].filter((record) => Object.entries(filter).every(
          ([key, expected]) => record[key] === expected
        ));
        return {
          limit(count) {
            query = query.slice(0, count);
            return this;
          },
          async get() {
            return { data: clone(query) };
          },
        };
      },
    };
  }

  return {
    collection,
    records(name) {
      return collections.get(name) || new Map();
    },
  };
}

function familyState(familyId) {
  return createInitialState({ familyId, familyName: 'Test Family' });
}

async function invoke(db, event, openid, options = {}) {
  return handleAction(event, { OPENID: openid }, db, {
    now: '2026-08-04T10:00:00.000Z',
    randomBytes: () => Buffer.from('abcdefghijklmnop', 'utf8'),
    ...options,
  });
}

test('bootstrap binds the first caller and does not return openid', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });

  const result = await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.member, {
    memberId: 'member-1',
    displayName: 'Dad',
    familyId: 'family-1',
    status: 'active',
  });
  assert.equal(result.data.member.openid, undefined);
});

test('createInvite and acceptInvite create a shared member', async () => {
  const state = familyState('family-1');
  const db = createMemoryDatabase({
    family_states: { 'family-1': state },
  });

  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const invite = await invoke(db, {
    action: 'createInvite',
    familyId: 'family-1',
  }, 'openid-1');

  assert.equal(invite.ok, true);
  assert.equal(invite.data.invite.code.length, 6);
  assert.equal(invite.data.invite.code.includes('0'), false);

  const joined = await invoke(db, {
    action: 'acceptInvite',
    code: invite.data.invite.code,
    memberId: 'member-2',
    displayName: 'Xiaoming',
  }, 'openid-2');

  assert.equal(joined.ok, true);
  assert.equal(joined.data.state.family.id, 'family-1');
  assert.equal(joined.data.state.members.some((member) => member.id === 'member-2'), true);
  assert.equal(joined.data.member.openid, undefined);
});

test('non-members cannot load a family state', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await assert.rejects(
    () => invoke(db, { action: 'load', familyId: 'family-1' }, 'openid-outsider'),
    (error) => error.code === 'NOT_MEMBER'
  );
});

test('revoked invite cannot be accepted', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const invite = await invoke(db, { action: 'createInvite', familyId: 'family-1' }, 'openid-1');
  await invoke(db, { action: 'revokeInvite', familyId: 'family-1' }, 'openid-1');

  await assert.rejects(
    () => invoke(db, {
      action: 'acceptInvite',
      code: invite.data.invite.code,
      memberId: 'member-2',
      displayName: 'Xiaoming',
    }, 'openid-2'),
    (error) => error.code === 'INVITE_REVOKED'
  );
});
