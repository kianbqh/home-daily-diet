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

test('creates a recipe assistant without blocking the existing store startup', () => {
  const api = {
    getStorageSync() {
      return '';
    },
    setStorageSync() {},
    cloud: {
      init() {},
      async callFunction() {
        return { result: { ok: true, data: {} } };
      },
    },
  };

  const result = createApplicationStore({
    api,
    config: { envId: 'env-test', recipeFunction: 'recipe-assistant' },
    storage: createMemoryStorage(),
  });

  assert.equal(typeof result.recipeAssistant.getRecipe, 'function');
  assert.equal(result.store.getFamilySummary().memberCount, 1);
});

test('recipe assistant initialization failure leaves the existing store usable', () => {
  const api = {
    getStorageSync() {
      return '';
    },
    setStorageSync() {},
    cloud: {
      init() {},
      async callFunction() {
        return { result: { ok: true, data: {} } };
      },
    },
  };

  const result = createApplicationStore({
    api,
    config: { envId: 'env-test' },
    storage: createMemoryStorage(),
    recipeAssistantFactory() {
      throw new Error('recipe service unavailable');
    },
  });

  assert.equal(result.recipeAssistant, null);
  assert.equal(result.store.getFamilySummary().memberCount, 1);
  assert.equal(result.cloudInitError, null);
});

test('application store wires permanent dish cleanup to the recipe assistant', async () => {
  const purges = [];
  const api = {
    getStorageSync() { return ''; },
    setStorageSync() {},
    cloud: {
      init() {},
      async callFunction({ data }) {
        return { result: { ok: true, data: { state: data.state || null } } };
      },
    },
  };
  const result = createApplicationStore({
    api,
    config: { envId: 'env-test' },
    storage: createMemoryStorage(),
    recipeAssistantFactory() {
      return {
        async purgeDishArtifacts(payload) {
          purges.push(payload);
          return { deletedDocuments: 0, deletedFiles: 0, pendingFiles: 0 };
        },
      };
    },
  });
  const familyId = result.store.getState().family.id;
  result.store.addDish({ id: 'dish-bootstrap-purge', name: '测试删除' }, '2026-08-17T08:00:00.000Z');
  result.store.deleteDish({ dishId: 'dish-bootstrap-purge' }, '2026-08-17T09:00:00.000Z');

  await result.store.purgeDish({ dishId: 'dish-bootstrap-purge' }, '2026-08-18T08:00:00.000Z');

  assert.deepEqual(purges, [{ familyId, dishId: 'dish-bootstrap-purge' }]);
});

test('uses a pack-safe runtime CloudBase config filename', () => {
  const root = path.resolve(__dirname, '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const runtimeConfig = require(path.join(root, 'cloudbase.config.js'));

  assert.equal(fs.existsSync(path.join(root, 'cloudbase.config.js')), true);
  assert.equal(runtimeConfig.envId, 'home-daily-diet-d8f5e7d6907dd53a');
  assert.equal(runtimeConfig.recipeFunction, 'recipe-assistant');
  assert.equal(runtimeConfig.recipeAudioPrefix, 'families/');
  assert.match(appSource, /cloudbase\.config\.js/);
  assert.doesNotMatch(appSource, /cloudbase\.config\.json/);
  assert.doesNotMatch(appSource, /cloudbase\.example\.json/);
});

test('app startup exposes the recipe assistant globally', () => {
  const priorApp = global.App;
  const priorWx = global.wx;
  const appPath = require.resolve('../app');
  let definition;
  global.App = (value) => {
    definition = value;
  };
  global.wx = {
    getStorageSync() {
      return '';
    },
    setStorageSync() {},
    cloud: {
      init() {},
      async callFunction() {
        return { result: { ok: true, data: {} } };
      },
    },
  };
  delete require.cache[appPath];
  require('../app');
  const instance = { globalData: { ...definition.globalData } };
  definition.onLaunch.call(instance);
  delete require.cache[appPath];
  global.App = priorApp;
  global.wx = priorWx;

  assert.equal(typeof instance.globalData.recipeAssistant.getRecipe, 'function');
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
