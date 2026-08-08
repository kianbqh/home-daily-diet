const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

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

test('trash page restores and permanently purges the selected dish through the store', () => {
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

  assert.deepEqual(calls, [
    ['restore', { dishId: 'dish-1' }],
    ['purge', { dishId: 'dish-1' }],
  ]);

  global.getApp = originalGetApp;
  global.wx = originalWx;
});
