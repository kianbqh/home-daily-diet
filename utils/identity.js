function uniqueSuffix() {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}`;
}

function getOrCreateId(api, key, prefix, suffix = uniqueSuffix) {
  if (!api || typeof api.getStorageSync !== 'function') return 'member-local';
  const existing = String(api.getStorageSync(key) || '').trim();
  if (existing) return existing;
  const id = `${prefix}-${suffix()}`;
  if (typeof api.setStorageSync === 'function') api.setStorageSync(key, id);
  return id;
}

function getOrCreateMemberId(api, suffix) {
  return getOrCreateId(api, 'family_member_id', 'member', suffix);
}

function getOrCreateFamilyId(api, suffix) {
  const id = getOrCreateId(api, 'family_id', 'family', suffix);
  return id === 'member-local' ? 'family-local' : id;
}

module.exports = { getOrCreateFamilyId, getOrCreateMemberId };
