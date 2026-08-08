const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addCookingRecord,
  addDish,
  cancelMealSelection,
  confirmMealSession,
  createInitialState,
  createMealSession,
  deleteDish,
  getDishSummary,
  addMember,
  updateMemberProfile,
  updateFamilyProfile,
  getFamilySummary,
  getSelectedSubmissions,
  findDishByName,
  findSimilarDishes,
  listDishSummaries,
  listDeletedDishSummaries,
  purgeDish,
  rateDish,
  restoreDish,
  submitMealSelection,
  upsertRecordReview,
  updateDishProfile,
  updateMealSelection,
} = require('../services/domain');

const NOW = '2026-08-02T10:00:00.000Z';

function stateWithDish(options = {}) {
  const state = createInitialState({
    familyId: 'family-test',
    memberId: 'member-test',
    memberName: '测试成员',
  });
  return addDish(state, { name: options.name || '番茄炒蛋', image: options.image || '' }, NOW);
}

test('rejects a dish with a blank name', () => {
  const state = createInitialState();

  assert.throws(
    () => addDish(state, { name: '   ' }, NOW),
    /菜名不能为空/
  );
});

test('allows a dish without an image and creates its first cooking record', () => {
  const state = addDish(createInitialState(), { name: '清炒西兰花' }, NOW);

  assert.equal(state.dishes.length, 1);
  assert.equal(state.dishes[0].name, '清炒西兰花');
  assert.equal(state.dishes[0].coverImage, '');
  assert.equal(state.cookingRecords.length, 1);
  assert.equal(state.cookingRecords[0].image, '');
});

test('can choose a record date independently from the save timestamp', () => {
  const state = addDish(createInitialState(), {
    name: '家常豆腐',
    recordedAt: '2026-07-31T12:00:00.000Z',
  }, NOW);

  assert.equal(state.dishes[0].createdAt, NOW);
  assert.equal(state.cookingRecords[0].recordedAt, '2026-07-31T12:00:00.000Z');
});

test('appends a later cooking record instead of replacing history', () => {
  const first = stateWithDish({ image: 'first.jpg' });
  const dishId = first.dishes[0].id;
  const second = addCookingRecord(first, {
    dishId,
    image: 'second.jpg',
    rating: 'like',
    note: '这次少放了一点盐',
  }, '2026-08-03T10:00:00.000Z');

  assert.equal(second.cookingRecords.length, 2);
  assert.deepEqual(
    second.cookingRecords.map((record) => record.image),
    ['first.jpg', 'second.jpg']
  );
  assert.equal(second.dishes[0].coverImage, 'second.jpg');
});

test('updates dish profile without changing its cooking history', () => {
  const first = stateWithDish({ name: '番茄炒蛋' });
  const dishId = first.dishes[0].id;
  const updated = updateDishProfile(first, {
    dishId,
    name: '少油番茄炒蛋',
    tags: ['家常', '下饭'],
  });

  assert.equal(updated.dishes[0].name, '少油番茄炒蛋');
  assert.deepEqual(updated.dishes[0].tags, ['家常', '下饭']);
  assert.equal(updated.cookingRecords.length, 1);
  assert.equal(updated.cookingRecords[0].dishId, dishId);
  assert.equal(findDishByName(updated, '少油番茄炒蛋').id, dishId);
});

test('finds similar dish names without automatically merging them', () => {
  const state = stateWithDish({ name: '番茄炒蛋' });

  const matches = findSimilarDishes(state, '少油番茄炒蛋');

  assert.deepEqual(matches.map((dish) => dish.name), ['番茄炒蛋']);
  assert.equal(state.dishes.length, 1);
});

test('does not allow a meal submission for a dish that is not in the dish library', () => {
  const empty = createInitialState();
  const withMeal = createMealSession(empty, { date: '2026-08-02', mealType: 'dinner' }, NOW);

  assert.throws(
    () => submitMealSelection(withMeal, {
      sessionId: withMeal.mealSessions[0].id,
      memberId: 'member-test',
      dishId: 'missing-dish',
    }, NOW),
    /只能选择菜品库中的菜品/
  );
});

