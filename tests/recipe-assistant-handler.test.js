const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const validRecipe = require('./fixtures/recipe-contract.json');

const {
  DEFAULT_CONFIG,
  RECORD_ACTION_CONTRACTS,
  RECORD_ID_ACTIONS,
  RECORD_SCOPED_ACTIONS,
  buildSourceText,
  createInputHash,
  createCloudFileApi,
  handleAction,
  main,
} = require('../cloudfunctions/recipe-assistant');
const { createRecipeRepository } = require('../cloudfunctions/recipe-assistant/repository');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}, options = {}) {
  const collections = new Map();
  const documentVersions = new Map();
  let transactionCount = 0;
  let transactionAttemptCount = 0;
  Object.entries(seed).forEach(([name, records]) => {
    collections.set(name, new Map(Object.entries(records).map(([id, data]) => [id, clone(data)])));
    Object.keys(records).forEach((id) => documentVersions.set(documentKey(name, id), 0));
  });

  function collection(name, transaction = null) {
    if (!collections.has(name)) collections.set(name, new Map());
    const records = collections.get(name);
    return {
      doc(id) {
        return {
          async get() {
            const key = documentKey(name, id);
            if (transaction && transaction.writes.has(key)) {
              return { data: clone(transaction.writes.get(key).data) };
            }
            if (transaction && !transaction.readVersions.has(key)) {
              transaction.readVersions.set(key, documentVersions.get(key) || 0);
            }
            const data = records.has(id) ? clone(records.get(id)) : null;
            if (transaction && typeof options.afterTransactionRead === 'function') {
              await options.afterTransactionRead({
                name, id, data: clone(data), attempt: transaction.attempt,
                transactionId: transaction.id,
              });
            }
            return { data };
          },
          async set({ data }) {
            rejectSystemId(data, 'set');
            const key = documentKey(name, id);
            const stored = { ...clone(data), _id: id };
            if (transaction) {
              if (!transaction.readVersions.has(key)) {
                transaction.readVersions.set(key, documentVersions.get(key) || 0);
              }
              transaction.writes.set(key, { name, id, data: stored });
              return { _id: id };
            }
            records.set(id, stored);
            documentVersions.set(key, (documentVersions.get(key) || 0) + 1);
            return { _id: id };
          },
        };
      },
      async add({ data }) {
        if (transaction) {
          const error = new Error('CloudBase transactions do not support collection.add');
          error.code = 'TRANSACTION_ADD_UNSUPPORTED';
          throw error;
        }
        rejectSystemId(data, 'add');
        const id = `${name}-${records.size + 1}`;
        records.set(id, { ...clone(data), _id: id });
        documentVersions.set(documentKey(name, id), 1);
        return { _id: id };
      },
      where(filter) {
        if (transaction) {
          const error = new Error('CloudBase transactions do not support collection.where');
          error.code = 'TRANSACTION_QUERY_UNSUPPORTED';
          throw error;
        }
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
            const data = clone(result);
            if (typeof options.afterQuery === 'function') {
              await options.afterQuery({ name, filter: clone(filter), data: clone(data) });
            }
            return { data };
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
    collection(name) {
      return collection(name);
    },
    async runTransaction(callback) {
      transactionCount += 1;
      if (typeof options.beforeTransaction === 'function') {
        await options.beforeTransaction(db, transactionCount);
      }
      const transactionId = transactionCount;
      const maxAttempts = options.maxTransactionAttempts || 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        transactionAttemptCount += 1;
        const transaction = {
          id: transactionId,
          attempt,
          readVersions: new Map(),
          writes: new Map(),
        };
        const transactionDb = {
          collection(name) {
            return collection(name, transaction);
          },
        };
        const result = await callback(transactionDb);
        const conflicted = [...transaction.readVersions.entries()].some(
          ([key, version]) => (documentVersions.get(key) || 0) !== version
        );
        if (conflicted) {
          if (attempt === maxAttempts) {
            const error = new Error('transaction conflict retry limit exceeded');
            error.code = 'TRANSACTION_CONFLICT';
            throw error;
          }
          continue;
        }
        transaction.writes.forEach(({ name, id, data }, key) => {
          collections.get(name).set(id, clone(data));
          documentVersions.set(key, (documentVersions.get(key) || 0) + 1);
        });
        return result;
      }
      throw new Error('unreachable transaction state');
    },
    records(name) {
      return collections.get(name) || new Map();
    },
    transactionCount() {
      return transactionCount;
    },
    transactionAttemptCount() {
      return transactionAttemptCount;
    },
  };
  return db;

  function documentKey(name, id) {
    return `${name}\u0000${id}`;
  }
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
    ['reserveRecording', 'RECORDING_FORMAT_INVALID'],
    ['refreshWorkspace', 'ASR_UNAVAILABLE'],
    ['addManualText', 'TEXT_REQUIRED'],
    ['attachRecordWorkspace', 'success'],
    ['cancelRecordWorkspace', 'success'],
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
  const actions = [
    ['submitRecording', 'FILE_REQUIRED'],
    ['updateTranscript', 'TRANSCRIPT_REVISION_INVALID'],
    ['deleteRecordingAudio', 'TRANSCRIPT_REQUIRED'],
    ['deleteRecording', 'success'],
  ];

  for (const [action, ownedOutcome] of actions) {
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
    assert.equal(ownedOutcome === 'success' ? owned.ok : owned.error.code,
      ownedOutcome === 'success' ? true : ownedOutcome, `${action}: forged recordId ignored`);
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
    [{ draftId: 'draft-record', recordId: 'record-deleted' }, 'SOURCE_REQUIRED', 'forged recordId ignored'],
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

test('first confirmation uses doc-only transaction operations and an identical retry returns the same immutable version', async () => {
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
  assert.equal(confirmed.data.version._id, 'family-a|dish-1|1');
  assert.equal(confirmed.data.version.publishedAsMain, true);
  assert.equal(confirmed.data.version.previousMainVersionId, '');
  assert.equal(confirmed.data.version.confirmedBy, 'member-a');
  assert.equal(confirmed.data.pointer.currentVersionId, confirmed.data.version._id);
  assert.equal(confirmed.data.pointer.currentVersionNumber, 1);
  assert.equal(confirmed.data.pointer.latestVersionNumber, 1);
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
  assert.equal(secondConfirmed.data.pointer.currentVersionNumber, 1);
  assert.equal(secondConfirmed.data.pointer.latestVersionNumber, 2);
  assert.equal(thirdConfirmed.data.version.versionNumber, 3);
  assert.equal(thirdConfirmed.data.version.publishedAsMain, true);
  assert.equal(thirdConfirmed.data.pointer.currentVersionId, thirdConfirmed.data.version._id);
  assert.equal(thirdConfirmed.data.pointer.latestVersionNumber, 3);
  assert.deepEqual(
    [...db.records('recipe_versions').values()].map((item) => item.versionNumber).sort(),
    [1, 2, 3]
  );
});

test('a legacy pointer initializes latestVersionNumber from currentVersionNumber without querying versions', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-1': {
      _id: 'family-a|dish-1', familyId: 'family-a', dishId: 'dish-1',
      currentVersionId: 'legacy-main', currentVersionNumber: 7,
      createdAt: 10, updatedBy: 'legacy-member', updatedAt: 11,
      mainLabel: 'preserve-main-metadata',
    },
  };
  seed.recipe_versions = {
    'legacy-main': {
      _id: 'legacy-main', familyId: 'family-a', dishId: 'dish-1',
      versionNumber: 7, recipe: clone(validRecipe),
    },
  };
  seed.recipe_drafts = {
    'legacy-draft': {
      _id: 'legacy-draft', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
      baseMainVersionId: 'legacy-main', confirmedVersionId: '', createdBy: 'member-a', createdAt: 20,
      updatedBy: 'member-a', updatedAt: 20,
    },
  };
  const db = createMemoryDatabase(seed);

  const result = await invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'legacy-draft',
    revision: 0, publishAsMain: false, baseMainVersionId: 'legacy-main',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.version.versionNumber, 8);
  assert.equal(result.data.version._id, 'family-a|dish-1|8');
  assert.equal(result.data.pointer.currentVersionId, 'legacy-main');
  assert.equal(result.data.pointer.currentVersionNumber, 7);
  assert.equal(result.data.pointer.latestVersionNumber, 8);
  assert.equal(result.data.pointer.createdAt, 10);
  assert.equal(result.data.pointer.mainLabel, 'preserve-main-metadata');
  assert.equal(result.data.pointer.updatedBy, 'member-a');
  assert.equal(result.data.pointer.updatedAt, 100);
});

test('concurrent non-main confirmations retry the shared counter and keep the main pointer unchanged', async () => {
  const seed = baseSeed();
  seed.family_recipes = {
    'family-a|dish-1': {
      _id: 'family-a|dish-1', familyId: 'family-a', dishId: 'dish-1',
      currentVersionId: 'main-version', currentVersionNumber: 4, latestVersionNumber: 4,
      createdAt: 1, updatedBy: 'member-a', updatedAt: 1,
    },
  };
  seed.recipe_versions = {
    'main-version': {
      _id: 'main-version', familyId: 'family-a', dishId: 'dish-1',
      versionNumber: 4, recipe: clone(validRecipe),
    },
  };
  seed.recipe_drafts = {
    'concurrent-draft-a': {
      _id: 'concurrent-draft-a', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
      baseMainVersionId: 'main-version', confirmedVersionId: '',
    },
    'concurrent-draft-b': {
      _id: 'concurrent-draft-b', familyId: 'family-a', dishId: 'dish-1', recordId: '',
      sourceType: 'manual', status: 'editing', recipe: clone(validRecipe), revision: 0,
      baseMainVersionId: 'main-version', confirmedVersionId: '',
    },
  };
  let firstPointerReads = 0;
  let releaseFirstReads;
  const bothReadPointer = new Promise((resolve) => { releaseFirstReads = resolve; });
  const db = createMemoryDatabase(seed, {
    async afterTransactionRead({ name, id, attempt }) {
      if (name !== 'family_recipes' || id !== 'family-a|dish-1' || attempt !== 1) return;
      firstPointerReads += 1;
      if (firstPointerReads === 2) releaseFirstReads();
      await bothReadPointer;
    },
  });
  const request = (draftId) => invoke(db, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId,
    revision: 0, publishAsMain: false, baseMainVersionId: 'main-version',
  });

  const [left, right] = await Promise.all([
    request('concurrent-draft-a'),
    request('concurrent-draft-b'),
  ]);
  const pointer = db.records('family_recipes').get('family-a|dish-1');

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  assert.deepEqual([left.data.version.versionNumber, right.data.version.versionNumber].sort(), [5, 6]);
  assert.notEqual(left.data.version._id, right.data.version._id);
  assert.equal(pointer.currentVersionId, 'main-version');
  assert.equal(pointer.currentVersionNumber, 4);
  assert.equal(pointer.latestVersionNumber, 6);
  assert.equal(db.transactionCount(), 2);
  assert.equal(db.transactionAttemptCount(), 3);
});

