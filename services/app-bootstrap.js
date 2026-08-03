const { createStore, CLOUD_FALLBACK_MESSAGE } = require('./app-store');
const { createCloudBaseSync } = require('./cloudbase-sync');
const { createInitialState } = require('./domain');
const { createMemoryStorage } = require('./storage');
const { getOrCreateFamilyId, getOrCreateMemberId } = require('../utils/identity');

const APP_INIT_FALLBACK_MESSAGE = '应用初始化失败，当前继续使用本地数据。';

function createFallbackApplicationStore(error) {
  return {
    store: createStore({
      storage: createMemoryStorage(),
      initialState: createInitialState({
        familyId: 'family-local',
        memberId: 'member-local',
        memberName: '我',
      }),
      initialSyncStatus: 'error',
      initialSyncMessage: APP_INIT_FALLBACK_MESSAGE,
    }),
    cloudSync: null,
    cloudInitError: error,
  };
}

function createApplicationStore(options = {}) {
  try {
    const api = options.api || null;
    const config = options.config || {};
    let cloudSync = null;
    let cloudInitError = null;

    try {
      cloudSync = createCloudBaseSync(api, config);
    } catch (error) {
      cloudInitError = error;
    }

    const memberId = getOrCreateMemberId(api);
    const storeOptions = {
      cloudSync,
      initialState: createInitialState({
        familyId: getOrCreateFamilyId(api),
        memberId,
      }),
    };
    if (options.storage) {
      storeOptions.storage = options.storage;
    }
    if (cloudInitError) {
      storeOptions.initialSyncStatus = 'error';
      storeOptions.initialSyncMessage = CLOUD_FALLBACK_MESSAGE;
    }

    return {
      store: createStore(storeOptions),
      cloudSync,
      cloudInitError,
    };
  } catch (error) {
    return createFallbackApplicationStore(error);
  }
}

module.exports = { APP_INIT_FALLBACK_MESSAGE, createApplicationStore };
