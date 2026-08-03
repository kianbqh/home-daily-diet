const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('uses a pack-safe runtime CloudBase config filename', () => {
  const root = path.resolve(__dirname, '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.equal(fs.existsSync(path.join(root, 'cloudbase.config.json')), true);
  assert.match(appSource, /cloudbase\.config\.json/);
  assert.doesNotMatch(appSource, /cloudbase\.example\.json/);
});

test('returns a local store when device storage initialization throws', () => {
  const api = {
    getStorageSync() {
      throw new Error('storage unavailable');
    },
    setStorageSync() {},
    cloud: {
      init() {},
    },
  };

  const result = createApplicationStore({
    api,
    config: { envId: 'env-test' },
  });

  assert.equal(result.store.getFamilySummary().memberCount, 1);
  assert.equal(result.store.getSyncStatus().status, 'error');
  assert.match(result.store.getSyncStatus().message, /初始化失败/);
});
