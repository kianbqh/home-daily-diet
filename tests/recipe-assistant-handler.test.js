const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const validRecipe = require('./fixtures/recipe-contract.json');

const {
  DEFAULT_CONFIG,
  RECORD_ACTION_CONTRACTS,
  RECORD_ID_ACTIONS,
  RECORD_SCOPED_ACTIONS,
  handleAction,
  main,
} = require('../cloudfunctions/recipe-assistant');
const { createRecipeRepository } = require('../cloudfunctions/recipe-assistant/repository');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}, options = {}) {
  const collections = new Map();
  let transactionCount = 0;
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
      transactionCount += 1;
      if (typeof options.beforeTransaction === 'function') {
        await options.beforeTransaction(db, transactionCount);
      }
      return callback(db);
    },
    records(name) {
      return collections.get(name) || new Map();
    },
    transactionCount() {
      return transactionCount;
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

test('fails closed on blank trusted identity before an empty-openid member can authorize', async () => {
  const seed = baseSeed();
  seed.family_members['malformed-empty-openid'] = {
    _id: 'malformed-empty-openid', familyId: 'family-a', memberId: 'malformed', openid: '', status: 'active',
  };

  for (const openid of ['', '   ']) {
    const result = await invoke(createMemoryDatabase(seed), {
      action: 'getRecipe', familyId: 'family-a', dishId: 'dish-1',
      openid: 'openid-a', memberId: 'member-a',
    }, openid);

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: '无法确认登录身份' },
    });
  }
});

test('defines every record-scoped action and the actions whose contract carries recordId', () => {
  assert.deepEqual(RECORD_ACTION_CONTRACTS, {
    recordId: [
      'getRecordWorkspace', 'reserveRecording', 'refreshWorkspace', 'addManualText',
      'attachRecordWorkspace', 'cancelRecordWorkspace',
    ],
    recordingId: [
      'submitRecording', 'updateTranscript', 'deleteRecordingAudio', 'deleteRecording',
    ],
    draftId: ['organizeDraft', 'getDraft', 'updateDraft', 'confirmDraft'],
  });
  assert.deepEqual([...RECORD_SCOPED_ACTIONS].sort(), [
    'addManualText',
    'attachRecordWorkspace',
    'cancelRecordWorkspace',
    'confirmDraft',
    'deleteRecording',
    'deleteRecordingAudio',
    'getDraft',
    'getRecordWorkspace',
    'organizeDraft',
    'refreshWorkspace',
    'reserveRecording',
    'submitRecording',
    'updateDraft',
    'updateTranscript',
  ]);
  assert.deepEqual([...RECORD_ID_ACTIONS].sort(), [
    'addManualText',
    'attachRecordWorkspace',
    'cancelRecordWorkspace',
    'getRecordWorkspace',
    'refreshWorkspace',
    'reserveRecording',
  ]);
});

test('pending direct-record actions verify cross-dish and cross-family record ownership before rejection', async () => {
  const seed = baseSeed();
  seed.family_states['family-b'].cookingRecords.push({
    id: 'record-family-b-only', familyId: 'family-b', dishId: 'dish-1',
  });
  const db = createMemoryDatabase(seed);
  const actions = [
    ['getRecordWorkspace', 'success'],
    ['reserveRecording', 'ACTION_INVALID'],
    ['refreshWorkspace', 'ACTION_INVALID'],
    ['addManualText', 'ACTION_INVALID'],
    ['attachRecordWorkspace', 'ACTION_INVALID'],
    ['cancelRecordWorkspace', 'ACTION_INVALID'],
  ];

  for (const [action, ownedOutcome] of actions) {
    const missing = await invoke(db, { action, familyId: 'family-a', dishId: 'dish-1' });
    assert.equal(missing.error.code, 'RECORD_REQUIRED', `${action}: missing`);

    for (const recordId of ['record-deleted', 'record-family-b-only']) {
      const denied = await invoke(db, {
        action, familyId: 'family-a', dishId: 'dish-1', recordId,
      });
      assert.equal(denied.error.code, 'RECORD_NOT_FOUND', `${action}: ${recordId}`);
    }

    const owned = await invoke(db, {
      action, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    });
    assert.equal(ownedOutcome === 'success' ? owned.ok : owned.error.code, ownedOutcome === 'success' ? true : ownedOutcome, action);
  }
});

