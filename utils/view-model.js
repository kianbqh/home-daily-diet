const {
  getDishSummary,
  getMealForDate,
  getFinalDishIds,
  getSelectedSubmissions,
  listDishSummaries,
} = require('../services/domain');
const { formatDate, formatMealType, formatRating } = require('./format');

const DEFAULT_FAMILY_NAME = '我们的家';
const DEFAULT_MEMBER_NAME = '我';

function syncTextFor(summary) {
  const status = summary && summary.syncStatus;
  if (status === 'ready') {
    return '已连接家庭云端，邀请链接可跨设备加入。';
  }
  if (status === 'connecting') {
    return '正在连接家庭云端，请稍候。';
  }
  if (status === 'error') {
    return summary.syncMessage || '云端连接失败，当前继续使用本地数据。';
  }
  return '当前使用本地模式，数据只保存在这台设备。';
}

function buildFamilyViewModel(state, summary) {
  if (!state || !summary) {
    const fallback = {
      id: '',
      name: DEFAULT_FAMILY_NAME,
      memberCount: 1,
      members: [],
      inviteCode: '',
      syncStatus: 'error',
      syncMessage: '应用初始化未完成，当前继续使用本地数据。',
    };
    return {
      family: { ...fallback, syncText: syncTextFor(fallback) },
      name: DEFAULT_FAMILY_NAME,
      memberName: DEFAULT_MEMBER_NAME,
    };
  }

  const currentMemberId = state.currentMemberId;
  const members = (summary.members || []).map((member) => {
    const displayName = String(member.displayName || DEFAULT_MEMBER_NAME);
    return {
      ...member,
      displayName,
      initial: displayName.slice(0, 1),
      isCurrent: member.id === currentMemberId,
    };
  });
  const currentMember = members.find((member) => member.id === currentMemberId);
  const family = {
    ...summary,
    name: summary.name || DEFAULT_FAMILY_NAME,
    memberCount: Number.isFinite(summary.memberCount) ? summary.memberCount : members.length,
    members,
  };
  family.syncText = syncTextFor(family);

  return {
    family,
    name: family.name,
    memberName: currentMember ? currentMember.displayName : DEFAULT_MEMBER_NAME,
  };
}

function buildHomeViewModel(state, date, mealType = 'dinner') {
  const dishes = listDishSummaries(state);
  const meal = getMealForDate(state, date, mealType);
  const selections = meal ? getSelectedSubmissions(state, meal.id) : [];
  const selectedDishCount = new Set(selections.map((selection) => selection.dishId)).size;
  const isEmpty = dishes.length === 0;
  return {
    familyName: state.family.name,
    memberCount: state.members.length,
    isEmpty,
    emptyTitle: '记录第一道家里的菜',
    emptyDescription: '把以前做过、以后还想吃的菜保存下来。',
    primaryAction: isEmpty ? 'record' : 'select',
    dishCount: dishes.length,
    dishes: dishes.slice(0, 4),
    mealId: meal ? meal.id : '',
    mealStatus: meal ? meal.status : 'none',
    mealTitle: '今天晚餐吃什么？',
    mealHint: isEmpty
      ? '先记录一道菜，之后就可以从菜品库里选择今天吃什么'
      : (meal && meal.status === 'confirmed'
        ? '菜单已经确认，吃完后可以追加制作记录'
        : (selections.length ? `已有 ${selections.length} 人次提交 ${selectedDishCount} 道菜` : '从菜品库里选几道想吃的菜')),
    selectedCount: selections.length,
    selectedDishCount,
    confirmed: Boolean(meal && meal.status === 'confirmed'),
  };
}

function buildLibraryViewModel(state, filters = {}) {
  const query = String(filters.query || '').trim();
  const tag = filters.tag || 'all';
  const dishes = listDishSummaries(state, { query, tag });
  const hasSearch = Boolean(query) || tag !== 'all';
  return {
    dishes,
    hasSearch,
    emptyTitle: hasSearch ? '没有找到符合条件的菜' : '记录第一道家里的菜',
    emptyDescription: hasSearch
      ? '换个菜名或筛选条件试试，也可以直接记录新菜。'
      : '记录一道家里的菜，它就会出现在这里，也能参与今天的选择。',
  };
}

function buildDishDetailViewModel(state, dishId) {
  const dish = getDishSummary(state, dishId);
  const history = state.cookingRecords
    .filter((record) => record.dishId === dishId)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .map((record) => ({
      ...record,
      recordDateLabel: formatDate(record.recordedAt),
      mealLabel: record.mealType ? formatMealType(record.mealType) : '未指定餐次',
      ratingLabel: formatRating(record.rating),
      noteLabel: record.note || '这次没有写备注',
    }));
  return { dish, history };
}

function buildMealViewModel(state, date, memberId, mealType = 'dinner') {
  const meal = getMealForDate(state, date, mealType);
  const submissions = meal ? getSelectedSubmissions(state, meal.id) : [];
  const selectedIds = new Set(submissions.map((submission) => submission.dishId));
  const mySelectedIds = new Set(submissions
    .filter((submission) => submission.memberId === memberId)
    .map((submission) => submission.dishId));
  const dishes = listDishSummaries(state).map((dish) => ({
    ...dish,
    selected: selectedIds.has(dish.id),
    selectedByMe: mySelectedIds.has(dish.id),
    submissionCount: submissions.filter((submission) => submission.dishId === dish.id).length,
  }));
  const finalIds = meal ? new Set(getFinalDishIds(state, meal.id)) : new Set();
  return {
    meal,
    dishes,
    finalDishes: dishes.filter((dish) => finalIds.has(dish.id)),
    selectedCount: submissions.length,
    selectedDishCount: selectedIds.size,
    canEdit: Boolean(meal && meal.status === 'open'),
    confirmed: Boolean(meal && meal.status === 'confirmed'),
    emptyLibrary: dishes.length === 0,
  };
}

module.exports = {
  buildDishDetailViewModel,
  buildFamilyViewModel,
  buildHomeViewModel,
  buildLibraryViewModel,
  buildMealViewModel,
};
