const {
  ASR_DAILY_SECONDS,
  BILLING_TIMEZONE,
  ORGANIZE_DAILY_CALLS,
  createRecipeError,
  usageDocumentId,
  withoutSystemId,
} = require('./logic');
const { isDeepStrictEqual } = require('node:util');

function createRecipeRepository(db, config, options = {}) {
  async function getDocument(name, id) {
    try {
      const result = await db.collection(name).doc(id).get();
      return result && result.data ? result.data : null;
    } catch (error) {
      const code = error && (error.errCode || error.code);
      const message = String(error && (error.errMsg || error.message) || '').toLowerCase();
      if (code === -1 || code === 'DOCUMENT_NOT_FOUND' || message.includes('not found') || message.includes('不存在')) {
        return null;
      }
      throw error;
    }
  }

  async function query(name, filter, options = {}) {
    let request = db.collection(name).where(filter);
    if (options.orderBy && typeof request.orderBy === 'function') {
      request = request.orderBy(options.orderBy, options.order || 'asc');
    }
    if (typeof request.limit === 'function') request = request.limit(options.limit || 100);
    const result = await request.get();
    return result && Array.isArray(result.data) ? result.data : [];
  }

  async function setDocument(name, id, data) {
    await db.collection(name).doc(id).set({ data: withoutSystemId(data) });
    return getDocument(name, id);
  }

  async function addDocument(name, data) {
    const result = await db.collection(name).add({ data: withoutSystemId(data) });
    return getDocument(name, result._id);
  }

  async function removeDocument(name, id) {
    try {
      const result = await db.collection(name).doc(id).remove();
      const removed = Number(result && result.stats && result.stats.removed);
      return Number.isFinite(removed) ? removed : 1;
    } catch (error) {
      const code = error && (error.errCode || error.code);
      const message = String(error && (error.errMsg || error.message) || '').toLowerCase();
      if (code === -1 || code === 'DOCUMENT_NOT_FOUND' || message.includes('not found') || message.includes('不存在')) {
        return 0;
      }
      throw error;
    }
  }

  function expirationFilter(now) {
    return db.command && typeof db.command.lte === 'function'
      ? db.command.lte(now)
      : null;
  }

  async function getDraft(familyIdOrInput, dishIdArg, draftIdArg) {
    const { familyId, dishId, draftId, recordId } = normalizeOwnedLookup(familyIdOrInput, dishIdArg, draftIdArg);
    if (draftId) {
      const draft = await getDocument(config.draftCollection, draftId);
      return owned(draft, familyId, dishId) && (recordId == null || draft.recordId === recordId) ? draft : null;
    }
    const drafts = await query(config.draftCollection, { familyId, dishId, recordId }, { limit: 1 });
    return drafts[0] || null;
  }

  async function setDraft(id, data) {
    return id
      ? setDocument(config.draftCollection, id, data)
      : addDocument(config.draftCollection, data);
  }

  async function listDraftsByDish(familyId, dishId, limit = 100) {
    return query(config.draftCollection, { familyId, dishId }, {
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
    });
  }

  async function getDraftArtifact(id) {
    return getDocument(config.draftCollection, id);
  }

  async function removeDraft(id) {
    return removeDocument(config.draftCollection, id);
  }

  async function listExpiredDrafts(now, limit = 20) {
    const expiresAt = expirationFilter(now);
    if (!expiresAt) return [];
    return query(config.draftCollection, { draftExpiresAt: expiresAt }, {
      orderBy: 'draftExpiresAt', order: 'asc', limit: Math.min(Math.max(Number(limit) || 20, 1), 20),
    });
  }

  async function getRecipePointer(familyId, dishId) {
    const pointer = await getDocument(config.recipeCollection, `${familyId}|${dishId}`);
    return owned(pointer, familyId, dishId) ? pointer : null;
  }

  async function setRecipePointer(familyId, dishId, data) {
    return setDocument(config.recipeCollection, `${familyId}|${dishId}`, data);
  }

  async function removeRecipePointer(familyId, dishId) {
    return removeDocument(config.recipeCollection, `${familyId}|${dishId}`);
  }

  async function getVersion(familyId, dishId, versionId) {
    const version = await getDocument(config.versionCollection, versionId);
    return owned(version, familyId, dishId) ? version : null;
  }

  async function listVersions(familyId, dishId, limit = 100) {
    return query(config.versionCollection, { familyId, dishId }, {
      orderBy: 'versionNumber', order: 'desc', limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
    });
  }

  async function createVersion(data) {
    const id = versionDocumentId(data.familyId, data.dishId, data.versionNumber);
    const existing = await getDocument(config.versionCollection, id);
    if (existing) {
      if (sameDocument(existing, data)) return existing;
      const error = new Error('recipe version is immutable');
      error.name = 'RecipeAssistantError';
      error.code = 'VERSION_IMMUTABLE_CONFLICT';
      error.stage = 'action';
      throw error;
    }
    return setDocument(config.versionCollection, id, data);
  }

  async function removeVersion(id) {
    return removeDocument(config.versionCollection, id);
  }

  async function getRecording(familyIdOrInput, dishIdArg, recordingIdArg) {
    const { familyId, dishId, recordingId, recordId } = normalizeOwnedLookup(
      familyIdOrInput, dishIdArg, recordingIdArg, 'recordingId'
    );
    const recording = await getDocument(config.recordingCollection, recordingId);
    return owned(recording, familyId, dishId)
      && recording.sourceType !== 'workspace_state'
      && (recordId == null || recording.recordId === recordId) ? recording : null;
  }

  async function listRecordings(familyId, dishId, recordId) {
    const recordings = await query(config.recordingCollection, { familyId, dishId, recordId }, {
      orderBy: 'sequence', order: 'asc', limit: 100,
    });
    return recordings.filter((item) => item.sourceType !== 'workspace_state');
  }

  async function getRecordingsByIds(familyId, dishId, recordId, recordingIds) {
    const recordings = [];
    for (const recordingId of Array.isArray(recordingIds) ? recordingIds : []) {
      const recording = await getRecording({ familyId, dishId, recordId, recordingId });
      recordings.push(recording);
    }
    return recordings;
  }

  async function setRecording(id, data) {
    return id
      ? setDocument(config.recordingCollection, id, data)
      : addDocument(config.recordingCollection, data);
  }

  async function listRecordingArtifactsByDish(familyId, dishId, limit = 100) {
    return query(config.recordingCollection, { familyId, dishId }, {
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100),
    });
  }

  async function getRecordingArtifact(id) {
    return getDocument(config.recordingCollection, id);
  }

  async function removeRecording(id) {
    return removeDocument(config.recordingCollection, id);
  }

  async function listExpiredRecordingArtifacts(now, limit = 20) {
    const expiresAt = expirationFilter(now);
    if (!expiresAt) return [];
    return query(config.recordingCollection, { draftExpiresAt: expiresAt }, {
      orderBy: 'draftExpiresAt', order: 'asc', limit: Math.min(Math.max(Number(limit) || 20, 1), 20),
    });
  }

  async function getWorkspaceState(familyId, dishId, recordId) {
    const state = await getDocument(config.recordingCollection, workspaceStateDocumentId(familyId, dishId, recordId));
    return owned(state, familyId, dishId) && state.recordId === recordId && state.sourceType === 'workspace_state'
      ? state : null;
  }

  async function setWorkspaceState(familyId, dishId, recordId, data) {
    return setDocument(config.recordingCollection, workspaceStateDocumentId(familyId, dishId, recordId), {
      ...data, familyId, dishId, recordId, sourceType: 'workspace_state',
    });
  }

  async function reserveAsrUsage(input) {
    return runUsageTransaction((transaction) => transaction.reserveAsrUsage(input), async () => {
      const normalized = normalizeReservationInput(input, 'asr');
      return reserveUsage(normalized, normalized.seconds);
    });
  }

  async function settleAsrUsage(input) {
    return runUsageTransaction((transaction) => transaction.settleAsrUsage(input), async () => {
      const normalized = normalizeUsageLookup(input);
      const operation = await requireUsageOperation(normalized, 'asr');
      const usage = await requireUsageDocument(normalized, operation.usageDocumentId);
      const actualSeconds = boundedActualSeconds(input.actualSeconds, operation.reserved);
      if (operation.status === 'released') return usageResult(usage, operation, true);
      if (operation.status === 'settled') {
        if (operation.settled !== actualSeconds) throw usageConflict();
        return usageResult(usage, operation, true);
      }
      const updatedOperation = {
        ...operation, status: 'settled', settled: actualSeconds, settledAt: normalized.now,
        updatedAt: normalized.now,
      };
      const reservations = withoutReservation(usage.reservations, normalized.operationId);
      const updated = await writeUsage(usage, {
        asrSeconds: Math.max(0, usage.asrSeconds - operation.reserved + actualSeconds),
        reservations,
        updatedAt: normalized.now,
      });
      await writeUsageOperation(updatedOperation);
      return usageResult(updated, updatedOperation, false);
    });
  }

  async function releaseAsrUsage(input) {
    return releaseUsage(input, 'asr');
  }

  async function reserveOrganizeUsage(input) {
    return runUsageTransaction((transaction) => transaction.reserveOrganizeUsage(input), async () => {
      const normalized = normalizeReservationInput({ ...input, seconds: 1 }, 'organize');
      return reserveUsage(normalized, 1);
    });
  }

  async function settleOrganizeUsage(input) {
    return runUsageTransaction((transaction) => transaction.settleOrganizeUsage(input), async () => {
      const normalized = normalizeUsageLookup(input);
      const operation = await requireUsageOperation(normalized, 'organize');
      const usage = await requireUsageDocument(normalized, operation.usageDocumentId);
      if (operation.status === 'settled' || operation.status === 'released') {
        return usageResult(usage, operation, true);
      }
      const updatedOperation = {
        ...operation, status: 'settled', settled: 1, settledAt: normalized.now, updatedAt: normalized.now,
      };
      const updated = await writeUsage(usage, {
        reservations: withoutReservation(usage.reservations, normalized.operationId),
        updatedAt: normalized.now,
      });
      await writeUsageOperation(updatedOperation);
      return usageResult(updated, updatedOperation, false);
    });
  }

  async function releaseOrganizeUsage(input) {
    return releaseUsage(input, 'organize');
  }

  async function releaseUsage(input, kind) {
    return runUsageTransaction((transaction) => (
      kind === 'asr' ? transaction.releaseAsrUsage(input) : transaction.releaseOrganizeUsage(input)
    ), async () => {
      const normalized = normalizeUsageLookup(input);
      const operation = await requireUsageOperation(normalized, kind);
      const usage = await requireUsageDocument(normalized, operation.usageDocumentId);
      if (operation.status === 'released' || operation.status === 'settled') {
        return usageResult(usage, operation, true);
      }
      const updatedOperation = {
        ...operation, status: 'released', settled: 0, releasedAt: normalized.now, updatedAt: normalized.now,
      };
      const counters = kind === 'asr'
        ? { asrSeconds: Math.max(0, usage.asrSeconds - operation.reserved) }
        : { organizeCalls: Math.max(0, usage.organizeCalls - 1) };
      const updated = await writeUsage(usage, {
        ...counters,
        reservations: withoutReservation(usage.reservations, normalized.operationId),
        updatedAt: normalized.now,
      });
      await writeUsageOperation(updatedOperation);
      return usageResult(updated, updatedOperation, false);
    });
  }

  async function reserveUsage(input, reserved) {
    const prior = await getUsageOperation(input.operationId);
    if (prior) {
      requireMatchingUsageOperation(prior, input, reserved);
      const usage = await requireUsageDocument(input, prior.usageDocumentId);
      return usageResult(usage, prior, true);
    }
    const existing = await getDocument(config.usageCollection, input.documentId);
    const usage = normalizeUsageDocument(existing, input);
    if (input.kind === 'asr' && usage.asrSeconds + reserved > ASR_DAILY_SECONDS) {
      throw createRecipeError('DAILY_ASR_LIMIT', '今日语音转写额度已用完');
    }
    if (input.kind === 'organize' && usage.organizeCalls + 1 > ORGANIZE_DAILY_CALLS) {
      throw createRecipeError('DAILY_ORGANIZE_LIMIT', '今日菜谱整理额度已用完');
    }
    const operation = {
      sourceType: 'usage_operation', operationId: input.operationId,
      familyId: input.familyId, usageDocumentId: input.documentId,
      kind: input.kind, reserved, status: 'reserved', settled: 0,
      createdAt: input.now, updatedAt: input.now,
    };
    const reservation = activeReservation(operation);
    const reservations = { ...usage.reservations, [input.operationId]: reservation };
    const updated = await writeUsage(usage, {
      asrSeconds: usage.asrSeconds + (input.kind === 'asr' ? reserved : 0),
      organizeCalls: usage.organizeCalls + (input.kind === 'organize' ? 1 : 0),
      reservations,
      updatedAt: input.now,
    });
    await writeUsageOperation(operation);
    return usageResult(updated, operation, false);
  }

  async function requireUsageDocument(input, documentId = input.documentId) {
    const existing = await getDocument(config.usageCollection, documentId);
    if (!existing || existing.familyId !== input.familyId) {
      throw createRecipeError('USAGE_OPERATION_NOT_FOUND', '找不到用量操作');
    }
    return normalizeUsageDocument(existing, { ...input, documentId });
  }

  async function writeUsage(usage, patch) {
    return setDocument(config.usageCollection, usage._id, { ...usage, ...patch });
  }

  async function getUsageOperation(operationId) {
    const operation = await getDocument(config.usageCollection, usageOperationDocumentId(operationId));
    return operation && operation.sourceType === 'usage_operation' ? operation : null;
  }

  async function requireUsageOperation(input, kind) {
    const operation = await getUsageOperation(input.operationId);
    if (!operation || operation.familyId !== input.familyId) {
      throw createRecipeError('USAGE_OPERATION_NOT_FOUND', '找不到用量操作');
    }
    if (operation.kind !== kind) throw usageConflict();
    return operation;
  }

  async function writeUsageOperation(operation) {
    return setDocument(
      config.usageCollection,
      usageOperationDocumentId(operation.operationId),
      operation,
    );
  }

  function runUsageTransaction(transactionCallback, directCallback) {
    if (options.inTransaction === true) return directCallback();
    if (typeof db.runTransaction !== 'function') {
      throw createRecipeError('DATABASE_UNAVAILABLE', '菜谱服务暂时不可用', 'open-database');
    }
    return db.runTransaction((transaction) => transactionCallback(
      createRecipeRepository(transaction, config, { inTransaction: true })
    ));
  }

  async function runTransaction(callback) {
    if (typeof db.runTransaction !== 'function') return callback(api);
    return db.runTransaction((transaction) => callback(
      createRecipeRepository(transaction, config, { inTransaction: true })
    ));
  }

  const api = {
    getDraft,
    setDraft,
    listDraftsByDish,
    getDraftArtifact,
    removeDraft,
    listExpiredDrafts,
    getRecipePointer,
    setRecipePointer,
    removeRecipePointer,
    getVersion,
    listVersions,
    createVersion,
    removeVersion,
    getRecording,
    getRecordingsByIds,
    listRecordings,
    setRecording,
    listRecordingArtifactsByDish,
    getRecordingArtifact,
    removeRecording,
    listExpiredRecordingArtifacts,
    getWorkspaceState,
    setWorkspaceState,
    reserveAsrUsage,
    settleAsrUsage,
    releaseAsrUsage,
    reserveOrganizeUsage,
    settleOrganizeUsage,
    releaseOrganizeUsage,
    runTransaction,
  };
  return api;
}

