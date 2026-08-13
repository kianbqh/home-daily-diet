const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  DEFAULT_CONFIG,
  handleAction,
  main,
} = require('../cloudfunctions/recipe-assistant');
const { createRecipeRepository } = require('../cloudfunctions/recipe-assistant/repository');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}, options = {}) {
  const collections = new Map();
  Object.entries(seed).forEach(([name, records]) => {
    collections.set(name, new Map(Object.entries(records).map(([id, data]) => [id, clone(data)])));
  });

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const records = collections.get(name);
    return {
      doc(id) {
        return {
          async get() {
            return { data: records.has(id) ? clone(records.get(id)) : null };
          },
          async set({ data }) {
            rejectSystemId(data, 'set');
            records.set(id, { ...clone(data), _id: id });
            return { _id: id };
          },
        };
      },
      async add({ data }) {
        rejectSystemId(data, 'add');
        const id = `${name}-${records.size + 1}`;
        records.set(id, { ...clone(data), _id: id });
        return { _id: id };
      },
      where(filter) {
        let result = [...records.values()].filter((record) => Object.entries(filter).every(
          ([key, expected]) => record[key] === expected
        ));
        return {
          orderBy(field, direction) {
            const multiplier = direction === 'desc' ? -1 : 1;
            result.sort((left, right) => multiplier * (Number(left[field]) - Number(right[field])));
            return this;
          },
          limit(count) {
            result = result.slice(0, count);
            return this;
          },
          async get() {
            return { data: clone(result) };
          },
        };
      },
    };

    function rejectSystemId(data, operation) {
      if (options.rejectSystemId && Object.hasOwn(data || {}, '_id')) {
        const error = new Error(`${operation} cannot write _id`);
        error.errCode = '-501007';
        throw error;
      }
    }
  }

  const db = {
    collection,
    async runTransaction(callback) {
      return callback(db);
    },
    records(name) {
      return collections.get(name) || new Map();
    },
  };
  return db;
}

function familyState(familyId = 'family-a') {
  return {
    family: { id: familyId },
    dishes: [
      { id: 'dish-1', status: 'active' },
      { id: 'dish-deleted', status: 'deleted' },
    ],
    cookingRecords: [
      { id: 'record-1', familyId, dishId: 'dish-1' },
      { id: 'record-deleted', familyId, dishId: 'dish-deleted' },
    ],
    purgedDishes: [{ familyId, dishId: 'dish-purged', purgedAt: '2026-08-01T00:00:00.000Z' }],
  };
}

function baseSeed() {
  return {
    family_states: {
      'family-a': familyState('family-a'),
      'family-b': familyState('family-b'),
    },
    family_members: {
      'member-a': { _id: 'member-a', familyId: 'family-a', memberId: 'member-a', openid: 'openid-a', status: 'active' },
      'member-b': { _id: 'member-b', familyId: 'family-b', memberId: 'member-b', openid: 'openid-b', status: 'active' },
      'member-revoked': { _id: 'member-revoked', familyId: 'family-a', memberId: 'member-revoked', openid: 'openid-revoked', status: 'revoked' },
    },
  };
}

function dependencies(db, overrides = {}) {
  return {
    db,
    now: () => 100,
    logger: { error() {} },
    ...overrides,
  };
}

async function invoke(db, event, openid = 'openid-a', overrides = {}) {
  return handleAction(event, { OPENID: openid, requestId: 'request-1' }, dependencies(db, overrides));
}

test('uses the fixed server-only collection names', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    stateCollection: 'family_states',
    memberCollection: 'family_members',
    recordingCollection: 'recipe_recordings',
    draftCollection: 'recipe_drafts',
    recipeCollection: 'family_recipes',
    versionCollection: 'recipe_versions',
    usageCollection: 'recipe_usage_daily',
  });
});

test('denies a non-member even when event identity fields claim membership', async () => {
  const result = await invoke(createMemoryDatabase(baseSeed()), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
    openid: 'openid-a', memberId: 'member-a',
  }, 'openid-b');

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'NOT_MEMBER', message: '你还不是这个家庭的成员' },
  });
});

test('denies revoked memberships', async () => {
  const result = await invoke(createMemoryDatabase(baseSeed()), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
  }, 'openid-revoked');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_MEMBER');
});

test('purged tombstones deny every implemented and pending recipe action', async () => {
  const db = createMemoryDatabase(baseSeed());
  for (const action of ['getRecipe', 'listVersions', 'getVersion', 'getRecordWorkspace', 'createManualDraft']) {
    const result = await invoke(db, {
      action, familyId: 'family-a', dishId: 'dish-purged', recordId: 'record-1', versionId: 'version-1',
    });
    assert.equal(result.ok, false, action);
    assert.equal(result.error.code, 'DISH_PURGED', action);
  }
});

