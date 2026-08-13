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

function loadComponent(relativePath) {
  const modulePath = require.resolve(path.join(root, relativePath));
  const originalComponent = global.Component;
  let definition = null;
  global.Component = (config) => {
    definition = config;
  };
  delete require.cache[modulePath];
  require(modulePath);
  global.Component = originalComponent;
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

function createComponentInstance(definition, data = {}) {
  return {
    ...definition.methods,
    data: { ...definition.data, ...data },
    setData(next) {
      Object.entries(next).forEach(([key, value]) => {
        const segments = key.split('.');
        if (segments.length === 1) {
          this.data[key] = value;
          return;
        }
        const rootKey = segments.shift();
        const target = { ...(this.data[rootKey] || {}) };
        let cursor = target;
        while (segments.length > 1) {
          const segment = segments.shift();
          cursor[segment] = { ...(cursor[segment] || {}) };
          cursor = cursor[segment];
        }
        cursor[segments[0]] = value;
        this.data[rootKey] = target;
      });
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
  assert.match(template, /wx:if="\{\{!isArchived && !editProfileVisible && \(!isExisting \|\| recordFormVisible\)\}\}" class="card-surface record-fields-card"/);
  assert.match(template, /wx:if="\{\{item\.displayImage\}\}"[^>]*src="\{\{item\.displayImage\}\}"/);
  assert.match(template, /wx:if="\{\{item\.displayRecordImage\}\}"[^>]*[\s\S]*src="\{\{item\.displayRecordImage\}\}"/);
  assert.doesNotMatch(template, /src="\{\{item\.(?:image|recordImage)\}\}"/);
});

test('dish detail display photos are wired to full-screen preview', () => {
  const template = read('pages/dish-edit/dish-edit.wxml');

  assert.match(template, /class="dish-hero-image"[^>]*data-src="\{\{dishCover\}\}"[^>]*bindtap="previewImage"/);
  assert.match(template, /class="history-image"[^>]*data-src="\{\{item\.displayImage\}\}"[^>]*bindtap="previewImage"/);
  assert.match(template, /class="review-detail-image"[^>]*data-src="\{\{item\.displayRecordImage\}\}"[^>]*bindtap="previewImage"/);
});

test('profile editor action buttons share a centered layout', () => {
  const styles = read('pages/dish-edit/dish-edit.wxss');
  const match = styles.match(/\.edit-profile-actions button\s*\{([^}]*)\}/);

  assert.ok(match, 'profile editor action button rule should exist');
  const rule = match[1];
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /align-items:\s*center/);
  assert.match(rule, /justify-content:\s*center/);
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.match(rule, /border-radius:\s*16rpx/);
  assert.match(rule, /line-height:\s*1/);
});

test('existing dish details gate the append-record form behind one button', () => {
  const template = read('pages/dish-edit/dish-edit.wxml');

  assert.match(template, /wx:if="\{\{isExisting && !isArchived && !editProfileVisible && !recordFormVisible\}\}" class="card-surface record-entry-card"/);
  assert.match(template, /class="primary-button" bindtap="startRecordEntry">追加新记录<\/button>/);
  assert.match(template, /wx:if="\{\{!isArchived && !editProfileVisible && \(!isExisting \|\| recordFormVisible\)\}\}" class="card-surface record-fields-card"/);
  assert.match(template, /wx:if="\{\{isExisting && recordFormVisible\}\}" class="secondary-button" bindtap="cancelRecordEntry">取消<\/button>/);
  assert.match(template, /\{\{isExisting \? '保存这次记录' : '保存这道菜'\}\}/);
});

test('dish detail recipe card stays separate from reviews, photos, and cooking history', () => {
  const template = read('pages/dish-edit/dish-edit.wxml');
  const script = read('pages/dish-edit/dish-edit.js');

  assert.match(template, /class="card-surface family-recipe-card"/);
  assert.match(template, /recipeLoading/);
  assert.match(template, /recipeError/);
  assert.match(template, /bindtap="openFamilyRecipe"/);
  assert.match(script, /refreshRecipeSummary\s*\(/);
  assert.match(script, /recipeSummary/);
  assert.match(script, /recipeLoading/);
  assert.match(script, /recipeError/);
});

test('cloud image helper delegates CloudBase file IDs to the Store without changing local URLs', async () => {
  const { resolveCloudFileUrls } = require('../utils/cloud-image');
  const store = {
    async resolveImageUrls(fileIds) {
      assert.deepEqual(fileIds, ['cloud://family/photo-1.jpg']);
      return new Map([['cloud://family/photo-1.jpg', 'https://cdn.example/photo-1.jpg']]);
    },
  };

  const urls = await resolveCloudFileUrls([
    'cloud://family/photo-1.jpg',
    'https://example.com/already-public.jpg',
    'cloud://family/photo-1.jpg',
  ], store);

  assert.equal(urls.get('cloud://family/photo-1.jpg'), 'https://cdn.example/photo-1.jpg');
  assert.equal(urls.has('https://example.com/already-public.jpg'), false);
});

test('dish card receives a Store-resolved HTTPS image without a client cloud API', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const fileId = 'cloud://env/family-meals/family-1/photo.jpg';
  global.getApp = () => ({
    globalData: {
      store: {
        async resolveImageUrls(fileIds) {
          assert.deepEqual(fileIds, [fileId]);
          return new Map([[fileId, 'https://cdn.example/photo.jpg']]);
        },
      },
    },
  });
  global.wx = undefined;
  const card = createComponentInstance(loadComponent('components/dish-card/dish-card.js'));

  card.updateDisplayDish({ id: 'dish-1', name: 'Tomato eggs', coverImage: fileId });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.data.displayDish.coverImage, 'https://cdn.example/photo.jpg');
  assert.equal(card.data.displayDish.hasImage, true);
  global.getApp = originalGetApp;
  global.wx = originalWx;
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
