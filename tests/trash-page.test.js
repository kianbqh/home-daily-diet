const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addDish,
  createInitialState,
  deleteDish: deleteDishState,
  purgeDish: purgeDishState,
  restoreDish: restoreDishState,
} = require('../services/domain');

function loadPage(relativePath) {
  const modulePath = require.resolve(`../${relativePath}`);
  const originalPage = global.Page;
  let definition = null;
  global.Page = (config) => { definition = config; };
  delete require.cache[modulePath];
  require(modulePath);
  global.Page = originalPage;
  return definition;
}

function createPageInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ...data },
    setData(next) {
      this.data = { ...this.data, ...next };
    },
  };
}

test('trash page is registered and exposes restore and permanent delete actions', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  const template = fs.readFileSync(path.join(__dirname, '../pages/trash/trash.wxml'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../pages/trash/trash.wxss'), 'utf8');
  assert.ok(appConfig.pages.includes('pages/trash/trash'));
  assert.match(template, /class="trash-action-button secondary-button"[^>]*bindtap="restoreDish"/);
  assert.match(template, /class="trash-action-button danger-button"[^>]*bindtap="purgeDish"/);
  assert.match(template, /bindtap="openDish"/);
  assert.match(styles, /\.trash-action-button\s*\{[\s\S]*height:\s*84rpx/);
  assert.match(styles, /\.trash-action-button\s*\{[\s\S]*display:\s*flex/);
});

test('trash page restores and permanently purges the selected dish through the store', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const store = {
    getState() {
      return {
        dishes: [{ id: 'dish-1', name: 'Archived dish', status: 'deleted', deletedAt: '2026-08-01T10:00:00.000Z' }],
        cookingRecords: [],
        dishRatings: [],
        recordReviews: [],
        purgedDishes: [],
      };
    },
    listDeletedDishes() {
      return [{ id: 'dish-1', name: 'Archived dish' }];
    },
    restoreDish(input) {
      calls.push(['restore', input]);
    },
    purgeDish(input) {
      calls.push(['purge', input]);
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showModal(options) {
      options.success({ confirm: true });
    },
    showToast() {},
    navigateTo() {},
    navigateBack() {},
  };

  const page = createPageInstance(loadPage('pages/trash/trash.js'));
  page.refresh();
  page.restoreDish({ currentTarget: { dataset: { dishId: 'dish-1' } } });
  page.purgeDish({ currentTarget: { dataset: { dishId: 'dish-1' } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ['restore', { dishId: 'dish-1' }],
    ['purge', { dishId: 'dish-1' }],
  ]);

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('trash page reports durable deletion when cloud attachments remain pending', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  const store = {
    getState() {
      return {
        dishes: [], cookingRecords: [], dishRatings: [], recordReviews: [], purgedDishes: [],
      };
    },
    listDeletedDishes() { return []; },
    async purgeDish(input) {
      assert.deepEqual(input, { dishId: 'dish-pending' });
      return {
        purged: true,
        cleanupPending: true,
        message: '菜品已删除，云端附件将在联网后继续清理',
      };
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showModal(options) { options.success({ confirm: true }); },
    showToast(options) { toasts.push(options); },
  };
  const page = createPageInstance(loadPage('pages/trash/trash.js'));

  try {
    page.purgeDish({ currentTarget: { dataset: { dishId: 'dish-pending' } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(toasts.at(-1).title, '菜品已删除，云端附件将在联网后继续清理');
    assert.equal(toasts.at(-1).icon, 'none');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

function createDeferredTrashHarness(action) {
  const cloudImageId = 'cloud://env/family-meals/family-1/deleted.jpg';
  let state = addDish(createInitialState({ familyId: 'family-1' }), {
    id: 'dish-1',
    name: 'Archived dish',
    image: cloudImageId,
  }, '2026-08-01T09:00:00.000Z');
  state = deleteDishState(state, { dishId: 'dish-1' }, '2026-08-01T10:00:00.000Z');
  const requests = [];
  const store = {
    getState() { return state; },
    resolveImageUrls(ids) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      requests.push({ ids, resolve });
      return promise;
    },
    restoreDish(input) {
      state = restoreDishState(state, input, '2026-08-02T10:00:00.000Z');
    },
    purgeDish(input) {
      state = purgeDishState(state, input, '2026-08-02T10:00:00.000Z');
    },
  };
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showModal(options) { options.success({ confirm: true }); },
    showToast() {},
  };
  const page = createPageInstance(loadPage('pages/trash/trash.js'));
  page.refresh();
  page[action]({ currentTarget: { dataset: { dishId: 'dish-1' } } });
  return {
    cloudImageId,
    page,
    requests,
    restoreGlobals() {
      global.getApp = originalGetApp;
      global.wx = originalWx;
    },
  };
}

test('trash ignores an older deferred image resolution after restoring the row', async () => {
  const harness = createDeferredTrashHarness('restoreDish');
  try {
    assert.deepEqual(harness.page.data.dishes, []);
    assert.equal(harness.requests.length, 1);
    harness.requests[0].resolve(new Map([[harness.cloudImageId, 'https://cdn.example/stale-restored.jpg']]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.page.data.dishes, []);
  } finally {
    harness.restoreGlobals();
  }
});

test('trash ignores an older deferred image resolution after permanently purging the row', async () => {
  const harness = createDeferredTrashHarness('purgeDish');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.page.data.dishes, []);
    assert.equal(harness.requests.length, 1);
    harness.requests[0].resolve(new Map([[harness.cloudImageId, 'https://cdn.example/stale-purged.jpg']]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.page.data.dishes, []);
  } finally {
    harness.restoreGlobals();
  }
});

test('trash invalidates a deferred image resolution when the page unloads', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const cloudImageId = 'cloud://env/family-meals/family-1/unloaded.jpg';
  let state = addDish(createInitialState({ familyId: 'family-1' }), {
    id: 'dish-1',
    name: 'Unloaded archived dish',
    image: cloudImageId,
  }, '2026-08-01T09:00:00.000Z');
  state = deleteDishState(state, { dishId: 'dish-1' }, '2026-08-01T10:00:00.000Z');
  let release;
  const store = {
    getState() { return state; },
    resolveImageUrls() {
      return new Promise((resolve) => { release = resolve; });
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {};
  const page = createPageInstance(loadPage('pages/trash/trash.js'));

  try {
    page.refresh();
    const beforeUnload = page.data.dishes.map((dish) => ({ ...dish }));
    assert.equal(typeof page.onUnload, 'function');
    page.onUnload();
    release(new Map([[cloudImageId, 'https://cdn.example/stale-unloaded.jpg']]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(page.data.dishes, beforeUnload);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});