test('deterministic version creation reuses identical content and refuses an immutable overwrite', async () => {
  const db = createMemoryDatabase(baseSeed(), { rejectSystemId: true });
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const version = {
    familyId: 'family-a', dishId: 'dish-1', recordId: '', versionNumber: 9,
    recipe: clone(validRecipe), sourceDraftId: 'draft-a', publishedAsMain: false,
    previousMainVersionId: 'main-version', confirmedBy: 'member-a', confirmedAt: 100,
  };

  const first = await repository.runTransaction((transaction) => transaction.createVersion(version));
  const retry = await repository.runTransaction((transaction) => transaction.createVersion({
    confirmedAt: version.confirmedAt,
    confirmedBy: version.confirmedBy,
    previousMainVersionId: version.previousMainVersionId,
    publishedAsMain: version.publishedAsMain,
    sourceDraftId: version.sourceDraftId,
    recipe: clone(version.recipe),
    versionNumber: version.versionNumber,
    recordId: version.recordId,
    dishId: version.dishId,
    familyId: version.familyId,
  }));
  let immutableError;
  try {
    await repository.runTransaction((transaction) => transaction.createVersion({
      ...version, sourceDraftId: 'draft-b',
    }));
  } catch (error) {
    immutableError = error;
  }

  assert.equal(first._id, 'family-a|dish-1|9');
  assert.deepEqual(retry, first);
  assert.equal(immutableError && immutableError.code, 'VERSION_IMMUTABLE_CONFLICT');
  assert.equal(db.records('recipe_versions').size, 1);
  assert.equal(db.records('recipe_versions').get('family-a|dish-1|9').sourceDraftId, 'draft-a');
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

test('getRecordWorkspace never exposes an ASR submission lease token', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'uploading', fileId: '',
      asrSubmitToken: 'server-only-token', asrSubmitLeaseExpiresAt: 120_100,
    },
  };
  const db = createMemoryDatabase(seed);

  const result = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  });

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.data).includes('server-only-token'), false);
  assert.equal(Object.hasOwn(result.data.recordings[0], 'asrSubmitLeaseExpiresAt'), false);
  assert.equal(db.records('recipe_recordings').get('audio').asrSubmitToken, 'server-only-token');
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

function recordingServices(overrides = {}) {
  const deleted = [];
  const submitted = [];
  let submitTokenSequence = 0;
  return {
    deleted,
    submitted,
    fileApi: {
      async getFileInfo({ fileId }) {
        return { fileId, byteLength: 1024, format: 'mp3', durationMs: 60_000 };
      },
      async getTempFileURL({ fileList }) {
        return { fileList: fileList.map((fileId) => ({ fileID: fileId, tempFileURL: `https://temp.example/${encodeURIComponent(fileId)}` })) };
      },
      async deleteFile({ fileList }) {
        deleted.push(...fileList);
        return { fileList };
      },
    },
    asrProvider: {
      async submit(input) {
        submitted.push(input);
        return { taskId: 1001, requestId: 'asr-request-1', submittedAt: 100, expiresAt: 200 };
      },
      async query() {
        return { status: 'transcribing', transcript: '', durationMs: 0, requestId: 'query-request', errorCode: '' };
      },
    },
    idGenerator: () => 'recording-fixed',
    asrSubmitTokenGenerator: () => `asr-submit-${++submitTokenSequence}`,
    ...overrides,
  };
}

function createMpeg2Layer3Frames(frameCount = 4) {
  const bitrateKbps = 48;
  const sampleRateHz = 16000;
  const frameLength = Math.floor((72000 * bitrateKbps) / sampleRateHz);
  const header = 0xffe00000
    | (0b10 << 19)
    | (0b01 << 17)
    | (1 << 16)
    | (6 << 12)
    | (2 << 10);
  return Buffer.concat(Array.from({ length: frameCount }, () => {
    const frame = Buffer.alloc(frameLength);
    frame.writeUInt32BE(header >>> 0, 0);
    return frame;
  }));
}

async function reserveOwnedRecording(db, services = recordingServices(), extra = {}) {
  const result = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1',
    recordId: 'record-1', format: 'mp3', ...extra,
  }, 'openid-a', services);
  return { result, services };
}

const PRE_SAVE_RECORD_ID = 'record-1787000000000-1';

function addSecondActiveMember(seed) {
  seed.family_members['member-a2'] = {
    _id: 'member-a2', familyId: 'family-a', memberId: 'member-a2', openid: 'openid-a2', status: 'active',
  };
  return seed;
}

test('trusted owner can reserve, read, add, submit, update, and delete a pre-save workspace', async () => {
  const db = createMemoryDatabase(baseSeed());
  const generatedIds = ['recording-pre-save', 'manual-pre-save'];
  const services = recordingServices({ idGenerator: () => generatedIds.shift() });

  const empty = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: PRE_SAVE_RECORD_ID,
  }, 'openid-a', services);
  assert.deepEqual(empty, { ok: true, data: { recordings: [], draft: null, audioUrls: {} } });

  const reserved = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1',
    recordId: PRE_SAVE_RECORD_ID, format: 'mp3', memberId: 'forged-member',
  }, 'openid-a', services);
  assert.equal(reserved.ok, true);
  assert.equal(reserved.data.recordingId, 'recording-pre-save');

  const read = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: PRE_SAVE_RECORD_ID,
  }, 'openid-a', services);
  assert.deepEqual(read.data.recordings.map((item) => item._id), ['recording-pre-save']);

  const added = await invoke(db, {
    action: 'addManualText', familyId: 'family-a', dishId: 'dish-1',
    recordId: PRE_SAVE_RECORD_ID, text: ' 少放盐 ', memberId: 'forged-member',
  }, 'openid-a', services);
  assert.equal(added.ok, true);
  assert.equal(added.data.recording.createdBy, 'member-a');

  const submitted = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1',
    recordingId: 'recording-pre-save', recordId: 'record-deleted',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-pre-save.mp3',
  }, 'openid-a', services);
  assert.equal(submitted.ok, true);
  assert.equal(submitted.data.recording.status, 'transcribing');

  const updated = await invoke(db, {
    action: 'updateTranscript', familyId: 'family-a', dishId: 'dish-1',
    recordingId: 'manual-pre-save', recordId: 'record-deleted', transcriptRevision: 0, text: '少放一点盐',
  }, 'openid-a', services);
  assert.equal(updated.ok, true);
  assert.equal(updated.data.recording.editedTranscript, '少放一点盐');

  const deleted = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1',
    recordingId: 'manual-pre-save', recordId: 'record-deleted',
  }, 'openid-a', services);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.data.recording.status, 'deleted');
});

test('an active member cannot read or mutate another member pre-save workspace', async () => {
  const db = createMemoryDatabase(addSecondActiveMember(baseSeed()));
  const services = recordingServices({ idGenerator: () => 'recording-private' });
  const recordId = 'record-1787000000000-2';
  const reserved = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);
  assert.equal(reserved.ok, true);
  db.records('recipe_drafts').set('draft-private', {
    _id: 'draft-private', familyId: 'family-a', dishId: 'dish-1', recordId,
    status: 'editing', createdBy: 'member-a', draftExpiresAt: 604800100,
  });

  const attempts = [
    { action: 'getRecordWorkspace', recordId },
    { action: 'addManualText', recordId, text: '偷改' },
    { action: 'refreshWorkspace', recordId },
    {
      action: 'submitRecording', recordingId: 'recording-private', recordId: 'record-1',
      fileId: 'cloud://env/families/family-a/recipe-audio/recording-private.mp3',
    },
    { action: 'updateTranscript', recordingId: 'recording-private', recordId: 'record-1', transcriptRevision: 0, text: '偷改' },
    { action: 'deleteRecording', recordingId: 'recording-private', recordId: 'record-1' },
  ];
  for (const attempt of attempts) {
    const denied = await invoke(db, {
      familyId: 'family-a', dishId: 'dish-1', memberId: 'member-a', ...attempt,
    }, 'openid-a2', services);
    assert.equal(denied.ok, false, attempt.action);
    assert.equal(denied.error.code, 'RECORD_NOT_FOUND', attempt.action);
  }

  const ownerRead = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  assert.equal(ownerRead.ok, true);
  assert.equal(ownerRead.data.draft._id, 'draft-private');
  assert.equal(db.records('recipe_recordings').get('recording-private').status, 'reserved');
});

test('attach stays strict until local save and only the temporary workspace owner can attach', async () => {
  const seed = addSecondActiveMember(baseSeed());
  const db = createMemoryDatabase(seed);
  const services = recordingServices({ idGenerator: () => 'recording-attach' });
  const recordId = 'record-1787000000000-3';
  await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);

  const beforeSave = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  assert.equal(beforeSave.error.code, 'RECORD_NOT_FOUND');

  db.records('family_states').get('family-a').cookingRecords.push({
    id: recordId, familyId: 'family-a', dishId: 'dish-1',
  });
  const otherMember = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a2', services);
  assert.equal(otherMember.error.code, 'RECORD_NOT_FOUND');

  const attached = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  assert.equal(attached.ok, true);
  assert.equal(db.records('recipe_recordings').get('recording-attach').draftExpiresAt, null);

  const historicalRead = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a2', services);
  assert.equal(historicalRead.ok, true);
});

test('pre-save workspace claims remain isolated across family and dish scopes', async () => {
  const seed = baseSeed();
  seed.family_states['family-a'].dishes.push({ id: 'dish-2', status: 'active' });
  const db = createMemoryDatabase(seed);
  const services = recordingServices({ idGenerator: () => 'recording-scoped' });
  const recordId = 'record-1787000000000-4';
  const owner = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);
  assert.equal(owner.ok, true);

  for (const scope of [
    { familyId: 'family-a', dishId: 'dish-2', openid: 'openid-a' },
    { familyId: 'family-b', dishId: 'dish-1', openid: 'openid-b' },
  ]) {
    const read = await invoke(db, {
      action: 'getRecordWorkspace', familyId: scope.familyId, dishId: scope.dishId, recordId,
    }, scope.openid, services);
    assert.equal(read.error.code, 'RECORD_NOT_FOUND', `${scope.familyId}|${scope.dishId}: read`);
    const reserve = await invoke(db, {
      action: 'reserveRecording', familyId: scope.familyId, dishId: scope.dishId, recordId, format: 'mp3',
    }, scope.openid, services);
    assert.equal(reserve.error.code, 'RECORD_NOT_FOUND', `${scope.familyId}|${scope.dishId}: reserve`);
  }
});

