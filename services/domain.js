const DEFAULT_MEAL_TYPE = 'dinner';
const VALID_RATINGS = new Set(['like', 'neutral', 'dislike']);
const DISH_CATEGORIES = ['荤菜', '素菜', '汤', '主食', '其他'];
const DISH_TAGS = ['家常', '快手', '下饭', '清淡', '辣味', '早餐', '节日菜'];
const REVIEW_MIN_STARS = 0.5;
const REVIEW_MAX_STARS = 5;
const REVIEW_STAR_STEP = 0.5;

let idSequence = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function timestamp(value) {
  return value instanceof Date ? value.toISOString() : (value || new Date().toISOString());
}

function makeId(prefix) {
  idSequence += 1;
  return `${prefix}-${Date.now()}-${idSequence}`;
}

function normalizeDishCategory(category) {
  const normalized = String(category || '').trim();
  return DISH_CATEGORIES.includes(normalized) ? normalized : '';
}

function normalizeDishTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag || '').trim()).filter(Boolean))];
}

function createInitialState(options = {}) {
  const familyId = options.familyId || 'family-local';
  const memberId = options.memberId || 'member-local';
  return {
    version: 1,
    family: {
      id: familyId,
      name: options.familyName || '我们的家',
      createdAt: timestamp(options.createdAt),
    },
    currentMemberId: memberId,
    members: [{
      id: memberId,
      displayName: options.memberName || '我',
      joinedAt: timestamp(options.createdAt),
    }],
    dishes: [],
    cookingRecords: [],
    dishRatings: [],
    recordReviews: [],
    purgedDishes: [],
    mealSessions: [],
    mealSubmissions: [],
  };
}

function updateFamilyProfile(inputState, input = {}) {
  const state = clone(inputState);
  const name = String(input.name || '').trim();
  if (!name) {
    throw new Error('家庭名称不能为空');
  }
  state.family.name = name;
  return state;
}

function addMember(inputState, input = {}) {
  const state = clone(inputState);
  const id = String(input.id || '').trim();
  const displayName = String(input.displayName || '').trim();
  if (!id || !displayName) {
    throw new Error('家庭成员信息不完整');
  }
  if (!state.members.some((member) => member.id === id)) {
    state.members.push({ id, displayName, joinedAt: timestamp(input.joinedAt) });
  }
  return state;
}

function updateMemberProfile(inputState, input = {}) {
  const state = clone(inputState);
  const member = state.members.find((item) => item.id === input.memberId);
  const displayName = String(input.displayName || '').trim();
  if (!member || !displayName) {
    throw new Error('成员称呼不能为空');
  }
  member.displayName = displayName;
  return state;
}

function getFamilySummary(inputState) {
  return {
    id: inputState.family.id,
    name: inputState.family.name,
    memberCount: inputState.members.length,
    members: inputState.members.map((member) => ({ ...member })),
    inviteCode: inputState.family.id,
  };
}

function requireDishName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) {
    throw new Error('菜名不能为空');
  }
  return normalized;
}

function findDish(state, dishId) {
  return state.dishes.find((dish) => dish.id === dishId);
}

function isActiveDish(dish) {
  return Boolean(dish && dish.status !== 'deleted');
}

function findMeal(state, sessionId) {
  return state.mealSessions.find((session) => session.id === sessionId);
}

function ensureOpenMeal(session) {
  if (!session) {
    throw new Error('找不到这次选餐');
  }
  if (session.status !== 'open') {
    throw new Error('菜单已经确认');
  }
}

