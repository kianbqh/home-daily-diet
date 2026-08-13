const { withoutSystemId } = require('./logic');
const { isDeepStrictEqual } = require('node:util');

function createRecipeRepository(db, config) {
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

  async function getRecipePointer(familyId, dishId) {
    const pointer = await getDocument(config.recipeCollection, `${familyId}|${dishId}`);
    return owned(pointer, familyId, dishId) ? pointer : null;
  }

  async function setRecipePointer(familyId, dishId, data) {
    return setDocument(config.recipeCollection, `${familyId}|${dishId}`, data);
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

  async function getRecording(familyIdOrInput, dishIdArg, recordingIdArg) {
    const { familyId, dishId, recordingId, recordId } = normalizeOwnedLookup(
      familyIdOrInput, dishIdArg, recordingIdArg, 'recordingId'
    );
    const recording = await getDocument(config.recordingCollection, recordingId);
    return owned(recording, familyId, dishId) && (recordId == null || recording.recordId === recordId) ? recording : null;
  }

  async function listRecordings(familyId, dishId, recordId) {
    return query(config.recordingCollection, { familyId, dishId, recordId }, {
      orderBy: 'sequence', order: 'asc', limit: 100,
    });
  }

  async function runTransaction(callback) {
    if (typeof db.runTransaction !== 'function') return callback(api);
    return db.runTransaction((transaction) => callback(createRecipeRepository(transaction, config)));
  }

  const api = {
    getDraft,
    setDraft,
    getRecipePointer,
    setRecipePointer,
    getVersion,
    listVersions,
    createVersion,
    getRecording,
    listRecordings,
    runTransaction,
  };
  return api;
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

function sameDocument(existing, expected) {
  return isDeepStrictEqual(withoutSystemId(existing), withoutSystemId(expected));
}

module.exports = { createRecipeRepository };
