function todayString(date = new Date()) {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDate(dateString) {
  if (!dateString) return '还没有记录';
  const date = new Date(dateString);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatMealType(mealType) {
  return ({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐' })[mealType] || '其他餐次';
}

function formatRating(rating) {
  return ({ like: '喜欢', neutral: '一般', dislike: '不喜欢' })[rating] || '暂无评价';
}

function formatStars(stars) {
  const value = Number(stars);
  if (!Number.isFinite(value) || value <= 0) return '暂无';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function initials(name) {
  return String(name || '菜').trim().slice(0, 1);
}

module.exports = { formatDate, formatMealType, formatRating, formatStars, initials, todayString };