function addDish(inputState, input = {}, now) {
  const state = clone(inputState);
  const name = requireDishName(input.name);
  const createdAt = timestamp(now);
  const recordedAt = timestamp(input.recordedAt || now);
  const image = input.image || '';
  const dishId = input.id || makeId('dish');
  const dish = {
    id: dishId,
    familyId: state.family.id,
    name,
    category: normalizeDishCategory(input.category),
    tags: normalizeDishTags(input.tags),
    createdBy: input.createdBy || state.currentMemberId,
    createdAt,
    updatedAt: createdAt,
    coverImage: image,
    status: 'active',
    deletedAt: '',
    restoredAt: '',
  };
  state.dishes.push(dish);
  state.cookingRecords.push({
    id: makeId('record'),
    familyId: state.family.id,
    dishId,
    recordedBy: input.recordedBy || state.currentMemberId,
    recordedAt,
    mealType: input.mealType || '',
    image,
    rating: input.rating || '',
    note: input.note || '',
  });
  return state;
}

function addCookingRecord(inputState, input = {}, now) {
  const state = clone(inputState);
  const dish = findDish(state, input.dishId);
  if (!isActiveDish(dish)) {
    throw new Error('找不到要记录的菜品');
  }
  const recordedAt = timestamp(input.recordedAt || now);
  const image = input.image || '';
  state.cookingRecords.push({
    id: makeId('record'),
    familyId: state.family.id,
    dishId: dish.id,
    recordedBy: input.recordedBy || state.currentMemberId,
    recordedAt,
    mealType: input.mealType || '',
    image,
    rating: input.rating || '',
    note: input.note || '',
  });
  dish.updatedAt = recordedAt;
  if (image) {
    dish.coverImage = image;
  }
  return state;
}

function updateDishProfile(inputState, input = {}) {
  const state = clone(inputState);
  const dish = findDish(state, input.dishId);
  if (!isActiveDish(dish)) {
    throw new Error('找不到要编辑的菜品');
  }
  dish.name = requireDishName(input.name);
  if (Array.isArray(input.tags)) {
    dish.tags = normalizeDishTags(input.tags);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'category')) {
    dish.category = normalizeDishCategory(input.category);
  }
  if (input.image) {
    dish.coverImage = input.image;
  }
  dish.updatedAt = timestamp(input.updatedAt);
  return state;
}

function rateDish(inputState, input = {}, now) {
  const state = clone(inputState);
  const dishId = String(input.dishId || '').trim();
  const memberId = String(input.memberId || state.currentMemberId || '').trim();
  const rating = String(input.rating || '').trim();
  const dish = findDish(state, dishId);
  if (!isActiveDish(dish)) {
    throw new Error('找不到要评价的菜品');
  }
  if (!memberId || !state.members.some((member) => member.id === memberId)) {
    throw new Error('家庭成员信息无效');
  }
  if (!VALID_RATINGS.has(rating)) {
    throw new Error('评价内容无效');
  }
  const updatedAt = timestamp(now);
  const ratings = Array.isArray(state.dishRatings) ? state.dishRatings : [];
  const existing = ratings.find((item) => item.dishId === dishId && item.memberId === memberId);
  if (existing) {
    existing.rating = rating;
    existing.updatedAt = updatedAt;
  } else {
    ratings.push({
      id: `${dishId}|${memberId}`,
      familyId: state.family.id,
      dishId,
      memberId,
      rating,
      createdAt: updatedAt,
      updatedAt,
    });
  }
  state.dishRatings = ratings;
  return state;
}

function upsertRecordReview(inputState, input = {}, now) {
  const state = clone(inputState);
  const dishId = String(input.dishId || '').trim();
  const recordId = String(input.recordId || '').trim();
  const memberId = String(input.memberId || state.currentMemberId || '').trim();
  const dish = findDish(state, dishId);
  const record = state.cookingRecords.find((item) => item.id === recordId);
  if (!isActiveDish(dish)) {
    throw new Error('找不到要评价的菜品');
  }
  if (!record || record.dishId !== dishId) {
    throw new Error('找不到这次制作记录');
  }
  if (!memberId || !state.members.some((member) => member.id === memberId)) {
    throw new Error('家庭成员信息无效');
  }

  const stars = Number(input.stars);
  if (!Number.isFinite(stars)
    || stars < REVIEW_MIN_STARS
    || stars > REVIEW_MAX_STARS
    || Math.abs(stars * 2 - Math.round(stars * 2)) > Number.EPSILON) {
    throw new Error('评分必须使用半星');
  }

  const text = String(input.text || '').trim();
  if (text.length > 300) {
    throw new Error('评价不能超过300字');
  }

  const updatedAt = timestamp(now);
  const reviews = Array.isArray(state.recordReviews) ? state.recordReviews : [];
  const reviewId = `${recordId}|${memberId}`;
  const existing = reviews.find((review) => review.id === reviewId);
  if (existing) {
    existing.stars = stars;
    existing.text = text;
    existing.updatedAt = updatedAt;
  } else {
    reviews.push({
      id: reviewId,
      familyId: state.family.id,
      dishId,
      recordId,
      memberId,
      stars,
      text,
      createdAt: updatedAt,
      updatedAt,
    });
  }
  state.recordReviews = reviews;
  return state;
}

