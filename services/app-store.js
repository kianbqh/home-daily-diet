const {
  addCookingRecord,
  addDish,
  addMember,
  cancelMealSelection,
  confirmMealSession,
  createInitialState,
  createMealSession,
  deleteDish,
  getMealForDate,
  getFamilySummary,
  getSelectedSubmissions,
  findDishByName,
  findSimilarDishes,
  listDeletedDishSummaries,
  listDishSummaries,
  purgeDish,
  rateDish,
  restoreDish,
  submitMealSelection,
  updateDishProfile,
  updateFamilyProfile,
  updateMemberProfile,
  updateMealSelection,
  upsertRecordReview,
} = require('./domain');
const { createDefaultStorage } = require('./storage');
const { mergeFamilyStates } = require('./cloudbase-sync');

const CLOUD_FALLBACK_MESSAGE = '云端连接失败，当前继续使用本地数据。';
const IMAGE_URL_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_IMAGE_URL_CACHE_MAX_ENTRIES = 500;
const MAX_RESOLVE_FILES = 50;

function cloudErrorMessage(error) {
  switch (error && error.code) {
    case 'CLOUD_CALL_FAILED':
      return '云函数调用失败，请检查 family-access 云函数。';
    case 'DATABASE_UNAVAILABLE':
      return '家庭云端数据库不可用，请检查集合配置。';
    case 'AUTH_REQUIRED':
      return '微信身份认证未完成，请重新打开小程序。';
    case 'NOT_MEMBER':
      return '当前微信用户尚未加入这个家庭。';
    case 'INTERNAL_ERROR':
      return 'family-access 云函数执行失败，请查看云函数日志。';
    default:
      return CLOUD_FALLBACK_MESSAGE;
  }
}

function normalizePersistedState(candidate, fallbackState) {
  const fallback = fallbackState || createInitialState();
  if (!candidate || typeof candidate !== 'object') return fallback;

  const candidateFamily = candidate.family && typeof candidate.family === 'object'
    ? candidate.family
    : {};
  const family = {
    ...fallback.family,
    ...candidateFamily,
    id: String(candidateFamily.id || fallback.family.id || '').trim() || 'family-local',
    name: String(candidateFamily.name || fallback.family.name || '').trim() || '我们家的饭桌',
  };
  family.updatedAt = String(candidateFamily.updatedAt || family.createdAt || '');

  let members = Array.isArray(candidate.members)
    ? candidate.members.filter((member) => member && member.id)
    : [];
  if (members.length === 0) {
    members = fallback.members.map((member) => ({ ...member }));
  }
  members = members.map((member) => ({
    ...member,
    joinedAt: String(member.joinedAt || family.createdAt || ''),
    updatedAt: String(member.updatedAt || member.joinedAt || family.createdAt || ''),
  }));

  let currentMemberId = String(candidate.currentMemberId || '').trim();
  if (!currentMemberId || !members.some((member) => member.id === currentMemberId)) {
    const fallbackMemberId = fallback.currentMemberId;
    currentMemberId = members.some((member) => member.id === fallbackMemberId)
      ? fallbackMemberId
      : members[0].id;
  }

  const normalized = {
    ...fallback,
    ...candidate,
    family,
    currentMemberId,
    members,
    dishes: Array.isArray(candidate.dishes) ? candidate.dishes : [],
    cookingRecords: Array.isArray(candidate.cookingRecords) ? candidate.cookingRecords : [],
    dishRatings: Array.isArray(candidate.dishRatings) ? candidate.dishRatings : [],
    recordReviews: Array.isArray(candidate.recordReviews) ? candidate.recordReviews : [],
    purgedDishes: Array.isArray(candidate.purgedDishes) ? candidate.purgedDishes : [],
    mealSessions: Array.isArray(candidate.mealSessions) ? candidate.mealSessions : [],
    mealSubmissions: Array.isArray(candidate.mealSubmissions) ? candidate.mealSubmissions : [],
  };
  const purgedIds = new Set(normalized.purgedDishes.map((item) => item.dishId));
  if (!purgedIds.size) return normalized;
  return {
    ...normalized,
    dishes: normalized.dishes.filter((dish) => !purgedIds.has(dish.id)),
    cookingRecords: normalized.cookingRecords.filter((record) => !purgedIds.has(record.dishId)),
    dishRatings: normalized.dishRatings.filter((rating) => !purgedIds.has(rating.dishId)),
    recordReviews: normalized.recordReviews.filter((review) => !purgedIds.has(review.dishId)),
    mealSubmissions: normalized.mealSubmissions.filter((submission) => !purgedIds.has(submission.dishId)),
    mealSessions: normalized.mealSessions.map((session) => ({
      ...session,
      finalDishIds: (session.finalDishIds || []).filter((dishId) => !purgedIds.has(dishId)),
    })),
  };
}

