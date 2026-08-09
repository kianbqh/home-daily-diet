const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { addDish, createInitialState } = require('../services/domain');

function loadPage(relativePath) {
  const modulePath = require.resolve(`../${relativePath}`);
  const originalPage = global.Page;
  let definition = null;
  global.Page = (config) => {
    definition = config;
  };
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

test('refreshable pages expose pull-down lifecycle methods and enable native refresh globally', () => {
  const appConfig = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  const pagePaths = [
    'pages/index/index.js',
    'pages/dishes/dishes.js',
    'pages/dish-edit/dish-edit.js',
    'pages/meal/meal.js',
    'pages/family/family.js',
    'pages/trash/trash.js',
  ];

  assert.equal(appConfig.window.enablePullDownRefresh, true);
  pagePaths.forEach((pagePath) => {
    const definition = loadPage(pagePath);
    assert.equal(typeof definition.onPullDownRefresh, 'function', `${pagePath} should refresh on pull-down`);
  });
});

test('refreshable page onShow handlers run their automatic sync paths', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const state = createInitialState({ memberId: 'member-1' });
  const summary = {
    id: 'family-1',
    name: '我们家',
    memberCount: 1,
    members: [{ id: 'member-1', displayName: '我' }],
    inviteCode: '',
    syncStatus: 'ready',
  };
  let syncCalls = 0;
  const store = {
    async syncFromCloud() { syncCalls += 1; },
    getState() { return state; },
    getFamilySummary() { return summary; },
    async getInvite() { return null; },
    getMeal() { return null; },
    ensureMeal() {},
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {};
  const pagePaths = [
    'pages/index/index.js',
    'pages/dishes/dishes.js',
    'pages/dish-edit/dish-edit.js',
    'pages/meal/meal.js',
    'pages/family/family.js',
    'pages/trash/trash.js',
  ];

  try {
    pagePaths.forEach((pagePath) => {
      const page = createPageInstance(loadPage(pagePath));
      assert.doesNotThrow(() => page.onShow(), `${pagePath} should start automatic sync`);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(syncCalls, pagePaths.length);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('dish detail lifecycle refreshes server fields without clearing review or record-photo drafts', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let state = addDish(createInitialState({ memberId: 'member-1' }), {
    id: 'dish-1',
    name: '初始菜名',
    image: 'cloud://family-meals/family-1/initial.jpg',
  }, '2026-08-09T10:00:00.000Z');
  const recordId = state.cookingRecords[0].id;
  let syncCalls = 0;
  let stopCalls = 0;
  const store = {
    async syncFromCloud() {
      syncCalls += 1;
      const suffix = syncCalls === 1 ? 'automatic' : 'manual';
      state = {
        ...state,
        dishes: state.dishes.map((dish) => ({
          ...dish,
          name: `${suffix} server dish`,
          coverImage: `cloud://family-meals/family-1/${suffix}-cover.jpg`,
        })),
        cookingRecords: state.cookingRecords.map((record) => ({
          ...record,
          image: `cloud://family-meals/family-1/${suffix}-record.jpg`,
        })),
      };
    },
    getState() { return state; },
    resolveImageUrls(ids) {
      return Promise.resolve(new Map(ids.map((id) => [id, `https://cdn.example/${id.slice('cloud://'.length)}`])));
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast() {},
    stopPullDownRefresh() { stopCalls += 1; },
  };
  const page = createPageInstance(loadPage('pages/dish-edit/dish-edit.js'));

  try {
    page.onLoad({ dishId: 'dish-1' });
    await new Promise((resolve) => setImmediate(resolve));
    page.setData({
      reviewingRecordId: recordId,
      reviewStars: 4.5,
      reviewText: '草稿评价',
      image: 'wxfile://pending-record-photo.jpg',
      displayImage: 'wxfile://pending-record-photo.jpg',
    });

    page.onShow();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      name: page.data.name,
      dishCover: page.data.dishCover,
      recordImage: page.data.history[0].image,
      reviewingRecordId: page.data.reviewingRecordId,
      reviewStars: page.data.reviewStars,
      reviewText: page.data.reviewText,
      image: page.data.image,
      displayImage: page.data.displayImage,
    }, {
      name: 'automatic server dish',
      dishCover: 'https://cdn.example/family-meals/family-1/automatic-cover.jpg',
      recordImage: 'https://cdn.example/family-meals/family-1/automatic-record.jpg',
      reviewingRecordId: recordId,
      reviewStars: 4.5,
      reviewText: '草稿评价',
      image: 'wxfile://pending-record-photo.jpg',
      displayImage: 'wxfile://pending-record-photo.jpg',
    });

    await page.onPullDownRefresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      name: page.data.name,
      dishCover: page.data.dishCover,
      recordImage: page.data.history[0].image,
      reviewingRecordId: page.data.reviewingRecordId,
      reviewStars: page.data.reviewStars,
      reviewText: page.data.reviewText,
      image: page.data.image,
      displayImage: page.data.displayImage,
      syncCalls,
      stopCalls,
    }, {
      name: 'manual server dish',
      dishCover: 'https://cdn.example/family-meals/family-1/manual-cover.jpg',
      recordImage: 'https://cdn.example/family-meals/family-1/manual-record.jpg',
      reviewingRecordId: recordId,
      reviewStars: 4.5,
      reviewText: '草稿评价',
      image: 'wxfile://pending-record-photo.jpg',
      displayImage: 'wxfile://pending-record-photo.jpg',
      syncCalls: 2,
      stopCalls: 1,
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('dish detail lifecycle does not overwrite an active profile edit draft', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const state = addDish(createInitialState({ memberId: 'member-1' }), {
    id: 'dish-1',
    name: '服务器菜名',
    image: 'cloud://family-meals/family-1/server-cover.jpg',
  }, '2026-08-09T10:00:00.000Z');
  let syncCalls = 0;
  let stopCalls = 0;
  const store = {
    async syncFromCloud() { syncCalls += 1; },
    getState() { return state; },
    resolveImageUrls() { return Promise.resolve(new Map()); },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast() {},
    stopPullDownRefresh() { stopCalls += 1; },
  };
  const page = createPageInstance(loadPage('pages/dish-edit/dish-edit.js'));

  try {
    page.onLoad({ dishId: 'dish-1', mode: 'edit' });
    await new Promise((resolve) => setImmediate(resolve));
    page.setData({
      nameDraft: '本地资料草稿',
      image: 'wxfile://pending-profile-photo.jpg',
      displayImage: 'wxfile://pending-profile-photo.jpg',
      selectedTags: ['家常'],
    });

    page.onShow();
    await new Promise((resolve) => setImmediate(resolve));
    await page.onPullDownRefresh();

    assert.deepEqual({
      nameDraft: page.data.nameDraft,
      image: page.data.image,
      displayImage: page.data.displayImage,
      selectedTags: page.data.selectedTags,
      syncCalls,
      stopCalls,
    }, {
      nameDraft: '本地资料草稿',
      image: 'wxfile://pending-profile-photo.jpg',
      displayImage: 'wxfile://pending-profile-photo.jpg',
      selectedTags: ['家常'],
      syncCalls: 2,
      stopCalls: 1,
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('meal pull-down during invite joining stops native refresh without syncing or creating a meal', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const state = addDish(
    createInitialState({ memberId: 'member-1' }),
    { name: '番茄炒蛋' },
    '2026-08-09T10:00:00.000Z'
  );
  let syncCalls = 0;
  let ensuredMeals = 0;
  let stopCalls = 0;
  const store = {
    async syncFromCloud() { syncCalls += 1; },
    getState() { return state; },
    getMeal() { return null; },
    ensureMeal() { ensuredMeals += 1; },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    stopPullDownRefresh() { stopCalls += 1; },
  };
  const page = createPageInstance(loadPage('pages/meal/meal.js'), {
    date: '2026-08-09',
    joining: true,
  });

  try {
    await page.onPullDownRefresh();
    assert.deepEqual({ syncCalls, ensuredMeals, stopCalls }, {
      syncCalls: 0,
      ensuredMeals: 0,
      stopCalls: 1,
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('existing dish page saves a member rating and exposes removal separately from recording', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let rated = null;
  let deleted = null;
  let modal = null;
  const state = createInitialState({ memberId: 'member-1' });
  const dishState = addDish(state, { name: '番茄炒蛋' }, '2026-08-07T10:00:00.000Z');
  const store = {
    getState() {
      return dishState;
    },
    rateDish(input) {
      rated = input;
    },
    deleteDish(input) {
      deleted = input;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast() {},
    showModal(options) {
      modal = options;
    },
    navigateBack() {},
  };

  const page = createPageInstance(loadPage('pages/dish-edit/dish-edit.js'), {
    isExisting: true,
    isEditingProfile: false,
    dishId: dishState.dishes[0].id,
  });

  page.chooseRating({ currentTarget: { dataset: { rating: 'like' } } });
  page.deleteCurrentDish();

  assert.deepEqual(rated, { dishId: dishState.dishes[0].id, rating: 'like' });
  assert.equal(modal.confirmText, '确认移除');
  modal.success({ confirm: true });
  assert.deepEqual(deleted, { dishId: dishState.dishes[0].id });
  await new Promise((resolve) => setTimeout(resolve, 500));

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('family invite link skips the join prompt when it is the current family invite', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let modalShown = false;
  let toast = null;
  const store = {
    getFamilySummary() {
      return { syncStatus: 'ready' };
    },
    async getInvite() {
      return { code: 'A7K9Q2', status: 'active' };
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast(options) {
      toast = options;
    },
    showModal() {
      modalShown = true;
    },
  };

  const page = createPageInstance(loadPage('pages/family/family.js'));
  page.refresh = () => {};
  await page.handleInviteLink('A7K9Q2');

  assert.equal(modalShown, false);
  assert.equal(toast.title, '你已在这个家庭中');

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('meal page handles dish-card selection events explicitly', () => {
  const template = fs.readFileSync('pages/meal/meal.wxml', 'utf8');
  const source = fs.readFileSync('pages/meal/meal.js', 'utf8');

  assert.match(template, /bind:dishTap="toggleDish"/);
  assert.match(source, /event\.detail && event\.detail\.dish/);
  assert.match(source, /ensureMeal\(\{ date: this\.data\.date, mealType: 'dinner' \}\)/);
});
