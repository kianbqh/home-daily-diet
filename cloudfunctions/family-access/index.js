const {
  createAccessError,
  createInviteCode,
  createMemberRecord,
  isInviteUsable,
  makeInviteRecord,
} = require('./logic');

const DEFAULT_CONFIG = {
  stateCollection: 'family_states',
  eventCollection: 'family_states_events',
  memberCollection: 'family_members',
  inviteCollection: 'family_invites',
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function timestamp(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

function configFor(options = {}) {
  return { ...DEFAULT_CONFIG, ...(options.config || {}) };
}

function requireValue(value, code, message) {
  if (String(value || '').trim()) return String(value).trim();
  throw createAccessError(code, message);
}

function publicMember(member) {
  if (!member) return null;
  return {
    memberId: member.memberId,
    displayName: member.displayName,
    familyId: member.familyId,
    status: member.status,
  };
}

function publicInvite(invite) {
  if (!invite) return null;
  return {
    code: invite.code,
    expiresAt: invite.expiresAt,
    status: invite.status,
    useCount: Number(invite.useCount || 0),
  };
}

function collection(db, name) {
  return db.collection(name);
}

async function query(db, name, filter, limit = 100) {
  let request = collection(db, name).where(filter);
  if (typeof request.limit === 'function') request = request.limit(limit);
  const result = await request.get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function getDocument(db, name, id) {
  const result = await collection(db, name).doc(id).get();
  return result && result.data ? result.data : null;
}

async function setDocument(db, name, id, data) {
  await collection(db, name).doc(id).set({ data });
}

async function updateDocument(db, name, id, data) {
  const document = collection(db, name).doc(id);
  if (typeof document.update === 'function') {
    await document.update({ data });
    return;
  }
  const existing = await getDocument(db, name, id);
  await setDocument(db, name, id, { ...(existing || {}), ...data });
}

async function addDocument(db, name, data) {
  await collection(db, name).add({ data });
}

function chooseLatest(remoteItem, localItem, dateField = 'updatedAt') {
  const remoteDate = remoteItem && (remoteItem[dateField] || remoteItem.confirmedAt || remoteItem.createdAt || '');
  const localDate = localItem && (localItem[dateField] || localItem.confirmedAt || localItem.createdAt || '');
  return localDate >= remoteDate ? localItem : remoteItem;
}

function mergeByKey(remoteItems = [], localItems = [], keyOf, resolver = chooseLatest) {
  const merged = new Map();
  remoteItems.forEach((item) => merged.set(keyOf(item), item));
  localItems.forEach((item) => {
    const key = keyOf(item);
    merged.set(key, merged.has(key) ? resolver(merged.get(key), item) : item);
  });
  return [...merged.values()];
}

function mergeMealSession(remoteItem, localItem) {
  if (remoteItem.status === 'confirmed' && localItem.status !== 'confirmed') return remoteItem;
  if (localItem.status === 'confirmed' && remoteItem.status !== 'confirmed') return localItem;
  return chooseLatest(remoteItem, localItem, 'confirmedAt');
}

function mergeFamilyStates(remote, local) {
  if (!remote) return clone(local);
  const merged = {
    ...clone(remote),
    ...clone(local),
    family: { ...(remote.family || {}), ...(local.family || {}) },
    members: mergeByKey(remote.members, local.members, (item) => item.id),
    dishes: mergeByKey(remote.dishes, local.dishes, (item) => item.id),
    cookingRecords: mergeByKey(remote.cookingRecords, local.cookingRecords, (item) => item.id),
    mealSessions: mergeByKey(remote.mealSessions, local.mealSessions, (item) => item.id, mergeMealSession),
    mealSubmissions: mergeByKey(
      remote.mealSubmissions,
      local.mealSubmissions,
      (item) => `${item.mealSessionId}|${item.memberId}|${item.dishId}`
    ),
  };
  delete merged.currentMemberId;
  return merged;
}

async function readFamilyState(db, config, familyId) {
  const base = await getDocument(db, config.stateCollection, familyId);
  let state = base;
  const events = await query(db, config.eventCollection, { familyId });
  events
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .forEach((event) => {
      state = mergeFamilyStates(state, event.state);
    });
  return state;
}

async function writeFamilyState(db, config, state, now) {
  const familyId = requireValue(state && state.family && state.family.id, 'INVALID_STATE', '家庭状态无效');
  const remote = await readFamilyState(db, config, familyId);
  const sharedState = mergeFamilyStates(remote, state);
  await addDocument(db, config.eventCollection, {
    familyId,
    state: sharedState,
    createdAt: timestamp(now),
  });
  await setDocument(db, config.stateCollection, familyId, sharedState);
  return sharedState;
}

async function findMember(db, config, familyId, openid) {
  const members = await query(db, config.memberCollection, {
    familyId,
    openid,
    status: 'active',
  }, 1);
  return members[0] || null;
}

async function requireMember(db, config, familyId, openid) {
  const member = await findMember(db, config, familyId, openid);
  if (!member) throw createAccessError('NOT_MEMBER', '你还不是这个家庭的成员');
  return member;
}

async function bootstrap(event, context, db, config, now) {
  const openid = requireValue(context.OPENID, 'AUTH_REQUIRED', '请先完成微信身份认证');
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  const memberId = requireValue(event.memberId, 'MEMBER_REQUIRED', '缺少成员信息');
  const displayName = String(event.displayName || '').trim() || '家庭成员';
  const current = await findMember(db, config, familyId, openid);
  if (current) {
    if (current.displayName !== displayName) {
      current.displayName = displayName;
      current.updatedAt = timestamp(now);
      await setDocument(db, config.memberCollection, current._id, current);
    }
    return { member: publicMember(current) };
  }
  const familyMembers = await query(db, config.memberCollection, { familyId, status: 'active' });
  if (familyMembers.length) {
    throw createAccessError('NOT_MEMBER', '你还不是这个家庭的成员');
  }
  const member = createMemberRecord({ familyId, memberId, openid, displayName }, now);
  await setDocument(db, config.memberCollection, member._id, member);
  return { member: publicMember(member) };
}

async function createInvite(event, context, db, config, now, options) {
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  const member = await requireMember(db, config, familyId, context.OPENID);
  const activeInvites = await query(db, config.inviteCollection, { familyId, status: 'active' }, 20);
  const active = activeInvites.find((invite) => isInviteUsable(invite, now));
  if (active) return { invite: publicInvite(active) };
  for (const invite of activeInvites) {
    await updateDocument(db, config.inviteCollection, invite._id, {
      status: 'expired',
      revokedAt: invite.revokedAt || timestamp(now),
    });
  }
  const code = createInviteCode(options.randomBytes);
  const record = makeInviteRecord({
    id: `invite-${familyId}-${code}`,
    familyId,
    createdBy: member.memberId,
    code,
  }, now);
  await addDocument(db, config.inviteCollection, record);
  return { invite: publicInvite(record) };
}

async function getInvite(event, context, db, config, now) {
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  await requireMember(db, config, familyId, context.OPENID);
  const invites = await query(db, config.inviteCollection, { familyId, status: 'active' }, 20);
  const invite = invites[0];
  if (!invite) return { invite: null };
  if (!isInviteUsable(invite, now)) {
    await updateDocument(db, config.inviteCollection, invite._id, {
      status: 'expired',
      revokedAt: invite.revokedAt || timestamp(now),
    });
    return { invite: null };
  }
  return { invite: publicInvite(invite) };
}

async function revokeInvite(event, context, db, config, now) {
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  await requireMember(db, config, familyId, context.OPENID);
  const invites = await query(db, config.inviteCollection, { familyId, status: 'active' }, 20);
  await Promise.all(invites.map((invite) => updateDocument(db, config.inviteCollection, invite._id, {
    status: 'revoked',
    revokedAt: timestamp(now),
  })));
  return { revoked: invites.length > 0 };
}

async function acceptInvite(event, context, db, config, now) {
  const openid = requireValue(context.OPENID, 'AUTH_REQUIRED', '请先完成微信身份认证');
  const code = requireValue(event.code, 'INVITE_INVALID', '邀请码无效').toUpperCase();
  const invites = await query(db, config.inviteCollection, { code }, 20);
  const invite = invites[0];
  if (!invite) throw createAccessError('INVITE_INVALID', '邀请码无效');
  if (invite.status === 'revoked') throw createAccessError('INVITE_REVOKED', '邀请码已撤销');
  if (!isInviteUsable(invite, now)) {
    await updateDocument(db, config.inviteCollection, invite._id, {
      status: 'expired',
      revokedAt: invite.revokedAt || timestamp(now),
    });
    throw createAccessError('INVITE_EXPIRED', '邀请码已过期');
  }
  const familyId = invite.familyId;
  const state = await readFamilyState(db, config, familyId);
  if (!state) throw createAccessError('FAMILY_NOT_FOUND', '找不到这个家庭空间');
  const memberId = requireValue(event.memberId, 'MEMBER_REQUIRED', '缺少成员信息');
  const displayName = String(event.displayName || '').trim() || '家庭成员';
  const memberDocumentId = `${familyId}|${memberId}`;
  const existingById = await getDocument(db, config.memberCollection, memberDocumentId);
  if (existingById && existingById.openid !== openid) {
    throw createAccessError('MEMBER_ID_CONFLICT', '成员信息冲突，请重新打开小程序后再试');
  }
  let member = await findMember(db, config, familyId, openid);
  if (!member) {
    member = createMemberRecord({ familyId, memberId, openid, displayName }, now);
  } else {
    member = { ...member, displayName, updatedAt: timestamp(now), status: 'active' };
  }
  await setDocument(db, config.memberCollection, member._id, member);
  const nextState = clone(state);
  nextState.members = Array.isArray(nextState.members) ? nextState.members : [];
  const existingMember = nextState.members.find((item) => item.id === memberId);
  if (existingMember) {
    existingMember.displayName = displayName;
  } else {
    nextState.members.push({ id: memberId, displayName });
  }
  const sharedState = await writeFamilyState(db, config, nextState, now);
  await updateDocument(db, config.inviteCollection, invite._id, {
    useCount: Number(invite.useCount || 0) + 1,
  });
  return { state: sharedState, member: publicMember(member) };
}

async function load(event, context, db, config) {
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  await requireMember(db, config, familyId, context.OPENID);
  return { state: await readFamilyState(db, config, familyId) };
}

async function save(event, context, db, config, now) {
  const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
  await requireMember(db, config, familyId, context.OPENID);
  if (!event.state || !event.state.family || event.state.family.id !== familyId) {
    throw createAccessError('INVALID_STATE', '家庭状态无效');
  }
  const state = await writeFamilyState(db, config, event.state, now);
  return { state };
}

async function handleAction(event = {}, context = {}, db, options = {}) {
  if (!db || typeof db.collection !== 'function') {
    throw createAccessError('DATABASE_UNAVAILABLE', '家庭云端暂时不可用');
  }
  const action = requireValue(event.action, 'ACTION_REQUIRED', '缺少操作类型');
  const config = configFor(options);
  const now = options.now || new Date().toISOString();
  switch (action) {
    case 'bootstrap':
      return { ok: true, data: await bootstrap(event, context, db, config, now) };
    case 'createInvite':
      return { ok: true, data: await createInvite(event, context, db, config, now, options) };
    case 'getInvite':
      return { ok: true, data: await getInvite(event, context, db, config, now) };
    case 'revokeInvite':
      return { ok: true, data: await revokeInvite(event, context, db, config, now) };
    case 'acceptInvite':
      return { ok: true, data: await acceptInvite(event, context, db, config, now) };
    case 'load':
      return { ok: true, data: await load(event, context, db, config) };
    case 'save':
      return { ok: true, data: await save(event, context, db, config, now) };
    default:
      throw createAccessError('ACTION_INVALID', '不支持这个操作');
  }
}

async function main(event = {}, context = {}) {
  try {
    // Loaded lazily so the action handler remains unit-testable without installing the server SDK locally.
    const cloud = require('wx-server-sdk');
    const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
    cloud.init(env ? { env } : {});
    const result = await handleAction(event, context, cloud.database(), {
      config: {
        stateCollection: process.env.STATE_COLLECTION || DEFAULT_CONFIG.stateCollection,
        eventCollection: process.env.EVENT_COLLECTION || DEFAULT_CONFIG.eventCollection,
        memberCollection: process.env.MEMBER_COLLECTION || DEFAULT_CONFIG.memberCollection,
        inviteCollection: process.env.INVITE_COLLECTION || DEFAULT_CONFIG.inviteCollection,
      },
    });
    return result;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.code ? error.message : '家庭云端暂时不可用',
      },
    };
  }
}

module.exports = { handleAction, main, mergeFamilyStates };
