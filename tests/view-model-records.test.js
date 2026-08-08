const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addCookingRecord,
  addDish,
  addMember,
  createInitialState,
  deleteDish,
  getDishSummary,
  upsertRecordReview,
} = require('../services/domain');
const { buildDishDetailViewModel, buildTrashViewModel } = require('../utils/view-model');
const { formatStars } = require('../utils/format');

const NOW = '2026-08-02T10:00:00.000Z';

test('dish detail view model aggregates record reviews and links each review to its cooking record', () => {
  let state = createInitialState({ memberId: 'member-me', memberName: 'Me' });
  state = addMember(state, { id: 'member-dad', displayName: 'Dad' });
  state = addDish(state, { name: 'Tomato eggs', category: '荤菜', tags: ['家常'] }, NOW);
  const dishId = state.dishes[0].id;
  state = addCookingRecord(state, {
    dishId,
    recordedAt: '2026-08-04T10:00:00.000Z',
    mealType: 'dinner',
    image: 'record.jpg',
  }, NOW);
  const firstRecordId = state.cookingRecords[0].id;
  const secondRecordId = state.cookingRecords[1].id;
  state = upsertRecordReview(state, {
    dishId,
    recordId: firstRecordId,
    memberId: 'member-me',
    stars: 4.5,
    text: '这次很好吃',
  }, '2026-08-04T12:00:00.000Z');
  state = upsertRecordReview(state, {
    dishId,
    recordId: secondRecordId,
    memberId: 'member-dad',
    stars: 3.5,
    text: '可以再少放一点盐',
  }, '2026-08-05T12:00:00.000Z');

  const model = buildDishDetailViewModel(state, dishId, 'member-me');

  assert.equal(model.dish.category, '荤菜');
  assert.equal(model.dish.reviewCount, 2);
  assert.equal(model.dish.averageStars, 4);
  assert.equal(model.reviewStats.averageLabel, '4');
  assert.equal(model.reviewStats.distribution['4.5'], 1);
  assert.equal(model.reviews.length, 2);
  assert.equal(model.reviews[0].displayName, 'Dad');
  assert.equal(model.reviews[0].recordId, secondRecordId);
  assert.equal(model.reviews[0].recordDateLabel, '8月4日');
  assert.equal(model.history[0].reviewCount, 1);
  assert.equal(model.history[1].reviewCount, 1);
  assert.equal(model.history[1].myReview.text, '这次很好吃');
  assert.equal(formatStars(4.5), '4.5');
});

test('trash view model lists deleted dishes with retained history and review counts', () => {
  let state = createInitialState();
  state = addDish(state, { name: 'Archived dish' }, NOW);
  const dishId = state.dishes[0].id;
  state = upsertRecordReview(state, {
    dishId,
    recordId: state.cookingRecords[0].id,
    stars: 5,
  }, NOW);
  state = deleteDish(state, { dishId }, '2026-08-03T10:00:00.000Z');

  const model = buildTrashViewModel(state);

  assert.equal(model.count, 1);
  assert.equal(model.dishes[0].name, 'Archived dish');
  assert.equal(model.dishes[0].recordCount, 1);
  assert.equal(model.dishes[0].reviewCount, 1);
  assert.equal(model.dishes[0].canRestore, true);
});

test('dish summary falls back to the latest portable cooking-record image', () => {
  let state = createInitialState();
  state = addDish(state, { name: 'Family dish' }, NOW);
  const dishId = state.dishes[0].id;
  state = addCookingRecord(state, {
    dishId,
    recordedAt: '2026-08-04T10:00:00.000Z',
    image: 'cloud://family-meals/family-1/latest.jpg',
  }, NOW);
  state.dishes[0].coverImage = '';

  const summary = getDishSummary(state, dishId);

  assert.equal(summary.coverImage, 'cloud://family-meals/family-1/latest.jpg');
  assert.equal(summary.hasImage, true);
});
