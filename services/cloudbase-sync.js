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

function mergeEventSnapshots(baseState, events = []) {
  return events
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .reduce((current, event) => mergeFamilyStates(current, event.state), baseState);
}

function createCloudBaseSync(api, options = {}) {
  const envId = String(options.envId || '').trim();
  if (!api || !api.cloud || !envId) {
    return null;
  }
  api.cloud.init({ env: envId, traceUser: true });
  const database = api.cloud.database();
  const collectionName = options.collection || options.stateCollection || 'family_states';
  const collection = database.collection(collectionName);
  const eventCollection = database.collection(options.eventCollection || `${collectionName}_events`);

  return {
    async load(familyId) {
      if (!familyId) return null;
      let state = null;
      try {
        const result = await collection.doc(familyId).get();
        state = result && result.data ? result.data : null;
      } catch (error) {
        const isMissingDocument = error && (
          error.errCode === -1
          || String(error.errMsg || error.message || '').includes('document not found')
        );
        if (!isMissingDocument) {
          throw error;
        }
      }
      if (eventCollection && typeof eventCollection.where === 'function') {
        const eventResult = await eventCollection.where({ familyId }).get();
        state = mergeEventSnapshots(state, eventResult && eventResult.data ? eventResult.data : []);
      }
      return state;
    },
    async save(state) {
      if (!state || !state.family || !state.family.id) {
        throw new Error('家庭状态缺少 family.id');
      }
      const remote = await this.load(state.family.id);
      const merged = mergeFamilyStates(remote, state);
      const sharedSnapshot = removeLocalIdentity(merged);
      if (eventCollection && typeof eventCollection.add === 'function') {
        await eventCollection.add({
          data: {
            familyId: state.family.id,
            state: sharedSnapshot,
            createdAt: new Date().toISOString(),
          },
        });
      }
      await collection.doc(state.family.id).set({ data: sharedSnapshot });
      return merged;
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