test('recordingId actions derive record ownership from the owned recording and ignore forged event.recordId', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    'recording-owned': { _id: 'recording-owned', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1' },
    'recording-other-dish': { _id: 'recording-other-dish', familyId: 'family-a', dishId: 'dish-deleted', recordId: 'record-deleted' },
    'recording-other-family': { _id: 'recording-other-family', familyId: 'family-b', dishId: 'dish-1', recordId: 'record-1' },
    'recording-broken-binding': { _id: 'recording-broken-binding', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-deleted' },
  };
  const db = createMemoryDatabase(seed);
  const actions = ['submitRecording', 'updateTranscript', 'deleteRecordingAudio', 'deleteRecording'];

  for (const action of actions) {
    const missing = await invoke(db, {
      action, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    });
    assert.equal(missing.error.code, 'RECORDING_REQUIRED', `${action}: missing`);

    for (const recordingId of ['recording-missing', 'recording-other-dish', 'recording-other-family']) {
      const denied = await invoke(db, {
        action, familyId: 'family-a', dishId: 'dish-1', recordingId,
        recordId: 'record-1',
      });
      assert.equal(denied.error.code, 'RECORDING_NOT_FOUND', `${action}: ${recordingId}`);
    }

    const brokenBinding = await invoke(db, {
      action, familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-broken-binding',
      recordId: 'record-1',
    });
    assert.equal(brokenBinding.error.code, 'RECORD_NOT_FOUND', `${action}: trusted recording binding`);

    const owned = await invoke(db, {
      action, familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-owned',
      recordId: 'record-deleted',
    });
    assert.equal(owned.error.code, 'ACTION_INVALID', `${action}: forged recordId ignored`);
  }
});

test('organizeDraft derives optional record ownership from the owned draft and ignores forged authorization inputs', async () => {
  const seed = baseSeed();
  seed.recipe_drafts = {
    'draft-manual': { _id: 'draft-manual', familyId: 'family-a', dishId: 'dish-1', recordId: '', revision: 0 },
    'draft-record': { _id: 'draft-record', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', revision: 0 },
    'draft-other-dish': { _id: 'draft-other-dish', familyId: 'family-a', dishId: 'dish-deleted', recordId: 'record-deleted', revision: 0 },
    'draft-other-family': { _id: 'draft-other-family', familyId: 'family-b', dishId: 'dish-1', recordId: 'record-1', revision: 0 },
    'draft-broken-binding': { _id: 'draft-broken-binding', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-deleted', revision: 0 },
  };
  const db = createMemoryDatabase(seed);

  const cases = [
    [{}, 'DRAFT_REQUIRED', 'missing'],
    [{ draftId: 'draft-missing', recordId: 'record-1' }, 'DRAFT_NOT_FOUND', 'missing document'],
    [{ draftId: 'draft-other-dish', recordId: 'record-1', sourceRecordingIds: ['recording-owned'] }, 'DRAFT_NOT_FOUND', 'foreign dish'],
    [{ draftId: 'draft-other-family', recordId: 'record-1', sourceRecordingIds: ['recording-owned'] }, 'DRAFT_NOT_FOUND', 'foreign family'],
    [{ draftId: 'draft-broken-binding', recordId: 'record-1' }, 'RECORD_NOT_FOUND', 'trusted draft binding'],
    [{ draftId: 'draft-manual', recordId: 'record-deleted' }, 'ACTION_INVALID', 'manual draft'],
    [{ draftId: 'draft-record', recordId: 'record-deleted' }, 'ACTION_INVALID', 'forged recordId ignored'],
  ];

  for (const [payload, expectedCode, label] of cases) {
    const result = await invoke(db, {
      action: 'organizeDraft', familyId: 'family-a', dishId: 'dish-1', ...payload,
    });
    assert.equal(result.error.code, expectedCode, label);
  }
});

test('manual drafts clone the current main recipe and use only trusted member identity', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-1': {
      _id: 'family-a|dish-1', familyId: 'family-a', dishId: 'dish-1',
      currentVersionId: 'version-main', currentVersionNumber: 7,
    },
  };
  seed.recipe_versions = {
    'version-main': {
      _id: 'version-main', familyId: 'family-a', dishId: 'dish-1', versionNumber: 7,
      recipe: {
        ...clone(validRecipe),
        ingredients: [{ ...validRecipe.ingredients[0], name: ' 鸡蛋 ', ignored: 'discard' }],
      },
    },
  };
  const db = createMemoryDatabase(seed);

  const created = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1',
    sourceType: 'edit_main', memberId: 'forged-member', openid: 'forged-openid',
  });
  const fetched = await invoke(db, {
    action: 'getDraft', familyId: 'family-a', dishId: 'dish-1', draftId: created.data.draft._id,
  });

  assert.equal(created.ok, true);
  assert.equal(created.data.draft.sourceType, 'edit_main');
  assert.equal(created.data.draft.status, 'editing');
  assert.equal(created.data.draft.baseMainVersionId, 'version-main');
  assert.equal(created.data.draft.revision, 0);
  assert.equal(created.data.draft.createdBy, 'member-a');
  assert.equal(created.data.draft.updatedBy, 'member-a');
  assert.equal(created.data.draft.modelProvider, '');
  assert.equal(created.data.draft.modelName, '');
  assert.deepEqual(created.data.draft.sourceRecordingIds, []);
  assert.equal(created.data.draft.recipe.ingredients[0].name, '鸡蛋');
  assert.equal(Object.hasOwn(created.data.draft.recipe.ingredients[0], 'ignored'), false);
  assert.deepEqual(fetched.data.draft, created.data.draft);
});