test('allows a member to change a dinner selection before confirmation', () => {
  let state = stateWithDish({ name: '番茄炒蛋' });
  state = addDish(state, { name: '紫菜蛋花汤' }, NOW);
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  const firstDish = state.dishes[0].id;
  const secondDish = state.dishes[1].id;

  state = submitMealSelection(state, { sessionId, memberId: 'member-test', dishId: firstDish }, NOW);
  state = updateMealSelection(state, { sessionId, memberId: 'member-test', dishId: secondDish }, NOW);

  assert.deepEqual(getSelectedSubmissions(state, sessionId).map((item) => item.dishId), [secondDish]);
});

test('locks the meal session after confirmation', () => {
  let state = stateWithDish();
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  const dishId = state.dishes[0].id;
  state = submitMealSelection(state, { sessionId, memberId: 'member-test', dishId }, NOW);
  state = confirmMealSession(state, { sessionId, memberId: 'member-test' }, NOW);

  assert.equal(state.mealSessions[0].status, 'confirmed');
  assert.deepEqual(state.mealSessions[0].finalDishIds, [dishId]);
  assert.throws(
    () => updateMealSelection(state, { sessionId, memberId: 'member-test', dishId }, NOW),
    /菜单已经确认/
  );
});

test('lets the cooking member confirm a subset of the submitted candidates', () => {
  let state = stateWithDish({ name: '番茄炒蛋' });
  state = addDish(state, { name: '冬瓜汤' }, NOW);
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  const firstDishId = state.dishes[0].id;
  const secondDishId = state.dishes[1].id;
  state = submitMealSelection(state, { sessionId, memberId: 'member-test', dishId: firstDishId }, NOW);
  state = submitMealSelection(state, { sessionId, memberId: 'member-2', dishId: secondDishId }, NOW);

  state = confirmMealSession(state, {
    sessionId,
    memberId: 'member-test',
    finalDishIds: [firstDishId],
  }, NOW);

  assert.deepEqual(state.mealSessions[0].finalDishIds, [firstDishId]);
});

test('reuses an already confirmed meal session for the same date and meal type', () => {
  let state = stateWithDish({ name: '红烧鸡翅' });
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  state = submitMealSelection(state, {
    sessionId,
    memberId: 'member-test',
    dishId: state.dishes[0].id,
  }, NOW);
  state = confirmMealSession(state, { sessionId, memberId: 'member-test' }, NOW);
  const reopened = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, '2026-08-03T10:00:00.000Z');

  assert.equal(reopened.mealSessions.length, 1);
  assert.equal(reopened.mealSessions[0].id, sessionId);
  assert.equal(reopened.mealSessions[0].status, 'confirmed');
});

test('summarizes ratings and keeps a readable no-image card state', () => {
  let state = stateWithDish({ name: '清炒时蔬' });
  const dishId = state.dishes[0].id;
  state = addCookingRecord(state, { dishId, rating: 'like' }, '2026-08-03T10:00:00.000Z');
  state = addCookingRecord(state, { dishId, rating: 'neutral' }, '2026-08-04T10:00:00.000Z');

  const summary = getDishSummary(state, dishId);
  assert.equal(summary.hasImage, false);
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.ratingLabel, '喜欢');
  assert.equal(summary.latestRecordAt, '2026-08-04T10:00:00.000Z');
});