test('an empty provisional cancel leaves a tombstone that blocks later segment creation', async () => {
  const cases = [
    {
      recordId: 'record-1787000000010-1',
      recordingId: 'recording-after-cancel',
      event: { action: 'reserveRecording', format: 'mp3' },
    },
    {
      recordId: 'record-1787000000010-2',
      recordingId: 'manual-after-cancel',
      event: { action: 'addManualText', text: '取消后不应保存' },
    },
  ];
  for (const item of cases) {
    const db = createMemoryDatabase(baseSeed());
    const services = recordingServices({ idGenerator: () => item.recordingId });
    const cancelled = await invoke(db, {
      action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: item.recordId,
    }, 'openid-a', services);
    assert.equal(cancelled.ok, true, item.event.action);

    const delayed = await invoke(db, {
      familyId: 'family-a', dishId: 'dish-1', recordId: item.recordId, ...item.event,
    }, 'openid-a', services);
    assert.equal(delayed.ok, false, item.event.action);
    assert.equal(delayed.error && delayed.error.code, 'RECORD_NOT_FOUND', item.event.action);
    assert.equal(db.records('recipe_recordings').get(`workspace-claim-${item.recordId}`).status, 'cancelled');
    assert.equal(db.records('recipe_recordings').has(item.recordingId), false, item.event.action);
  }
});

test('cancelled claim wins when reserve or manual creation resumes from an older transaction snapshot', async () => {
  const cases = [
    {
      recordId: 'record-1787000000020-1',
      recordingId: 'recording-delayed-cancel',
      event: { action: 'reserveRecording', format: 'mp3' },
    },
    {
      recordId: 'record-1787000000020-2',
      recordingId: 'manual-delayed-cancel',
      event: { action: 'addManualText', text: '并发取消' },
    },
  ];
  for (const item of cases) {
    let releaseCreation;
    let markCreationPaused;
    const creationReleased = new Promise((resolve) => { releaseCreation = resolve; });
    const creationPaused = new Promise((resolve) => { markCreationPaused = resolve; });
    const workspaceStateId = `workspace-family-a-dish-1-${item.recordId}`;
    let paused = false;
    const db = createMemoryDatabase(baseSeed(), {
      async afterTransactionRead({ name, id, attempt }) {
        if (!paused && attempt === 1 && name === 'recipe_recordings' && id === workspaceStateId) {
          paused = true;
          markCreationPaused();
          await creationReleased;
        }
      },
    });
    const services = recordingServices({ idGenerator: () => item.recordingId });
    const creation = invoke(db, {
      familyId: 'family-a', dishId: 'dish-1', recordId: item.recordId, ...item.event,
    }, 'openid-a', services);
    await creationPaused;

    const cancelled = await invoke(db, {
      action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: item.recordId,
    }, 'openid-a', services);
    releaseCreation();
    const delayed = await creation;

    assert.equal(cancelled.ok, true, item.event.action);
    assert.equal(delayed.ok, false, item.event.action);
    assert.equal(delayed.error && delayed.error.code, 'RECORD_NOT_FOUND', item.event.action);
    assert.equal(db.records('recipe_recordings').get(`workspace-claim-${item.recordId}`).status, 'cancelled');
    assert.equal(db.records('recipe_recordings').has(item.recordingId), false, item.event.action);

    const submit = await invoke(db, {
      action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: item.recordingId,
      recordId: 'record-1', fileId: `cloud://env/families/family-a/recipe-audio/${item.recordingId}.mp3`,
    }, 'openid-a', services);
    assert.equal(submit.error.code, 'RECORDING_NOT_FOUND', `${item.event.action}: submit`);
  }
});

test('cancellation tombstones the claim before its cleanup snapshot can miss a concurrent creation', async () => {
  const recordId = 'record-1787000000030-1';
  const recordingId = 'recording-before-cleanup';
  const workspaceStateId = `workspace-family-a-dish-1-${recordId}`;
  let releaseCreation;
  let markCreationPaused;
  let releaseCleanup;
  let markCleanupReached;
  const creationReleased = new Promise((resolve) => { releaseCreation = resolve; });
  const creationPaused = new Promise((resolve) => { markCreationPaused = resolve; });
  const cleanupReleased = new Promise((resolve) => { releaseCleanup = resolve; });
  const cleanupReached = new Promise((resolve) => { markCleanupReached = resolve; });
  let creationWasPaused = false;
  let scopedRecordingQueries = 0;
  const db = createMemoryDatabase(baseSeed(), {
    async afterTransactionRead({ name, id, attempt }) {
      if (!creationWasPaused && attempt === 1 && name === 'recipe_recordings' && id === workspaceStateId) {
        creationWasPaused = true;
        markCreationPaused();
        await creationReleased;
      }
    },
    async afterQuery({ name, filter }) {
      if (name !== 'recipe_recordings'
        || filter.familyId !== 'family-a'
        || filter.dishId !== 'dish-1'
        || filter.recordId !== recordId) return;
      scopedRecordingQueries += 1;
      if (scopedRecordingQueries === 4) {
        markCleanupReached();
        await cleanupReleased;
      }
    },
  });
  const services = recordingServices({ idGenerator: () => recordingId });
  const creation = invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);
  await creationPaused;

  const cancellation = invoke(db, {
    action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  await cleanupReached;
  releaseCreation();
  const created = await creation;
  releaseCleanup();
  const cancelled = await cancellation;

  const activeSegments = [...db.records('recipe_recordings').values()].filter((item) => (
    item.recordId === recordId && item.sourceType !== 'workspace_state' && item.status !== 'deleted'
  ));
  assert.equal(cancelled.ok, true);
  assert.equal(db.records('recipe_recordings').get(`workspace-claim-${recordId}`).status, 'cancelled');
  assert.equal(activeSegments.length, 0);
  if (created.ok) {
    assert.equal(db.records('recipe_recordings').get(recordingId).status, 'deleted');
  } else {
    assert.equal(created.error && created.error.code, 'RECORD_NOT_FOUND');
  }
});

test('cancelled claim atomically wins over an in-flight attach and retry stays idempotent', async () => {
  const recordId = 'record-1787000000040-1';
  const recordingId = 'recording-cancel-wins';
  const claimId = `workspace-claim-${recordId}`;
  let pauseClaimTransition = false;
  let claimPaused = false;
  let releaseAttach;
  let markAttachPaused;
  const attachReleased = new Promise((resolve) => { releaseAttach = resolve; });
  const attachPaused = new Promise((resolve) => { markAttachPaused = resolve; });
  const db = createMemoryDatabase(baseSeed(), {
    async afterTransactionRead({ name, id }) {
      if (!pauseClaimTransition || claimPaused
        || name !== 'recipe_recordings' || id !== claimId) return;
      claimPaused = true;
      markAttachPaused();
      await attachReleased;
    },
  });
  const services = recordingServices({ idGenerator: () => recordingId });
  const reserved = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);
  assert.equal(reserved.ok, true);
  db.records('family_states').get('family-a').cookingRecords.push({
    id: recordId, familyId: 'family-a', dishId: 'dish-1',
  });

  pauseClaimTransition = true;
  const attaching = invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  await attachPaused;
  const cancelled = await invoke(db, {
    action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  releaseAttach();
  const attached = await attaching;

  assert.equal(cancelled.ok, true);
  assert.equal(attached.ok, false);
  assert.equal(attached.error.code, 'RECORD_NOT_FOUND');
  assert.equal(db.records('recipe_recordings').get(claimId).status, 'cancelled');
  assert.equal(db.records('recipe_recordings').get(recordingId).status, 'deleted');
  const activeSegments = [...db.records('recipe_recordings').values()].filter((item) => (
    item.recordId === recordId && item.sourceType !== 'workspace_state' && item.status !== 'deleted'
  ));
  assert.equal(activeSegments.length, 0);

  const cancelRetry = await invoke(db, {
    action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  const attachRetry = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  assert.equal(cancelRetry.ok, true);
  assert.equal(attachRetry.ok, false);
  assert.equal(attachRetry.error.code, 'RECORD_NOT_FOUND');
});

test('attached claim atomically wins over an in-flight cancel and retry stays idempotent', async () => {
  const recordId = 'record-1787000000040-2';
  const recordingId = 'recording-attach-wins';
  const claimId = `workspace-claim-${recordId}`;
  let pauseClaimTransition = false;
  let claimPaused = false;
  let releaseCancel;
  let markCancelPaused;
  const cancelReleased = new Promise((resolve) => { releaseCancel = resolve; });
  const cancelPaused = new Promise((resolve) => { markCancelPaused = resolve; });
  const db = createMemoryDatabase(baseSeed(), {
    async afterTransactionRead({ name, id }) {
      if (!pauseClaimTransition || claimPaused
        || name !== 'recipe_recordings' || id !== claimId) return;
      claimPaused = true;
      markCancelPaused();
      await cancelReleased;
    },
  });
  const services = recordingServices({ idGenerator: () => recordingId });
  const reserved = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-a', dishId: 'dish-1', recordId, format: 'mp3',
  }, 'openid-a', services);
  assert.equal(reserved.ok, true);
  db.records('family_states').get('family-a').cookingRecords.push({
    id: recordId, familyId: 'family-a', dishId: 'dish-1',
  });

  pauseClaimTransition = true;
  const cancelling = invoke(db, {
    action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  await cancelPaused;
  const attached = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  releaseCancel();
  const cancelled = await cancelling;

  assert.equal(attached.ok, true);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'RECORD_NOT_FOUND');
  assert.equal(db.records('recipe_recordings').get(claimId).status, 'attached');
  const stored = db.records('recipe_recordings').get(recordingId);
  assert.notEqual(stored.status, 'deleted');
  assert.equal(stored.draftExpiresAt, null);

  const attachRetry = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  const cancelRetry = await invoke(db, {
    action: 'cancelRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId,
  }, 'openid-a', services);
  assert.equal(attachRetry.ok, true);
  assert.equal(cancelRetry.ok, false);
  assert.equal(cancelRetry.error.code, 'RECORD_NOT_FOUND');
});

test('pre-save IDs fail closed and archived dishes cannot open a new workspace', async () => {
  const db = createMemoryDatabase(baseSeed());
  const services = recordingServices();
  for (const event of [
    { action: 'getRecordWorkspace', recordId: 'draft-1787000000000-1' },
    { action: 'reserveRecording', recordId: '../record-1787000000000-1', format: 'mp3' },
    { action: 'addManualText', recordId: 'not-a-record', text: '文字' },
    { action: 'cancelRecordWorkspace', recordId: 'record/1787000000000/1' },
  ]) {
    const denied = await invoke(db, { familyId: 'family-a', dishId: 'dish-1', ...event }, 'openid-a', services);
    assert.equal(denied.ok, false, event.action);
    assert.equal(denied.error.code, 'RECORD_ID_INVALID', event.action);
  }

  const archived = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-deleted',
    recordId: 'record-1787000000000-5',
  }, 'openid-a', services);
  assert.equal(archived.error.code, 'DISH_DELETED');

  const historical = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-deleted', recordId: 'record-deleted',
  }, 'openid-a', services);
  assert.equal(historical.ok, true);
});

