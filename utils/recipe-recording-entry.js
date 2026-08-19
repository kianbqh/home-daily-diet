function recordsForDish(state, dishId) {
  const targetDishId = String(dishId || '');
  return (Array.isArray(state && state.cookingRecords) ? state.cookingRecords : [])
    .filter((record) => String(record && record.id || '')
      && String(record && record.dishId || '') === targetDishId);
}

function recordTime(record) {
  const parsed = Date.parse(String(record && record.recordedAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRecipeRecordingRecordId(
  state,
  dishId,
  preferredRecordId = '',
  requestedFamilyId = '',
) {
  const currentFamilyId = String(state && state.family && state.family.id || '');
  const expectedFamilyId = String(requestedFamilyId || '');
  if (currentFamilyId && expectedFamilyId && currentFamilyId !== expectedFamilyId) return '';
  const records = recordsForDish(state, dishId);
  const preferred = String(preferredRecordId || '');
  if (preferred && records.some((record) => String(record.id) === preferred)) return preferred;
  const latest = records.reduce((selected, record) => {
    if (!selected) return record;
    return recordTime(record) >= recordTime(selected) ? record : selected;
  }, null);
  return String(latest && latest.id || '');
}

function recipeRecordingUrl(values = {}) {
  const query = ['familyId', 'dishId', 'recordId']
    .map((key) => [key, values[key]])
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/pages/recipe-recording/recipe-recording?${query}`;
}

module.exports = {
  recipeRecordingUrl,
  resolveRecipeRecordingRecordId,
};
