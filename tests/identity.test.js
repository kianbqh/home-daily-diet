const test = require('node:test');
const assert = require('node:assert/strict');

const { getOrCreateFamilyId, getOrCreateMemberId } = require('../utils/identity');

test('keeps one local member identity per device for family joining', () => {
  const values = new Map();
  const api = {
    getStorageSync(key) {
      return values.get(key) || '';
    },
    setStorageSync(key, value) {
      values.set(key, value);
    },
  };

  const first = getOrCreateMemberId(api, () => 'abc123');
  const second = getOrCreateMemberId(api, () => 'different');

  assert.equal(first, 'member-abc123');
  assert.equal(second, first);
});

test('creates one unique local family identity per device', () => {
  const values = new Map();
  const api = {
    getStorageSync(key) {
      return values.get(key) || '';
    },
    setStorageSync(key, value) {
      values.set(key, value);
    },
  };

  const first = getOrCreateFamilyId(api, () => 'family123');
  const second = getOrCreateFamilyId(api, () => 'different');

  assert.equal(first, 'family-family123');
  assert.equal(second, first);
});