test('cancels a member selection while the meal is still open', () => {
  let state = stateWithDish({ name: '青椒肉丝' });
  state = createMealSession(state, { date: '2026-08-02', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  const dishId = state.dishes[0].id;
  state = submitMealSelection(state, { sessionId, memberId: 'member-test', dishId }, NOW);
  state = cancelMealSelection(state, { sessionId, memberId: 'member-test', dishId }, NOW);

  assert.equal(getSelectedSubmissions(state, sessionId).length, 0);
});

test('searches dish summaries by name and keeps image status in the result', () => {
  let state = stateWithDish({ name: '蒜蓉生菜', image: 'greens.jpg' });
  state = addDish(state, { name: '冬瓜汤' }, NOW);

  const results = listDishSummaries(state, { query: '生菜' });

  assert.equal(results.length, 1);
  assert.equal(results[0].name, '蒜蓉生菜');
  assert.equal(results[0].hasImage, true);
});

test('can filter the library to dishes with a family favorite rating', () => {
  let state = stateWithDish({ name: '家常红烧肉' });
  const favoriteId = state.dishes[0].id;
  state = addDish(state, { name: '清炒青菜' }, NOW);
  state = addCookingRecord(state, { dishId: favoriteId, rating: 'like' }, '2026-08-03T10:00:00.000Z');

  const results = listDishSummaries(state, { tag: 'favorite' });

  assert.deepEqual(results.map((dish) => dish.name), ['家常红烧肉']);
});

test('upserts one rating per family member and dish', () => {
  let state = stateWithDish({ name: '番茄炒蛋' });
  const dishId = state.dishes[0].id;

  state = rateDish(state, { dishId, memberId: 'member-test', rating: 'like' }, NOW);
  state = rateDish(state, {
    dishId,
    memberId: 'member-test',
    rating: 'neutral',
  }, '2026-08-03T10:00:00.000Z');

  assert.equal(state.dishRatings.length, 1);
  assert.equal(state.dishRatings[0].rating, 'neutral');
  assert.equal(state.dishRatings[0].updatedAt, '2026-08-03T10:00:00.000Z');
});

test('soft deletes a dish while preserving its cooking history', () => {
  const state = stateWithDish({ name: '番茄炒蛋' });
  const dishId = state.dishes[0].id;

  const deleted = deleteDish(state, { dishId }, '2026-08-04T10:00:00.000Z');

  assert.equal(deleted.dishes[0].status, 'deleted');
  assert.equal(deleted.dishes[0].deletedAt, '2026-08-04T10:00:00.000Z');
  assert.equal(deleted.cookingRecords.length, state.cookingRecords.length);
  assert.equal(listDishSummaries(deleted).length, 0);
  assert.equal(findDishByName(deleted, '番茄炒蛋'), null);
});

test('updates the family name and adds an invited member without duplicate identities', () => {
  let state = createInitialState({ familyName: '周末饭桌' });
  state = updateFamilyProfile(state, { name: '我们家饭桌' });
  state = addMember(state, { id: 'member-2', displayName: '妈妈' });
  state = addMember(state, { id: 'member-2', displayName: '妈妈' });

  const summary = getFamilySummary(state);
  assert.equal(summary.name, '我们家饭桌');
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.members[1].displayName, '妈妈');
  assert.equal(summary.inviteCode, state.family.id);
});

test('updates a member display name without changing family permissions', () => {
  const state = createInitialState({ memberId: 'member-test', memberName: '我' });
  const updated = updateMemberProfile(state, {
    memberId: 'member-test',
    displayName: '小明',
  });

  assert.equal(updated.members[0].displayName, '小明');
  assert.equal(updated.currentMemberId, 'member-test');
});

test('stores optional dish category and characteristic tags without free-form category text', () => {
  const state = addDish(createInitialState(), {
    name: 'Tomato eggs',
    category: '荤菜',
    tags: ['家常', '下饭', 'not-allowed'],
  }, NOW);

  assert.equal(state.dishes[0].category, '荤菜');
  assert.deepEqual(state.dishes[0].tags, ['家常', '下饭', 'not-allowed']);

  const updated = updateDishProfile(state, {
    dishId: state.dishes[0].id,
    name: 'Tomato eggs',
    category: '汤',
    tags: ['清淡', '辣味'],
  });
  assert.equal(updated.dishes[0].category, '汤');
  assert.deepEqual(updated.dishes[0].tags, ['清淡', '辣味']);

  assert.deepEqual(listDishSummaries(updated, { tag: '汤' }).map((dish) => dish.id), [updated.dishes[0].id]);
});

test('upserts a half-star review for one cooking record and keeps it separate from other records', () => {
  let state = stateWithDish({ name: 'Tomato eggs' });
  const dishId = state.dishes[0].id;
  state = addCookingRecord(state, { dishId }, '2026-08-03T10:00:00.000Z');
  const firstRecordId = state.cookingRecords[0].id;
  const secondRecordId = state.cookingRecords[1].id;

  state = upsertRecordReview(state, {
    dishId,
    recordId: secondRecordId,
    memberId: 'member-test',
    stars: 3.5,
    text: '这次盐放得刚好',
  }, '2026-08-04T10:00:00.000Z');
  state = upsertRecordReview(state, {
    dishId,
    recordId: secondRecordId,
    memberId: 'member-test',
    stars: 4.5,
    text: '下次还想吃',
  }, '2026-08-05T10:00:00.000Z');

  assert.equal(state.recordReviews.length, 1);
  assert.equal(state.recordReviews[0].id, `${secondRecordId}|member-test`);
  assert.equal(state.recordReviews[0].stars, 4.5);
  assert.equal(state.recordReviews[0].text, '下次还想吃');
  assert.equal(state.recordReviews[0].recordId, secondRecordId);
  assert.notEqual(state.recordReviews[0].recordId, firstRecordId);
  assert.throws(
    () => upsertRecordReview(state, {
      dishId,
      recordId: secondRecordId,
      memberId: 'member-test',
      stars: 4.25,
    }, NOW),
    /半星/
  );
});

test('restores a deleted dish and permanently purges its records, reviews, and meal references', () => {
  let state = stateWithDish({ name: 'Tomato eggs' });
  const dishId = state.dishes[0].id;
  const recordId = state.cookingRecords[0].id;
  state = upsertRecordReview(state, {
    dishId,
    recordId,
    memberId: 'member-test',
    stars: 5,
  }, NOW);
  state = rateDish(state, { dishId, memberId: 'member-test', rating: 'like' }, NOW);
  state = createMealSession(state, { date: '2026-08-04', mealType: 'dinner' }, NOW);
  const sessionId = state.mealSessions[0].id;
  state = submitMealSelection(state, { sessionId, memberId: 'member-test', dishId }, NOW);
  state = confirmMealSession(state, { sessionId, memberId: 'member-test' }, NOW);
  state = deleteDish(state, { dishId }, '2026-08-05T10:00:00.000Z');

  assert.deepEqual(listDeletedDishSummaries(state).map((dish) => dish.id), [dishId]);
  const restored = restoreDish(state, { dishId }, '2026-08-06T10:00:00.000Z');
  assert.equal(restored.dishes[0].status, 'active');
  assert.equal(restored.dishes[0].deletedAt, '');

  const deletedAgain = deleteDish(restored, { dishId }, '2026-08-07T10:00:00.000Z');
  const purged = purgeDish(deletedAgain, { dishId }, '2026-08-08T10:00:00.000Z');
  assert.equal(purged.dishes.some((dish) => dish.id === dishId), false);
  assert.equal(purged.cookingRecords.some((record) => record.dishId === dishId), false);
  assert.equal(purged.recordReviews.some((review) => review.dishId === dishId), false);
  assert.equal(purged.dishRatings.some((rating) => rating.dishId === dishId), false);
  assert.equal(purged.mealSubmissions.some((submission) => submission.dishId === dishId), false);
  assert.deepEqual(purged.mealSessions[0].finalDishIds, []);
  assert.equal(purged.purgedDishes[0].dishId, dishId);
  assert.equal(listDeletedDishSummaries(purged).length, 0);
});
