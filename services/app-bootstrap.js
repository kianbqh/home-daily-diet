const { createStore, CLOUD_FALLBACK_MESSAGE } = require('./app-store');
const { createCloudBaseSync } = require('./cloudbase-sync');
const { createInitialState } = require('./domain');
const { getOrCreateFamilyId, getOrCreateMemberId } = require('../utils/identity');

function createApplicationStore(options = {}) {
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
}

module.exports = { createApplicationStore };