test('manual draft creation rejects non-manual sources and cross-scope record bindings', async () => {
  const db = createMemoryDatabase(baseSeed());

  const nonManual = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'recording',
  });
  const crossDishRecord = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1',
    sourceType: 'manual', recordId: 'record-deleted',
  });

  assert.equal(nonManual.error.code, 'SOURCE_TYPE_INVALID');
  assert.equal(crossDishRecord.error.code, 'RECORD_NOT_FOUND');
  assert.equal(db.records('recipe_drafts').size, 0);
});

test('draft actions never use a draft id across family or dish scopes', async () => {
  const seed = baseSeed();
  seed.recipe_drafts = {
    'draft-other-family': {
      _id: 'draft-other-family', familyId: 'family-b', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
    },
    'draft-other-dish': {
      _id: 'draft-other-dish', familyId: 'family-a', dishId: 'dish-deleted', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
    },
  };
  const db = createMemoryDatabase(seed);

  for (const draftId of ['draft-other-family', 'draft-other-dish']) {
    for (const action of ['getDraft', 'updateDraft', 'confirmDraft']) {
      const result = await invoke(db, {
        action, familyId: 'family-a', dishId: 'dish-1', draftId,
        revision: 0, recipe: clone(validRecipe), publishAsMain: true, baseMainVersionId: '',
      });
      assert.equal(result.error.code, 'DRAFT_NOT_FOUND', `${action}: ${draftId}`);
    }
  }
});

test('updateDraft normalizes valid recipes, increments revision, and rejects a stale revision', async () => {
  const db = createMemoryDatabase(baseSeed());
  const created = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
  });
  const draft = created.data.draft;
  const recipe = {
    ...clone(validRecipe),
    ingredients: [{ ...validRecipe.ingredients[0], name: ' 鸡蛋 ', ignored: 'discard' }],
  };

  const saved = await invoke(db, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: draft._id,
    revision: 0, recipe, memberId: 'forged-member',
  });
  const stale = await invoke(db, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: draft._id,
    revision: 0, recipe: clone(validRecipe),
  });

  assert.equal(saved.data.draft.revision, 1);
  assert.equal(saved.data.draft.updatedBy, 'member-a');
  assert.equal(saved.data.draft.recipe.ingredients[0].name, '鸡蛋');
  assert.equal(Object.hasOwn(saved.data.draft.recipe.ingredients[0], 'ignored'), false);
  assert.equal(stale.error.code, 'DRAFT_CONFLICT');
});

test('updateDraft re-reads and compares revision inside runTransaction', async () => {
  const seed = baseSeed();
  seed.recipe_drafts = {
    'draft-race': {
      _id: 'draft-race', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
      createdBy: 'member-a', createdAt: 1, updatedBy: 'member-a', updatedAt: 1,
    },
  };
  const db = createMemoryDatabase(seed, {
    async beforeTransaction(database) {
      await database.collection('recipe_drafts').doc('draft-race').set({
        data: { ...seed.recipe_drafts['draft-race'], revision: 1 },
      });
    },
  });

  const result = await invoke(db, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-race',
    revision: 0, recipe: clone(validRecipe),
  });

  assert.equal(result.error.code, 'DRAFT_CONFLICT');
  assert.equal(db.transactionCount(), 1);
  assert.equal(db.records('recipe_drafts').get('draft-race').revision, 1);
});

