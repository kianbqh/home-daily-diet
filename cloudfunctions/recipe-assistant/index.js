const { createRecipeRepository } = require('./repository');
const {
  createRecipeError,
  publicMessage,
  requireValue,
  runtimeErrorCode,
  sanitize,
} = require('./logic');

const DEFAULT_CONFIG = Object.freeze({
  stateCollection: 'family_states',
  memberCollection: 'family_members',
  recordingCollection: 'recipe_recordings',
  draftCollection: 'recipe_drafts',
  recipeCollection: 'family_recipes',
  versionCollection: 'recipe_versions',
  usageCollection: 'recipe_usage_daily',
});

const RECORD_ACTION_CONTRACTS = Object.freeze({
  recordId: Object.freeze([
    'getRecordWorkspace', 'reserveRecording', 'refreshWorkspace', 'addManualText',
    'attachRecordWorkspace', 'cancelRecordWorkspace',
  ]),
  recordingId: Object.freeze([
    'submitRecording', 'updateTranscript', 'deleteRecordingAudio', 'deleteRecording',
  ]),
  draftId: Object.freeze(['organizeDraft']),
});

const RECORD_ID_ACTIONS = RECORD_ACTION_CONTRACTS.recordId;
const RECORD_SCOPED_ACTIONS = Object.freeze(Object.values(RECORD_ACTION_CONTRACTS).flat());

function configFor(dependencies = {}) {
  return { ...DEFAULT_CONFIG, ...(dependencies.config || {}) };
}