function normalizeReservationInput(input, kind) {
  const normalized = normalizeUsageLookup(input);
  const seconds = Number(input && input.seconds);
  if (kind === 'asr' && (!Number.isFinite(seconds) || seconds <= 0 || seconds > ASR_DAILY_SECONDS)) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  return { ...normalized, kind, seconds };
}

function normalizeUsageLookup(input = {}) {
  const familyId = String(input.familyId || '').trim();
  const operationId = String(input.operationId || '').trim();
  const now = Number(input.now == null ? Date.now() : input.now);
  const billingTimestamp = Number(input.billingTimestamp == null ? now : input.billingTimestamp);
  if (!familyId || familyId.length > 300 || !validUsageOperationId(operationId)
    || !Number.isFinite(now) || !Number.isFinite(billingTimestamp)) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  return {
    familyId, operationId, now, billingTimestamp,
    documentId: usageDocumentId(familyId, billingTimestamp),
  };
}

function normalizeUsageDocument(existing, input) {
  const billingDate = input.documentId.slice(input.documentId.lastIndexOf('|') + 1);
  return {
    ...(existing || {}),
    _id: input.documentId,
    familyId: input.familyId,
    billingDate,
    billingTimezone: BILLING_TIMEZONE,
    asrSeconds: boundedCounter(existing && existing.asrSeconds),
    organizeCalls: boundedCounter(existing && existing.organizeCalls),
    reservations: normalizeReservations(existing && existing.reservations),
    createdAt: existing && existing.createdAt != null ? existing.createdAt : input.now,
    updatedAt: existing && existing.updatedAt != null ? existing.updatedAt : input.now,
  };
}