test('recipe validation errors do not echo raw recipe content in responses or logs', async () => {
  const logs = [];
  const db = createMemoryDatabase(baseSeed());
  const created = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
  });
  const secret = 'private-recipe-content-must-not-leak';
  const result = await invoke(db, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: created.data.draft._id,
    revision: 0,
    recipe: { ...clone(validRecipe), ingredients: [{ ...validRecipe.ingredients[0], name: '', note: secret }] },
  }, 'openid-a', { logger: { error(value) { logs.push(value); } } });
  const serialized = JSON.stringify({ result, logs });

  assert.equal(result.error.code, 'RECIPE_INVALID');
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['action', 'code', 'durationMs', 'requestId', 'stage'].sort());
});

test('first confirmation publishes once and an identical retry returns the same immutable version', async () => {
  const db = createMemoryDatabase(baseSeed(), { rejectSystemId: true });
  const created = await invoke(db, {
    action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
  });
  const saved = await invoke(db, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: created.data.draft._id,
    revision: 0, recipe: clone(validRecipe),
  });
  const request = {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: saved.data.draft._id,
    revision: 1, publishAsMain: false, baseMainVersionId: '', memberId: 'forged-member',
  };

  const confirmed = await invoke(db, request);
  const retried = await invoke(db, request);

  assert.equal(confirmed.data.draft.status, 'confirmed');
  assert.equal(confirmed.data.draft.revision, 1);
  assert.equal(confirmed.data.draft.confirmedVersionId, confirmed.data.version._id);
  assert.equal(confirmed.data.version.versionNumber, 1);
  assert.equal(confirmed.data.version.publishedAsMain, true);
  assert.equal(confirmed.data.version.previousMainVersionId, '');
  assert.equal(confirmed.data.version.confirmedBy, 'member-a');
  assert.equal(confirmed.data.pointer.currentVersionId, confirmed.data.version._id);
  assert.equal(confirmed.data.pointer.currentVersionNumber, 1);
  assert.equal(confirmed.data.pointer.updatedBy, 'member-a');
  assert.equal(retried.data.version._id, confirmed.data.version._id);
  assert.equal(retried.data.draft.confirmedVersionId, confirmed.data.version._id);
  assert.equal(db.records('recipe_versions').size, 1);
});

test('later confirmations preserve main by default and allocate monotonic versions before an explicit publish', async () => {
  const db = createMemoryDatabase(baseSeed());

  async function saveDraft() {
    const created = await invoke(db, {
      action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
    });
    return invoke(db, {
      action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: created.data.draft._id,
      revision: 0, recipe: clone(validRecipe),
    });
  }

  const first = await saveDraft();
  const firstConfirmed = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: first.data.draft._id,
    revision: 1, publishAsMain: false, baseMainVersionId: '',
  });
  const firstVersionId = firstConfirmed.data.version._id;

  const savedOnly = await saveDraft();
  const secondConfirmed = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: savedOnly.data.draft._id,
    revision: 1, publishAsMain: false, baseMainVersionId: firstVersionId,
  });

  const published = await saveDraft();
  const thirdConfirmed = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: published.data.draft._id,
    revision: 1, publishAsMain: true, baseMainVersionId: firstVersionId,
  });

  assert.equal(secondConfirmed.data.version.versionNumber, 2);
  assert.equal(secondConfirmed.data.version.publishedAsMain, false);
  assert.equal(secondConfirmed.data.pointer.currentVersionId, firstVersionId);
  assert.equal(thirdConfirmed.data.version.versionNumber, 3);
  assert.equal(thirdConfirmed.data.version.publishedAsMain, true);
  assert.equal(thirdConfirmed.data.pointer.currentVersionId, thirdConfirmed.data.version._id);
  assert.deepEqual(
    [...db.records('recipe_versions').values()].map((item) => item.versionNumber).sort(),
    [1, 2, 3]
  );
});