async function query(db, name, filter, limit = 100) {
  let request = db.collection(name).where(filter);
  if (typeof request.limit === 'function') request = request.limit(limit);
  const result = await request.get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function getDocument(db, name, id) {
  try {
    const result = await db.collection(name).doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    const code = error && (error.errCode || error.code);
    const message = String(error && (error.errMsg || error.message) || '').toLowerCase();
    if (code === -1 || code === 'DOCUMENT_NOT_FOUND' || message.includes('not found') || message.includes('不存在')) return null;
    throw error;
  }
}

function createGuards(db, config) {
  async function requireMember(familyId, openid) {
    if (!String(openid || '').trim()) {
      throw createRecipeError('AUTH_REQUIRED', '无法确认登录身份', 'authorize');
    }
    const members = await query(db, config.memberCollection, { familyId, openid, status: 'active' }, 1);
    if (!members[0]) throw createRecipeError('NOT_MEMBER', '你还不是这个家庭的成员', 'authorize');
    return members[0];
  }

  async function requireActiveDish(familyId, dishId, options = {}) {
    const state = await getDocument(db, config.stateCollection, familyId);
    if (!state || !state.family || state.family.id !== familyId) {
      throw createRecipeError('DISH_NOT_FOUND', '找不到这道菜', 'authorize');
    }
    if ((state.purgedDishes || []).some((item) => item && item.dishId === dishId)) {
      throw createRecipeError('DISH_PURGED', '这道菜已经彻底删除', 'authorize');
    }
    const dish = (state.dishes || []).find((item) => item && item.id === dishId);
    if (!dish) throw createRecipeError('DISH_NOT_FOUND', '找不到这道菜', 'authorize');
    if (dish.status === 'deleted' && options.allowArchived === true) return dish;
    if (dish.status !== 'active') throw createRecipeError('DISH_DELETED', '这道菜已进入回收站', 'authorize');
    return dish;
  }

  async function requireCookingRecord(familyId, dishId, recordId) {
    const state = await getDocument(db, config.stateCollection, familyId);
    const record = state && (state.cookingRecords || []).find((item) => item
      && item.id === recordId
      && item.dishId === dishId
      && (!item.familyId || item.familyId === familyId));
    if (!record) throw createRecipeError('RECORD_NOT_FOUND', '找不到这次制作记录', 'authorize');
    return record;
  }

  return { requireMember, requireActiveDish, requireCookingRecord };
}

async function handleAction(event = {}, context = {}, dependencies = {}) {
  const action = String(event.action || '').trim() || 'unknown';
  const requestId = String(context.requestId || context.requestID || event.requestId || '').trim();
  const startedAt = nowMs(dependencies);
  let stage = 'validate';
  try {
    const db = dependencies.db;
    if (!db || typeof db.collection !== 'function') {
      throw createRecipeError('DATABASE_UNAVAILABLE', '菜谱服务暂时不可用', 'open-database');
    }
    const requiredAction = requireValue(event.action, 'ACTION_REQUIRED', '缺少操作类型');
    const familyId = requireValue(event.familyId, 'FAMILY_REQUIRED', '缺少家庭信息');
    const dishId = requireValue(event.dishId, 'DISH_REQUIRED', '缺少菜品信息');
    const config = configFor(dependencies);
    const repository = dependencies.repository || createRecipeRepository(db, config);
    const guards = dependencies.guards || createGuards(db, config);

    stage = 'authorize';
    const openid = String(context.OPENID || '').trim();
    if (!openid) throw createRecipeError('AUTH_REQUIRED', '无法确认登录身份', 'authorize');
    await guards.requireMember(familyId, openid);
    const allowArchived = ['getRecipe', 'listVersions', 'getVersion', 'getRecordWorkspace'].includes(requiredAction);
    await guards.requireActiveDish(familyId, dishId, { allowArchived });
    await authorizeRecordScope(requiredAction, event, familyId, dishId, repository, guards);

    stage = 'action';
    let data;
    switch (requiredAction) {
      case 'getRecipe':
        data = await getRecipe(repository, familyId, dishId);
        break;
      case 'listVersions':
        data = { versions: await repository.listVersions(familyId, dishId, 100) };
        break;
      case 'getVersion':
        data = await getVersion(repository, familyId, dishId, event.versionId);
        break;
      case 'getRecordWorkspace':
        data = await getRecordWorkspace(repository, familyId, dishId, event.recordId);
        break;
      default:
        throw createRecipeError('ACTION_INVALID', '不支持这个操作', 'action');
    }
    return { ok: true, data: sanitize(data) };
  } catch (error) {
    const code = runtimeErrorCode(error);
    const log = {
      stage: error && error.stage ? error.stage : stage,
      action,
      code,
      requestId,
      durationMs: Math.max(0, nowMs(dependencies) - startedAt),
    };
    const logger = dependencies.logger || console;
    if (logger && typeof logger.error === 'function') logger.error(log);
    return { ok: false, error: { code, message: publicMessage(error) } };
  }
}

async function getRecipe(repository, familyId, dishId) {
  const pointer = await repository.getRecipePointer(familyId, dishId);
  if (!pointer || !pointer.currentVersionId) return { pointer: null, version: null };
  const version = await repository.getVersion(familyId, dishId, pointer.currentVersionId);
  if (!version) return { pointer: null, version: null };
  return { pointer, version };
}

async function getVersion(repository, familyId, dishId, rawVersionId) {
  const versionId = requireValue(rawVersionId, 'VERSION_REQUIRED', '缺少菜谱版本');
  const version = await repository.getVersion(familyId, dishId, versionId);
  if (!version) throw createRecipeError('VERSION_NOT_FOUND', '找不到这个菜谱版本');
  return { version };
}

async function getRecordWorkspace(repository, familyId, dishId, rawRecordId) {
  const recordId = requireValue(rawRecordId, 'RECORD_REQUIRED', '缺少制作记录');
  const [recordings, draft] = await Promise.all([
    repository.listRecordings(familyId, dishId, recordId),
    repository.getDraft({ familyId, dishId, recordId }),
  ]);
  return { recordings, draft };
}

async function authorizeRecordScope(action, event, familyId, dishId, repository, guards) {
  if (!RECORD_SCOPED_ACTIONS.includes(action)) return;
  if (RECORD_ID_ACTIONS.includes(action)) {
    const recordId = requireValue(event.recordId, 'RECORD_REQUIRED', '缺少制作记录');
    await guards.requireCookingRecord(familyId, dishId, recordId);
    return;
  }
  if (RECORD_ACTION_CONTRACTS.recordingId.includes(action)) {
    const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
    const recording = await repository.getRecording(familyId, dishId, recordingId);
    if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
    await guards.requireCookingRecord(familyId, dishId, recording.recordId);
    return;
  }
  const draftId = requireValue(event.draftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const draft = await repository.getDraft(familyId, dishId, draftId);
  if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
  const recordId = String(draft.recordId || '').trim();
  if (recordId) await guards.requireCookingRecord(familyId, dishId, recordId);
}

function nowMs(dependencies) {
  const value = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

async function main(event = {}, context = {}) {
  const startedAt = Date.now();
  try {
    const cloud = require('wx-server-sdk');
    const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
    const runtimeEnv = cloud.DYNAMIC_CURRENT_ENV || env;
    cloud.init(runtimeEnv ? { env: runtimeEnv } : {});
    const wxContext = typeof cloud.getWXContext === 'function' ? cloud.getWXContext() : {};
    const requestContext = {
      requestId: String(context.requestId || context.requestID || '').trim(),
      OPENID: String(wxContext && wxContext.OPENID || '').trim(),
    };
    const db = cloud.database(runtimeEnv ? { env: runtimeEnv } : {});
    return handleAction(event, requestContext, {
      db,
      now: Date.now,
      logger: console,
      startedAt,
    });
  } catch (error) {
    const code = runtimeErrorCode(error);
    const log = {
      stage: error && error.stage ? error.stage : 'load-sdk',
      action: String(event.action || 'unknown'),
      code,
      requestId: String(context.requestId || context.requestID || ''),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(log);
    return { ok: false, error: { code, message: publicMessage(error) } };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  RECORD_ACTION_CONTRACTS,
  RECORD_ID_ACTIONS,
  RECORD_SCOPED_ACTIONS,
  createGuards,
  handleAction,
  main,
  publicMessage,
  runtimeErrorCode,
};
