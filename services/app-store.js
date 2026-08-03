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

const CLOUD_FALLBACK_MESSAGE = '云端连接失败，当前继续使用本地数据。';

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
    name: String(candidateFamily.name || fallback.family.name || '').trim() || '我们的家',
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

  function commit(nextState) {
    state = nextState;
    storage.saveState(state);
    notify();
    if (cloudSync && typeof cloudSync.save === 'function') {
      const snapshot = state;
      cloudSaveChain = cloudSaveChain
        .then(() => cloudSync.save(snapshot))
        .then(() => updateSyncStatus('ready'))
        .catch(() => updateSyncStatus('error', CLOUD_FALLBACK_MESSAGE));
    }
    return state;
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
      const localState = state;
      try {
        await cloudSaveChain;
        const remote = await cloudSync.load(state.family.id);
        if (remote) {
          const localMemberId = localState.currentMemberId;
          const localMember = localState.members.find((member) => member.id === localMemberId);
          const normalizedRemote = normalizePersistedState(remote, localState);
          state = { ...normalizedRemote, currentMemberId: localMemberId };
          if (localMember && !state.members.some((member) => member.id === localMemberId)) {
            state = addMember(state, localMember);
          }
          storage.saveState(state);
        }
        syncStatus = 'ready';
        syncMessage = '';
        notify();
      } catch (error) {
        state = localState;
        updateSyncStatus('error', CLOUD_FALLBACK_MESSAGE);
      }
      return state;
    },
    async joinFamily(familyId, member) {
      if (!cloudSync || typeof cloudSync.load !== 'function') {
        throw new Error('当前还没有配置家庭云端同步');
      }
      const remote = await cloudSync.load(familyId);
      if (!remote) {
        throw new Error('没有找到这个家庭空间');
      }
      let nextState = addMember(remote, member);
      nextState.currentMemberId = member.id;
      commit(nextState);
      return nextState;
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
      return {
        ...getFamilySummary(state),
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

module.exports = { CLOUD_FALLBACK_MESSAGE, createStore };
