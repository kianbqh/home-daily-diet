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
  if (!remote) return local;
  const merged = {
    ...remote,
    ...local,
    family: { ...remote.family, ...local.family },
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
  const currentMemberId = local.currentMemberId || remote.currentMemberId;
  if (currentMemberId) {
    merged.currentMemberId = currentMemberId;
  } else {
    delete merged.currentMemberId;
  }
  return merged;
}

function removeLocalIdentity(state) {
  const shared = { ...state };
  delete shared.currentMemberId;
  return shared;
}

function createCloudError(body) {
  const error = new Error(
    body && body.error && body.error.message
      ? body.error.message
      : '家庭云端暂时不可用'
  );
  error.code = body && body.error && body.error.code
    ? body.error.code
    : 'CLOUD_FUNCTION_ERROR';
  return error;
}

function normalizeCallError(error, action) {
  const code = error && typeof error.code === 'string' && error.code
    ? error.code
    : 'CLOUD_CALL_FAILED';
  const normalized = new Error(
    error && (error.errMsg || error.message)
      ? (error.errMsg || error.message)
      : 'cloud function call failed'
  );
  normalized.code = code;
  normalized.action = action;
  return normalized;
}

function unwrapFunctionResult(result) {
  const body = result && result.result ? result.result : result;
  if (!body || body.ok !== true) throw createCloudError(body);
  return body.data || {};
}

function createCloudBaseSync(api, options = {}) {
  const envId = String(options.envId || '').trim();
  if (!api || !api.cloud || !envId) {
    return null;
  }
  api.cloud.init({ env: envId, traceUser: true });
  if (typeof api.cloud.callFunction !== 'function') return null;
  const accessFunction = options.accessFunction || 'family-access';

  async function callFunction(action, payload = {}) {
    try {
      const result = await api.cloud.callFunction({
        name: accessFunction,
        data: { action, ...payload },
      });
      return unwrapFunctionResult(result);
    } catch (error) {
      const normalized = normalizeCallError(error, action);
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[CloudBase]', action, normalized.code);
      }
      throw normalized;
    }
  }

  return {
    async bootstrap(state) {
      if (!state || !state.family || !state.family.id) return null;
      const member = state.members.find((item) => item.id === state.currentMemberId);
      return callFunction('bootstrap', {
        familyId: state.family.id,
        memberId: state.currentMemberId,
        displayName: member ? member.displayName : '家庭成员',
      });
    },
    async load(familyId) {
      if (!familyId) return null;
      const data = await callFunction('load', { familyId });
      return data.state || null;
    },
    async save(state) {
      if (!state || !state.family || !state.family.id) {
        throw new Error('家庭状态缺少 family.id');
      }
      const data = await callFunction('save', {
        familyId: state.family.id,
        state: removeLocalIdentity(state),
      });
      return data.state || state;
    },
    async createInvite(familyId) {
      const data = await callFunction('createInvite', { familyId });
      return data.invite || null;
    },
    async getInvite(familyId) {
      const data = await callFunction('getInvite', { familyId });
      return data.invite || null;
    },
    async revokeInvite(familyId) {
      const data = await callFunction('revokeInvite', { familyId });
      return data;
    },
    async acceptInvite(code, member = {}) {
      return callFunction('acceptInvite', {
        code,
        memberId: member.id,
        displayName: member.displayName,
      });
    },
    async uploadImage(filePath, familyId = 'family-local') {
      if (!filePath || !api.cloud.uploadFile) return filePath || '';
      if (/^(cloud:\/\/|https?:\/\/)/.test(filePath)) return filePath;
      const extension = String(filePath).match(/\.[a-z0-9]+$/i);
      const suffix = extension ? extension[0] : '.jpg';
      const result = await api.cloud.uploadFile({
        cloudPath: `${options.fileStoragePrefix || 'family-meals/'}${familyId}/${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
        filePath,
      });
      return result && result.fileID ? result.fileID : filePath;
    },
  };
}

module.exports = { createCloudBaseSync, mergeFamilyStates };
