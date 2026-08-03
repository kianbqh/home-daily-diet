const STORAGE_KEY = 'family-meals-state-v1';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryStorage(initialState = null) {
  let stored = clone(initialState);
  return {
    loadState() {
      return clone(stored);
    },
    saveState(state) {
      stored = clone(state);
    },
    clearState() {
      stored = null;
    },
  };
}

function createWxStorage(api) {
  if (!api || typeof api.getStorageSync !== 'function') {
    return createMemoryStorage();
  }
  return {
    loadState() {
      return api.getStorageSync(STORAGE_KEY) || null;
    },
    saveState(state) {
      api.setStorageSync(STORAGE_KEY, state);
    },
    clearState() {
      api.removeStorageSync(STORAGE_KEY);
    },
  };
}

function createDefaultStorage() {
  return createWxStorage(typeof wx === 'undefined' ? null : wx);
}

module.exports = {
  STORAGE_KEY,
  createDefaultStorage,
  createMemoryStorage,
  createWxStorage,
};

