const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecipeRepository } = require('../cloudfunctions/recipe-assistant/repository');
const {
  createUsageOperationId,
  usageDocumentId,
} = require('../cloudfunctions/recipe-assistant/logic');
const { DEFAULT_CONFIG } = require('../cloudfunctions/recipe-assistant');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryDatabase(seed = {}) {
  const collections = new Map();
  const versions = new Map();
  let transactionId = 0;
  Object.entries(seed).forEach(([name, records]) => {
    collections.set(name, new Map(Object.entries(records).map(([id, value]) => [id, clone(value)])));
    Object.keys(records).forEach((id) => versions.set(`${name}\u0000${id}`, 0));
  });

  function collection(name, transaction) {
    if (!collections.has(name)) collections.set(name, new Map());
    const records = collections.get(name);
    return {
      doc(id) {
        const key = `${name}\u0000${id}`;
        return {
          async get() {
            if (transaction && transaction.writes.has(key)) {
              return { data: clone(transaction.writes.get(key).data) };
            }
            if (transaction && !transaction.reads.has(key)) {
              transaction.reads.set(key, versions.get(key) || 0);
            }
            return { data: records.has(id) ? clone(records.get(id)) : null };
          },
          async set({ data }) {
            const stored = { ...clone(data), _id: id };
            if (transaction) {
              if (!transaction.reads.has(key)) transaction.reads.set(key, versions.get(key) || 0);
              transaction.writes.set(key, { name, id, data: stored });
            } else {
              records.set(id, stored);
              versions.set(key, (versions.get(key) || 0) + 1);
            }
            return { _id: id };
          },
        };
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
          limit(count) { result = result.slice(0, count); return this; },
          async get() { return { data: clone(result) }; },
        };
      },
    };
  }

  const db = {
    collection(name) { return collection(name, null); },
    async runTransaction(callback) {
      const id = ++transactionId;
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        const transaction = { id, attempt, reads: new Map(), writes: new Map() };
        const transactionDb = { collection(name) { return collection(name, transaction); } };
        const result = await callback(transactionDb);
        const conflicted = [...transaction.reads].some(([key, version]) => (versions.get(key) || 0) !== version);
        if (conflicted) {
          if (attempt === 30) throw new Error('transaction retry limit exceeded');
          continue;
        }
        transaction.writes.forEach(({ name, id: documentId, data }, key) => {
          collections.get(name).set(documentId, clone(data));
          versions.set(key, (versions.get(key) || 0) + 1);
        });
        return result;
      }
      throw new Error('unreachable');
    },
    records(name) { return collections.get(name) || new Map(); },
  };
  return db;
}

async function outcome(promise) {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, code: error && error.code };
  }
}

test('daily usage IDs use the explicit Asia/Shanghai billing-day boundary', async () => {
  const before = Date.parse('2026-08-13T15:59:59.999Z');
  const after = Date.parse('2026-08-13T16:00:00.000Z');
  assert.equal(usageDocumentId('family-1', before), 'family-1|2026-08-13');
  assert.equal(usageDocumentId('family-1', after), 'family-1|2026-08-14');

  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  await repository.reserveOrganizeUsage({ familyId: 'family-1', operationId: 'organize-before', now: before });
  await repository.reserveOrganizeUsage({ familyId: 'family-1', operationId: 'organize-after', now: after });

  assert.equal(db.records('recipe_usage_daily').get('family-1|2026-08-13').billingTimezone, 'Asia/Shanghai');
  assert.equal(db.records('recipe_usage_daily').get('family-1|2026-08-14').billingDate, '2026-08-14');
});

test('twenty-one concurrent organize reservations produce exactly twenty successes', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const now = Date.parse('2026-08-13T02:00:00.000Z');

  const results = await Promise.all(Array.from({ length: 21 }, (_, index) => outcome(
    repository.reserveOrganizeUsage({ familyId: 'family-1', operationId: `op-${index}`, now })
  )));

  assert.equal(results.filter((item) => item.ok).length, 20);
  assert.deepEqual(results.filter((item) => !item.ok).map((item) => item.code), ['DAILY_ORGANIZE_LIMIT']);
  assert.equal(db.records('recipe_usage_daily').get('family-1|2026-08-13').organizeCalls, 20);
});

test('identical operation retries are idempotent and conflicting reuse is rejected', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const input = { familyId: 'family-1', operationId: 'same-operation', now: 100 };

  const first = await repository.reserveOrganizeUsage(input);
  const retry = await repository.reserveOrganizeUsage(input);

  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, true);
  assert.equal(db.records('recipe_usage_daily').values().next().value.organizeCalls, 1);
  await assert.rejects(
    repository.reserveAsrUsage({ ...input, seconds: 180 }),
    (error) => error && error.code === 'USAGE_OPERATION_CONFLICT'
  );
  await assert.rejects(
    repository.reserveAsrUsage({ familyId: 'family-1', operationId: 'asr-conflict', seconds: 180, now: 100 })
      .then(() => repository.reserveAsrUsage({ familyId: 'family-1', operationId: 'asr-conflict', seconds: 120, now: 100 })),
    (error) => error && error.code === 'USAGE_OPERATION_CONFLICT'
  );
});