test('reserves an owned MP3 upload path and rejects format, clip-count, and family scope violations', async () => {
  const db = createMemoryDatabase(baseSeed());
  const services = recordingServices();
  const reserved = await reserveOwnedRecording(db, services);

  assert.equal(reserved.result.ok, true);
  assert.deepEqual(reserved.result.data, {
    recordingId: 'recording-fixed',
    cloudPath: 'families/family-a/recipe-audio/recording-fixed.mp3',
    expiresAt: 604800100,
  });
  assert.equal(db.records('recipe_recordings').get('recording-fixed').status, 'reserved');
  assert.equal(db.records('recipe_recordings').get('recording-fixed').sequence, 1);

  const badFormat = await reserveOwnedRecording(createMemoryDatabase(baseSeed()), recordingServices(), { format: 'm4a' });
  assert.equal(badFormat.result.error.code, 'RECORDING_FORMAT_INVALID');

  const fullSeed = baseSeed();
  fullSeed.recipe_recordings = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`clip-${index}`, {
    _id: `clip-${index}`, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    sequence: index + 1, status: 'ready', durationMs: 1,
  }]));
  const full = await reserveOwnedRecording(createMemoryDatabase(fullSeed), recordingServices());
  assert.equal(full.result.error.code, 'RECORDING_LIMIT_EXCEEDED');

  const foreign = await invoke(db, {
    action: 'reserveRecording', familyId: 'family-b', dishId: 'dish-1', recordId: 'record-1', format: 'mp3',
  }, 'openid-a', services);
  assert.equal(foreign.error.code, 'NOT_MEMBER');
});

test('submitRecording accepts only its exact reserved file and trusted MP3 metadata', async () => {
  const cases = [
    ['forged path', { fileId: 'cloud://env/families/family-b/recipe-audio/other.mp3' }, {}, 'FILE_ACCESS_DENIED'],
    ['oversize', {}, { fileApi: { async getFileInfo() { return { byteLength: 5 * 1024 * 1024 + 1, format: 'mp3', durationMs: 1 }; } } }, 'FILE_TOO_LARGE'],
    ['too long', {}, { fileApi: { async getFileInfo() { return { byteLength: 10, format: 'mp3', durationMs: 180_001 }; } } }, 'RECORDING_LIMIT_EXCEEDED'],
    ['wrong metadata format', {}, { fileApi: { async getFileInfo() { return { byteLength: 10, format: 'm4a', durationMs: 1 }; } } }, 'RECORDING_FORMAT_INVALID'],
    ['metadata unavailable', {}, { fileApi: { async getFileInfo() { throw new Error('private provider failure'); } } }, 'FILE_METADATA_UNAVAILABLE'],
  ];
  for (const [label, eventPatch, servicePatch, code] of cases) {
    const db = createMemoryDatabase(baseSeed());
    const base = recordingServices();
    const services = { ...base, ...servicePatch };
    await reserveOwnedRecording(db, services);
    const submitted = await invoke(db, {
      action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
      fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3', byteLength: 1,
      ...eventPatch,
    }, 'openid-a', services);
    assert.equal(submitted.error.code, code, label);
  }

  const db = createMemoryDatabase(baseSeed());
  const services = recordingServices();
  await reserveOwnedRecording(db, services);
  const submitted = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3', byteLength: 99_999_999,
  }, 'openid-a', services);
  assert.equal(submitted.ok, true);
  const stored = db.records('recipe_recordings').get('recording-fixed');
  assert.equal(stored.byteLength, 1024);
  assert.equal(stored.durationMs, 60_000);
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, 1001);
});

test('submitRecording rejects a trusted duration that would exceed fifteen minutes', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    prior: { _id: 'prior', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1, status: 'ready', durationMs: 850_000 },
  };
  const services = recordingServices({
    idGenerator: () => 'recording-next',
    fileApi: { async getFileInfo() { return { byteLength: 1024, format: 'mp3', durationMs: 60_000 }; } },
  });
  const db = createMemoryDatabase(seed);
  await reserveOwnedRecording(db, services);
  const result = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-next',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-next.mp3',
  }, 'openid-a', services);
  assert.equal(result.error.code, 'RECORDING_LIMIT_EXCEEDED');
});

test('manual text, transcript revisions, attachment, and workspace audio URLs follow the workspace contract', async () => {
  const db = createMemoryDatabase(baseSeed());
  const services = recordingServices({ idGenerator: () => 'manual-fixed' });
  const added = await invoke(db, {
    action: 'addManualText', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', text: ' 少放盐 ',
  }, 'openid-a', services);
  assert.equal(added.data.recording.sourceType, 'manual_text');
  assert.equal(added.data.recording.editedTranscript, '少放盐');
  assert.equal(added.data.recording.transcriptRevision, 0);

  const updated = await invoke(db, {
    action: 'updateTranscript', familyId: 'family-a', dishId: 'dish-1', recordingId: 'manual-fixed',
    transcriptRevision: 0, text: '少放一点盐',
  }, 'openid-a', services);
  assert.equal(updated.data.recording.transcriptRevision, 1);
  const stale = await invoke(db, {
    action: 'updateTranscript', familyId: 'family-a', dishId: 'dish-1', recordingId: 'manual-fixed',
    transcriptRevision: 0, text: '覆盖别人修改',
  }, 'openid-a', services);
  assert.equal(stale.error.code, 'TRANSCRIPT_CONFLICT');

  const reserved = recordingServices({ idGenerator: () => 'recording-audio-fixed' });
  await reserveOwnedRecording(db, reserved);
  await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-audio-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-audio-fixed.mp3',
  }, 'openid-a', reserved);
  const attached = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', reserved);
  assert.equal(attached.ok, true);
  assert.equal(db.records('recipe_recordings').get('recording-audio-fixed').draftExpiresAt, null);

  const workspace = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', reserved);
  assert.deepEqual(workspace.data.recordings.map((item) => item.sequence), [1, 2]);
  assert.equal(workspace.data.audioUrls['recording-audio-fixed'].startsWith('https://temp.example/'), true);
  assert.equal(JSON.stringify([...db.records('recipe_recordings').values()]).includes('temp.example'), false);
});

test('audio deletion requires text, persists before deleting, and keeps retry state on provider failure', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: { _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1, sourceType: 'audio', status: 'ready', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3', rawTranscript: '', editedTranscript: '', transcriptRevision: 0 },
  };
  const db = createMemoryDatabase(seed);
  const denied = await invoke(db, {
    action: 'deleteRecordingAudio', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', recordingServices());
  assert.equal(denied.error.code, 'TRANSCRIPT_REQUIRED');

  db.records('recipe_recordings').get('audio').editedTranscript = '保留文字';
  const failing = recordingServices({ fileApi: {
    async deleteFile() { throw new Error('delete failed'); },
  } });
  const pending = await invoke(db, {
    action: 'deleteRecordingAudio', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', failing);
  assert.equal(pending.ok, true);
  assert.equal(db.records('recipe_recordings').get('audio').audioDeletePending, true);
  assert.equal(db.records('recipe_recordings').get('audio').fileId.includes('audio.mp3'), true);

  const retry = recordingServices();
  const deleted = await invoke(db, {
    action: 'deleteRecordingAudio', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', retry);
  assert.equal(deleted.ok, true);
  assert.equal(db.records('recipe_recordings').get('audio').fileId, '');
  assert.equal(db.records('recipe_recordings').get('audio').audioDeletePending, false);
});

test('deleting a transcribing recording leaves a tombstone that rejects late transcript writes', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: { _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1, sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3', transcriptRevision: 0 },
  };
  const db = createMemoryDatabase(seed);
  const services = recordingServices();
  const removed = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', services);
  assert.equal(removed.ok, true);
  assert.equal(db.records('recipe_recordings').get('audio').status, 'deleted');

  const late = await invoke(db, {
    action: 'updateTranscript', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
    transcriptRevision: 0, text: '迟到的识别结果',
  }, 'openid-a', services);
  assert.equal(late.error.code, 'RECORDING_DELETED');
  assert.equal(db.records('recipe_recordings').get('audio').editedTranscript || '', '');
});

test('a tombstoned recording retries a previously failed cloud-file deletion', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: { _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3',
      transcriptRevision: 0 },
  };
  const db = createMemoryDatabase(seed);
  const failed = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', recordingServices({ fileApi: { async deleteFile() { throw new Error('offline'); } } }));
  assert.equal(failed.ok, true);
  assert.equal(failed.data.recording.audioDeletePending, true);

  const retry = recordingServices();
  const cleaned = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', retry);
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.data.recording.audioDeletePending, false);
  assert.equal(cleaned.data.recording.fileId, '');
  assert.deepEqual(retry.deleted, ['cloud://env/families/family-a/recipe-audio/audio.mp3']);
});

test('deletion while ASR submission is pending prevents a late result from resurrecting the recording', async () => {
  const db = createMemoryDatabase(baseSeed());
  let releaseSubmit;
  let submitStarted;
  const started = new Promise((resolve) => { submitStarted = resolve; });
  const services = recordingServices({
    idGenerator: () => 'recording-race',
    asrProvider: {
      submit() {
        submitStarted();
        return new Promise((resolve) => { releaseSubmit = resolve; });
      },
    },
  });
  await reserveOwnedRecording(db, services);
  const submitting = invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-race',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-race.mp3',
  }, 'openid-a', services);
  await started;

  const deleted = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-race',
  }, 'openid-a', services);
  assert.equal(deleted.ok, true);
  assert.equal(db.records('recipe_recordings').get('recording-race').asrSubmitToken || '', '');
  assert.equal(db.records('recipe_recordings').get('recording-race').asrSubmitLeaseExpiresAt || null, null);
  releaseSubmit({ taskId: 3001, requestId: 'late-request', submittedAt: 100, expiresAt: 200 });
  const late = await submitting;

  assert.equal(late.error.code, 'RECORDING_DELETED');
  const stored = db.records('recipe_recordings').get('recording-race');
  assert.equal(stored.status, 'deleted');
  assert.notEqual(stored.asrTaskId, 3001);
});

