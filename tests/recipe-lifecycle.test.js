const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONFIG,
  cleanupExpiredWorkspaces,
  handleAction,
} = require('../cloudfunctions/recipe-assistant');
const { createRecipeRepository } = require('../cloudfunctions/recipe-assistant/repository');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createLifecycleDatabase(seed = {}) {
  const collections = new Map(Object.entries(seed).map(([name, records]) => [
    name,
    new Map(Object.entries(records).map(([id, value]) => [id, { ...clone(value), _id: id }])),
  ]));
  const queryLog = [];
  const command = {
    lte(value) {
      return { __operator: 'lte', value };
    },
    gt(value) {
      return { __operator: 'gt', value };
    },
  };

  function records(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function matches(actual, expected) {
    if (expected && expected.__operator === 'lte') {
      return actual != null && Number(actual) <= Number(expected.value);
    }
    if (expected && expected.__operator === 'gt') {
      return actual != null && String(actual) > String(expected.value);
    }
    return actual === expected;
  }

  function compare(left, right) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left).localeCompare(String(right));
  }

  function collection(name) {
    const values = records(name);
    return {
      doc(id) {
        return {
          async get() {
            return { data: values.has(id) ? clone(values.get(id)) : null };
          },
          async set({ data }) {
            values.set(id, { ...clone(data), _id: id });
            return { _id: id };
          },
          async remove() {
            const removed = values.delete(id) ? 1 : 0;
            return { stats: { removed } };
          },
        };
      },
      async add({ data }) {
        const id = `${name}-${values.size + 1}`;
        values.set(id, { ...clone(data), _id: id });
        return { _id: id };
      },
      where(filter) {
        let result = [...values.values()].filter((value) => Object.entries(filter).every(
          ([key, expected]) => matches(value[key], expected)
        ));
        let requestedLimit = 100;
        return {
          orderBy(field, direction) {
            const multiplier = direction === 'desc' ? -1 : 1;
            result.sort((left, right) => multiplier * compare(left[field], right[field]));
            return this;
          },
          limit(limit) {
            requestedLimit = Number(limit);
            result = result.slice(0, requestedLimit);
            return this;
          },
          async get() {
            queryLog.push({ name, filter: clone(filter), limit: requestedLimit });
            return { data: clone(result) };
          },
        };
      },
    };
  }

  const db = {
    command,
    collection,
    records,
    queryLog,
    async runTransaction(callback) {
      return callback(db);
    },
  };
  return db;
}

function familyState(status = 'active', purgedDishes = []) {
  return {
    family: { id: 'family-a', name: 'Lifecycle family' },
    dishes: [{ id: 'dish-1', familyId: 'family-a', name: '番茄炒蛋', status }],
    cookingRecords: [{ id: 'record-1', familyId: 'family-a', dishId: 'dish-1' }],
    purgedDishes,
  };
}

function baseSeed(status = 'active', purgedDishes = []) {
  return {
    family_states: { 'family-a': familyState(status, purgedDishes) },
    family_members: {
      'member-a': {
        familyId: 'family-a', memberId: 'member-a', openid: 'openid-a', status: 'active',
      },
    },
    family_recipes: {
      'family-a|dish-1': {
        familyId: 'family-a', dishId: 'dish-1', currentVersionId: 'version-1', currentVersionNumber: 1,
      },
    },
    recipe_versions: {
      'version-1': { familyId: 'family-a', dishId: 'dish-1', versionNumber: 1, recipe: { title: '番茄炒蛋' } },
    },
    recipe_drafts: {
      'draft-1': { familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', status: 'editing' },
    },
    recipe_recordings: {
      'recording-1': {
        familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'audio',
        status: 'ready', editedTranscript: '少放盐', fileId: '', sequence: 1,
      },
    },
    recipe_usage_daily: {},
  };
}

function invoke(db, event, overrides = {}) {
  return handleAction(event, { OPENID: 'openid-a', requestId: 'lifecycle-request' }, {
    db,
    now: () => 1_786_000_000_000,
    logger: { error() {} },
    ...overrides,
  });
}

test('archived dishes keep recipe history readable, reject every mutation, and edit again after restore', async () => {
  const db = createLifecycleDatabase(baseSeed('deleted'));

  const recipe = await invoke(db, { action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1' });
  const workspace = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  });
  assert.equal(recipe.ok, true);
  assert.equal(recipe.data.version._id, 'version-1');
  assert.equal(workspace.ok, true);
  assert.equal(workspace.data.recordings[0]._id, 'recording-1');

  const mutations = [
    'createManualDraft', 'organizeDraft', 'updateDraft', 'confirmDraft',
    'reserveRecording', 'submitRecording', 'refreshWorkspace', 'addManualText',
    'updateTranscript', 'deleteRecordingAudio', 'deleteRecording',
    'attachRecordWorkspace', 'cancelRecordWorkspace',
  ];
  for (const action of mutations) {
    const result = await invoke(db, { action, familyId: 'family-a', dishId: 'dish-1' });
    assert.equal(result.error.code, 'DISH_ARCHIVED', action);
  }

  db.records('family_states').get('family-a').dishes[0].status = 'active';
  const restored = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.data.draft.status, 'editing');
});

