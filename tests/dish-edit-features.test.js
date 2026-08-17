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
  const calls = [];
  const store = {
    getState: () => ({ family: { id: 'family-internal-1' } }),
    uploadImage: async (filePath) => {
      calls.push('upload');
      return `cloud://${filePath}`;
    },
    addCookingRecord(input) {
      calls.push('add');
      added = input;
    },
  };
  const recipeAssistant = {
    async attachRecordWorkspace(payload) {
      calls.push('attach');
      assert.deepEqual(payload, {
        familyId: 'family-internal-1', dishId: 'dish-1', recordId: added.id,
      });
    },
  };
  global.getApp = () => ({ globalData: { store, recipeAssistant } });
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
    recordingFamilyKey: 'family-internal-1',
  });
  page.selectComponent = () => ({ async clearLocalClips() { calls.push('clear-local'); } });
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
  assert.deepEqual(calls, ['upload', 'add', 'attach', 'clear-local']);
  await new Promise((resolve) => setTimeout(resolve, 500));

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('existing dish details cancel only after explicit confirmation and clear cloud before local clips', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  let modal = null;
  global.getApp = () => ({
    globalData: {
      store: { getState: () => ({ family: { id: 'family-internal-1' } }) },
      recipeAssistant: {
        async cancelRecordWorkspace(payload) {
          calls.push({ action: 'cancel-cloud', payload });
        },
      },
    },
  });
  global.wx = {
    showModal(options) {
      modal = options;
      options.success({ confirm: true, cancel: false });
    },
    showToast() {},
  };
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
    dishId: 'dish-1',
    recordingFamilyKey: 'family-internal-1',
  });
  page.selectComponent = () => ({ async clearLocalClips() { calls.push({ action: 'clear-local' }); } });

  page.startRecordEntry();
  assert.equal(page.data.recordFormVisible, true);
  assert.match(page.data.recordIdDraft, /^record-/);
  const reservedRecordId = page.data.recordIdDraft;
  page.startRecordEntry();
  assert.equal(page.data.recordIdDraft, reservedRecordId);

  page.setData({ recordWorkspaceBusy: true });
  await page.cancelRecordEntry();
  assert.equal(modal, null, 'save in progress must not open a competing cancellation');
  assert.deepEqual(calls, []);
  assert.equal(page.data.recordIdDraft, reservedRecordId);
  page.setData({ recordWorkspaceBusy: false });

  page.setData({
    image: 'wxfile://draft.jpg',
    displayImage: 'wxfile://draft.jpg',
    mealType: 'custom',
    mealTypeLabel: '其他餐次',
    customMealType: '夜宵',
    customMealTypeDraft: '夜宵',
  });
  await page.cancelRecordEntry();

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
  assert.equal(modal.content, '本次未保存的录音和文字会被删除');
  assert.deepEqual(calls, [
    {
      action: 'cancel-cloud',
      payload: { familyId: 'family-internal-1', dishId: 'dish-1', recordId: reservedRecordId },
    },
    { action: 'clear-local' },
  ]);
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('append record entry recovers the newest local workspace before generating an id', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let cancelled = false;
  global.getApp = () => ({
    globalData: {
      store: { getState: () => ({ family: { id: 'family-internal-1' } }) },
      recipeAssistant: { cancelRecordWorkspace() { cancelled = true; } },
    },
  });
  global.wx = {};
  const page = createPageInstance(loadPage(), {
    isExisting: true,
    isArchived: false,
    editProfileVisible: false,
    dishId: 'dish-1',
    recordingFamilyKey: 'family-internal-1',
    recordIdDraft: '',
  });
  const lookups = [];
  page.selectComponent = () => ({
    findWorkspace(input) {
      lookups.push(input);
      return { recordId: 'record-recovered', workspaceKey: 'family-internal-1|dish-1|record-recovered' };
    },
  });

  page.startRecordEntry();
  page.onUnload();

  assert.deepEqual(lookups, [{ familyId: 'family-internal-1', dishId: 'dish-1' }]);
  assert.equal(page.data.recordIdDraft, 'record-recovered');
  assert.equal(cancelled, false, 'abnormal page exit must leave the workspace recoverable');
  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('a failed local cooking-record save never attaches the recording workspace', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  let page;
  let busyDuringUpload = null;
  const store = {
    getState: () => ({ family: { id: 'family-internal-1' } }),
    async uploadImage(filePath) {
      calls.push('upload');
      busyDuringUpload = page.data.recordWorkspaceBusy;
      return `cloud://${filePath}`;
    },
    addCookingRecord() { calls.push('add'); throw new Error('local save failed'); },
  };
  global.getApp = () => ({
    globalData: {
      store,
      recipeAssistant: { async attachRecordWorkspace() { calls.push('attach'); } },
    },
  });
  global.wx = { showLoading() {}, hideLoading() {}, showToast() {} };
  try {
    page = createPageInstance(loadPage(), {
      isExisting: true,
      editProfileVisible: false,
      isArchived: false,
      recordFormVisible: true,
      dishId: 'dish-1',
      nameDraft: 'Tomato eggs',
      recordIdDraft: 'record-stable-failure',
      recordDate: '2026-08-08',
      mealType: 'dinner',
      image: 'local-photo.jpg',
      displayImage: 'local-photo.jpg',
      recordingFamilyKey: 'family-internal-1',
    });

    await page.save();

    assert.deepEqual(calls, ['upload', 'add']);
    assert.equal(busyDuringUpload, true, 'record save must lock before photo upload starts');
    assert.equal(page.data.recordIdDraft, 'record-stable-failure');
    assert.equal(page.data.recordFormVisible, true);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
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