test('production file adapter downloads and parses trusted MP3 bytes without retaining client metadata', async () => {
  const content = createMpeg2Layer3Frames(4);
  const downloads = [];
  const fileApi = createCloudFileApi({
    async downloadFile(input) {
      downloads.push(input);
      return { fileContent: content };
    },
  });

  const metadata = await fileApi.getFileInfo({ fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3' });

  assert.deepEqual(downloads, [{ fileID: 'cloud://env/families/family-a/recipe-audio/audio.mp3' }]);
  assert.deepEqual(metadata, {
    fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3',
    byteLength: 864,
    format: 'mp3',
    durationMs: 144,
  });
});

test('production file adapter fails closed without trustworthy bounded MP3 bytes', async () => {
  const cases = [
    ['missing downloadFile', {}, 'FILE_METADATA_UNAVAILABLE'],
    ['missing content', { async downloadFile() { return {}; } }, 'FILE_METADATA_UNAVAILABLE'],
    ['non-buffer content', { async downloadFile() { return { fileContent: new Uint8Array([1, 2, 3]) }; } }, 'FILE_METADATA_UNAVAILABLE'],
    ['non-MP3 bytes', { async downloadFile() { return { fileContent: Buffer.from('not an mp3') }; } }, 'FILE_METADATA_UNAVAILABLE'],
    ['oversized bytes', { async downloadFile() { return { fileContent: Buffer.alloc(5 * 1024 * 1024 + 1) }; } }, 'FILE_TOO_LARGE'],
  ];

  for (const [label, cloud, expectedCode] of cases) {
    const fileApi = createCloudFileApi(cloud);
    await assert.rejects(
      fileApi.getFileInfo({ fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3' }),
      (error) => error && error.code === expectedCode,
      label
    );
  }
});

test('attachRecordWorkspace cannot clear expiration or resurrect a recording deleted after listing', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'reserved', draftExpiresAt: 700, fileId: '', createdBy: 'member-a',
    },
  };
  const db = createMemoryDatabase(seed);
  const baseRepository = createRecipeRepository(db, DEFAULT_CONFIG);
  let raced = false;
  const repository = {
    ...baseRepository,
    async listRecordings(...args) {
      const listed = await baseRepository.listRecordings(...args);
      if (!raced) {
        raced = true;
        await baseRepository.setRecording('audio', {
          ...listed[0], status: 'deleted', deletedAt: 99, audioDeletePending: false,
        });
      }
      return listed;
    },
  };

  const result = await invoke(db, {
    action: 'attachRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', { repository });

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'deleted');
  assert.equal(stored.deletedAt, 99);
  assert.equal(stored.draftExpiresAt, 700);
});

test('tombstone cleanup targets the fileId committed after the initial delete read', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'reserved', draftExpiresAt: 700, fileId: '', durationMs: 0, createdBy: 'member-a',
    },
  };
  const db = createMemoryDatabase(seed);
  const baseRepository = createRecipeRepository(db, DEFAULT_CONFIG);
  let reads = 0;
  const uploadedFileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const repository = {
    ...baseRepository,
    async getRecording(...args) {
      const stale = await baseRepository.getRecording(...args);
      reads += 1;
      if (reads === 2) {
        await baseRepository.setRecording('audio', {
          ...stale, status: 'transcribing', fileId: uploadedFileId, byteLength: 864,
          durationMs: 144, durationCommitted: true,
        });
      }
      return stale;
    },
  };
  const services = recordingServices();

  const result = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', { ...services, repository });

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'deleted');
  assert.equal(services.deleted.includes(uploadedFileId) || stored.audioDeletePending === true, true);
  assert.equal(stored.fileId === '' || stored.fileId === uploadedFileId, true);
});

test('deleteRecordingAudio re-reads current text and file state before marking deletion pending', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'ready', fileId: 'cloud://env/families/family-a/recipe-audio/old.mp3',
      rawTranscript: '原文字', editedTranscript: '原文字', transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  const baseRepository = createRecipeRepository(db, DEFAULT_CONFIG);
  const currentFileId = 'cloud://env/families/family-a/recipe-audio/current.mp3';
  let reads = 0;
  const repository = {
    ...baseRepository,
    async getRecording(...args) {
      const stale = await baseRepository.getRecording(...args);
      reads += 1;
      if (reads === 2) {
        await baseRepository.setRecording('audio', {
          ...stale, fileId: currentFileId, editedTranscript: '家人刚修订的文字', transcriptRevision: 1,
        });
      }
      return stale;
    },
  };
  const services = recordingServices();

  const result = await invoke(db, {
    action: 'deleteRecordingAudio', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio',
  }, 'openid-a', { ...services, repository });

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.editedTranscript, '家人刚修订的文字');
  assert.equal(stored.transcriptRevision, 1);
  assert.deepEqual(services.deleted, [currentFileId]);
  assert.equal(stored.fileId, '');
});

test('workspace counters serialize concurrent reservations and release duration on tombstone deletion', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`clip-${index}`, {
    _id: `clip-${index}`, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    sequence: index + 1, sourceType: 'audio', status: 'ready', durationMs: 100_000,
    durationCommitted: true,
  }]));
  const db = createMemoryDatabase(seed);
  const first = recordingServices({ idGenerator: () => 'recording-ten' });
  const second = recordingServices({ idGenerator: () => 'recording-eleven' });

  const [ten, eleven] = await Promise.all([
    reserveOwnedRecording(db, first),
    reserveOwnedRecording(db, second),
  ]);
  assert.deepEqual([ten.result.ok, eleven.result.ok].sort(), [false, true]);
  assert.equal([ten.result, eleven.result].find((item) => !item.ok).error.code, 'RECORDING_LIMIT_EXCEEDED');

  const successful = [ten.result, eleven.result].find((item) => item.ok);
  const recordingId = successful.data.recordingId;
  const selected = recordingId === 'recording-ten' ? first : second;
  await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId,
    fileId: `cloud://env/families/family-a/recipe-audio/${recordingId}.mp3`,
  }, 'openid-a', selected);
  const deleted = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1', recordingId,
  }, 'openid-a', selected);
  assert.equal(deleted.ok, true);

  const state = db.records('recipe_recordings').get('workspace-family-a-dish-1-record-1');
  assert.equal(state.activeCount, 9);
  assert.equal(state.totalDurationMs, 900_000);

  const replacement = await reserveOwnedRecording(db, recordingServices({ idGenerator: () => 'recording-replacement' }));
  assert.equal(replacement.result.ok, true);
});

test('manual text shares the ten-segment workspace quota', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`clip-${index}`, {
    _id: `clip-${index}`, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    sequence: index + 1, sourceType: 'manual_text', status: 'ready', durationMs: 0,
  }]));
  const result = await invoke(createMemoryDatabase(seed), {
    action: 'addManualText', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', text: '第十一段',
  }, 'openid-a', recordingServices({ idGenerator: () => 'manual-eleven' }));
  assert.equal(result.error.code, 'RECORDING_LIMIT_EXCEEDED');
});

test('workspace state documents are not addressable as recordings and foreign audio never gets a temporary URL', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    'workspace-family-a-dish-1-record-1': {
      _id: 'workspace-family-a-dish-1-record-1', familyId: 'family-a', dishId: 'dish-1',
      recordId: 'record-1', sourceType: 'workspace_state', status: 'active', activeCount: 1,
    },
    foreign: {
      _id: 'foreign', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'ready', fileId: 'cloud://env/families/family-b/recipe-audio/foreign.mp3',
    },
  };
  const db = createMemoryDatabase(seed);
  const internal = await invoke(db, {
    action: 'deleteRecording', familyId: 'family-a', dishId: 'dish-1',
    recordingId: 'workspace-family-a-dish-1-record-1',
  }, 'openid-a', recordingServices());
  assert.equal(internal.error.code, 'RECORDING_NOT_FOUND');

  let requested = null;
  const workspace = await invoke(db, {
    action: 'getRecordWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', recordingServices({ fileApi: {
    async getTempFileURL(input) { requested = input; return { fileList: [] }; },
  } }));
  assert.equal(workspace.ok, true);
  assert.deepEqual(workspace.data.audioUrls, {});
  assert.equal(requested, null);
});

test('submitRecording keeps an unexpired ASR task idempotent and replaces an expired task on the same recording', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrTaskId: 1001, asrSubmittedAt: 50, asrExpiresAt: 200, transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  const activeServices = recordingServices({ now: () => 100 });
  const active = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId,
  }, 'openid-a', activeServices);
  assert.equal(active.error.code, 'ASR_TASK_IN_PROGRESS');
  assert.equal(activeServices.submitted.length, 0);

  const retryServices = recordingServices({
    now: () => 201,
    asrProvider: {
      async submit(input) {
        retryServices.submitted.push(input);
        return { taskId: 2001, requestId: 'replacement-request', submittedAt: 201, expiresAt: 301 };
      },
    },
  });
  const retried = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId,
  }, 'openid-a', retryServices);
  assert.equal(retried.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored._id, 'audio');
  assert.equal(stored.asrTaskId, 2001);
  assert.equal(stored.asrRequestId, 'replacement-request');
  assert.equal(retryServices.submitted.length, 1);
});

test('concurrent retries create only one replacement ASR task', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'failed', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrTaskId: 1001, asrSubmittedAt: 10, asrExpiresAt: 20, transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  let submits = 0;
  const services = recordingServices({ asrProvider: {
    async submit() {
      submits += 1;
      return { taskId: 2001, requestId: 'replacement-request', submittedAt: 100, expiresAt: 200 };
    },
  } });
  const event = {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId,
  };

  const results = await Promise.all([
    invoke(db, event, 'openid-a', services),
    invoke(db, event, 'openid-a', services),
  ]);

  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.deepEqual(results.filter((item) => !item.ok).map((item) => item.error.code), ['ASR_TASK_IN_PROGRESS']);
  assert.equal(submits, 1);
});

test('an orphaned uploading lease becomes retryable at its two-minute expiry boundary', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'uploading', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrSubmitToken: 'orphan-token', asrSubmitLeaseExpiresAt: 120_100,
      asrTaskId: '', asrSubmittedAt: null, asrExpiresAt: null, transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  const services = recordingServices({
    now: () => 120_100,
    asrSubmitTokenGenerator: () => 'recovery-token',
    asrProvider: { async submit() {
      return { taskId: 2001, requestId: 'recovered-request', submittedAt: 120_100, expiresAt: 220_100 };
    } },
  });

  const result = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId,
  }, 'openid-a', services);

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, 2001);
  assert.equal(stored.asrSubmitToken || '', '');
  assert.equal(stored.asrSubmitLeaseExpiresAt || null, null);
});

test('an unexpired uploading lease blocks a concurrent submit', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'uploading', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrSubmitToken: 'active-token', asrSubmitLeaseExpiresAt: 120_101,
      asrTaskId: '', asrSubmittedAt: null, asrExpiresAt: null, transcriptRevision: 0,
    },
  };
  const services = recordingServices({ now: () => 120_100 });

  const result = await invoke(createMemoryDatabase(seed), {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId,
  }, 'openid-a', services);

  assert.equal(result.error.code, 'ASR_TASK_IN_PROGRESS');
  assert.equal(services.submitted.length, 0);
});

test('a stale submit success cannot overwrite a newer lease result', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'failed', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrTaskId: '', transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  let now = 100;
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const first = recordingServices({
    now: () => now,
    asrSubmitTokenGenerator: () => 'first-token',
    asrProvider: { submit() {
      firstStarted();
      return new Promise((resolve) => { releaseFirst = resolve; });
    } },
  });
  const event = { action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId };
  const firstCall = invoke(db, event, 'openid-a', first);
  await started;
  const firstLease = db.records('recipe_recordings').get('audio');
  assert.equal(firstLease.asrSubmitToken, 'first-token');
  assert.equal(firstLease.asrSubmitLeaseExpiresAt, 120_100);

  now = 120_100;
  const second = recordingServices({
    now: () => now,
    asrSubmitTokenGenerator: () => 'second-token',
    asrProvider: { async submit() {
      return { taskId: 2002, requestId: 'second-request', submittedAt: now, expiresAt: now + 1000 };
    } },
  });
  const secondResult = await invoke(db, event, 'openid-a', second);
  assert.equal(secondResult.ok, true);

  releaseFirst({ taskId: 2001, requestId: 'first-request', submittedAt: 100, expiresAt: 1000 });
  const staleResult = await firstCall;
  assert.equal(staleResult.error.code, 'ASR_SUBMIT_LEASE_LOST');
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, 2002);
  assert.equal(stored.asrRequestId, 'second-request');
});