function deleteDish(inputState, input = {}, now) {
  const state = clone(inputState);
  const dish = findDish(state, input.dishId);
  if (!dish) {
    throw new Error('找不到要删除的菜品');
  }
  if (dish.status === 'deleted') {
    return state;
  }
  const deletedAt = timestamp(now);
  dish.status = 'deleted';
  dish.deletedAt = deletedAt;
  dish.restoredAt = '';
  dish.updatedAt = deletedAt;
  return state;
}

function restoreDish(inputState, input = {}, now) {
  const state = clone(inputState);
  const dish = findDish(state, input.dishId);
  if (!dish) {
    throw new Error('找不到要恢复的菜品');
  }
  if ((state.purgedDishes || []).some((item) => item.dishId === dish.id)) {
    throw new Error('这道菜已经彻底删除');
  }
  if (dish.status !== 'deleted') return state;
  const restoredAt = timestamp(now);
  dish.status = 'active';
  dish.deletedAt = '';
  dish.restoredAt = restoredAt;
  dish.updatedAt = restoredAt;
  return state;
}

function listDeletedDishSummaries(inputState) {
  return inputState.dishes
    .filter((dish) => dish && dish.status === 'deleted')
    .map((dish) => getDishSummary(inputState, dish.id))
    .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
}

function purgeDish(inputState, input = {}, now) {
  const state = clone(inputState);
  const dishId = String(input.dishId || '').trim();
  const dish = findDish(state, dishId);
  const alreadyPurged = (state.purgedDishes || []).some((item) => item.dishId === dishId);
  if (!dish && alreadyPurged) return state;
  if (!dish) {
    throw new Error('找不到要彻底删除的菜品');
  }
  if (dish.status !== 'deleted') {
    throw new Error('只能彻底删除回收站中的菜品');
  }

  state.dishes = state.dishes.filter((item) => item.id !== dishId);
  state.cookingRecords = state.cookingRecords.filter((record) => record.dishId !== dishId);
  state.recordReviews = (state.recordReviews || []).filter((review) => review.dishId !== dishId);
  state.dishRatings = (state.dishRatings || []).filter((rating) => rating.dishId !== dishId);
  state.mealSubmissions = (state.mealSubmissions || []).filter((submission) => submission.dishId !== dishId);
  state.mealSessions = (state.mealSessions || []).map((session) => ({
    ...session,
    finalDishIds: (session.finalDishIds || []).filter((id) => id !== dishId),
  }));
  state.purgedDishes = [
    ...(state.purgedDishes || []).filter((item) => item.dishId !== dishId),
    {
      id: `${state.family.id}|${dishId}`,
      familyId: state.family.id,
      dishId,
      purgedAt: timestamp(now),
    },
  ];
  return state;
}

function findDishByName(inputState, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return inputState.dishes.find((dish) => (
    isActiveDish(dish) && dish.name.trim().toLowerCase() === normalized
  )) || null;
}

