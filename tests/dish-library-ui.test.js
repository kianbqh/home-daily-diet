const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadPage(relativePath) {
  const modulePath = require.resolve(path.join(root, relativePath));
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

test('homepage recent dish cards are wired to the dish detail page', () => {
  const template = read('pages/index/index.wxml');
  const script = read('pages/index/index.js');

  assert.match(template, /<dish-card[\s\S]*bind:dishTap="onRecentDishTap"/);
  assert.match(script, /onRecentDishTap\s*\(event\)/);

  const originalWx = global.wx;
  let navigation = null;
  global.wx = {
    navigateTo(options) {
      navigation = options;
    },
  };
  const page = loadPage('pages/index/index.js');
  page.onRecentDishTap({ detail: { dish: { id: 'dish-recent-1' } } });
  assert.deepEqual(navigation, {
    url: '/pages/dish-edit/dish-edit?dishId=dish-recent-1',
  });
  global.wx = originalWx;
});

test('dish library header keeps the title on one line and actions inside the page', () => {
  const template = read('pages/dishes/dishes.wxml');
  const styles = read('pages/dishes/dishes.wxss');

  assert.match(template, /class="page-header"/);
  assert.match(styles, /\.dishes-page\s+\.page-header\s*\{[\s\S]*display:\s*block/);
  assert.match(styles, /\.dishes-page\s+\.page-title\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(styles, /\.library-header-actions\s*\{[\s\S]*width:\s*100%/);
  assert.match(styles, /\.library-header-actions\s+button\s*\{[\s\S]*flex:\s*1/);
});

test('dish detail uses five complete visual stars and a modal profile editor', () => {
  const template = read('pages/dish-edit/dish-edit.wxml');
  const styles = read('pages/dish-edit/dish-edit.wxss');
  const script = read('pages/dish-edit/dish-edit.js');

  assert.match(template, /class="star-base"/);
  assert.match(template, /class="star-hit-area star-left"/);
  assert.match(template, /class="star-hit-area star-right"/);
  assert.doesNotMatch(template, /点击半颗或一颗星/);
  assert.match(template, /class="edit-profile-mask"/);
  assert.match(template, /class="edit-profile-card"/);
  assert.match(script, /editProfileVisible/);
  assert.match(script, /cancelProfileEdit\s*\(/);
  assert.match(styles, /\.detail-actions\s+button\s*\{[\s\S]*height:\s*84rpx/);
  assert.match(template, /wx:if="\{\{!isArchived && !editProfileVisible\}\}" class="card-surface record-fields-card"/);
});

test('cloud image helper resolves CloudBase file IDs without changing local URLs', async () => {
  const { resolveCloudFileUrls } = require('../utils/cloud-image');
  const cloudApi = {
    getTempFileURL({ fileList, success }) {
      success({
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: `https://cdn.example/${encodeURIComponent(fileID)}`,
        })),
      });
    },
  };

  const urls = await resolveCloudFileUrls([
    'cloud://family/photo-1.jpg',
    'https://example.com/already-public.jpg',
    'cloud://family/photo-1.jpg',
  ], cloudApi);

  assert.equal(urls.get('cloud://family/photo-1.jpg'), 'https://cdn.example/cloud%3A%2F%2Ffamily%2Fphoto-1.jpg');
  assert.equal(urls.has('https://example.com/already-public.jpg'), false);
});

test('profile edit opens as an overlay and saves without navigating away', async () => {
  const { addDish, createInitialState, updateDishProfile } = require('../services/domain');
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let state = addDish(createInitialState(), { name: '番茄炒蛋' }, '2026-08-08T10:00:00.000Z');
  const dishId = state.dishes[0].id;
  const store = {
    getState() {
      return state;
    },
    updateDish(input) {
      state = updateDishProfile(state, input, '2026-08-08T11:00:00.000Z');
      return state;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = { showToast() {} };

  const page = createPageInstance(loadPage('pages/dish-edit/dish-edit.js'), {
    isExisting: true,
    isEditingProfile: false,
    editProfileVisible: false,
    canEditProfile: true,
    dishId,
    name: '番茄炒蛋',
    nameDraft: '番茄炒蛋',
    image: '',
  });
  page.startProfileEdit();
  assert.equal(page.data.editProfileVisible, true);
  page.onNameInput({ detail: { value: '少油番茄炒蛋' } });
  await page.save();

  assert.equal(state.dishes[0].name, '少油番茄炒蛋');
  assert.equal(page.data.editProfileVisible, false);
  assert.equal(page.data.isEditingProfile, false);

  global.getApp = originalGetApp;
  global.wx = originalWx;
});