function normalizeReservations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([operationId, reservation]) => (
    validUsageOperationId(operationId)
      && reservation && typeof reservation === 'object' && !Array.isArray(reservation)
  )).map(([operationId, reservation]) => [operationId, { ...reservation }]));
}

function validUsageOperationId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function usageOperationDocumentId(operationId) {
  return `usage-operation-${operationId}`;
}

function activeReservation(operation) {
  return {
    kind: operation.kind,
    reserved: operation.reserved,
    status: 'reserved',
    settled: 0,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function withoutReservation(value, operationId) {
  const reservations = { ...value };
  delete reservations[operationId];
  return reservations;
}

function requireMatchingUsageOperation(operation, input, reserved) {
  if (operation.familyId !== input.familyId
    || operation.kind !== input.kind
    || operation.reserved !== reserved
    || !['reserved', 'settled', 'released'].includes(operation.status)
    || !String(operation.usageDocumentId || '').trim()) {
    throw usageConflict();
  }
}

function boundedActualSeconds(value, reserved) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  return Math.min(seconds, reserved);
}

function boundedCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function usageResult(usage, reservation, reused) {
  return {
    ok: true,
    reused,
    status: reservation.status,
    reserved: reservation.reserved,
    settled: reservation.settled,
    asrSeconds: usage.asrSeconds,
    organizeCalls: usage.organizeCalls,
  };
}

function usageConflict() {
  return createRecipeError('USAGE_OPERATION_CONFLICT', '用量操作与已有记录冲突');
}

function owned(document, familyId, dishId) {
  return Boolean(document && document.familyId === familyId && document.dishId === dishId);
}

function normalizeOwnedLookup(familyIdOrInput, dishId, documentId, documentKey = 'draftId') {
  if (familyIdOrInput && typeof familyIdOrInput === 'object') return familyIdOrInput;
  return { familyId: familyIdOrInput, dishId, [documentKey]: documentId };
}

function versionDocumentId(familyId, dishId, versionNumber) {
  return `${familyId}|${dishId}|${versionNumber}`;
}

function workspaceStateDocumentId(familyId, dishId, recordId) {
  return `workspace-${familyId}-${dishId}-${recordId}`;
}

function sameDocument(existing, expected) {
  return isDeepStrictEqual(withoutSystemId(existing), withoutSystemId(expected));
}

module.exports = { createRecipeRepository };