test('allows deleted-dish history reads but denies pending mutations', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-deleted': {
      _id: 'family-a|dish-deleted', familyId: 'family-a', dishId: 'dish-deleted', currentVersionId: 'version-deleted', currentVersionNumber: 1,
    },
  };
  seed.recipe_versions = {
    'version-deleted': { _id: 'version-deleted', familyId: 'family-a', dishId: 'dish-deleted', versionNumber: 1, recipe: { steps: [] } },
  };
  const db = createMemoryDatabase(seed);

  const recipe = await invoke(db, { action: 'getRecipe', familyId: 'family-a', dishId: 'dish-deleted' });
  const versions = await invoke(db, { action: 'listVersions', familyId: 'family-a', dishId: 'dish-deleted' });
  const version = await invoke(db, { action: 'getVersion', familyId: 'family-a', dishId: 'dish-deleted', versionId: 'version-deleted' });
  const workspace = await invoke(db, { action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-deleted', recordId: 'record-deleted' });
  const mutation = await invoke(db, { action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-deleted' });

  assert.equal(recipe.ok, true);
  assert.equal(versions.ok, true);
  assert.equal(version.ok, true);
  assert.equal(workspace.ok, true);
  assert.equal(mutation.error.code, 'DISH_DELETED');
});

test('requires a dish owned by the requested family', async () => {
  const result = await invoke(createMemoryDatabase(baseSeed()), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-missing',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DISH_NOT_FOUND');
});

test('returns a null recipe pair when no pointer exists', async () => {
  const result = await invoke(createMemoryDatabase(baseSeed()), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
  });

  assert.deepEqual(result, { ok: true, data: { pointer: null, version: null } });
});

test('getRecipe verifies pointer and version ownership and sanitizes sensitive fields', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-1': {
      _id: 'family-a|dish-1', familyId: 'family-a', dishId: 'dish-1', currentVersionId: 'version-2',
      currentVersionNumber: 2, openid: 'must-not-leak', tempFileURL: 'https://temporary.example/pointer',
    },
    'family-b|dish-1': { _id: 'family-b|dish-1', familyId: 'family-b', dishId: 'dish-1', currentVersionId: 'version-other' },
  };
  seed.recipe_versions = {
    'version-2': {
      _id: 'version-2', familyId: 'family-a', dishId: 'dish-1', versionNumber: 2,
      recipe: { familyNotes: ['safe'], nested: { openid: 'hidden', temporaryUrl: 'https://temporary.example/version' } },
    },
    'version-other': { _id: 'version-other', familyId: 'family-b', dishId: 'dish-1', versionNumber: 99, recipe: { secret: true } },
  };

  const result = await invoke(createMemoryDatabase(seed), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.data.pointer._id, 'family-a|dish-1');
  assert.equal(result.data.version._id, 'version-2');
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('temporary.example'), false);
  assert.equal(serialized.includes('version-other'), false);
});

test('treats a cross-family recipe pointer as absent', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-1': { _id: 'family-a|dish-1', familyId: 'family-b', dishId: 'dish-1', currentVersionId: 'version-other' },
  };
  seed.recipe_versions = {
    'version-other': { _id: 'version-other', familyId: 'family-b', dishId: 'dish-1', versionNumber: 1, recipe: { secret: true } },
  };

  const result = await invoke(createMemoryDatabase(seed), {
    action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
  });

  assert.deepEqual(result, { ok: true, data: { pointer: null, version: null } });
});