test('purge requires a tombstone, blocks reads first, and converges without deleting foreign files or usage', async () => {
  const seed = baseSeed('deleted');
  seed.recipe_recordings = {
    own: {
      familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'audio', status: 'ready',
      fileId: 'cloud://env/families/family-a/recipe-audio/own.mp3', draftExpiresAt: null,
    },
    foreign: {
      familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'audio', status: 'ready',
      fileId: 'cloud://env/families/family-b/recipe-audio/foreign.mp3', draftExpiresAt: null,
    },
    otherDish: { familyId: 'family-a', dishId: 'dish-2', sourceType: 'audio', fileId: '' },
    otherFamily: { familyId: 'family-b', dishId: 'dish-1', sourceType: 'audio', fileId: '' },
  };
  seed.recipe_drafts.other = { familyId: 'family-a', dishId: 'dish-2', status: 'editing' };
  seed.recipe_versions.other = { familyId: 'family-a', dishId: 'dish-2', versionNumber: 1 };
  seed.recipe_usage_daily.usage = { familyId: 'family-a', asrSeconds: 180, organizeCalls: 1 };
  const db = createLifecycleDatabase(seed);
  let failOwnFile = true;
  const deletedFileLists = [];
  const fileApi = {
    async deleteFile({ fileList }) {
      deletedFileLists.push([...fileList]);
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          status: failOwnFile ? -1 : 0,
          errMsg: failOwnFile ? 'temporary storage failure' : 'ok',
        })),
      };
    },
  };

  const absent = await invoke(db, {
    action: 'purgeDishArtifacts', familyId: 'family-a', dishId: 'dish-1',
  }, { fileApi });
  assert.equal(absent.error.code, 'PURGE_NOT_CONFIRMED');

  const state = db.records('family_states').get('family-a');
  state.dishes = [];
  state.purgedDishes = [{ familyId: 'family-a', dishId: 'dish-1', purgedAt: '2026-08-18T00:00:00.000Z' }];
  const blocked = await invoke(db, { action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1' });
  assert.equal(blocked.error.code, 'DISH_PURGED');

  const partial = await invoke(db, {
    action: 'purgeDishArtifacts', familyId: 'family-a', dishId: 'dish-1',
  }, { fileApi });
  assert.equal(partial.ok, true);
  assert.equal(partial.data.pendingFiles, 1);
  assert.equal(db.records('recipe_recordings').has('own'), true);
  assert.equal(db.records('recipe_recordings').get('own').cleanupPending, true);
  assert.equal(db.records('recipe_recordings').has('foreign'), false);
  assert.equal(db.records('recipe_recordings').has('otherDish'), true);
  assert.equal(db.records('recipe_recordings').has('otherFamily'), true);
  assert.equal(db.records('recipe_usage_daily').has('usage'), true);
  assert.deepEqual(deletedFileLists, [['cloud://env/families/family-a/recipe-audio/own.mp3']]);
  assert.deepEqual(Object.keys(partial.data).sort(), ['deletedDocuments', 'deletedFiles', 'pendingFiles']);
  assert.equal(JSON.stringify(partial).includes('family-b/recipe-audio'), false);

  failOwnFile = false;
  const completed = await invoke(db, {
    action: 'purgeDishArtifacts', familyId: 'family-a', dishId: 'dish-1',
  }, { fileApi });
  assert.equal(completed.ok, true);
  assert.equal(completed.data.pendingFiles, 0);
  assert.equal(completed.data.deletedFiles, 1);
  assert.equal(db.records('recipe_recordings').has('own'), false);
  assert.equal([...db.records('recipe_drafts').values()].some((item) => item.dishId === 'dish-1'), false);
  assert.equal([...db.records('family_recipes').values()].some((item) => item.dishId === 'dish-1'), false);
  assert.equal([...db.records('recipe_versions').values()].some((item) => item.dishId === 'dish-1'), false);
  assert.equal(db.records('recipe_usage_daily').has('usage'), true);
});

