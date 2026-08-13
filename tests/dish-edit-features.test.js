const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { addDish, createInitialState } = require('../services/domain');

function loadPage() {
  const modulePath = require.resolve('../pages/dish-edit/dish-edit.js');
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
    setData(next, callback) {
      this.data = { ...this.data, ...next };
      if (callback) callback();
    },
  };
}

test('dish detail template uses record-level half-star reviews and selectable category chips', () => {
  const template = fs.readFileSync(path.join(__dirname, '../pages/dish-edit/dish-edit.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../pages/dish-edit/dish-edit.js'), 'utf8');

  assert.match(template, /bindtap="chooseReviewStar"/);
  assert.match(template, /bindtap="submitReview"/);
  assert.match(template, /class="category-chip/);
  assert.match(template, /class="characteristic-chip/);
  assert.match(template, /class="card-surface review-list"/);
  assert.doesNotMatch(template, /tagsDraft/);
  assert.doesNotMatch(template, /ratingOptions/);
  assert.match(script, /rateRecord\(/);
  assert.match(script, /selectedCategory/);
  assert.match(script, /displayImage/);
});

test('detail page submits a half-star review for the selected production record', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let saved = null;
  const store = {
    getState() {
      return {
        currentMemberId: 'member-me',
        members: [{ id: 'member-me', displayName: 'Me' }],
        dishes: [{ id: 'dish-1', name: 'Tomato eggs', status: 'active', coverImage: '' }],
        cookingRecords: [{ id: 'record-1', dishId: 'dish-1', recordedAt: '2026-08-02T10:00:00.000Z' }],
        recordReviews: [],
      };
    },
    rateRecord(input) {
      saved = input;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showToast() {},
  };

  const page = createPageInstance(loadPage(), {
    isExisting: true,
    isEditingProfile: false,
    isArchived: false,
    dishId: 'dish-1',
    history: [{ id: 'record-1', canReview: true, myReview: null }],
  });
  page.startReview({ currentTarget: { dataset: { recordId: 'record-1' } } });
  page.chooseReviewStar({ currentTarget: { dataset: { stars: '4.5' } } });
  page.onReviewTextInput({ detail: { value: '这次火候很好' } });
  page.submitReview();

  assert.deepEqual(saved, {
    dishId: 'dish-1',
    recordId: 'record-1',
    stars: 4.5,
    text: '这次火候很好',
  });
  assert.equal(page.data.reviewingRecordId, '');

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('saving an appended record clears only the current record photo after upload', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let added = null;
  const store = {
    uploadImage: async (filePath) => `cloud://${filePath}`,
    addCookingRecord(input) {
      added = input;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  global.wx = {
    showLoading() {},
    hideLoading() {},
    showToast() {},
    navigateBack() {},
  };

  const page = createPageInstance(loadPage(), {
    isExisting: true,
    isEditingProfile: false,
    isArchived: false,
    dishId: 'dish-1',
    nameDraft: 'Tomato eggs',
    recordDate: '2026-08-08',
    mealType: 'dinner',
    image: 'local-photo.jpg',
    displayImage: 'local-photo.jpg',
  });
  page.startRecordEntry();
  const reservedRecordId = page.data.recordIdDraft;
  page.startRecordEntry();
  assert.match(reservedRecordId, /^record-/);
  assert.equal(page.data.recordIdDraft, reservedRecordId);
  await page.save();

  assert.equal(added.id, reservedRecordId);
  assert.equal(added.image, 'cloud://local-photo.jpg');
  assert.equal(page.data.image, '');
  assert.equal(page.data.displayImage, '');
  assert.equal(page.data.recordIdDraft, '');
  await new Promise((resolve) => setTimeout(resolve, 500));

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('existing dish details open and cancel the append-record form without keeping drafts', () => {
  const page = createPageInstance(loadPage(), {
    isExisting: true,
    isArchived: false,
    recordFormVisible: false,
    image: '',
    displayImage: '',
    mealType: '',
    mealTypeLabel: '未指定餐次',
    customMealType: '',
    customMealTypeDraft: '',
  });

  page.startRecordEntry();
  assert.equal(page.data.recordFormVisible, true);
  assert.match(page.data.recordIdDraft, /^record-/);
  const reservedRecordId = page.data.recordIdDraft;
  page.startRecordEntry();
  assert.equal(page.data.recordIdDraft, reservedRecordId);

  page.setData({
    image: 'wxfile://draft.jpg',
    displayImage: 'wxfile://draft.jpg',
    mealType: 'custom',
    mealTypeLabel: '其他餐次',
    customMealType: '夜宵',
    customMealTypeDraft: '夜宵',
  });
  page.cancelRecordEntry();

  assert.deepEqual({
    recordFormVisible: page.data.recordFormVisible,
    recordIdDraft: page.data.recordIdDraft,
    image: page.data.image,
    displayImage: page.data.displayImage,
    mealType: page.data.mealType,
    mealTypeLabel: page.data.mealTypeLabel,
    customMealType: page.data.customMealType,
    customMealTypeDraft: page.data.customMealTypeDraft,
  }, {
    recordFormVisible: false,
    recordIdDraft: '',
    image: '',
    displayImage: '',
    mealType: '',
    mealTypeLabel: '未指定餐次',
    customMealType: '',
    customMealTypeDraft: '',
  });
});

test('new dish pages ignore append-record form controls', () => {
  const page = createPageInstance(loadPage(), {
    isExisting: false,
    recordFormVisible: false,
  });

  page.startRecordEntry();
  assert.equal(page.data.recordFormVisible, false);
});

test('category and characteristic tag selection is chip based', () => {
  const state = addDish(createInitialState(), { name: 'Tomato eggs' });
  const page = createPageInstance(loadPage(), {
    selectedCategory: '',
    selectedTags: [],
    isExisting: false,
    dishId: '',
  });
  page.chooseCategory({ currentTarget: { dataset: { category: '荤菜' } } });
  page.toggleTag({ currentTarget: { dataset: { tag: '家常' } } });
  page.toggleTag({ currentTarget: { dataset: { tag: '下饭' } } });
  page.toggleTag({ currentTarget: { dataset: { tag: '家常' } } });

  assert.equal(state.dishes[0].name, 'Tomato eggs');
  assert.equal(page.data.selectedCategory, '荤菜');
  assert.deepEqual(page.data.selectedTags, ['下饭']);
});