function createMealSession(inputState, input = {}, now) {
  const state = clone(inputState);
  const date = input.date || new Date().toISOString().slice(0, 10);
  const mealType = input.mealType || DEFAULT_MEAL_TYPE;
  const existing = state.mealSessions.find((session) => (
    session.date === date && session.mealType === mealType
  ));
  if (existing) {
    return state;
  }
  state.mealSessions.push({
    id: makeId('meal'),
    familyId: state.family.id,
    date,
    mealType,
    status: 'open',
    createdBy: input.createdBy || state.currentMemberId,
    createdAt: timestamp(now),
    confirmedBy: '',
    confirmedAt: '',
    finalDishIds: [],
  });
  return state;
}

function submitMealSelection(inputState, input = {}, now) {
  const state = clone(inputState);
  const session = findMeal(state, input.sessionId);
  ensureOpenMeal(session);
  if (!isActiveDish(findDish(state, input.dishId))) {
    throw new Error('只能选择菜品库中的菜品');
  }
  const duplicate = state.mealSubmissions.find((submission) => (
    submission.mealSessionId === input.sessionId
      && submission.memberId === input.memberId
      && submission.dishId === input.dishId
      && submission.status === 'selected'
  ));
  if (!duplicate) {
    state.mealSubmissions.push({
      id: makeId('submission'),
      mealSessionId: input.sessionId,
      dishId: input.dishId,
      memberId: input.memberId || state.currentMemberId,
      status: 'selected',
      updatedAt: timestamp(now),
    });
  }
  return state;
}

function updateMealSelection(inputState, input = {}, now) {
  const state = clone(inputState);
  const session = findMeal(state, input.sessionId);
  ensureOpenMeal(session);
  state.mealSubmissions = state.mealSubmissions.filter((submission) => !(
    submission.mealSessionId === input.sessionId
      && submission.memberId === input.memberId
      && submission.status === 'selected'
  ));
  return submitMealSelection(state, input, now);
}

function cancelMealSelection(inputState, input = {}, now) {
  const state = clone(inputState);
  const session = findMeal(state, input.sessionId);
  ensureOpenMeal(session);
  state.mealSubmissions = state.mealSubmissions.map((submission) => {
    if (
      submission.mealSessionId === input.sessionId
      && submission.memberId === input.memberId
      && submission.dishId === input.dishId
      && submission.status === 'selected'
    ) {
      return { ...submission, status: 'cancelled', updatedAt: timestamp(now) };
    }
    return submission;
  });
  return state;
}

function getSelectedSubmissions(inputState, sessionId) {
  return inputState.mealSubmissions.filter((submission) => (
    submission.mealSessionId === sessionId
      && submission.status === 'selected'
      && isActiveDish(findDish(inputState, submission.dishId))
  ));
}

function confirmMealSession(inputState, input = {}, now) {
  const state = clone(inputState);
  const session = findMeal(state, input.sessionId);
  ensureOpenMeal(session);
  if (getSelectedSubmissions(state, input.sessionId).length === 0) {
    throw new Error('至少选择一道菜后才能确认菜单');
  }
  const selectedDishIds = getSelectedSubmissions(state, input.sessionId).map((submission) => submission.dishId);
  const finalDishIds = input.finalDishIds && input.finalDishIds.length
    ? input.finalDishIds
    : selectedDishIds;
  const allSelected = finalDishIds.every((dishId) => selectedDishIds.includes(dishId));
  if (!allSelected || finalDishIds.length === 0) {
    throw new Error('最终菜单必须来自已提交的菜品');
  }
  session.status = 'confirmed';
  session.confirmedBy = input.memberId || state.currentMemberId;
  session.confirmedAt = timestamp(now);
  session.finalDishIds = [...new Set(finalDishIds)];
  return state;
}

function getFinalDishIds(inputState, sessionId) {
  const session = findMeal(inputState, sessionId);
  if (!session) return [];
  return session.finalDishIds && session.finalDishIds.length
    ? [...session.finalDishIds]
    : getSelectedSubmissions(inputState, sessionId).map((submission) => submission.dishId);
}