test('confirmDraft rejects a stale main base without creating a version or changing the draft', async () => {
  const db = createMemoryDatabase(baseSeed());

  async function createSavedDraft() {
    const created = await invoke(db, {
      action: 'createManualDraft', familyId: 'family-a', dishId: 'dish-1', sourceType: 'manual',
    });
    return invoke(db, {
      action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: created.data.draft._id,
      revision: 0, recipe: clone(validRecipe),
    });
  }

  const initial = await createSavedDraft();
  const initialConfirmation = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: initial.data.draft._id,
    revision: 1, publishAsMain: false, baseMainVersionId: '',
  });
  const oldMainId = initialConfirmation.data.version._id;
  const stale = await createSavedDraft();
  const winner = await createSavedDraft();
  await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: winner.data.draft._id,
    revision: 1, publishAsMain: true, baseMainVersionId: oldMainId,
  });
  const versionCount = db.records('recipe_versions').size;

  const conflict = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: stale.data.draft._id,
    revision: 1, publishAsMain: true, baseMainVersionId: oldMainId,
  });

  assert.equal(conflict.error.code, 'MAIN_RECIPE_CONFLICT');
  assert.equal(db.records('recipe_versions').size, versionCount);
  assert.equal(db.records('recipe_drafts').get(stale.data.draft._id).status, 'editing');
  assert.equal(db.records('recipe_drafts').get(stale.data.draft._id).confirmedVersionId, '');
});

test('confirmDraft re-reads and compares revision inside runTransaction', async () => {
  const seed = baseSeed();
  seed.recipe_drafts = {
    'draft-confirm-race': {
      _id: 'draft-confirm-race', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
      baseMainVersionId: '', confirmedVersionId: '', createdBy: 'member-a', createdAt: 1,
      updatedBy: 'member-a', updatedAt: 1,
    },
  };
  const db = createMemoryDatabase(seed, {
    async beforeTransaction(database) {
      await database.collection('recipe_drafts').doc('draft-confirm-race').set({
        data: { ...seed.recipe_drafts['draft-confirm-race'], revision: 1 },
      });
    },
  });

  const result = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-confirm-race',
    revision: 0, publishAsMain: false, baseMainVersionId: '',
  });

  assert.equal(result.error.code, 'DRAFT_CONFLICT');
  assert.equal(db.transactionCount(), 1);
  assert.equal(db.records('recipe_versions').size, 0);
});

test('confirmation validates the stored recipe and recipe versions expose no update route', async () => {
  const seed = baseSeed();
  seed.recipe_drafts = {
    'draft-invalid': {
      _id: 'draft-invalid', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: { ingredients: [{ name: 'secret-raw-recipe' }] },
      revision: 0, baseMainVersionId: '', confirmedVersionId: '',
    },
  };
  const db = createMemoryDatabase(seed);
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);

  const invalid = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-invalid',
    revision: 0, publishAsMain: false, baseMainVersionId: '',
  });
  const updateVersion = await invoke(db, {
    action: 'updateVersion', familyId: 'family-a', dishId: 'dish-1', versionId: 'version-1',
    recipe: clone(validRecipe),
  });

  assert.equal(invalid.error.code, 'RECIPE_INVALID');
  assert.equal(JSON.stringify(invalid).includes('secret-raw-recipe'), false);
  assert.equal(typeof repository.setVersion, 'undefined');
  assert.equal(typeof repository.updateVersion, 'undefined');
  assert.equal(updateVersion.error.code, 'ACTION_INVALID');
  assert.equal(db.records('recipe_versions').size, 0);
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
      recipe: {
        familyNotes: ['safe'],
        fileId: 'cloud://env/durable-recipe-source',
        nested: {
          creatorOpenid: 'creator-hidden',
          _openid: 'system-hidden',
          audioUrl: 'https://temporary.example/audio',
          downloadUrl: 'https://temporary.example/download',
          tempFileURL: 'https://temporary.example/version',
          instruction: 'legitimate recipe field',
        },
      },
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
  assert.equal(serialized.includes('creator-hidden'), false);
  assert.equal(serialized.includes('system-hidden'), false);
  assert.equal(serialized.includes('temporary.example'), false);
  assert.equal(serialized.includes('version-other'), false);
  assert.equal(result.data.version.recipe.fileId, 'cloud://env/durable-recipe-source');
  assert.equal(result.data.version.recipe.nested.instruction, 'legitimate recipe field');
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
