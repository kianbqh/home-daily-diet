const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialState } = require('../services/domain');
const {
  handleAction,
  mergeFamilyStates,
  resolveOpenId,
  runtimeErrorCode,
} = require('../cloudfunctions/family-access');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}, options = {}) {
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
            if (!data && options.throwOnMissing && name === 'family_states') {
              const error = new Error('document not found');
              error.errCode = -1;
              throw error;
            }
            return { data: data ? clone(data) : null };
          },
          async set({ data }) {
            if (options.rejectSystemId && Object.prototype.hasOwnProperty.call(data || {}, '_id')) {
              const error = new Error('document.set:fail -501007 invalid parameters. cannot update _id');
              error.errCode = '-501007';
              throw error;
            }
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
        if (options.rejectSystemId && Object.prototype.hasOwnProperty.call(data || {}, '_id')) {
          const error = new Error('document.add:fail -501007 invalid parameters. cannot set _id');
          error.errCode = '-501007';
          throw error;
        }
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

test('resolves the trusted mini-program identity returned by getWXContext', () => {
  assert.equal(resolveOpenId({ OPENID: 'context-openid' }, { OPENID: 'wx-openid' }), 'wx-openid');
  assert.equal(resolveOpenId({}, { OPENID: 'wx-openid' }), 'wx-openid');
  assert.equal(resolveOpenId({ OPENID: 'context-openid' }, {}), 'context-openid');
  assert.equal(resolveOpenId({ userInfo: { openId: 'event-openid' } }, {}), '');
});

test('keeps CloudBase runtime error codes available for diagnosis', () => {
  assert.equal(runtimeErrorCode({ errCode: -502005 }), '-502005');
  assert.equal(runtimeErrorCode({ code: 'DATABASE_PERMISSION_DENIED' }), 'DATABASE_PERMISSION_DENIED');
  assert.equal(runtimeErrorCode(new Error('unknown failure')), 'INTERNAL_ERROR');
});

test('cloud function merge also keeps deletion tombstones and explicit restores deterministic', () => {
  const remote = {
    family: { id: 'family-merge' },
    dishes: [{ id: 'dish-1', status: 'active', updatedAt: '2026-08-08T12:00:00.000Z' }],
  };
  const localDeleted = {
    family: { id: 'family-merge' },
    dishes: [{
      id: 'dish-1',
      status: 'deleted',
      updatedAt: '2026-08-08T11:00:00.000Z',
      deletedAt: '2026-08-08T11:00:00.000Z',
    }],
  };
  const deleted = mergeFamilyStates(remote, localDeleted);
  assert.equal(deleted.dishes[0].status, 'deleted');

  const localRestored = {
    family: { id: 'family-merge' },
    dishes: [{
      id: 'dish-1',
      status: 'active',
      restoredAt: '2026-08-08T13:00:00.000Z',
      updatedAt: '2026-08-08T13:00:00.000Z',
    }],
  };
  const restored = mergeFamilyStates(deleted, localRestored);
  assert.equal(restored.dishes[0].status, 'active');
  assert.equal(restored.dishes[0].restoredAt, '2026-08-08T13:00:00.000Z');
});

test('cloud function merge keeps newer remote family and member profiles', () => {
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

test('cloud function merge keeps remote family and member profiles on equal timestamps', () => {
  const remote = createInitialState({
    familyId: 'family-profile-tie',
    familyName: '云端家庭',
    memberId: 'member-1',
    memberName: '云端成员',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  remote.family.updatedAt = '2026-08-09T10:00:00.000Z';
  remote.members[0].updatedAt = '2026-08-09T10:00:00.000Z';

  const local = createInitialState({
    familyId: 'family-profile-tie',
    familyName: '本地家庭',
    memberId: 'member-1',
    memberName: '本地成员',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  local.family.updatedAt = '2026-08-09T10:00:00.000Z';
  local.members[0].updatedAt = '2026-08-09T10:00:00.000Z';

  const merged = mergeFamilyStates(remote, local);
  assert.equal(merged.family.name, '云端家庭');
  assert.equal(merged.members[0].displayName, '云端成员');
});

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

test('first cloud save treats a missing family state document as an empty state', async () => {
  const db = createMemoryDatabase({}, { throwOnMissing: true });
  const state = familyState('family-new');

  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-new',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const result = await invoke(db, {
    action: 'save',
    familyId: 'family-new',
    state,
  }, 'openid-1');

  assert.equal(result.ok, true);
  assert.equal(result.data.state.family.id, 'family-new');
});

test('database writes strip CloudBase system ids before set and add', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  }, { rejectSystemId: true });

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

test('acceptInvite versions a joined member and preserves a later rename through merge', async () => {
  const state = createInitialState({
    familyId: 'family-1',
    familyName: 'Test Family',
    memberId: 'member-1',
    memberName: 'Dad',
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  const db = createMemoryDatabase({
    family_states: { 'family-1': state },
  });

  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1', { now: '2026-08-02T00:00:00.000Z' });
  const invite = await invoke(db, {
    action: 'createInvite',
    familyId: 'family-1',
  }, 'openid-1', { now: '2026-08-02T01:00:00.000Z' });

  const joined = await invoke(db, {
    action: 'acceptInvite',
    code: invite.data.invite.code,
    memberId: 'member-2',
    displayName: 'Xiaoming',
  }, 'openid-2', { now: '2026-08-03T00:00:00.000Z' });
  const joinedMember = joined.data.state.members.find((member) => member.id === 'member-2');
  assert.equal(joinedMember.joinedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(joinedMember.updatedAt, '2026-08-03T00:00:00.000Z');

  const renamed = await invoke(db, {
    action: 'acceptInvite',
    code: invite.data.invite.code,
    memberId: 'member-2',
    displayName: 'Little Ming',
  }, 'openid-2', { now: '2026-08-04T00:00:00.000Z' });
  const renamedMember = renamed.data.state.members.find((member) => member.id === 'member-2');
  assert.equal(renamedMember.displayName, 'Little Ming');
  assert.equal(renamedMember.updatedAt, '2026-08-04T00:00:00.000Z');
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

test('resolves only a member family image path and denies other requested files', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');

  const resolved = await invoke(db, {
    action: 'resolveFiles',
    familyId: 'family-1',
    fileIds: [
      'cloud://env/family-meals/family-1/photo.jpg',
      'cloud://env/family-meals/family-2/private.jpg',
    ],
  }, 'openid-1', {
    fileApi: {
      async getTempFileURL({ fileList }) {
        return {
          fileList: fileList.map((fileID) => ({
            fileID,
            tempFileURL: `https://cdn/${fileID.split('/').pop()}`,
          })),
        };
      },
    },
  });

  assert.equal(resolved.data.files[0].tempFileURL, 'https://cdn/photo.jpg');
  assert.equal(resolved.data.files[1].code, 'FILE_ACCESS_DENIED');
});

test('rejects prefixed and nested family roots without calling the file SDK', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  let fileApiCalls = 0;
  const fileIds = [
    'cloud://env/other/family-meals/family-1/photo.jpg',
    'cloud://env/family-meals/family-2/nested/family-meals/family-1/private.jpg',
  ];

  const resolved = await invoke(db, {
    action: 'resolveFiles',
    familyId: 'family-1',
    fileIds,
  }, 'openid-1', {
    fileApi: {
      async getTempFileURL() {
        fileApiCalls += 1;
        return { fileList: [] };
      },
    },
  });

  assert.equal(fileApiCalls, 0);
  assert.deepEqual(resolved.data.files, fileIds.map((fileID) => ({
    fileID,
    tempFileURL: '',
    code: 'FILE_ACCESS_DENIED',
  })));
});

test('preserves duplicate resolveFiles results in original request order', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const first = 'cloud://env/family-meals/family-1/first.jpg';
  const second = 'cloud://env/family-meals/family-1/second.jpg';
  let requestedFromSdk = [];

  const resolved = await invoke(db, {
    action: 'resolveFiles',
    familyId: 'family-1',
    fileIds: [first, second, first],
  }, 'openid-1', {
    fileApi: {
      async getTempFileURL({ fileList }) {
        requestedFromSdk = fileList;
        return {
          fileList: fileList.map((fileID) => ({
            fileID,
            tempFileURL: `https://cdn/${fileID.split('/').pop()}`,
          })),
        };
      },
    },
  });

  assert.deepEqual(requestedFromSdk, [first, second]);
  assert.deepEqual(resolved.data.files.map((file) => file.fileID), [first, second, first]);
  assert.deepEqual(resolved.data.files.map((file) => file.tempFileURL), [
    'https://cdn/first.jpg',
    'https://cdn/second.jpg',
    'https://cdn/first.jpg',
  ]);
});

test('keeps denied files denied when the SDK returns only partial file results', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const successful = 'cloud://env/family-meals/family-1/photo.jpg';
  const failed = 'cloud://env/family-meals/family-1/missing.jpg';
  const denied = 'cloud://env/family-meals/family-2/private.jpg';

  const resolved = await invoke(db, {
    action: 'resolveFiles',
    familyId: 'family-1',
    fileIds: [successful, failed, denied],
  }, 'openid-1', {
    fileApi: {
      async getTempFileURL() {
        return {
          fileList: [
            { fileID: successful, tempFileURL: 'https://cdn/photo.jpg' },
            { fileID: failed, code: 'FILE_NOT_FOUND', tempFileURL: '' },
          ],
        };
      },
    },
  });

  assert.equal(resolved.data.files[0].tempFileURL, 'https://cdn/photo.jpg');
  assert.equal(resolved.data.files[1].code, 'FILE_RESOLVE_FAILED');
  assert.equal(resolved.data.files[2].code, 'FILE_ACCESS_DENIED');
});

test('converts rejected SDK lookups into per-file failures without overriding denial', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');
  const allowed = 'cloud://env/family-meals/family-1/photo.jpg';
  const denied = 'cloud://env/family-meals/family-2/private.jpg';

  const resolved = await invoke(db, {
    action: 'resolveFiles',
    familyId: 'family-1',
    fileIds: [allowed, denied],
  }, 'openid-1', {
    fileApi: {
      async getTempFileURL() {
        throw new Error('storage unavailable');
      },
    },
  });

  assert.equal(resolved.data.files[0].code, 'FILE_RESOLVE_FAILED');
  assert.equal(resolved.data.files[1].code, 'FILE_ACCESS_DENIED');
});

test('non-members cannot resolve family image URLs', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });

  await assert.rejects(
    () => invoke(db, {
      action: 'resolveFiles',
      familyId: 'family-1',
      fileIds: ['cloud://env/family-meals/family-1/photo.jpg'],
    }, 'openid-outsider'),
    (error) => error.code === 'NOT_MEMBER'
  );
});

test('rejects resolveFiles requests with more than fifty unique cloud file IDs', async () => {
  const db = createMemoryDatabase({
    family_states: { 'family-1': familyState('family-1') },
  });
  await invoke(db, {
    action: 'bootstrap',
    familyId: 'family-1',
    memberId: 'member-1',
    displayName: 'Dad',
  }, 'openid-1');

  await assert.rejects(
    () => invoke(db, {
      action: 'resolveFiles',
      familyId: 'family-1',
      fileIds: Array.from({ length: 51 }, (_, index) => `cloud://env/family-meals/family-1/${index}.jpg`),
    }, 'openid-1'),
    (error) => error.code === 'FILE_LIMIT_EXCEEDED'
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
