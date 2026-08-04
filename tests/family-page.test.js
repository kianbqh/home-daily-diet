const test = require('node:test');
const assert = require('node:assert/strict');

function loadFamilyPage() {
  const modulePath = require.resolve('../pages/family/family.js');
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

test('family page renders safe defaults when the app store is unavailable', () => {
  const originalGetApp = global.getApp;
  global.getApp = () => ({ globalData: { store: null } });
  const page = createPageInstance(loadFamilyPage());

  assert.doesNotThrow(() => page.refresh());
  assert.equal(page.data.family.name, '我们的家');
  assert.equal(page.data.family.memberCount, 1);

  global.getApp = originalGetApp;
});

test('family page reports initialization instead of throwing when saving without a store', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let toast = null;
  global.getApp = () => ({ globalData: { store: null } });
  global.wx = {
    showToast(options) {
      toast = options;
    },
  };
  const page = createPageInstance(loadFamilyPage(), { name: '周末饭桌' });

  assert.doesNotThrow(() => page.saveName());
  assert.match(toast.title, /初始化/);

  global.getApp = originalGetApp;
  global.wx = originalWx;
});

test('family inputs keep in-progress text when a store refresh arrives', () => {
  const originalGetApp = global.getApp;
  const refreshListeners = [];
  const state = { currentMemberId: 'member-1' };
  const summary = {
    id: 'family-1',
    name: '我们的家',
    memberCount: 1,
    members: [{ id: 'member-1', displayName: '我' }],
    inviteCode: 'family-1',
    syncStatus: 'ready',
  };
  const store = {
    subscribe(listener) {
      refreshListeners.push(listener);
      return () => {};
    },
    getState() {
      return state;
    },
    getFamilySummary() {
      return summary;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  const page = createPageInstance(loadFamilyPage());

  page.onLoad();
  page.onNameInput({ detail: { value: '周末饭桌' } });
  page.onMemberNameInput({ detail: { value: '小明' } });
  refreshListeners[0]();

  assert.equal(page.data.name, '周末饭桌');
  assert.equal(page.data.memberName, '小明');
  global.getApp = originalGetApp;
});

test('family inputs keep the latest native input value when a stale refresh races the input event', () => {
  const originalGetApp = global.getApp;
  const refreshListeners = [];
  const state = { currentMemberId: 'member-1' };
  const summary = {
    id: 'family-1',
    name: '旧家庭名',
    memberCount: 1,
    members: [{ id: 'member-1', displayName: '我' }],
    inviteCode: 'A7K9Q2',
    syncStatus: 'ready',
  };
  const store = {
    subscribe(listener) {
      refreshListeners.push(listener);
      return () => {};
    },
    getState() {
      return state;
    },
    getFamilySummary() {
      return summary;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  const page = createPageInstance(loadFamilyPage());

  page.onLoad();
  page.onNameInput({ detail: { value: '我也' } });
  page.onMemberNameInput({ detail: { value: '小明' } });

  // Simulate a stale native setData completion arriving after the input event.
  page.data.name = '旧家庭名';
  page.data.memberName = '我';
  refreshListeners[0]();

  assert.equal(page.data.name, '我也');
  assert.equal(page.data.memberName, '小明');
  global.getApp = originalGetApp;
});

test('family inputs do not rebind the native value while editing', () => {
  const originalGetApp = global.getApp;
  const refreshListeners = [];
  const state = { currentMemberId: 'member-1' };
  const summary = {
    id: 'family-1',
    name: '旧家庭名',
    memberCount: 1,
    members: [{ id: 'member-1', displayName: '我' }],
    inviteCode: '',
    syncStatus: 'ready',
  };
  const store = {
    subscribe(listener) {
      refreshListeners.push(listener);
      return () => {};
    },
    getState() {
      return state;
    },
    getFamilySummary() {
      return summary;
    },
  };
  global.getApp = () => ({ globalData: { store } });
  const page = createPageInstance(loadFamilyPage());
  let setDataCalls = 0;
  const originalSetData = page.setData;
  page.setData = (next) => {
    setDataCalls += 1;
    originalSetData.call(page, next);
  };

  page.onLoad();
  page.refresh();
  setDataCalls = 0;
  page.onNameFocus();
  page.onNameInput({ detail: { value: '新家庭名' } });
  page.onMemberNameFocus();
  page.onMemberNameInput({ detail: { value: '小明' } });

  assert.equal(setDataCalls, 2);
  assert.equal(page.nameDraft, '新家庭名');
  assert.equal(page.memberNameDraft, '小明');
  assert.equal(page.data.nameDraft, '新家庭名');
  assert.equal(page.data.memberNameDraft, '小明');

  refreshListeners[0]();

  assert.equal(page.data.nameDraft, '新家庭名');
  assert.equal(page.data.memberNameDraft, '小明');
  assert.equal(page.nameDraft, '新家庭名');
  assert.equal(page.memberNameDraft, '小明');
  global.getApp = originalGetApp;
});
