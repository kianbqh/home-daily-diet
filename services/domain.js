const DEFAULT_MEAL_TYPE = 'dinner';

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
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdBy: input.createdBy || state.currentMemberId,
    createdAt,
    updatedAt: createdAt,
    coverImage: image,
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
  if (!dish) {
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
  if (!dish) {
    throw new Error('找不到要编辑的菜品');
  }
  dish.name = requireDishName(input.name);
  if (Array.isArray(input.tags)) {
    dish.tags = input.tags.filter(Boolean);
  }
  if (input.image) {
    dish.coverImage = input.image;
  }
  dish.updatedAt = timestamp(input.updatedAt);
  return state;
}

function findDishByName(inputState, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return inputState.dishes.find((dish) => dish.name.trim().toLowerCase() === normalized) || null;
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
  if (!findDish(state, input.dishId)) {
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
    submission.mealSessionId === sessionId && submission.status === 'selected'
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
  const rated = records.filter((record) => record.rating);
  const counts = rated.reduce((result, record) => {
    result[record.rating] = (result[record.rating] || 0) + 1;
    return result;
  }, {});
  const ratingLabel = counts.like
    ? '喜欢'
    : (counts.neutral ? '一般' : (counts.dislike ? '不喜欢' : '暂无评价'));
  return {
    ...dish,
    hasImage: Boolean(dish.coverImage),
    recordCount: records.length,
    latestRecordAt: records[0] ? records[0].recordedAt : '',
    ratingLabel,
    ratingCounts: counts,
  };
}

function listDishSummaries(inputState, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const tag = options.tag || 'all';
  return inputState.dishes
    .map((dish) => getDishSummary(inputState, dish.id))
    .filter((dish) => !query || dish.name.toLowerCase().includes(query))
    .filter((dish) => tag !== 'favorite' || dish.ratingLabel === '喜欢')
    .filter((dish) => tag === 'all' || tag === 'favorite' || dish.tags.includes(tag))
    .sort((a, b) => b.latestRecordAt.localeCompare(a.latestRecordAt));
}

function findSimilarDishes(inputState, name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/[\s，,。.!！?？、_-]+/g, '');
  if (normalized.length < 2) return [];
  return inputState.dishes.filter((dish) => {
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
  addCookingRecord,
  addDish,
  addMember,
  cancelMealSelection,
  confirmMealSession,
  createInitialState,
  createMealSession,
  getDishSummary,
  getFamilySummary,
  getFinalDishIds,
  getMealForDate,
  getSelectedSubmissions,
  findDishByName,
  findSimilarDishes,
  listDishSummaries,
  submitMealSelection,
  updateFamilyProfile,
  updateMemberProfile,
  updateDishProfile,
  updateMealSelection,
};