function sharedSnapshot(value) {
  const snapshot = JSON.parse(JSON.stringify(value || {}));
  delete snapshot.currentMemberId;
  return snapshot;
}

function sharedStatesEqual(left, right) {
  return JSON.stringify(sharedSnapshot(left)) === JSON.stringify(sharedSnapshot(right));
}

function createStore(options = {}) {
  const storage = options.storage || createDefaultStorage();
  const cloudSync = options.cloudSync || null;
  const clock = options.clock || Date.now;
  const syncIntervalMs = Number(options.syncIntervalMs || 5000);
  const imageCacheMaxEntries = Math.max(
    1,
    Number(options.imageCacheMaxEntries || DEFAULT_IMAGE_URL_CACHE_MAX_ENTRIES)
  );
  const storedState = storage.loadState();
  let state = normalizePersistedState(storedState, options.initialState || createInitialState());
  if (storedState) storage.saveState(state);
  const listeners = new Set();
  let cloudSaveChain = Promise.resolve();
  let localRevision = 0;
  let invite = null;
  let syncStatus = options.initialSyncStatus || (cloudSync ? 'connecting' : 'local');
  let syncMessage = options.initialSyncMessage || '';
  let syncPromise = null;
  let lastSuccessfulSyncAt = null;
  let failedCloudSyncRevision = null;
  let familyGeneration = 0;
  let activeFamilyTransitionGeneration = null;
  const imageUrlCache = new Map();

  function familyIdOf(value) {
    return String(value && value.family && value.family.id || '').trim();
  }

  function captureFamilyContext() {
    return { familyId: familyIdOf(state), generation: familyGeneration };
  }

  function isCurrentFamilyContext(context) {
    return Boolean(context)
      && context.generation === familyGeneration
      && context.familyId === familyIdOf(state);
  }

  function assertStateFamily(value, expectedFamilyId) {
    const actualFamilyId = familyIdOf(value);
    if (!actualFamilyId || !expectedFamilyId || actualFamilyId !== expectedFamilyId) {
      const error = new Error('家庭状态与当前家庭不一致');
      error.code = 'FAMILY_MISMATCH';
      throw error;
    }
  }

  function familyContextStaleError() {
    const error = new Error('家庭已切换，本次保存结果已失效');
    error.code = 'FAMILY_CONTEXT_STALE';
    return error;
  }

  function imageCacheKey(familyId, fileId) {
    return `${familyId}\n${fileId}`;
  }

  function pruneImageUrlCache(now) {
    imageUrlCache.forEach((entry, key) => {
      if (!entry || entry.expiresAt <= now) imageUrlCache.delete(key);
    });
    while (imageUrlCache.size > imageCacheMaxEntries) {
      const oldestKey = imageUrlCache.keys().next().value;
      imageUrlCache.delete(oldestKey);
    }
  }

  function beginFamilyTransition() {
    familyGeneration += 1;
    activeFamilyTransitionGeneration = familyGeneration;
    syncPromise = null;
    lastSuccessfulSyncAt = null;
    failedCloudSyncRevision = null;
    invite = null;
    imageUrlCache.clear();
    return captureFamilyContext();
  }

  async function resolveImageUrls(fileIds) {
    const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [fileIds])
      .filter((fileId) => typeof fileId === 'string' && fileId.indexOf('cloud://') === 0))];
    const urls = new Map();
    const context = captureFamilyContext();
    const now = clock();
    pruneImageUrlCache(now);
    const unresolved = ids.filter((fileId) => {
      const key = imageCacheKey(context.familyId, fileId);
      const cached = imageUrlCache.get(key);
      if (cached && cached.expiresAt > now) {
        urls.set(fileId, cached.url);
        imageUrlCache.delete(key);
        imageUrlCache.set(key, cached);
        return false;
      }
      return true;
    });
    if (!unresolved.length || !cloudSync || typeof cloudSync.resolveFiles !== 'function') return urls;
    const batches = [];
    for (let index = 0; index < unresolved.length; index += MAX_RESOLVE_FILES) {
      batches.push(unresolved.slice(index, index + MAX_RESOLVE_FILES));
    }
    await Promise.all(batches.map(async (batch) => {
      try {
        const files = await cloudSync.resolveFiles(context.familyId, batch);
        if (!isCurrentFamilyContext(context)) return;
        const requestedIds = new Set(batch);
        (files || []).forEach((file) => {
          const fileId = file && (file.fileID || file.fileId);
          const url = file && (file.tempFileURL || file.tempFileUrl);
          if (!requestedIds.has(fileId) || !/^https?:\/\//.test(String(url || ''))) return;
          imageUrlCache.set(imageCacheKey(context.familyId, fileId), {
            familyId: context.familyId,
            fileId,
            url,
            expiresAt: clock() + IMAGE_URL_CACHE_MS,
          });
          pruneImageUrlCache(clock());
          urls.set(fileId, url);
        });
      } catch (error) {
        // Leave failed IDs uncached so the next screen refresh can retry them.
      }
    }));
    return isCurrentFamilyContext(context) ? urls : new Map();
  }

  function notify() {
    listeners.forEach((listener) => listener(state));
  }

  function updateSyncStatus(status, message = '') {
    const changed = syncStatus !== status || syncMessage !== message;
    syncStatus = status;
    syncMessage = message;
    if (changed) notify();
  }

  function queueCloudSave(snapshot, revision, context = captureFamilyContext()) {
    if (!cloudSync || typeof cloudSync.save !== 'function') return Promise.resolve(snapshot);
    let skipped = false;
    const operation = cloudSaveChain.then(() => {
      assertStateFamily(snapshot, context.familyId);
      if (!isCurrentFamilyContext(context)
        || activeFamilyTransitionGeneration === context.generation) {
        skipped = true;
        return snapshot;
      }
      return cloudSync.save(snapshot);
    });
    cloudSaveChain = operation.catch(() => undefined);
    return operation
      .then((saved) => {
        if (!skipped
          && isCurrentFamilyContext(context)
          && revision === localRevision
          && failedCloudSyncRevision !== revision) {
          updateSyncStatus('ready');
        }
        return saved;
      })
      .catch((error) => {
        if (isCurrentFamilyContext(context)) {
          updateSyncStatus('error', cloudErrorMessage(error));
        }
        throw error;
      });
  }

  function commitWithCloudSave(nextState) {
    state = nextState;
    localRevision += 1;
    const snapshot = state;
    const revision = localRevision;
    const context = captureFamilyContext();
    storage.saveState(state);
    notify();
    return {
      snapshot,
      context,
      save: queueCloudSave(snapshot, revision, context),
    };
  }

  function commit(nextState) {
    const operation = commitWithCloudSave(nextState);
    operation.save.catch(() => {});
    return operation.snapshot;
  }

  async function commitAndWait(nextState) {
    const operation = commitWithCloudSave(nextState);
    try {
      await operation.save;
    } catch (error) {
      if (!isCurrentFamilyContext(operation.context)) throw familyContextStaleError();
      throw error;
    }
    if (!isCurrentFamilyContext(operation.context)) throw familyContextStaleError();
    return state;
  }

  function currentMember() {
    return state.members.find((member) => member.id === state.currentMemberId);
  }

  async function performCloudSync(context) {
    if (!cloudSync || typeof cloudSync.load !== 'function') {
      if (isCurrentFamilyContext(context)) updateSyncStatus('local');
      return { state, succeeded: true };
    }
    const localStateAtStart = state;
    try {
      await cloudSaveChain;
      if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      assertStateFamily(state, context.familyId);
      if (typeof cloudSync.bootstrap === 'function') {
        const bootstrapState = state;
        const bootstrapMember = bootstrapState.members.find(
          (member) => member.id === bootstrapState.currentMemberId
        );
        await cloudSync.bootstrap(bootstrapState, bootstrapMember);
        if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      }
      const remote = await cloudSync.load(context.familyId);
      if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      const latestLocalState = state;
      assertStateFamily(latestLocalState, context.familyId);
      if (remote) assertStateFamily(remote, context.familyId);
      const merged = remote
        ? mergeFamilyStates(remote, latestLocalState)
        : latestLocalState;
      assertStateFamily(merged, context.familyId);
      if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      state = normalizePersistedState(merged, latestLocalState);
      state.currentMemberId = latestLocalState.currentMemberId;
      storage.saveState(state);
      notify();
      if (!remote || !sharedStatesEqual(remote, merged)) {
        await queueCloudSave(state, localRevision, context);
        if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      }
      failedCloudSyncRevision = null;
      updateSyncStatus('ready');
      return { state, succeeded: true };
    } catch (error) {
      if (!isCurrentFamilyContext(context)) return { state, succeeded: false, stale: true };
      // Keep the newest local state, including edits made while the request was in flight.
      state = state || localStateAtStart;
      storage.saveState(state);
      failedCloudSyncRevision = localRevision;
      updateSyncStatus('error', cloudErrorMessage(error));
      return { state, succeeded: false };
    }
  }

  return {
    getState() {
      return state;
    },
    syncFromCloud({ force = false } = {}) {
      if (syncPromise) return syncPromise;
      if (activeFamilyTransitionGeneration === familyGeneration) return Promise.resolve(state);
      if (!force && lastSuccessfulSyncAt !== null && clock() - lastSuccessfulSyncAt < syncIntervalMs) {
        return Promise.resolve(state);
      }
      const context = captureFamilyContext();
      let request = null;
      request = performCloudSync(context)
        .then((result) => {
          if (result.succeeded && !result.stale && isCurrentFamilyContext(context)) {
            lastSuccessfulSyncAt = clock();
          }
          return result.state;
        })
        .finally(() => {
          if (syncPromise === request) syncPromise = null;
        });
      syncPromise = request;
      return request;
    },
    hydrateFromCloud() {
      return this.syncFromCloud({ force: true });
    },
    async joinFamilyByInvite(code, member) {
      if (!cloudSync || typeof cloudSync.acceptInvite !== 'function') {
        throw new Error('当前还没有配置家庭云端同步');
      }
      const transition = beginFamilyTransition();
      try {
        await cloudSaveChain;
        if (!isCurrentFamilyContext(transition)) return state;
        const result = await cloudSync.acceptInvite(code, member);
        if (!isCurrentFamilyContext(transition)) return state;
        const remote = result && result.state ? result.state : null;
        if (!remote) throw new Error('没有找到这个家庭空间');
        const remoteFamilyId = familyIdOf(remote);
        if (!remoteFamilyId) throw new Error('没有找到这个家庭空间');
        const memberId = result.member && result.member.memberId
          ? result.member.memberId
          : member.id;
        state = normalizePersistedState({ ...remote, currentMemberId: memberId }, state);
        assertStateFamily(state, remoteFamilyId);
        state.currentMemberId = memberId;
        if (!state.members.some((item) => item.id === memberId)) {
          state = addMember(state, { id: memberId, displayName: member.displayName });
        }
        localRevision += 1;
        invite = null;
        imageUrlCache.clear();
        storage.saveState(state);
        updateSyncStatus('ready');
        notify();
        return state;
      } finally {
        if (activeFamilyTransitionGeneration === transition.generation) {
          activeFamilyTransitionGeneration = null;
        }
      }
    },
    async getInvite() {
      if (!cloudSync || typeof cloudSync.getInvite !== 'function') return null;
      invite = await cloudSync.getInvite(state.family.id);
      notify();
      return invite;
    },
    async createInvite() {
      if (!cloudSync || typeof cloudSync.createInvite !== 'function') {
        throw new Error('连接云端后才能生成邀请码');
      }
      invite = await cloudSync.createInvite(state.family.id);
      notify();
      return invite;
    },
    async revokeInvite() {
      if (!cloudSync || typeof cloudSync.revokeInvite !== 'function') {
        throw new Error('连接云端后才能撤销邀请码');
      }
      const result = await cloudSync.revokeInvite(state.family.id);
      invite = null;
      notify();
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addDish(input, now) {
      return commit(addDish(state, input, now));
    },
    addCookingRecord(input, now) {
      return commit(addCookingRecord(state, input, now));
    },
    addCookingRecordAndWait(input, now) {
      return commitAndWait(addCookingRecord(state, input, now));
    },
    updateFamily(input, now) {
      return commit(updateFamilyProfile(state, input, now));
    },
    updateMember(input, now) {
      return commit(updateMemberProfile(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    updateDish(input, now) {
      return commit(updateDishProfile(state, input, now));
    },
    rateDish(input, now) {
      return commit(rateDish(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    rateRecord(input, now) {
      return commit(upsertRecordReview(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    deleteDish(input, now) {
      return commit(deleteDish(state, input, now));
    },
    restoreDish(input, now) {
      return commit(restoreDish(state, input, now));
    },
    purgeDish(input, now) {
      return commit(purgeDish(state, input, now));
    },
    getFamilySummary() {
      const summary = getFamilySummary(state);
      return {
        ...summary,
        inviteCode: invite ? invite.code : '',
        inviteExpiresAt: invite ? invite.expiresAt : '',
        inviteStatus: invite ? invite.status : 'unavailable',
        cloudEnabled: syncStatus === 'ready',
        syncStatus,
        syncMessage,
      };
    },
    getSyncStatus() {
      return { status: syncStatus, message: syncMessage };
    },
    ensureMeal(input, now) {
      const nextState = createMealSession(state, input, now);
      commit(nextState);
      return getMealForDate(state, input.date, input.mealType || 'dinner');
    },
    getMeal(date, mealType = 'dinner') {
      return getMealForDate(state, date, mealType);
    },
    selectDish(input, now) {
      return commit(submitMealSelection(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    updateSelection(input, now) {
      return commit(updateMealSelection(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    cancelSelection(input, now) {
      return commit(cancelMealSelection(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    confirmMeal(input, now) {
      return commit(confirmMealSession(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }, now));
    },
    getSelectedDishes(sessionId) {
      return getSelectedSubmissions(state, sessionId);
    },
    listDishes(filters = {}) {
      return listDishSummaries(state, filters);
    },
    listDeletedDishes() {
      return listDeletedDishSummaries(state);
    },
    findDishByName(name) {
      return findDishByName(state, name);
    },
    findSimilarDishes(name) {
      return findSimilarDishes(state, name);
    },
    resolveImageUrls,
    async uploadImage(filePath) {
      if (!filePath || /^(cloud:\/\/|https?:\/\/)/.test(filePath)) return filePath || '';
      if (!cloudSync || typeof cloudSync.uploadImage !== 'function') {
        const error = new Error('云端图片上传暂不可用');
        error.code = 'IMAGE_UPLOAD_UNAVAILABLE';
        throw error;
      }
      return cloudSync.uploadImage(filePath, state.family.id);
    },
  };
}

module.exports = { CLOUD_FALLBACK_MESSAGE, createStore, normalizePersistedState };