test('a stale submit failure cannot mark a newer task failed', async () => {
  const fileId = 'cloud://env/families/family-a/recipe-audio/audio.mp3';
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'failed', reservedCloudPath: 'families/family-a/recipe-audio/audio.mp3',
      fileId, format: 'mp3', byteLength: 1024, durationMs: 60_000, durationCommitted: true,
      asrTaskId: '', transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  let now = 100;
  let rejectFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const first = recordingServices({
    now: () => now,
    asrSubmitTokenGenerator: () => 'first-token',
    asrProvider: { submit() {
      firstStarted();
      return new Promise((resolve, reject) => { rejectFirst = reject; });
    } },
  });
  const event = { action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'audio', fileId };
  const firstCall = invoke(db, event, 'openid-a', first);
  await started;

  now = 120_100;
  const second = recordingServices({
    now: () => now,
    asrSubmitTokenGenerator: () => 'second-token',
    asrProvider: { async submit() {
      return { taskId: 2002, requestId: 'second-request', submittedAt: now, expiresAt: now + 1000 };
    } },
  });
  assert.equal((await invoke(db, event, 'openid-a', second)).ok, true);

  rejectFirst(new Error('first provider failed late'));
  const staleResult = await firstCall;
  assert.equal(staleResult.error.code, 'ASR_SUBMIT_LEASE_LOST');
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, 2002);
  assert.equal(stored.errorCode, '');
});

test('submitRecording rejects an invalid provider task id without persisting transcribing state', async () => {
  const db = createMemoryDatabase(baseSeed());
  const services = recordingServices({ asrProvider: { async submit() {
    return { taskId: 0, requestId: 'invalid-request', submittedAt: 100, expiresAt: 200 };
  } } });
  await reserveOwnedRecording(db, services);

  const result = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3',
  }, 'openid-a', services);

  assert.equal(result.error.code, 'ASR_SUBMIT_RESPONSE_INVALID');
  const stored = db.records('recipe_recordings').get('recording-fixed');
  assert.equal(stored.status, 'failed');
  assert.equal(stored.asrTaskId || '', '');
  assert.equal(stored.asrSubmitToken || '', '');
  assert.equal(stored.asrSubmitLeaseExpiresAt || null, null);
});

test('refreshWorkspace ignores a stale ready result when a retry reuses the Tencent task id', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3',
      asrTaskId: 1001, asrSubmittedAt: 10, asrExpiresAt: 1000,
      asrRequestId: 'old-request', rawTranscript: '', editedTranscript: '', transcriptRevision: 0, errorCode: '',
    },
  };
  const db = createMemoryDatabase(seed);
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise((resolve) => { markQueryStarted = resolve; });
  const services = recordingServices({ asrProvider: { query(input) {
    return new Promise((resolve) => {
      releaseQuery = resolve;
      markQueryStarted(input);
    });
  } } });

  const refreshing = invoke(db, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);
  assert.deepEqual(await queryStarted, { taskId: 1001, submittedAt: 10, expiresAt: 1000 });

  Object.assign(db.records('recipe_recordings').get('audio'), {
    status: 'transcribing', asrTaskId: '1001', asrSubmittedAt: '20', asrExpiresAt: '2000',
    asrRequestId: 'new-request', rawTranscript: '', editedTranscript: '', transcriptRevision: 0, errorCode: '',
  });
  releaseQuery({
    status: 'ready', transcript: '过期识别文字', durationMs: 1000,
    requestId: 'stale-ready-request', errorCode: '',
  });
  const result = await refreshing;

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, '1001');
  assert.equal(stored.asrSubmittedAt, '20');
  assert.equal(stored.asrRequestId, 'new-request');
  assert.equal(stored.rawTranscript, '');
  assert.equal(stored.editedTranscript, '');
  assert.equal(stored.errorCode, '');
});

test('refreshWorkspace ignores a stale failure when a retry reuses the Tencent task id', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    audio: {
      _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3',
      asrTaskId: '2001', asrSubmittedAt: '30', asrExpiresAt: '1000',
      asrRequestId: 'old-request', rawTranscript: '', editedTranscript: '', transcriptRevision: 0, errorCode: '',
    },
  };
  const db = createMemoryDatabase(seed);
  let releaseQuery;
  let markQueryStarted;
  const queryStarted = new Promise((resolve) => { markQueryStarted = resolve; });
  const services = recordingServices({ asrProvider: { query(input) {
    return new Promise((resolve) => {
      releaseQuery = resolve;
      markQueryStarted(input);
    });
  } } });

  const refreshing = invoke(db, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);
  await queryStarted;

  Object.assign(db.records('recipe_recordings').get('audio'), {
    status: 'transcribing', asrTaskId: 2001, asrSubmittedAt: 40, asrExpiresAt: 2000,
    asrRequestId: 'new-request', rawTranscript: '', editedTranscript: '', transcriptRevision: 0, errorCode: '',
  });
  releaseQuery({
    status: 'failed', transcript: '', durationMs: 0,
    requestId: 'stale-failure-request', errorCode: 'ASR_TASK_FAILED',
  });
  const result = await refreshing;

  assert.equal(result.ok, true);
  const stored = db.records('recipe_recordings').get('audio');
  assert.equal(stored.status, 'transcribing');
  assert.equal(stored.asrTaskId, 2001);
  assert.equal(stored.asrSubmittedAt, 40);
  assert.equal(stored.asrRequestId, 'new-request');
  assert.equal(stored.errorCode, '');
});

test('refreshWorkspace rejects a malformed stored ASR generation before querying the provider', async () => {
  const invalidSubmittedAtValues = [undefined, null, false, '', 'not-a-timestamp', -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const asrSubmittedAt of invalidSubmittedAtValues) {
    const seed = baseSeed();
    seed.recipe_recordings = {
      audio: {
        _id: 'audio', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
        sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/audio.mp3',
        asrTaskId: 3001, asrSubmittedAt, asrExpiresAt: 1000,
        asrRequestId: 'existing-request', rawTranscript: '', editedTranscript: '', transcriptRevision: 0, errorCode: '',
      },
    };
    let queryCalls = 0;
    const services = recordingServices({ asrProvider: { async query() {
      queryCalls += 1;
      return { status: 'ready', transcript: '不应写入', durationMs: 1000, requestId: 'unexpected', errorCode: '' };
    } } });
    const db = createMemoryDatabase(seed);

    const result = await invoke(db, {
      action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
    }, 'openid-a', services);

    assert.equal(result.error.code, 'ASR_TASK_GENERATION_INVALID', String(asrSubmittedAt));
    assert.equal(queryCalls, 0, String(asrSubmittedAt));
    const stored = db.records('recipe_recordings').get('audio');
    assert.equal(stored.status, 'transcribing', String(asrSubmittedAt));
    assert.equal(stored.rawTranscript, '', String(asrSubmittedAt));
    assert.equal(stored.asrRequestId, 'existing-request', String(asrSubmittedAt));
  }
});

