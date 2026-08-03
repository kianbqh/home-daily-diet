const test = require('node:test');
const assert = require('node:assert/strict');

const { createApplicationStore } = require('../services/app-bootstrap');
const { createMemoryStorage } = require('../services/storage');

test('creates a usable local store when wx.cloud.init throws', () => {
  const api = {
    getStorageSync() {
      return '';
    },
    setStorageSync() {},
    cloud: {
      init() {
        throw new Error('environment unavailable');
      },
    },
  };

  const result = createApplicationStore({
    api,
    config: { envId: 'broken-env' },
    storage: createMemoryStorage(),
  });

  assert.equal(result.store.getFamilySummary().memberCount, 1);
  assert.equal(result.store.getFamilySummary().syncStatus, 'error');
  assert.match(result.store.getFamilySummary().syncMessage, /本地数据/);
  assert.match(result.cloudInitError.message, /environment unavailable/);
});
