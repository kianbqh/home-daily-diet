const test = require('node:test');
const assert = require('node:assert/strict');

const { formatDate } = require('../utils/format');

test('formats a cooking record date for a dish card', () => {
  assert.equal(formatDate('2026-08-04T10:00:00.000Z'), '8月4日');
  assert.equal(formatDate(''), '还没有记录');
});