function getDishSummary(inputState, dishId) {
  const dish = findDish(inputState, dishId);
  if (!dish) {
    return null;
  }
  const records = inputState.cookingRecords
    .filter((record) => record.dishId === dishId)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const recordImage = records.find((record) => record && record.image)?.image || '';
  const dishImage = String(dish.coverImage || '');
  const hasPortableDishImage = /^(cloud:\/\/|https?:\/\/)/.test(dishImage);
  const coverImage = hasPortableDishImage || !recordImage ? dishImage : recordImage;
  const ratings = [
    ...records.filter((record) => record.rating).map((record) => ({ rating: record.rating })),
    ...(Array.isArray(inputState.dishRatings) ? inputState.dishRatings : [])
      .filter((item) => item.dishId === dishId && item.rating),
  ];
  const rated = ratings.filter((record) => record.rating);
  const counts = rated.reduce((result, record) => {
    result[record.rating] = (result[record.rating] || 0) + 1;
    return result;
  }, {});
  const ratingLabel = counts.like
    ? '喜欢'
    : (counts.neutral ? '一般' : (counts.dislike ? '不喜欢' : '暂无评价'));
  const reviews = (Array.isArray(inputState.recordReviews) ? inputState.recordReviews : [])
    .filter((review) => review.dishId === dishId && Number.isFinite(Number(review.stars)));
  const starTotal = reviews.reduce((total, review) => total + Number(review.stars), 0);
  const averageStars = reviews.length ? Math.round((starTotal / reviews.length) * 10) / 10 : 0;
  const ratingDistribution = reviews.reduce((result, review) => {
    const key = String(Number(review.stars));
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  return {
    ...dish,
    coverImage,
    hasImage: Boolean(coverImage),
    recordCount: records.length,
    latestRecordAt: records[0] ? records[0].recordedAt : '',
    ratingLabel: reviews.length ? `${averageStars}星` : ratingLabel,
    ratingCounts: counts,
    reviewCount: reviews.length,
    averageStars,
    ratingDistribution,
  };
}

function listDishSummaries(inputState, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const tag = options.tag || 'all';
  return inputState.dishes
    .filter(isActiveDish)
    .map((dish) => getDishSummary(inputState, dish.id))
    .filter((dish) => !query || dish.name.toLowerCase().includes(query))
    .filter((dish) => (
      tag === 'all'
      || (tag === 'favorite' && (dish.ratingLabel === '喜欢' || dish.averageStars >= 4))
      || (tag !== 'favorite' && (dish.category === tag || dish.tags.includes(tag)))
    ))
    .sort((a, b) => b.latestRecordAt.localeCompare(a.latestRecordAt));
}

function findSimilarDishes(inputState, name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/[\s，,。.!！?？、_-]+/g, '');
  if (normalized.length < 2) return [];
  return inputState.dishes.filter((dish) => isActiveDish(dish)).filter((dish) => {
    const existing = dish.name.toLowerCase().replace(/[\s，,。.!！?？、_-]+/g, '');
    return existing !== normalized
      && existing.length >= 2
      && (existing.includes(normalized) || normalized.includes(existing));
  });
}

function getMealForDate(inputState, date, mealType = DEFAULT_MEAL_TYPE) {
  return inputState.mealSessions.find((session) => (
    session.date === date && session.mealType === mealType
  )) || null;
}

module.exports = {
  DEFAULT_MEAL_TYPE,
  DISH_CATEGORIES,
  DISH_TAGS,
  REVIEW_MAX_STARS,
  REVIEW_MIN_STARS,
  REVIEW_STAR_STEP,
  addCookingRecord,
  addDish,
  addMember,
  cancelMealSelection,
  confirmMealSession,
  createInitialState,
  createMealSession,
  deleteDish,
  getDishSummary,
  getFamilySummary,
  getFinalDishIds,
  getMealForDate,
  getSelectedSubmissions,
  findDishByName,
  findSimilarDishes,
  isActiveDish,
  listDishSummaries,
  listDeletedDishSummaries,
  purgeDish,
  rateDish,
  restoreDish,
  submitMealSelection,
  updateFamilyProfile,
  updateMemberProfile,
  updateDishProfile,
  updateMealSelection,
  upsertRecordReview,
};
