const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

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

function createInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ...data },
    setData(next) {
      this.data = { ...this.data, ...next };
    },
  };
}

function createShareStore() {
  const state = {
    family: { id: 'family-very-long-internal-id' },
    currentMemberId: 'member-1',
    dishes: [{ id: 'dish-1', name: 'Dish' }],
  };
  return {
    getState() {
      return state;
    },
    getFamilySummary() {
      return { inviteCode: 'A7K9Q2', syncStatus: 'ready' };
    },
    ensureMeal() {
      return { id: 'meal-1' };
    },
  };
}

test('index share path uses inviteCode instead of familyId', () => {
  const originalGetApp = global.getApp;
  const store = createShareStore();
  global.getApp = () => ({ globalData: { store } });
  const page = createInstance(loadPage('pages/index/index.js'));

  const share = page.onShareAppMessage();

  assert.equal(share.path.includes('familyId='), false);
  assert.equal(share.path.includes('inviteCode=A7K9Q2'), true);
  global.getApp = originalGetApp;
});

test('meal share path uses inviteCode and preserves meal context', () => {
  const originalGetApp = global.getApp;
  const store = createShareStore();
  global.getApp = () => ({ globalData: { store } });
  const page = createInstance(loadPage('pages/meal/meal.js'), {
    date: '2026-08-04',
    model: { meal: { id: 'meal-1', familyId: 'family-very-long-internal-id' } },
  });

  const share = page.onShareAppMessage();

  assert.equal(share.path.includes('familyId='), false);
  assert.equal(share.path.includes('inviteCode=A7K9Q2'), true);
  assert.equal(share.path.includes('sessionId=meal-1'), true);
  global.getApp = originalGetApp;
});

test('index and dishes pages expose lifecycle subscription hooks', () => {
  const indexSource = fs.readFileSync('pages/index/index.js', 'utf8');
  const dishesSource = fs.readFileSync('pages/dishes/dishes.js', 'utf8');

  assert.equal(indexSource.includes('subscribe('), true);
  assert.equal(indexSource.includes('onUnload'), true);
  assert.equal(dishesSource.includes('subscribe('), true);
  assert.equal(dishesSource.includes('onUnload'), true);
});

test('meal join flow uses invite code instead of direct family loading', () => {
  const source = fs.readFileSync('pages/meal/meal.js', 'utf8');

  assert.equal(source.includes('joinFamilyByInvite'), true);
  assert.equal(source.includes('store.joinFamily('), false);
  assert.equal(source.includes('familyId=${familyId}'), false);
});