test('purge advances beyond a full page of persistent file failures', async () => {
  const seed = baseSeed('deleted', [
    { familyId: 'family-a', dishId: 'dish-1', purgedAt: '2026-08-18T00:00:00.000Z' },
  ]);
  seed.family_states['family-a'].dishes = [];
  seed.recipe_recordings = {};
  for (let index = 0; index < 100; index += 1) {
    const id = `blocked-${String(index).padStart(3, '0')}`;
    seed.recipe_recordings[id] = {
      familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'audio', status: 'ready',
      fileId: `cloud://env/families/family-a/recipe-audio/${id}.mp3`, draftExpiresAt: null,
    };
  }
  seed.recipe_recordings['ready-100'] = {
    familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'manual_text',
    status: 'ready', fileId: '', draftExpiresAt: null,
  };
  const db = createLifecycleDatabase(seed);
  const fileApi = {
    async deleteFile({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          fileID, status: -1, errMsg: 'persistent storage failure',
        })),
      };
    },
  };

  const result = await invoke(db, {
    action: 'purgeDishArtifacts', familyId: 'family-a', dishId: 'dish-1',
  }, { fileApi });

  assert.equal(result.ok, true);
  assert.equal(result.data.pendingFiles, 100);
  assert.equal(db.records('recipe_recordings').has('ready-100'), false);
  assert.equal(db.records('recipe_recordings').has('blocked-000'), true);
});

test('opportunistic cleanup skips expired artifacts once their workspace claim is attached', async () => {
  const now = 1_786_000_000_000;
  const claimId = 'workspace-family-a-dish-1-record-1';
  const db = createLifecycleDatabase({
    recipe_recordings: {
      [claimId]: {
        familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
        sourceType: 'workspace_state', workspaceClaim: true, status: 'attached', draftExpiresAt: null,
      },
      'expired-after-attach': {
        familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
        sourceType: 'audio', status: 'ready', fileId: '', draftExpiresAt: now - 1,
      },
    },
    recipe_drafts: {
      'draft-expired-after-attach': {
        familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
        status: 'editing', draftExpiresAt: now - 1,
      },
    },
  });
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);

  const result = await cleanupExpiredWorkspaces(repository, null, now, 20);

  assert.equal(result.processed, 0);
  assert.equal(db.records('recipe_recordings').has('expired-after-attach'), true);
  assert.equal(db.records('recipe_drafts').has('draft-expired-after-attach'), true);
});

test('opportunistic cleanup processes at most twenty indexed expired artifacts and retries failed files', async () => {
  const now = 1_786_000_000_000;
  const recordings = {};
  for (let index = 0; index < 21; index += 1) {
    const id = `expired-${String(index).padStart(2, '0')}`;
    recordings[id] = {
      familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sourceType: 'audio', status: 'ready',
      fileId: index === 0 ? 'cloud://env/families/family-a/recipe-audio/expired-00.mp3' : '',
      draftExpiresAt: now - 1_000 + index,
    };
  }
  recordings.attached = {
    familyId: 'family-a', dishId: 'dish-1', sourceType: 'audio', fileId: '', draftExpiresAt: null,
  };
  recordings.future = {
    familyId: 'family-a', dishId: 'dish-1', sourceType: 'audio', fileId: '', draftExpiresAt: now + 1,
  };
  const db = createLifecycleDatabase({
    recipe_recordings: recordings,
    recipe_drafts: {
      'expired-draft': { familyId: 'family-a', dishId: 'dish-1', status: 'editing', draftExpiresAt: now - 1 },
    },
  });
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  let failFile = true;
  const fileApi = {
    async deleteFile() {
      if (failFile) throw new Error('temporary file failure');
      return {};
    },
  };

  assert.equal(typeof cleanupExpiredWorkspaces, 'function');
  const first = await cleanupExpiredWorkspaces(repository, fileApi, now, 20);
  assert.equal(first.processed, 20);
  assert.equal(first.pendingFiles, 1);
  assert.equal(db.records('recipe_recordings').get('expired-00').cleanupPending, true);
  assert.equal(db.records('recipe_drafts').has('expired-draft'), true);
  assert.equal(db.queryLog.every((entry) => Object.hasOwn(entry.filter, 'draftExpiresAt')), true);
  assert.equal(db.queryLog.every((entry) => entry.limit <= 20), true);

  failFile = false;
  const second = await cleanupExpiredWorkspaces(repository, fileApi, now, 20);
  assert.equal(second.pendingFiles, 0);
  assert.equal([...db.records('recipe_recordings').values()].filter(
    (item) => item.draftExpiresAt != null && item.draftExpiresAt <= now
  ).length, 0);
  assert.equal(db.records('recipe_drafts').has('expired-draft'), false);
  assert.equal(db.records('recipe_recordings').has('attached'), true);
  assert.equal(db.records('recipe_recordings').has('future'), true);
});
