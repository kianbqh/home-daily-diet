const crypto = require('node:crypto');

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function timestamp(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

function createInviteCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(6);
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
  }
  return code;
}

function isInviteUsable(invite, now = new Date().toISOString()) {
  if (!invite || invite.status !== 'active' || invite.revokedAt) return false;
  if (!invite.expiresAt) return false;
  return Date.parse(invite.expiresAt) > Date.parse(timestamp(now));
}

function makeInviteRecord(input = {}, now) {
  const createdAt = timestamp(now);
  return {
    _id: input.id || `invite-${input.familyId}-${createdAt}`,
    familyId: String(input.familyId || ''),
    code: String(input.code || ''),
    createdBy: String(input.createdBy || ''),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + INVITE_TTL_MS).toISOString(),
    revokedAt: '',
    status: 'active',
    useCount: 0,
  };
}

function createMemberRecord(input = {}, now) {
  const createdAt = timestamp(now);
  const familyId = String(input.familyId || '');
  const memberId = String(input.memberId || '');
  return {
    _id: `${familyId}|${memberId}`,
    familyId,
    memberId,
    openid: String(input.openid || ''),
    displayName: String(input.displayName || '').trim(),
    joinedAt: createdAt,
    updatedAt: createdAt,
    status: 'active',
  };
}

function createAccessError(code, message) {
  const error = new Error(message);
  error.name = 'FamilyAccessError';
  error.code = code;
  return error;
}

module.exports = {
  INVITE_ALPHABET,
  INVITE_TTL_MS,
  createAccessError,
  createInviteCode,
  createMemberRecord,
  isInviteUsable,
  makeInviteRecord,
};