test('lists at most one hundred owned versions in descending version order', async () => {
  const seed = baseSeed();
  seed.recipe_versions = {};
  for (let number = 1; number <= 105; number += 1) {
    seed.recipe_versions[`version-${number}`] = {
      _id: `version-${number}`, familyId: 'family-a', dishId: 'dish-1', versionNumber: number, recipe: { number },
    };
  }
  seed.recipe_versions['other-family'] = {
    _id: 'other-family', familyId: 'family-b', dishId: 'dish-1', versionNumber: 999, recipe: { secret: true },
  };
  seed.recipe_versions['other-dish'] = {
    _id: 'other-dish', familyId: 'family-a', dishId: 'dish-deleted', versionNumber: 998, recipe: { secret: true },
  };

  const result = await invoke(createMemoryDatabase(seed), {
    action: 'listVersions', familyId: 'family-a', dishId: 'dish-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.versions.length, 100);
  assert.deepEqual(result.data.versions.slice(0, 3).map((item) => item.versionNumber), [105, 104, 103]);
  assert.equal(result.data.versions.at(-1).versionNumber, 6);
  assert.equal(JSON.stringify(result).includes('other-family'), false);
});

test('getVersion verifies both family and dish ownership', async () => {
  const seed = baseSeed();
  seed.recipe_versions = {
    'version-other-family': { _id: 'version-other-family', familyId: 'family-b', dishId: 'dish-1', versionNumber: 1 },
    'version-other-dish': { _id: 'version-other-dish', familyId: 'family-a', dishId: 'dish-deleted', versionNumber: 2 },
  };
  const db = createMemoryDatabase(seed);

  for (const versionId of ['version-other-family', 'version-other-dish', 'version-missing']) {
    const result = await invoke(db, {
      action: 'getVersion', familyId: 'family-a', dishId: 'dish-1', versionId,
    });
    assert.equal(result.ok, false, versionId);
    assert.equal(result.error.code, 'VERSION_NOT_FOUND', versionId);
  }
});

test('getRecordWorkspace requires a bound cooking record and returns only owned sanitized documents', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    'recording-1': {
      _id: 'recording-1', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      editedTranscript: 'safe transcript', openid: 'hidden', tempFileURL: 'https://temporary.example/audio',
    },
    'recording-other-family': { _id: 'recording-other-family', familyId: 'family-b', dishId: 'dish-1', recordId: 'record-1', sequence: 2, rawTranscript: 'secret' },
    'recording-other-record': { _id: 'recording-other-record', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-other', sequence: 3, rawTranscript: 'secret' },
  };
  seed.recipe_drafts = {
    'draft-1': { _id: 'draft-1', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', revision: 2, recipe: { tips: ['safe'] } },
    'draft-other': { _id: 'draft-other', familyId: 'family-b', dishId: 'dish-1', recordId: 'record-1', revision: 9, recipe: { secret: true } },
  };
  const db = createMemoryDatabase(seed);

  const result = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  });
  const denied = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-missing',
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.recordings.map((item) => item._id), ['recording-1']);
  assert.equal(result.data.draft._id, 'draft-1');
  assert.equal(serialized.includes('hidden'), false);
  assert.equal(serialized.includes('temporary.example'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(denied.error.code, 'RECORD_NOT_FOUND');
});

test('repository set operations strip CloudBase system ids and transaction delegates to the database', async () => {
  const db = createMemoryDatabase(baseSeed(), { rejectSystemId: true });
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);

  const draft = await repository.setDraft('draft-1', {
    _id: 'draft-1', familyId: 'family-a', dishId: 'dish-1', revision: 0,
  });
  const pointer = await repository.setRecipePointer('family-a', 'dish-1', {
    _id: 'forged-id', familyId: 'family-a', dishId: 'dish-1', currentVersionId: 'version-1',
  });
  const transactionValue = await repository.runTransaction(async (transactionRepository) => {
    const stored = await transactionRepository.getDraft({ familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-1' });
    return stored.revision + 1;
  });

  assert.equal(draft._id, 'draft-1');
  assert.equal(pointer._id, 'family-a|dish-1');
  assert.equal(transactionValue, 1);
});

test('main trusts only getWXContext OPENID and emits only the permitted error log fields', async () => {
  const db = createMemoryDatabase(baseSeed());
  const logs = [];
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    getWXContext() { return { OPENID: 'openid-b' }; },
    database() { return db; },
  };
  const originalLoad = Module._load;
  const originalError = console.error;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  console.error = (...args) => logs.push(args);

  try {
    const result = await main({
      action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
      openid: 'openid-a', memberId: 'member-a', transcript: 'must not be logged', recipe: { secret: true },
    }, { OPENID: 'openid-a', requestId: 'trusted-request-id' });

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'NOT_MEMBER', message: '你还不是这个家庭的成员' },
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].length, 1);
    assert.deepEqual(Object.keys(logs[0][0]).sort(), ['action', 'code', 'durationMs', 'requestId', 'stage'].sort());
    assert.deepEqual({ ...logs[0][0], durationMs: 0 }, {
      stage: 'authorize', action: 'getRecipe', code: 'NOT_MEMBER', requestId: 'trusted-request-id', durationMs: 0,
    });
    assert.equal(JSON.stringify(logs).includes('must not be logged'), false);
    assert.equal(JSON.stringify(logs).includes('secret'), false);
  } finally {
    Module._load = originalLoad;
    console.error = originalError;
  }
});