test('refreshWorkspace queries at most ten owned transcribing recordings in sequence order', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`audio-${index + 1}`, {
    _id: `audio-${index + 1}`, familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: index + 1,
    sourceType: 'audio', status: 'transcribing', fileId: `cloud://env/families/family-a/recipe-audio/audio-${index + 1}.mp3`,
    asrTaskId: index + 1, asrSubmittedAt: 10, asrExpiresAt: 1000, rawTranscript: '', editedTranscript: '', transcriptRevision: 0,
  }]));
  const queried = [];
  const services = recordingServices({ asrProvider: {
    async query(input) {
      queried.push(input);
      return { status: 'transcribing', transcript: '', durationMs: 0, requestId: `q-${input.taskId}`, errorCode: '' };
    },
  } });

  const result = await invoke(createMemoryDatabase(seed), {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);

  assert.equal(result.ok, true);
  assert.deepEqual(queried.map((item) => item.taskId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('refreshWorkspace persists ready text without overwriting a user edit and keeps failed audio retryable', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    ready: {
      _id: 'ready', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/ready.mp3',
      asrTaskId: 1, asrSubmittedAt: 10, asrExpiresAt: 1000, rawTranscript: '', editedTranscript: '家人修订文字', transcriptRevision: 1,
    },
    failed: {
      _id: 'failed', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 2,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/failed.mp3',
      asrTaskId: 2, asrSubmittedAt: 10, asrExpiresAt: 1000, rawTranscript: '', editedTranscript: '', transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  const services = recordingServices({ asrProvider: { async query({ taskId }) {
    return taskId === 1
      ? { status: 'ready', transcript: '机器识别文字', durationMs: 1234, requestId: 'ready-query', errorCode: '' }
      : { status: 'failed', transcript: '', durationMs: 0, requestId: 'failed-query', errorCode: 'ASR_TASK_FAILED' };
  } } });

  const result = await invoke(db, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);

  assert.equal(result.ok, true);
  const ready = db.records('recipe_recordings').get('ready');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.rawTranscript, '机器识别文字');
  assert.equal(ready.editedTranscript, '家人修订文字');
  assert.equal(ready.transcriptRevision, 1);
  const failed = db.records('recipe_recordings').get('failed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ASR_TASK_FAILED');
  assert.equal(failed.fileId.endsWith('/failed.mp3'), true);
});

test('refreshWorkspace initializes edited text once and cannot resurrect a recording deleted during ASR query', async () => {
  const seed = baseSeed();
  seed.recipe_recordings = {
    initial: {
      _id: 'initial', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 1,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/initial.mp3',
      asrTaskId: 1, asrSubmittedAt: 10, asrExpiresAt: 1000, rawTranscript: '', editedTranscript: '', transcriptRevision: 0,
    },
    deleted: {
      _id: 'deleted', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1', sequence: 2,
      sourceType: 'audio', status: 'transcribing', fileId: 'cloud://env/families/family-a/recipe-audio/deleted.mp3',
      asrTaskId: 2, asrSubmittedAt: 10, asrExpiresAt: 1000, rawTranscript: '', editedTranscript: '', transcriptRevision: 0,
    },
  };
  const db = createMemoryDatabase(seed);
  const services = recordingServices({ asrProvider: { async query({ taskId }) {
    if (taskId === 2) db.records('recipe_recordings').get('deleted').status = 'deleted';
    return { status: 'ready', transcript: `识别结果${taskId}`, durationMs: 1000, requestId: `q-${taskId}`, errorCode: '' };
  } } });

  const result = await invoke(db, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);

  assert.equal(result.ok, true);
  const initial = db.records('recipe_recordings').get('initial');
  assert.equal(initial.rawTranscript, '识别结果1');
  assert.equal(initial.editedTranscript, '识别结果1');
  assert.equal(db.records('recipe_recordings').get('deleted').status, 'deleted');
  assert.equal(db.records('recipe_recordings').get('deleted').rawTranscript, '');
});

function organizeSeed(options = {}) {
  const seed = baseSeed();
  const oldRecipe = {
    ...clone(validRecipe),
    ingredients: [{ ...clone(validRecipe.ingredients[0]), name: '旧菜谱' }],
  };
  seed.recipe_drafts = {
    'draft-recording': {
      _id: 'draft-recording', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
      sourceRecordingIds: [], sourceType: 'manual', status: 'editing', recipe: oldRecipe,
      baseMainVersionId: '', revision: 0, inputHash: '', modelProvider: '', modelName: '',
      promptVersion: '', lastErrorCode: '', confirmedVersionId: '', createdBy: 'member-a',
      createdAt: 1, updatedBy: 'member-a', updatedAt: 1,
      ...(options.draft || {}),
    },
  };
  seed.recipe_recordings = {
    'recording-first': {
      _id: 'recording-first', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
      sequence: 1, sourceType: 'audio', status: 'ready', rawTranscript: '第一段原文',
      editedTranscript: '第一段', transcriptRevision: 0, createdBy: 'member-a',
    },
    'recording-second': {
      _id: 'recording-second', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
      sequence: 2, sourceType: 'manual_text', status: 'ready', rawTranscript: '第二段',
      editedTranscript: '第二段', transcriptRevision: 0, createdBy: 'member-a',
    },
    ...(options.recordings || {}),
  };
  return seed;
}

function organizeEvent(sourceRecordingIds = ['recording-second', 'recording-first']) {
  return {
    action: 'organizeDraft', familyId: 'family-a', dishId: 'dish-1',
    draftId: 'draft-recording', sourceRecordingIds,
    memberId: 'forged-member', modelName: 'forged-model', inputHash: 'forged-hash',
    organizeLeaseId: 'forged-lease',
  };
}

function organizedRecipe(name = '新菜谱') {
  return {
    ...clone(validRecipe),
    ingredients: [{ ...clone(validRecipe.ingredients[0]), name }],
  };
}

test('buildSourceText orders selected recordings and createInputHash is an unambiguous SHA-256', () => {
  const sourceText = buildSourceText([
    { _id: 'second', sequence: 2, editedTranscript: '第二段' },
    { _id: 'first', sequence: 1, editedTranscript: '第一段' },
  ]);
  assert.equal(sourceText, '【第 1 段】\n第一段\n\n【第 2 段】\n第二段');

  const input = { sourceText, modelName: 'hy3', promptVersion: 'v1' };
  const expected = crypto.createHash('sha256')
    .update(JSON.stringify(['hy3', 'v1', sourceText]), 'utf8')
    .digest('hex');
  assert.equal(createInputHash(input), expected);
  assert.notEqual(createInputHash({ ...input, modelName: 'deepseek-v4-flash' }), expected);
});

test('organizeDraft rejects pending, empty, and oversized sources before calling the provider', async () => {
  const cases = [
    {
      code: 'RECORDINGS_PENDING',
      seed: organizeSeed({ recordings: {
        'recording-second': {
          _id: 'recording-second', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
          sequence: 2, sourceType: 'audio', status: 'transcribing', editedTranscript: '',
        },
      } }),
      ids: ['recording-first', 'recording-second'],
    },
    {
      code: 'SOURCE_REQUIRED',
      seed: organizeSeed({ recordings: {
        'recording-first': {
          _id: 'recording-first', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
          sequence: 1, sourceType: 'manual_text', status: 'ready', editedTranscript: '   ',
        },
      } }),
      ids: ['recording-first'],
    },
    {
      code: 'SOURCE_TOO_LONG',
      seed: organizeSeed({ recordings: {
        'recording-first': {
          _id: 'recording-first', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
          sequence: 1, sourceType: 'manual_text', status: 'ready', editedTranscript: '菜'.repeat(30_001),
        },
      } }),
      ids: ['recording-first'],
    },
  ];

  for (const item of cases) {
    let calls = 0;
    const result = await invoke(createMemoryDatabase(item.seed), organizeEvent(item.ids), 'openid-a', {
      recipeProvider: { async organize() { calls += 1; return { recipe: organizedRecipe() }; } },
      recipeModel: 'hy3', recipePromptVersion: 'v1',
      organizeLeaseIdGenerator: () => 'lease-validation',
    });
    assert.equal(result.error.code, item.code, item.code);
    assert.equal(calls, 0, item.code);
  }
});

test('organizeDraft stores a ready normalized result and reuses the same input hash without a second model call', async () => {
  const db = createMemoryDatabase(organizeSeed());
  let calls = 0;
  const services = {
    recipeModel: 'hy3', recipePromptVersion: 'v1',
    organizeLeaseIdGenerator: () => 'lease-ready',
    recipeProvider: { async organize(input) {
      calls += 1;
      assert.equal(input.sourceText, '【第 1 段】\n第一段\n\n【第 2 段】\n第二段');
      assert.match(input.userId, /^[a-f0-9]{64}$/);
      return {
        recipe: { ...organizedRecipe(), ignored: 'discard-me' },
        requestId: 'request-model-1', modelName: 'hy3', promptVersion: 'v1',
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, reasoning: 'do-not-store' },
      };
    } },
  };

  const first = await invoke(db, organizeEvent(), 'openid-a', services);
  const second = await invoke(db, organizeEvent(), 'openid-a', services);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  assert.equal(first.data.draft.status, 'ready');
  assert.equal(first.data.draft.revision, 1);
  assert.equal(first.data.draft.recipe.ingredients[0].name, '新菜谱');
  assert.equal(Object.hasOwn(first.data.draft.recipe, 'ignored'), false);
  assert.deepEqual(first.data.draft.sourceRecordingIds, ['recording-first', 'recording-second']);
  assert.equal(first.data.draft.modelRequestId, 'request-model-1');
  assert.deepEqual(first.data.draft.modelUsage, {
    prompt_tokens: 12, completion_tokens: 7, total_tokens: 19,
  });
  assert.equal(Object.hasOwn(first.data.draft, 'organizeLeaseId'), false);
  assert.equal(second.data.draft.inputHash, first.data.draft.inputHash);
});

test('organizeDraft enforces an active lease and recovers an expired lease', async () => {
  const activeDb = createMemoryDatabase(organizeSeed({ draft: {
    status: 'organizing', organizeLeaseId: 'lease-active', organizeLeaseExpiresAt: 1_001,
  } }));
  let activeCalls = 0;
  const active = await invoke(activeDb, organizeEvent(), 'openid-a', {
    now: () => 1_000,
    recipeProvider: { async organize() { activeCalls += 1; return { recipe: organizedRecipe() }; } },
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-new',
  });
  assert.equal(active.error.code, 'ORGANIZE_IN_PROGRESS');
  assert.equal(activeCalls, 0);

  const expiredDb = createMemoryDatabase(organizeSeed({ draft: {
    status: 'organizing', organizeLeaseId: 'lease-expired', organizeLeaseExpiresAt: 1_000,
  } }));
  let expiredCalls = 0;
  const recovered = await invoke(expiredDb, organizeEvent(), 'openid-a', {
    now: () => 1_000,
    recipeProvider: { async organize() {
      expiredCalls += 1;
      return { recipe: organizedRecipe('恢复菜谱'), requestId: 'recovered', modelName: 'hy3', promptVersion: 'v1', usage: {} };
    } },
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-recovered',
  });
  assert.equal(recovered.ok, true);
  assert.equal(expiredCalls, 1);
  assert.equal(recovered.data.draft.recipe.ingredients[0].name, '恢复菜谱');
});

test('organizeDraft failure preserves the previous recipe and transcript and stores only a public error code', async () => {
  const db = createMemoryDatabase(organizeSeed());
  const privateMessage = 'upstream included private transcript 第一段 and key sk-secret';
  const result = await invoke(db, organizeEvent(), 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-failed',
    recipeProvider: { async organize() {
      const error = new Error(privateMessage);
      error.name = 'TokenHubProviderError';
      error.code = 'AI_HTTP_ERROR';
      throw error;
    } },
  });

  const stored = db.records('recipe_drafts').get('draft-recording');
  assert.equal(result.error.code, 'AI_HTTP_ERROR');
  assert.equal(stored.status, 'failed');
  assert.equal(stored.lastErrorCode, 'AI_HTTP_ERROR');
  assert.equal(stored.recipe.ingredients[0].name, '旧菜谱');
  assert.equal(db.records('recipe_recordings').get('recording-first').editedTranscript, '第一段');
  assert.equal(Object.hasOwn(stored, 'organizeLeaseId'), false);
  assert.equal(JSON.stringify({ result, stored }).includes(privateMessage), false);
  assert.equal(JSON.stringify({ result, stored }).includes('sk-secret'), false);
});

test('a late organizeDraft result cannot overwrite a replacement lease result', async () => {
  const db = createMemoryDatabase(organizeSeed());
  let releaseProvider;
  let announceProvider;
  const providerStarted = new Promise((resolve) => { announceProvider = resolve; });
  const organizing = invoke(db, organizeEvent(), 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-old',
    recipeProvider: { async organize() {
      announceProvider();
      return new Promise((resolve) => { releaseProvider = resolve; });
    } },
  });
  await providerStarted;
  const current = db.records('recipe_drafts').get('draft-recording');
  await db.collection('recipe_drafts').doc('draft-recording').set({ data: {
    ...current,
    status: 'ready', inputHash: 'newer-hash', organizeLeaseId: 'lease-new',
    organizeLeaseExpiresAt: 999_999, recipe: organizedRecipe('更新后的菜谱'), revision: 4,
  } });
  releaseProvider({
    recipe: organizedRecipe('迟到菜谱'), requestId: 'late', modelName: 'hy3', promptVersion: 'v1', usage: {},
  });

  const result = await organizing;
  const stored = db.records('recipe_drafts').get('draft-recording');
  assert.equal(result.ok, true);
  assert.equal(stored.recipe.ingredients[0].name, '更新后的菜谱');
  assert.equal(stored.inputHash, 'newer-hash');
  assert.equal(stored.organizeLeaseId, 'lease-new');
  assert.equal(stored.revision, 4);
});

