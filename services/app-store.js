const {
  addCookingRecord,
  addDish,
  addMember,
  cancelMealSelection,
  confirmMealSession,
  createInitialState,
  createMealSession,
  getMealForDate,
  getFamilySummary,
  getSelectedSubmissions,
  findDishByName,
  findSimilarDishes,
  listDishSummaries,
  submitMealSelection,
  updateDishProfile,
  updateFamilyProfile,
  updateMemberProfile,
  updateMealSelection,
} = require('./domain');
const { createDefaultStorage } = require('./storage');
const { mergeFamilyStates } = require('./cloudbase-sync');

const CLOUD_FALLBACK_MESSAGE = '云端连接失败，当前继续使用本地数据。';

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

  let members = Array.isArray(candidate.members)
    ? candidate.members.filter((member) => member && member.id)
    : [];
  if (members.length === 0) {
    members = fallback.members.map((member) => ({ ...member }));
  }

  let currentMemberId = String(candidate.currentMemberId || '').trim();
  if (!currentMemberId || !members.some((member) => member.id === currentMemberId)) {
    const fallbackMemberId = fallback.currentMemberId;
    currentMemberId = members.some((member) => member.id === fallbackMemberId)
      ? fallbackMemberId
      : members[0].id;
  }

  return {
    ...fallback,
    ...candidate,
    family,
    currentMemberId,
    members,
    dishes: Array.isArray(candidate.dishes) ? candidate.dishes : [],
    cookingRecords: Array.isArray(candidate.cookingRecords) ? candidate.cookingRecords : [],
    mealSessions: Array.isArray(candidate.mealSessions) ? candidate.mealSessions : [],
    mealSubmissions: Array.isArray(candidate.mealSubmissions) ? candidate.mealSubmissions : [],
  };
}

function createStore(options = {}) {
  const storage = options.storage || createDefaultStorage();
  const cloudSync = options.cloudSync || null;
  const storedState = storage.loadState();
  let state = normalizePersistedState(storedState, options.initialState || createInitialState());
  if (storedState) storage.saveState(state);
  const listeners = new Set();
  let cloudSaveChain = Promise.resolve();
  let localRevision = 0;
  let invite = null;
  let syncStatus = options.initialSyncStatus || (cloudSync ? 'connecting' : 'local');
  let syncMessage = options.initialSyncMessage || '';

  function notify() {
    listeners.forEach((listener) => listener(state));
  }

  function updateSyncStatus(status, message = '') {
    const changed = syncStatus !== status || syncMessage !== message;
    syncStatus = status;
    syncMessage = message;
    if (changed) notify();
  }

  function queueCloudSave(snapshot, revision) {
    if (!cloudSync || typeof cloudSync.save !== 'function') return Promise.resolve(snapshot);
    const operation = cloudSaveChain.then(() => cloudSync.save(snapshot));
    cloudSaveChain = operation.catch(() => undefined);
    return operation
      .then((saved) => {
        if (revision === localRevision) updateSyncStatus('ready');
        return saved;
      })
      .catch((error) => {
        updateSyncStatus('error', cloudErrorMessage(error));
        throw error;
      });
  }

  function commit(nextState) {
    state = nextState;
    localRevision += 1;
    storage.saveState(state);
    notify();
    queueCloudSave(state, localRevision).catch(() => {});
    return state;
  }

  function currentMember() {
    return state.members.find((member) => member.id === state.currentMemberId);
  }

  return {
    getState() {
      return state;
    },
    async hydrateFromCloud() {
      if (!cloudSync || typeof cloudSync.load !== 'function') {
        updateSyncStatus('local');
        return state;
      }
      const localStateAtStart = state;
      try {
        await cloudSaveChain;
        if (typeof cloudSync.bootstrap === 'function') {
          const member = currentMember();
          await cloudSync.bootstrap(state, member);
        }
        const remote = await cloudSync.load(state.family.id);
        const latestLocalState = state;
        const merged = remote
          ? mergeFamilyStates(remote, latestLocalState)
          : latestLocalState;
        state = normalizePersistedState(merged, latestLocalState);
        state.currentMemberId = latestLocalState.currentMemberId;
        storage.saveState(state);
        notify();
        await queueCloudSave(state, localRevision);
        updateSyncStatus('ready');
      } catch (error) {
        // Keep the newest local state, including edits made while the request was in flight.
        state = state || localStateAtStart;
        storage.saveState(state);
        updateSyncStatus('error', cloudErrorMessage(error));
      }
      return state;
    },
    async joinFamilyByInvite(code, member) {
      if (!cloudSync || typeof cloudSync.acceptInvite !== 'function') {
        throw new Error('当前还没有配置家庭云端同步');
      }
      const result = await cloudSync.acceptInvite(code, member);
      const remote = result && result.state ? result.state : null;
      if (!remote) throw new Error('没有找到这个家庭空间');
      const memberId = result.member && result.member.memberId
        ? result.member.memberId
        : member.id;
      state = normalizePersistedState({ ...remote, currentMemberId: memberId }, state);
      state.currentMemberId = memberId;
      if (!state.members.some((item) => item.id === memberId)) {
        state = addMember(state, { id: memberId, displayName: member.displayName });
      }
      localRevision += 1;
      invite = null;
      storage.saveState(state);
      updateSyncStatus('ready');
      notify();
      return state;
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
    updateFamily(input) {
      return commit(updateFamilyProfile(state, input));
    },
    updateMember(input) {
      return commit(updateMemberProfile(state, {
        ...input,
        memberId: input.memberId || state.currentMemberId,
      }));
    },
    updateDish(input, now) {
      return commit(updateDishProfile(state, input, now));
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
    findDishByName(name) {
      return findDishByName(state, name);
    },
    findSimilarDishes(name) {
      return findSimilarDishes(state, name);
    },
    async uploadImage(filePath) {
      if (!cloudSync || typeof cloudSync.uploadImage !== 'function') return filePath || '';
      return cloudSync.uploadImage(filePath, state.family.id);
    },
  };
}

module.exports = { CLOUD_FALLBACK_MESSAGE, createStore, normalizePersistedState };
