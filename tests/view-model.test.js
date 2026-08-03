const test = require('node:test');
const assert = require('node:assert/strict');

const { addCookingRecord, addDish, createInitialState, createMealSession, submitMealSelection, confirmMealSession } = require('../services/domain');
const {
  buildDishDetailViewModel,
  buildFamilyViewModel,
  buildHomeViewModel,
  buildLibraryViewModel,
  buildMealViewModel,
} = require('../utils/view-model');

const NOW = '2026-08-02T10:00:00.000Z';

test('family view model keeps readable defaults when app state is unavailable', () => {
  const model = buildFamilyViewModel(null, null);

  assert.equal(model.family.name, '我们的家');
  assert.equal(model.family.memberCount, 1);
  assert.equal(model.family.syncStatus, 'error');
  assert.match(model.family.syncText, /本地数据/);
  assert.equal(model.name, '我们的家');
  assert.equal(model.memberName, '我');
});

test('family view model decorates members and reports a ready cloud connection', () => {
  const state = createInitialState({ memberId: 'member-me', memberName: '小明' });
  const summary = {
    id: state.family.id,
    name: state.family.name,
    memberCount: 1,
    members: state.members,
    inviteCode: state.family.id,
    syncStatus: 'ready',
    syncMessage: '',
  };

  const model = buildFamilyViewModel(state, summary);

  assert.equal(model.family.members[0].initial, '小');
  assert.equal(model.family.members[0].isCurrent, true);
  assert.equal(model.family.syncText, '已连接家庭云端，邀请链接可跨设备加入。');
  assert.equal(model.memberName, '小明');
});

test('home view model guides an empty family to record the first dish', () => {
  const model = buildHomeViewModel(createInitialState(), '2026-08-02');

  assert.equal(model.isEmpty, true);
  assert.equal(model.emptyTitle, '记录第一道家里的菜');
  assert.equal(model.primaryAction, 'record');
  assert.equal(model.mealHint, '先记录一道菜，之后就可以从菜品库里选择今天吃什么');
});

test('library view model distinguishes an empty library from an empty search', () => {
  let state = addDish(createInitialState(), { name: '鱼香茄子' }, NOW);

  const noSearch = buildLibraryViewModel(state, { query: '', tag: 'all' });
  const noMatch = buildLibraryViewModel(state, { query: '红烧肉', tag: 'all' });

  assert.equal(noSearch.emptyTitle, '记录第一道家里的菜');
  assert.equal(noMatch.emptyTitle, '没有找到符合条件的菜');
  assert.equal(noMatch.hasSearch, true);
});

test('dish detail view model exposes cooking history in reverse chronological order', () => {
  let state = addDish(createInitialState(), { name: '鱼香茄子' }, NOW);
  const dishId = state.dishes[0].id;
  state = addCookingRecord(state, {
    dishId,
    recordedAt: '2026-08-04T10:00:00.000Z',
    rating: 'like',
    note: '少放一点盐',
  }, NOW);

  const model = buildDishDetailViewModel(state, dishId);

  assert.equal(model.dish.name, '鱼香茄子');
  assert.equal(model.history.length, 2);
  assert.equal(model.history[0].recordDateLabel, '8月4日');
  assert.equal(model.history[0].ratingLabel, '喜欢');
  assert.equal(model.history[0].note, '少放一点盐');
  assert.equal(model.history[1].mealLabel, '未指定餐次');
});

test('home view model shows the open dinner session and library shortcut', () => {
  let state = addDish(createInitialState(), { name: '鱼香茄子' }, NOW);
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const model = buildHomeViewModel(state, '2026-08-02');

  assert.equal(model.isEmpty, false);
  assert.equal(model.mealStatus, 'open');
  assert.equal(model.mealTitle, '今天晚餐吃什么？');
  assert.equal(model.dishCount, 1);
  assert.equal(model.familyName, '我们的家');
});

test('meal view model marks selected dishes and disables editing after confirmation', () => {
  let state = addDish(createInitialState(), { name: '清蒸鱼' }, NOW);
  state = addDish(state, { name: '冬瓜汤' }, NOW);
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  state = submitMealSelection(state, {
    sessionId,
    memberId: state.currentMemberId,
    dishId: state.dishes[0].id,
  }, NOW);
  const openModel = buildMealViewModel(state, '2026-08-02', state.currentMemberId);
  state = confirmMealSession(state, { sessionId, memberId: state.currentMemberId }, NOW);
  const confirmedModel = buildMealViewModel(state, '2026-08-02', state.currentMemberId);

  assert.equal(openModel.dishes[0].selected, true);
  assert.equal(openModel.canEdit, true);
  assert.equal(openModel.selectedDishCount, 1);
  assert.equal(confirmedModel.canEdit, false);
  assert.equal(confirmedModel.confirmed, true);
  assert.equal(confirmedModel.finalDishes.length, 1);
  assert.equal(confirmedModel.finalDishes[0].name, '清蒸鱼');
});