test('a late organizeDraft failure cannot mark a replacement lease result failed', async () => {
  const db = createMemoryDatabase(organizeSeed());
  let rejectProvider;
  let announceProvider;
  const providerStarted = new Promise((resolve) => { announceProvider = resolve; });
  const organizing = invoke(db, organizeEvent(), 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-old-failure',
    recipeProvider: { async organize() {
      announceProvider();
      return new Promise((_resolve, reject) => { rejectProvider = reject; });
    } },
  });
  await providerStarted;
  const current = db.records('recipe_drafts').get('draft-recording');
  await db.collection('recipe_drafts').doc('draft-recording').set({ data: {
    ...current,
    status: 'ready', inputHash: 'replacement-hash', organizeLeaseId: 'lease-replacement',
    organizeLeaseExpiresAt: 999_999, recipe: organizedRecipe('替代结果'), revision: 5,
    lastErrorCode: '',
  } });
  const staleError = new Error('private stale failure');
  staleError.code = 'AI_HTTP_ERROR';
  rejectProvider(staleError);

  const result = await organizing;
  const stored = db.records('recipe_drafts').get('draft-recording');
  assert.equal(result.ok, true);
  assert.equal(stored.status, 'ready');
  assert.equal(stored.recipe.ingredients[0].name, '替代结果');
  assert.equal(stored.inputHash, 'replacement-hash');
  assert.equal(stored.lastErrorCode, '');
  assert.equal(stored.revision, 5);
});

test('organizeDraft rejects an unapproved configured model before acquiring a lease or calling the provider', async () => {
  const db = createMemoryDatabase(organizeSeed());
  let calls = 0;
  const result = await invoke(db, organizeEvent(), 'openid-a', {
    recipeModel: 'kimi-k2', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'must-not-use',
    recipeProvider: { async organize() { calls += 1; return { recipe: organizedRecipe() }; } },
  });

  assert.equal(result.error.code, 'AI_NOT_CONFIGURED');
  assert.equal(calls, 0);
  assert.equal(db.records('recipe_drafts').get('draft-recording').status, 'editing');
  assert.equal(Object.hasOwn(db.records('recipe_drafts').get('draft-recording'), 'organizeLeaseId'), false);
});

test('organizing drafts reject human update/confirmation and confirmed drafts cannot be organized', async () => {
  const organizingDb = createMemoryDatabase(organizeSeed({ draft: {
    status: 'organizing', revision: 2, organizeLeaseId: 'lease-active', organizeLeaseExpiresAt: 999_999,
  } }));
  const updated = await invoke(organizingDb, {
    action: 'updateDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-recording',
    revision: 2, recipe: organizedRecipe('人工修改'),
  });
  const confirmed = await invoke(organizingDb, {
    action: 'confirmDraft', familyId: 'family-a', dishId: 'dish-1', draftId: 'draft-recording',
    revision: 2, publishAsMain: false, baseMainVersionId: '',
  });
  assert.equal(updated.error.code, 'DRAFT_CONFLICT');
  assert.equal(confirmed.error.code, 'DRAFT_CONFLICT');
  assert.equal(organizingDb.records('recipe_drafts').get('draft-recording').recipe.ingredients[0].name, '旧菜谱');

  const confirmedDb = createMemoryDatabase(organizeSeed({ draft: {
    status: 'confirmed', confirmedVersionId: 'version-1',
  } }));
  const organized = await invoke(confirmedDb, organizeEvent(), 'openid-a', {
    recipeProvider: { async organize() { throw new Error('must not call'); } },
    recipeModel: 'hy3', recipePromptVersion: 'v1',
  });
  assert.equal(organized.error.code, 'DRAFT_CONFLICT');
});

test('organizeDraft rejects a selected recording outside the draft record without calling the provider', async () => {
  const seed = organizeSeed({ recordings: {
    foreign: {
      _id: 'foreign', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-other',
      sequence: 3, sourceType: 'manual_text', status: 'ready', editedTranscript: '不应读取',
    },
  } });
  let calls = 0;
  const result = await invoke(createMemoryDatabase(seed), organizeEvent(['foreign']), 'openid-a', {
    recipeProvider: { async organize() { calls += 1; return { recipe: organizedRecipe() }; } },
    recipeModel: 'hy3', recipePromptVersion: 'v1',
  });
  assert.equal(result.error.code, 'RECORDING_NOT_FOUND');
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes('不应读取'), false);
});

test('submitRecording reserves 180 seconds, releases only a definite no-request failure, and settles ready duration once', async () => {
  const failedDb = createMemoryDatabase(baseSeed());
  const failedServices = recordingServices({
    asrProvider: { async submit() {
      const error = new Error('configuration failed before request');
      error.code = 'ASR_NOT_CONFIGURED';
      error.requestIssued = false;
      throw error;
    } },
  });
  await reserveOwnedRecording(failedDb, failedServices);
  const failed = await invoke(failedDb, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3', operationId: 'forged-client-operation',
  }, 'openid-a', failedServices);

  assert.equal(failed.ok, false);
  const failedUsage = failedDb.records('recipe_usage_daily').get('family-a|1970-01-01');
  assert.equal(failedUsage.asrSeconds, 0);
  assert.equal(Object.values(failedUsage.reservations)[0].status, 'released');
  assert.equal(Object.hasOwn(failedUsage.reservations, 'forged-client-operation'), false);

  const readyDb = createMemoryDatabase(baseSeed());
  const readyServices = recordingServices({
    asrProvider: {
      async submit() { return { taskId: 1001, requestId: 'submit-safe', submittedAt: 100, expiresAt: 200 }; },
      async query() {
        return { status: 'ready', transcript: '只存录音文档', durationMs: 12_500, requestId: 'ready-safe', errorCode: '' };
      },
    },
  });
  await reserveOwnedRecording(readyDb, readyServices);
  const submitted = await invoke(readyDb, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3', operationId: 'forged-client-operation',
  }, 'openid-a', readyServices);
  assert.equal(submitted.ok, true);
  assert.equal(readyDb.records('recipe_usage_daily').get('family-a|1970-01-01').asrSeconds, 180);

  await invoke(readyDb, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', readyServices);
  await invoke(readyDb, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', readyServices);

  const readyUsage = readyDb.records('recipe_usage_daily').get('family-a|1970-01-01');
  assert.equal(readyUsage.asrSeconds, 12.5);
  assert.equal(Object.values(readyUsage.reservations)[0].status, 'settled');
  assert.equal(Object.values(readyUsage.reservations)[0].settled, 12.5);
  assert.equal(JSON.stringify(submitted.data).includes('UsageOperation'), false);
});

test('ASR quota rejection does not call the provider', async () => {
  const seed = baseSeed();
  seed.recipe_usage_daily = {
    'family-a|1970-01-01': {
      _id: 'family-a|1970-01-01', familyId: 'family-a', billingDate: '1970-01-01',
      billingTimezone: 'Asia/Shanghai', asrSeconds: 3600, organizeCalls: 0, reservations: {},
    },
  };
  const db = createMemoryDatabase(seed);
  let calls = 0;
  const services = recordingServices({
    asrProvider: { async submit() { calls += 1; throw new Error('must not call'); } },
  });
  await reserveOwnedRecording(db, services);

  const result = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3',
  }, 'openid-a', services);

  assert.equal(result.error.code, 'DAILY_ASR_LIMIT');
  assert.equal(calls, 0);
  assert.equal(db.records('recipe_recordings').get('recording-fixed').status, 'reserved');
});

test('ASR ready after the Shanghai day boundary settles the reservation day', async () => {
  const db = createMemoryDatabase(baseSeed());
  let clock = Date.parse('2026-08-13T15:59:59.900Z');
  const services = recordingServices({
    now: () => clock,
    asrProvider: {
      async submit() {
        return { taskId: 1001, requestId: 'before-midnight', submittedAt: clock, expiresAt: clock + 60_000 };
      },
      async query() {
        return { status: 'ready', transcript: '跨日结果', durationMs: 12_500, requestId: 'after-midnight', errorCode: '' };
      },
    },
  });
  await reserveOwnedRecording(db, services);
  const submitted = await invoke(db, {
    action: 'submitRecording', familyId: 'family-a', dishId: 'dish-1', recordingId: 'recording-fixed',
    fileId: 'cloud://env/families/family-a/recipe-audio/recording-fixed.mp3',
  }, 'openid-a', services);
  assert.equal(submitted.ok, true);

  clock = Date.parse('2026-08-13T16:00:00.100Z');
  const refreshed = await invoke(db, {
    action: 'refreshWorkspace', familyId: 'family-a', dishId: 'dish-1', recordId: 'record-1',
  }, 'openid-a', services);

  assert.equal(refreshed.ok, true);
  assert.equal(db.records('recipe_usage_daily').get('family-a|2026-08-13').asrSeconds, 12.5);
  assert.equal(db.records('recipe_usage_daily').has('family-a|2026-08-14'), false);
});

test('organizeDraft releases a pre-request failure but consumes issued invalid output', async () => {
  const preflightDb = createMemoryDatabase(organizeSeed());
  const preflight = await invoke(preflightDb, organizeEvent(), 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-preflight',
    recipeProvider: { async organize() {
      const error = new Error('missing configuration before fetch');
      error.code = 'AI_NOT_CONFIGURED';
      error.requestIssued = false;
      throw error;
    } },
  });

  assert.equal(preflight.error.code, 'AI_NOT_CONFIGURED');
  const preflightUsage = preflightDb.records('recipe_usage_daily').get('family-a|1970-01-01');
  assert.equal(preflightUsage.organizeCalls, 0);
  assert.equal(Object.values(preflightUsage.reservations)[0].status, 'released');

  const invalidDb = createMemoryDatabase(organizeSeed());
  const invalid = await invoke(invalidDb, organizeEvent(), 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-invalid-output',
    recipeProvider: { async organize() { return { recipe: { title: 'invalid provider output' } }; } },
  });

  assert.equal(invalid.error.code, 'AI_OUTPUT_INVALID');
  const invalidUsage = invalidDb.records('recipe_usage_daily').get('family-a|1970-01-01');
  assert.equal(invalidUsage.organizeCalls, 1);
  assert.equal(Object.values(invalidUsage.reservations)[0].status, 'settled');
  assert.equal(JSON.stringify(invalidUsage).includes('invalid provider output'), false);
});

test('organize quota rejection does not call the provider or store caller content', async () => {
  const seed = organizeSeed();
  seed.recipe_usage_daily = {
    'family-a|1970-01-01': {
      _id: 'family-a|1970-01-01', familyId: 'family-a', billingDate: '1970-01-01',
      billingTimezone: 'Asia/Shanghai', asrSeconds: 0, organizeCalls: 20, reservations: {},
    },
  };
  const db = createMemoryDatabase(seed);
  let calls = 0;
  const result = await invoke(db, {
    ...organizeEvent(), operationId: 'forged-operation', apiKey: 'sk-do-not-store', rawProvider: { private: true },
  }, 'openid-a', {
    recipeModel: 'hy3', recipePromptVersion: 'v1', organizeLeaseIdGenerator: () => 'lease-over-limit',
    recipeProvider: { async organize() { calls += 1; return { recipe: organizedRecipe() }; } },
  });

  assert.equal(result.error.code, 'DAILY_ORGANIZE_LIMIT');
  assert.equal(calls, 0);
  assert.equal(db.records('recipe_drafts').get('draft-recording').status, 'editing');
  assert.equal(JSON.stringify(db.records('recipe_usage_daily').get('family-a|1970-01-01')).includes('sk-do-not-store'), false);
});
