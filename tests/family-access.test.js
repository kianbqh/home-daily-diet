const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INVITE_ALPHABET,
  INVITE_TTL_MS,
  createAccessError,
  createInviteCode,
  createMemberRecord,
  isInviteUsable,
  makeInviteRecord,
} = require('../cloudfunctions/family-access/logic');

test('invite code is six characters and excludes ambiguous characters', () => {
  const code = createInviteCode(() => Buffer.from('abcdefghijklmnop', 'utf8'));

  assert.equal(code.length, 6);
  assert.equal(code.split('').every((character) => INVITE_ALPHABET.includes(character)), true);
  assert.equal(/[01IO]/.test(code), false);
});

test('invite code uses the configured alphabet and the six-byte input', () => {
  let requestedBytes = 0;
  const code = createInviteCode((size) => {
    requestedBytes = size;
    return Buffer.alloc(size, 1);
  });

  assert.equal(requestedBytes, 6);
  assert.equal(code, INVITE_ALPHABET[1].repeat(6));
});

test('invite is usable only while active and before expiration', () => {
  const now = '2026-08-04T10:00:00.000Z';

  assert.equal(isInviteUsable({
    status: 'active',
    expiresAt: '2026-08-05T10:00:00.000Z',
  }, now), true);
  assert.equal(isInviteUsable({
    status: 'revoked',
    expiresAt: '2026-08-05T10:00:00.000Z',
  }, now), false);
  assert.equal(isInviteUsable({
    status: 'active',
    expiresAt: '2026-08-03T10:00:00.000Z',
  }, now), false);
});

test('invite record has a 30-day lifetime and starts active', () => {
  const now = '2026-08-04T10:00:00.000Z';
  const record = makeInviteRecord({
    familyId: 'family-1',
    createdBy: 'member-1',
    code: 'A7K9Q2',
  }, now);

  assert.equal(record.familyId, 'family-1');
  assert.equal(record.createdBy, 'member-1');
  assert.equal(record.code, 'A7K9Q2');
  assert.equal(record.status, 'active');
  assert.equal(record.useCount, 0);
  assert.equal(Date.parse(record.expiresAt) - Date.parse(now), INVITE_TTL_MS);
});

test('member records use a stable family/member document id', () => {
  const record = createMemberRecord({
    familyId: 'family-1',
    memberId: 'member-2',
    openid: 'openid-2',
    displayName: 'Xiaoming',
  }, '2026-08-04T10:00:00.000Z');

  assert.deepEqual(record, {
    _id: 'family-1|member-2',
    familyId: 'family-1',
    memberId: 'member-2',
    openid: 'openid-2',
    displayName: 'Xiaoming',
    joinedAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
    status: 'active',
  });
});

test('access errors expose a stable code and safe message', () => {
  const error = createAccessError('INVITE_REVOKED', 'Invite code has been revoked');

  assert.equal(error.code, 'INVITE_REVOKED');
  assert.equal(error.message, 'Invite code has been revoked');
  assert.equal(error.name, 'FamilyAccessError');
});
