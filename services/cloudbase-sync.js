function chooseLatest(remoteItem, localItem, dateField = 'updatedAt') {
  const remoteDate = remoteItem && (remoteItem[dateField] || remoteItem.confirmedAt || remoteItem.createdAt || '');
  const localDate = localItem && (localItem[dateField] || localItem.confirmedAt || localItem.createdAt || '');
  return localDate >= remoteDate ? localItem : remoteItem;
}

function chooseDish(remoteItem, localItem) {
  const remoteDeleted = remoteItem && remoteItem.status === 'deleted';
  const localDeleted = localItem && localItem.status === 'deleted';
  if (remoteDeleted !== localDeleted) {
    const deletedItem = remoteDeleted ? remoteItem : localItem;
    const activeItem = remoteDeleted ? localItem : remoteItem;
    // A deletion is a tombstone. A stale active snapshot must not resurrect it.
    // Only an explicit restore (recorded by restoredAt) can override that tombstone.
    if (activeItem && activeItem.restoredAt) {
      const restoredAt = String(activeItem.restoredAt || activeItem.updatedAt || '');
      const deletedAt = String(deletedItem.deletedAt || deletedItem.updatedAt || '');
      if (restoredAt >= deletedAt) return activeItem;
    }
    return deletedItem;
  }
  if (remoteDeleted && localDeleted) {
    return chooseLatest(remoteItem, localItem, 'deletedAt');
  }
  return chooseLatest(remoteItem, localItem);
}

function chooseProfile(remoteItem, localItem, fallbackField) {
  const remoteTime = String(remoteItem && (remoteItem.updatedAt || remoteItem[fallbackField]) || '');
  const localTime = String(localItem && (localItem.updatedAt || localItem[fallbackField]) || '');
  return localTime > remoteTime ? localItem : remoteItem;
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

function purgeDishReferences(state) {
  if (!state) return state;
  const purgedIds = new Set((state.purgedDishes || []).map((item) => item.dishId));
  if (!purgedIds.size) return state;
  return {
    ...state,
    dishes: (state.dishes || []).filter((dish) => !purgedIds.has(dish.id)),
    cookingRecords: (state.cookingRecords || []).filter((record) => !purgedIds.has(record.dishId)),
    dishRatings: (state.dishRatings || []).filter((rating) => !purgedIds.has(rating.dishId)),
    recordReviews: (state.recordReviews || []).filter((review) => !purgedIds.has(review.dishId)),
    mealSubmissions: (state.mealSubmissions || []).filter((submission) => !purgedIds.has(submission.dishId)),
    mealSessions: (state.mealSessions || []).map((session) => ({
      ...session,
      finalDishIds: (session.finalDishIds || []).filter((dishId) => !purgedIds.has(dishId)),
    })),
  };
}

function assertSameFamily(remote, local) {
  const remoteFamilyId = String(remote && remote.family && remote.family.id || '').trim();
  const localFamilyId = String(local && local.family && local.family.id || '').trim();
  if (!remoteFamilyId || !localFamilyId || remoteFamilyId !== localFamilyId) {
    const error = new Error('不能合并不同家庭的状态');
    error.code = 'FAMILY_MISMATCH';
    throw error;
  }
  return remoteFamilyId;
}

function mergeFamilyStates(remote, local) {
  if (!remote) return purgeDishReferences(local);
  assertSameFamily(remote, local);
  const merged = {
    ...remote,
    ...local,
    family: chooseProfile(remote.family, local.family, 'createdAt'),
    members: mergeByKey(
      remote.members,
      local.members,
      (item) => item.id,
      (remoteMember, localMember) => chooseProfile(remoteMember, localMember, 'joinedAt')
    ),
    dishes: mergeByKey(remote.dishes, local.dishes, (item) => item.id, chooseDish),
    cookingRecords: mergeByKey(remote.cookingRecords, local.cookingRecords, (item) => item.id),
    dishRatings: mergeByKey(
      remote.dishRatings || [],
      local.dishRatings || [],
      (item) => item.id || `${item.dishId}|${item.memberId}`
    ),
    recordReviews: mergeByKey(
      remote.recordReviews || [],
      local.recordReviews || [],
      (item) => item.id || `${item.recordId}|${item.memberId}`
    ),
    purgedDishes: mergeByKey(
      remote.purgedDishes || [],
      local.purgedDishes || [],
      (item) => item.id || item.dishId,
      (remoteItem, localItem) => chooseLatest(remoteItem, localItem, 'purgedAt')
    ),
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
  return purgeDishReferences(merged);
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

function uniqueCloudFileIds(fileIds) {
  const values = Array.isArray(fileIds) ? fileIds : [fileIds];
  return [...new Set(values.filter((fileId) => typeof fileId === 'string' && fileId.indexOf('cloud://') === 0))];
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
    async resolveFiles(familyId, fileIds) {
      const ids = uniqueCloudFileIds(fileIds);
      if (!familyId || !ids.length) return [];
      const data = await callFunction('resolveFiles', { familyId, fileIds: ids });
      return Array.isArray(data.files) ? data.files : [];
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
      if (!filePath || /^(cloud:\/\/|https?:\/\/)/.test(filePath)) return filePath || '';
      if (typeof api.cloud.uploadFile !== 'function') {
        const error = new Error('云端图片上传暂不可用');
        error.code = 'IMAGE_UPLOAD_UNAVAILABLE';
        throw error;
      }
      const extension = String(filePath).match(/\.[a-z0-9]+$/i);
      const suffix = extension ? extension[0] : '.jpg';
      const result = await api.cloud.uploadFile({
        cloudPath: `${options.fileStoragePrefix || 'family-meals/'}${familyId}/${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
        filePath,
      });
      if (!result || !result.fileID) {
        const error = new Error('云端图片上传未返回文件地址');
        error.code = 'IMAGE_UPLOAD_UNAVAILABLE';
        throw error;
      }
      return result.fileID;
    },
  };
}

module.exports = { createCloudBaseSync, mergeFamilyStates };
