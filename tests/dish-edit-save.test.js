const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { addCookingRecord, addDish, createInitialState } = require('../services/domain');

function loadDishEditPage() {
  const modulePath = require.resolve('../pages/dish-edit/dish-edit.js');
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

test('saves a dish without its photo when image upload fails', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let saved = null;
  const store = {
    uploadImage() {
      return Promise.reject(new Error('storage unavailable'));
    },
    findDishByName() {
      return null;
    },
    findSimilarDishes() {
      return [];
    },
    addDish(payload) {
      saved = payload;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showLoading() {},
    hideLoading() {},
    showToast() {},
    showActionSheet() {},
  };
  const page = createPageInstance(loadDishEditPage(), {
    name: 'Tomato eggs',
    image: 'wxfile://photo',
    tags: '',
    recordDate: '2026-08-04',
    mealType: 'dinner',
    isExisting: false,
    isEditingProfile: false,
  });

  await page.save();

  assert.equal(saved.name, 'Tomato eggs');
  assert.equal(saved.image, '');
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('dish record page does not render rating or note sections', () => {
  const template = fs.readFileSync('pages/dish-edit/dish-edit.wxml', 'utf8');

  assert.equal(template.includes('ratingLabel'), false);
  assert.equal(template.includes('history-note'), false);
  assert.equal(template.includes('吃起来怎么样'), false);
  assert.equal(template.includes('备注'), false);
});

test('an image-less cooking record keeps the existing dish cover', () => {
  let state = addDish(createInitialState(), {
    name: 'Tomato eggs',
    image: 'cloud://cover-image',
  }, '2026-08-04T10:00:00.000Z');
  const dishId = state.dishes[0].id;

  state = addCookingRecord(state, {
    dishId,
    image: '',
  }, '2026-08-04T11:00:00.000Z');

  assert.equal(state.dishes[0].coverImage, 'cloud://cover-image');
});