test('ASR reserve, release, and bounded settlement are idempotent and never go negative', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const base = { familyId: 'family-1', now: 100 };

  await repository.reserveAsrUsage({ ...base, operationId: 'released-asr', seconds: 180 });
  await repository.releaseAsrUsage({ ...base, operationId: 'released-asr' });
  await repository.releaseAsrUsage({ ...base, operationId: 'released-asr' });
  await repository.settleAsrUsage({ ...base, operationId: 'released-asr', actualSeconds: 90 });

  await repository.reserveAsrUsage({ ...base, operationId: 'settled-asr', seconds: 180 });
  await repository.settleAsrUsage({ ...base, operationId: 'settled-asr', actualSeconds: 72.5 });
  await repository.settleAsrUsage({ ...base, operationId: 'settled-asr', actualSeconds: 72.5 });
  await repository.releaseAsrUsage({ ...base, operationId: 'settled-asr' });

  await repository.reserveAsrUsage({ ...base, operationId: 'bounded-asr', seconds: 180 });
  await repository.settleAsrUsage({ ...base, operationId: 'bounded-asr', actualSeconds: 999 });

  const usage = db.records('recipe_usage_daily').values().next().value;
  assert.equal(usage.asrSeconds, 252.5);
  assert.equal(usage.reservations && Object.keys(usage.reservations).length, 0);
  assert.equal(db.records('recipe_usage_daily').get('usage-operation-released-asr').status, 'released');
  assert.equal(db.records('recipe_usage_daily').get('usage-operation-settled-asr').settled, 72.5);
  assert.equal(db.records('recipe_usage_daily').get('usage-operation-bounded-asr').settled, 180);
  assert.ok(usage.asrSeconds >= 0);
});

test('settlement after midnight updates the original reservation day', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const reservedAt = Date.parse('2026-08-13T15:59:59.900Z');
  const settledAt = Date.parse('2026-08-13T16:00:00.100Z');
  await repository.reserveAsrUsage({
    familyId: 'family-1', operationId: 'cross-day-asr', seconds: 180, now: reservedAt,
  });

  await repository.settleAsrUsage({
    familyId: 'family-1', operationId: 'cross-day-asr', actualSeconds: 12.5,
    billingTimestamp: reservedAt, now: settledAt,
  });

  assert.equal(db.records('recipe_usage_daily').get('family-1|2026-08-13').asrSeconds, 12.5);
  assert.equal(db.records('recipe_usage_daily').has('family-1|2026-08-14'), false);
});

test('usage operations reject unsafe IDs and derive opaque IDs from authorized leases', () => {
  assert.match(createUsageOperationId({
    kind: 'asr', familyId: 'family-a', artifactId: 'recording-1', leaseId: 'server-lease', parameter: '180',
  }), /^asr-[a-f0-9]{64}$/);
  assert.notEqual(
    createUsageOperationId({ kind: 'asr', familyId: 'family-a', artifactId: 'recording-1', leaseId: 'server-lease', parameter: '180' }),
    createUsageOperationId({ kind: 'asr', familyId: 'family-b', artifactId: 'recording-1', leaseId: 'server-lease', parameter: '180' })
  );
  assert.throws(
    () => createUsageOperationId({ kind: 'asr', familyId: '', artifactId: 'recording-1', leaseId: 'server-lease' }),
    (error) => error && error.code === 'USAGE_OPERATION_INVALID'
  );
});

test('repository rejects operation IDs that are unsafe reservation-map keys', async () => {
  const repository = createRecipeRepository(createMemoryDatabase(), DEFAULT_CONFIG);
  for (const operationId of ['__proto__', 'constructor', 'contains.dot', 'x'.repeat(129)]) {
    await assert.rejects(
      repository.reserveOrganizeUsage({ familyId: 'family-1', operationId, now: 100 }),
      (error) => error && error.code === 'USAGE_OPERATION_INVALID',
      operationId
    );
  }
});

test('short settled ASR operations do not create a hidden reservation-capacity limit', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  for (let index = 0; index < 129; index += 1) {
    const operationId = `settled-${index}`;
    await repository.reserveAsrUsage({ familyId: 'family-1', operationId, seconds: 180, now: 100 });
    await repository.settleAsrUsage({
      familyId: 'family-1', operationId, actualSeconds: 1, now: 100,
    });
  }

  const usage = db.records('recipe_usage_daily').get('family-1|1970-01-01');
  assert.equal(usage.asrSeconds, 129);
  assert.equal(Object.keys(usage.reservations).length, 0);
  assert.equal(JSON.stringify([...db.records('recipe_usage_daily').values()]).includes('openid'), false);
});

test('released operation credentials remain idempotent after many later operations', async () => {
  const db = createMemoryDatabase();
  const repository = createRecipeRepository(db, DEFAULT_CONFIG);
  const original = { familyId: 'family-1', operationId: 'released-original', seconds: 180, now: 100 };
  await repository.reserveAsrUsage(original);
  await repository.releaseAsrUsage(original);

  for (let index = 0; index < 300; index += 1) {
    const operationId = `released-later-${index}`;
    await repository.reserveAsrUsage({ familyId: 'family-1', operationId, seconds: 180, now: 100 });
    await repository.releaseAsrUsage({ familyId: 'family-1', operationId, now: 100 });
  }

  const retry = await repository.reserveAsrUsage(original);
  assert.equal(retry.reused, true);
  assert.equal(retry.status, 'released');
  assert.equal(db.records('recipe_usage_daily').get('family-1|1970-01-01').asrSeconds, 0);
  await assert.rejects(
    repository.reserveAsrUsage({ ...original, seconds: 120 }),
    (error) => error && error.code === 'USAGE_OPERATION_CONFLICT'
  );
});
