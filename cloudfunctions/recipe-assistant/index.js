const { createRecipeRepository } = require('./repository');
const { createTencentAsrProvider } = require('./providers/tencent-asr');
const {
  ALLOWED_MODELS: ALLOWED_RECIPE_MODELS,
  DEFAULT_MODEL: DEFAULT_RECIPE_MODEL,
  DEFAULT_PROMPT_VERSION: DEFAULT_RECIPE_PROMPT_VERSION,
  createTokenHubProvider,
} = require('./providers/tokenhub');
const crypto = require('node:crypto');
const { normalizeRecipe, validateRecipe } = require('./recipe-schema');
const {
  buildSourceText,
  createInputHash,
  createRecipeError,
  createUsageOperationId,
  publicMessage,
  requireRevision,
  requireTranscriptRevision,
  requireValue,
  runtimeErrorCode,
  sanitize,
  sanitizeTokenUsage,
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
  draftId: Object.freeze(['organizeDraft', 'getDraft', 'updateDraft', 'confirmDraft']),
});

const RECORD_ID_ACTIONS = RECORD_ACTION_CONTRACTS.recordId;
const RECORD_SCOPED_ACTIONS = Object.freeze(Object.values(RECORD_ACTION_CONTRACTS).flat());
const MAX_RECORDINGS = 10;
const MAX_WORKSPACE_DURATION_MS = 15 * 60 * 1000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_RECORDING_DURATION_MS = 3 * 60 * 1000;
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Longer than the normal cloud invocation path, but short enough to recover a crashed submission promptly.
const ASR_SUBMIT_LEASE_MS = 2 * 60 * 1000;
const ASR_RESERVATION_SECONDS = 180;
const ORGANIZE_LEASE_MS = 10 * 60 * 1000;
const MAX_SOURCE_CHARACTERS = 30_000;
const CONFLICT_CODES = Object.freeze([
  'DRAFT_CONFLICT', 'MAIN_RECIPE_CONFLICT', 'TRANSCRIPT_CONFLICT',
]);
let productionAsrProvider = null;
let productionRecipeProvider = null;
let productionRecipeProviderKey = '';

function configFor(dependencies = {}) {
  return { ...DEFAULT_CONFIG, ...(dependencies.config || {}) };
}

function createConflictError(code, message, current, revision) {
  const error = createRecipeError(code, message);
  const normalizedRevision = Number(revision);
  const rawUpdatedAt = current && current.updatedAt;
  const normalizedUpdatedAt = rawUpdatedAt == null ? Number.NaN : Number(rawUpdatedAt);
  error.currentRevision = Number.isInteger(normalizedRevision) && normalizedRevision >= 0
    ? normalizedRevision : 0;
  error.currentUpdatedBy = String(current && (current.updatedBy || current.createdBy) || '').slice(0, 200);
  error.currentUpdatedAt = Number.isFinite(normalizedUpdatedAt) ? normalizedUpdatedAt : null;
  return error;
}

function publicErrorPayload(error) {
  const code = runtimeErrorCode(error);
  if (error && error.name === 'RecipeAssistantError' && CONFLICT_CODES.includes(code)) {
    return {
      code,
      currentRevision: Number.isInteger(error.currentRevision) && error.currentRevision >= 0
        ? error.currentRevision : 0,
      currentUpdatedBy: String(error.currentUpdatedBy || '').slice(0, 200),
      currentUpdatedAt: Number.isFinite(error.currentUpdatedAt) ? error.currentUpdatedAt : null,
    };
  }
  return { code, message: publicMessage(error) };
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
    const member = await guards.requireMember(familyId, openid);
    const allowArchived = ['getRecipe', 'listVersions', 'getVersion', 'getRecordWorkspace'].includes(requiredAction);
    const dish = await guards.requireActiveDish(familyId, dishId, { allowArchived });
    const recordAuthorization = await authorizeRecordScope(
      requiredAction, event, member, dish, familyId, dishId, repository, guards, db, config
    );
    if (recordAuthorization && recordAuthorization.kind === 'provisional'
      && recordAuthorization.hasWorkspace && requiredAction !== 'cancelRecordWorkspace') {
      await claimProvisionalWorkspace(
        db, config, familyId, dishId, recordAuthorization.recordId, member.memberId, nowMs(dependencies)
      );
    }

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
        data = await getRecordWorkspace(repository, familyId, dishId, event.recordId, dependencies.fileApi);
        break;
      case 'reserveRecording':
        data = await reserveRecording(
          repository, member, familyId, dishId, event, dependencies, nowMs(dependencies), recordAuthorization
        );
        break;
      case 'submitRecording':
        data = await submitRecording(
          repository, member, familyId, dishId, event, dependencies, nowMs(dependencies), recordAuthorization
        );
        break;
      case 'refreshWorkspace':
        data = await refreshWorkspace(repository, member, familyId, dishId, event.recordId, dependencies, nowMs(dependencies));
        break;
      case 'addManualText':
        data = await addManualText(
          repository, member, familyId, dishId, event, dependencies, nowMs(dependencies), recordAuthorization
        );
        break;
      case 'updateTranscript':
        data = await updateTranscript(repository, member, familyId, dishId, event, nowMs(dependencies));
        break;
      case 'deleteRecordingAudio':
        data = await deleteRecordingAudio(repository, member, familyId, dishId, event, dependencies.fileApi, nowMs(dependencies));
        break;
      case 'deleteRecording':
        data = await deleteRecording(repository, member, familyId, dishId, event, dependencies.fileApi, nowMs(dependencies));
        break;
      case 'attachRecordWorkspace':
        data = await attachRecordWorkspace(
          repository, member, familyId, dishId, event.recordId, dependencies,
          nowMs(dependencies), recordAuthorization
        );
        break;
      case 'cancelRecordWorkspace':
        data = await cancelRecordWorkspace(
          repository, member, familyId, dishId, event.recordId, dependencies, nowMs(dependencies), recordAuthorization
        );
        break;
      case 'createManualDraft':
        data = await createManualDraft(repository, guards, member, familyId, dishId, event, nowMs(dependencies));
        break;
      case 'organizeDraft':
        data = await organizeDraft(repository, member, familyId, dishId, event, dependencies, nowMs(dependencies));
        break;
      case 'getDraft':
        data = await getDraft(repository, familyId, dishId, event.draftId);
        break;
      case 'updateDraft':
        data = await updateDraft(repository, member, familyId, dishId, event, nowMs(dependencies));
        break;
      case 'confirmDraft':
        data = await confirmDraft(repository, member, familyId, dishId, event, nowMs(dependencies));
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
    return { ok: false, error: publicErrorPayload(error) };
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

async function getRecordWorkspace(repository, familyId, dishId, rawRecordId, fileApi) {
  const recordId = requireValue(rawRecordId, 'RECORD_REQUIRED', '缺少制作记录');
  const [recordings, draft] = await Promise.all([
    repository.listRecordings(familyId, dishId, recordId),
    repository.getDraft({ familyId, dishId, recordId }),
  ]);
  const audioUrls = {};
  const playable = recordings.filter((item) => item.status !== 'deleted'
    && fileIdBelongsToFamily(item.fileId, familyId));
  if (playable.length && fileApi && typeof fileApi.getTempFileURL === 'function') {
    const response = await fileApi.getTempFileURL({ fileList: playable.map((item) => item.fileId) });
    const entries = Array.isArray(response) ? response : response && response.fileList;
    (entries || []).forEach((item, index) => {
      const fileId = String(item && (item.fileID || item.fileId) || playable[index] && playable[index].fileId || '');
      const recording = playable.find((candidate) => candidate.fileId === fileId);
      const url = String(item && (item.tempFileURL || item.tempFileUrl || item.url) || '');
      if (recording && url) audioUrls[recording._id] = url;
    });
  }
  return { recordings: recordings.filter((item) => item.status !== 'deleted'), draft, audioUrls };
}

async function reserveRecording(repository, member, familyId, dishId, event, dependencies, now, authorization) {
  const recordId = requireValue(event.recordId, 'RECORD_REQUIRED', '缺少制作记录');
  if (String(event.format || '').trim().toLowerCase() !== 'mp3') {
    throw createRecipeError('RECORDING_FORMAT_INVALID', '录音格式必须为 MP3', 'validate');
  }
  const recordings = (await repository.listRecordings(familyId, dishId, recordId))
    .filter((item) => item.status !== 'deleted');
  const generated = typeof dependencies.idGenerator === 'function'
    ? dependencies.idGenerator()
    : `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const recordingId = `recording-${String(generated || '').replace(/^recording-/, '')}`;
  if (!/^recording-[A-Za-z0-9_-]+$/.test(recordingId)) {
    throw createRecipeError('RECORDING_ID_INVALID', '无法创建录音片段');
  }
  if (authorization && authorization.kind === 'provisional') {
    await claimProvisionalWorkspace(
      dependencies.db, configFor(dependencies), familyId, dishId, recordId, member.memberId, now
    );
  }
  const cloudPath = `families/${familyId}/recipe-audio/${recordingId}.mp3`;
  const expiresAt = now + RECORDING_TTL_MS;
  const recording = await runSegmentCreationTransaction(
    repository, dependencies, authorization, familyId, dishId, recordId, member.memberId,
    async (transaction) => {
      if (await transaction.getRecording(familyId, dishId, recordingId)) {
        throw createRecipeError('RECORDING_CONFLICT', '录音片段已存在，请重试');
      }
      const existingState = await transaction.getWorkspaceState(familyId, dishId, recordId);
      requireProvisionalStateOwner(existingState, member.memberId, authorization);
      const activeCount = existingState ? Number(existingState.activeCount) || 0 : recordings.length;
      if (activeCount >= MAX_RECORDINGS) {
        throw createRecipeError('RECORDING_LIMIT_EXCEEDED', '每次制作最多保留 10 段录音');
      }
      const sequence = existingState ? (Number(existingState.nextSequence) || nextSequence(recordings)) : nextSequence(recordings);
      await transaction.setWorkspaceState(familyId, dishId, recordId, {
        familyId, dishId, recordId, sourceType: 'workspace_state', status: 'active',
        createdBy: existingState && existingState.createdBy || member.memberId,
        createdAt: existingState && existingState.createdAt != null ? existingState.createdAt : now,
        activeCount: activeCount + 1, totalDurationMs: existingState
          ? Number(existingState.totalDurationMs) || 0
          : recordings.reduce((sum, item) => sum + validDuration(item.durationMs), 0),
        nextSequence: sequence + 1, updatedAt: now,
      });
      return transaction.setRecording(recordingId, {
        familyId, dishId, recordId, sequence, sourceType: 'audio',
        reservedCloudPath: cloudPath, fileId: '', durationMs: 0, durationCommitted: false,
        format: 'mp3', byteLength: 0, status: 'reserved', rawTranscript: '', editedTranscript: '', transcriptRevision: 0,
        errorCode: '', createdBy: member.memberId, createdAt: now, updatedBy: member.memberId,
        updatedAt: now, audioDeletedAt: null, audioDeletePending: false, draftExpiresAt: expiresAt,
      });
    },
  );
  return { recordingId: recording._id, cloudPath, expiresAt };
}

async function submitRecording(repository, member, familyId, dishId, event, dependencies, now, authorization) {
  const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
  const fileId = requireValue(event.fileId, 'FILE_REQUIRED', '缺少录音文件');
  const fileApi = dependencies.fileApi;
  const asrProvider = dependencies.asrProvider;
  const submitToken = createAsrSubmitToken(dependencies);
  const usageOperationId = createUsageOperationId({
    kind: 'asr', familyId, artifactId: recordingId, leaseId: submitToken,
    parameter: String(ASR_RESERVATION_SECONDS),
  });
  const recording = await repository.getRecording(familyId, dishId, recordingId);
  if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
  if (recording.status === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
  if (hasUnexpiredAsrTask(recording, now) || hasActiveSubmitLease(recording, now)) {
    throw createRecipeError('ASR_TASK_IN_PROGRESS', '这段录音正在识别，请稍后刷新');
  }
  if (!isSubmittableRecording(recording)) {
    throw createRecipeError('RECORDING_STATE_INVALID', '录音片段当前不能提交');
  }
  if (!fileIdMatchesCloudPath(fileId, recording.reservedCloudPath)) {
    throw createRecipeError('FILE_ACCESS_DENIED', '录音文件与预留路径不匹配', 'authorize');
  }
  const metadata = await trustedFileMetadata(fileApi, fileId);
  if (metadata.byteLength > MAX_AUDIO_BYTES) throw createRecipeError('FILE_TOO_LARGE', '录音文件不能超过 5 MB');
  if (metadata.durationMs > MAX_RECORDING_DURATION_MS) throw createRecipeError('RECORDING_LIMIT_EXCEEDED', '每段录音不能超过 3 分钟');
  if (metadata.format !== 'mp3' || recording.format !== 'mp3') {
    throw createRecipeError('RECORDING_FORMAT_INVALID', '录音格式必须为 MP3');
  }
  if (dependencies.asrProviderConfigured === false) {
    throw createRecipeError('ASR_NOT_CONFIGURED', '语音识别服务尚未配置');
  }
  const accepted = await repository.runTransaction(async (transaction) => {
    const current = await transaction.getRecording(familyId, dishId, recordingId);
    if (!current || current.status === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
    requireProvisionalArtifactOwner(current, member.memberId, authorization);
    if (hasUnexpiredAsrTask(current, now) || hasActiveSubmitLease(current, now)) {
      throw createRecipeError('ASR_TASK_IN_PROGRESS', '这段录音正在识别，请稍后刷新');
    }
    if (!isSubmittableRecording(current)) {
      throw createRecipeError('RECORDING_STATE_INVALID', '录音片段当前不能提交');
    }
    const state = await transaction.getWorkspaceState(familyId, dishId, current.recordId);
    requireProvisionalStateOwner(state, member.memberId, authorization);
    const recordings = await repository.listRecordings(familyId, dishId, current.recordId);
    const existingTotal = state
      ? Number(state.totalDurationMs) || 0
      : recordings.reduce((sum, item) => sum + (item._id === recordingId ? 0 : validDuration(item.durationMs)), 0);
    const previousDuration = current.durationCommitted ? validDuration(current.durationMs) : 0;
    const totalDuration = existingTotal - previousDuration + validDuration(metadata.durationMs);
    if (totalDuration > MAX_WORKSPACE_DURATION_MS) {
      throw createRecipeError('RECORDING_LIMIT_EXCEEDED', '单次制作录音累计不能超过 15 分钟');
    }
    await settleAsrReservationIfPresent(transaction, current, now);
    await transaction.reserveAsrUsage({
      familyId, seconds: ASR_RESERVATION_SECONDS, operationId: usageOperationId, now,
    });
    await transaction.setWorkspaceState(familyId, dishId, current.recordId, {
      ...(state || {}), familyId, dishId, recordId: current.recordId, sourceType: 'workspace_state',
      createdBy: state && state.createdBy || member.memberId,
      createdAt: state && state.createdAt != null ? state.createdAt : now,
      status: 'active', activeCount: state ? Number(state.activeCount) || 0 : recordings.filter((item) => item.status !== 'deleted').length,
      totalDurationMs: totalDuration, nextSequence: state ? Number(state.nextSequence) || nextSequence(recordings) : nextSequence(recordings),
      updatedAt: now,
    });
    return transaction.setRecording(recordingId, {
      ...current, fileId, byteLength: metadata.byteLength, durationMs: validDuration(metadata.durationMs), durationCommitted: true,
      status: 'uploading', asrTaskId: '', asrRequestId: '', asrSubmittedAt: null, asrExpiresAt: null,
      asrSubmitToken: submitToken, asrSubmitLeaseExpiresAt: now + ASR_SUBMIT_LEASE_MS,
      asrUsageOperationId: usageOperationId,
      asrUsageReservedAt: now,
      errorCode: '', updatedBy: member.memberId, updatedAt: now,
    });
  });
  let task = {};
  try {
    if (asrProvider && typeof asrProvider.submit === 'function') {
      const url = await temporaryFileUrl(fileApi, fileId);
      task = await asrProvider.submit({ url, fileId, recordingId });
    }
    requireAsrTaskId(task.taskId, 'ASR_SUBMIT_RESPONSE_INVALID');
  } catch (error) {
    const disposition = await repository.runTransaction(async (transaction) => {
      await transaction.releaseAsrUsage({
        familyId, operationId: usageOperationId, billingTimestamp: now, now: nowMs(dependencies),
      });
      const current = await transaction.getRecording(familyId, dishId, recordingId);
      if (!current || current.status === 'deleted') return 'deleted';
      if (current.status !== 'uploading' || current.asrSubmitToken !== submitToken) return 'lost';
      await transaction.setRecording(recordingId, {
        ...current, status: 'failed', asrSubmitToken: '', asrSubmitLeaseExpiresAt: null,
        errorCode: error && error.code === 'ASR_SUBMIT_RESPONSE_INVALID'
          ? 'ASR_SUBMIT_RESPONSE_INVALID' : 'ASR_SUBMIT_FAILED',
        updatedBy: member.memberId, updatedAt: now,
      });
      return 'owned';
    });
    if (disposition === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
    if (disposition === 'lost') throw createRecipeError('ASR_SUBMIT_LEASE_LOST', '录音提交已由新的请求接管');
    throw error;
  }
  const finalized = await repository.runTransaction(async (transaction) => {
    const current = await transaction.getRecording(familyId, dishId, recordingId);
    if (!current || current.status === 'deleted') {
      await transaction.settleAsrUsage({
        familyId, operationId: usageOperationId, actualSeconds: ASR_RESERVATION_SECONDS,
        billingTimestamp: now, now: nowMs(dependencies),
      });
      return { disposition: 'deleted', recording: current };
    }
    if (current.status !== 'uploading' || current.asrSubmitToken !== submitToken) {
      await transaction.settleAsrUsage({
        familyId, operationId: usageOperationId, actualSeconds: ASR_RESERVATION_SECONDS,
        billingTimestamp: now, now: nowMs(dependencies),
      });
      return { disposition: 'lost', recording: current };
    }
    const updated = await transaction.setRecording(recordingId, {
      ...current, status: 'transcribing', asrTaskId: requireAsrTaskId(task.taskId, 'ASR_SUBMIT_RESPONSE_INVALID'),
      asrRequestId: task.requestId || '',
      asrSubmittedAt: task.submittedAt == null ? now : task.submittedAt,
      asrExpiresAt: task.expiresAt == null ? null : task.expiresAt,
      asrSubmitToken: '', asrSubmitLeaseExpiresAt: null,
      errorCode: '', updatedBy: member.memberId, updatedAt: now,
    });
    return { disposition: 'owned', recording: updated };
  });
  if (finalized.disposition === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
  if (finalized.disposition === 'lost') throw createRecipeError('ASR_SUBMIT_LEASE_LOST', '录音提交已由新的请求接管');
  return { recording: finalized.recording };
}

async function refreshWorkspace(repository, member, familyId, dishId, rawRecordId, dependencies, now) {
  const recordId = requireValue(rawRecordId, 'RECORD_REQUIRED', '缺少制作记录');
  const asrProvider = dependencies.asrProvider;
  if (!asrProvider || typeof asrProvider.query !== 'function') {
    throw createRecipeError('ASR_UNAVAILABLE', '语音识别服务暂时不可用');
  }
  const candidates = (await repository.listRecordings(familyId, dishId, recordId))
    .filter((item) => item.status === 'transcribing' && item.asrTaskId !== '' && item.asrTaskId != null)
    .slice(0, 10);
  const refreshed = [];
  for (const candidate of candidates) {
    const generation = requireAsrTaskGeneration(candidate);
    const result = await asrProvider.query({
      taskId: generation.taskId,
      submittedAt: generation.submittedAt,
      expiresAt: candidate.asrExpiresAt,
    });
    const updated = await repository.runTransaction(async (transaction) => {
      const current = await transaction.getRecording(familyId, dishId, candidate._id);
      if (!current || current.status === 'deleted' || current.recordId !== recordId) return current;
      if (current.status !== 'transcribing' || !sameAsrTaskGeneration(current, generation)) return current;
      if (result.status === 'transcribing') {
        return transaction.setRecording(candidate._id, {
          ...current,
          asrRequestId: result.requestId || current.asrRequestId || '',
          updatedAt: now,
        });
      }
      if (result.status === 'ready') {
        const transcript = String(result.transcript || '').trim();
        const preserveEdit = Number(current.transcriptRevision) > 0 || String(current.editedTranscript || '').trim() !== '';
        if (current.asrUsageOperationId) {
          await transaction.settleAsrUsage({
            familyId,
            operationId: current.asrUsageOperationId,
            actualSeconds: Math.max(0, Number(result.durationMs) || 0) / 1000,
            billingTimestamp: current.asrUsageReservedAt,
            now,
          });
        }
        return transaction.setRecording(candidate._id, {
          ...current,
          status: 'ready',
          rawTranscript: transcript,
          editedTranscript: preserveEdit ? current.editedTranscript : transcript,
          asrRequestId: result.requestId || current.asrRequestId || '',
          errorCode: '',
          updatedBy: member.memberId,
          updatedAt: now,
        });
      }
      if (current.asrUsageOperationId) {
        await transaction.settleAsrUsage({
          familyId,
          operationId: current.asrUsageOperationId,
          actualSeconds: ASR_RESERVATION_SECONDS,
          billingTimestamp: current.asrUsageReservedAt,
          now,
        });
      }
      return transaction.setRecording(candidate._id, {
        ...current,
        status: 'failed',
        asrRequestId: result.requestId || current.asrRequestId || '',
        errorCode: result.errorCode || 'ASR_TASK_FAILED',
        updatedBy: member.memberId,
        updatedAt: now,
      });
    });
    if (updated && updated.status !== 'deleted') refreshed.push(updated);
  }
  return { recordings: refreshed };
}

function hasUnexpiredAsrTask(recording, now) {
  if (!recording || recording.status !== 'transcribing' || !recording.asrTaskId) return false;
  const expiresAt = Number(recording.asrExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function hasActiveSubmitLease(recording, now) {
  if (!recording || recording.status !== 'uploading' || !String(recording.asrSubmitToken || '')) return false;
  const expiresAt = Number(recording.asrSubmitLeaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

async function settleAsrReservationIfPresent(transaction, recording, now) {
  if (!recording || !recording.asrUsageOperationId) return;
  await transaction.settleAsrUsage({
    familyId: recording.familyId,
    operationId: recording.asrUsageOperationId,
    actualSeconds: ASR_RESERVATION_SECONDS,
    billingTimestamp: recording.asrUsageReservedAt,
    now,
  });
}

function isSubmittableRecording(recording) {
  return ['reserved', 'failed', 'transcribing', 'uploading'].includes(recording.status);
}

function createAsrSubmitToken(dependencies) {
  const generated = typeof dependencies.asrSubmitTokenGenerator === 'function'
    ? dependencies.asrSubmitTokenGenerator()
    : crypto.randomBytes(18).toString('base64url');
  const token = String(generated || '').trim();
  if (!token) throw createRecipeError('INTERNAL_ERROR', '菜谱服务暂时不可用');
  return token;
}

function requireAsrTaskId(value, code) {
  const taskId = normalizeSafeInteger(value, 1);
  if (taskId == null) {
    throw createRecipeError(code, '语音识别服务返回了无效任务');
  }
  return taskId;
}

function requireAsrTaskGeneration(recording) {
  const generation = normalizeAsrTaskGeneration(recording);
  if (!generation) {
    throw createRecipeError('ASR_TASK_GENERATION_INVALID', '语音识别任务信息无效');
  }
  return generation;
}

function sameAsrTaskGeneration(recording, expected) {
  const actual = normalizeAsrTaskGeneration(recording);
  return Boolean(actual
    && actual.taskId === expected.taskId
    && actual.submittedAt === expected.submittedAt);
}

function normalizeAsrTaskGeneration(recording) {
  const taskId = normalizeSafeInteger(recording && recording.asrTaskId, 1);
  const submittedAt = normalizeSafeInteger(recording && recording.asrSubmittedAt, 0);
  return taskId == null || submittedAt == null ? null : { taskId, submittedAt };
}

function normalizeSafeInteger(value, minimum) {
  const validType = typeof value === 'number'
    || (typeof value === 'string' && /^\d+$/.test(value));
  if (!validType) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum ? normalized : null;
}

async function addManualText(repository, member, familyId, dishId, event, dependencies, now, authorization) {
  const recordId = requireValue(event.recordId, 'RECORD_REQUIRED', '缺少制作记录');
  const text = requireValue(event.text, 'TEXT_REQUIRED', '请输入文字说明');
  const recordings = (await repository.listRecordings(familyId, dishId, recordId))
    .filter((item) => item.status !== 'deleted');
  const generated = typeof dependencies.idGenerator === 'function'
    ? dependencies.idGenerator()
    : `${now}-${Math.random().toString(36).slice(2, 10)}`;
  const recordingId = String(generated).startsWith('recording-') || String(generated).startsWith('manual-')
    ? String(generated) : `recording-${generated}`;
  if (authorization && authorization.kind === 'provisional') {
    await claimProvisionalWorkspace(
      dependencies.db, configFor(dependencies), familyId, dishId, recordId, member.memberId, now
    );
  }
  const recording = await runSegmentCreationTransaction(
    repository, dependencies, authorization, familyId, dishId, recordId, member.memberId,
    async (transaction) => {
      if (await transaction.getRecording(familyId, dishId, recordingId)) {
        throw createRecipeError('RECORDING_CONFLICT', '内容片段已存在，请重试');
      }
      const state = await transaction.getWorkspaceState(familyId, dishId, recordId);
      requireProvisionalStateOwner(state, member.memberId, authorization);
      const activeCount = state ? Number(state.activeCount) || 0 : recordings.length;
      if (activeCount >= MAX_RECORDINGS) throw createRecipeError('RECORDING_LIMIT_EXCEEDED', '每次制作最多保留 10 段内容');
      const sequence = state ? Number(state.nextSequence) || nextSequence(recordings) : nextSequence(recordings);
      await transaction.setWorkspaceState(familyId, dishId, recordId, {
        ...(state || {}), familyId, dishId, recordId, sourceType: 'workspace_state', status: 'active',
        createdBy: state && state.createdBy || member.memberId,
        createdAt: state && state.createdAt != null ? state.createdAt : now,
        activeCount: activeCount + 1,
        totalDurationMs: state ? Number(state.totalDurationMs) || 0 : recordings.reduce((sum, item) => sum + validDuration(item.durationMs), 0),
        nextSequence: sequence + 1, updatedAt: now,
      });
      return transaction.setRecording(recordingId, {
        familyId, dishId, recordId, sequence, sourceType: 'manual_text',
        fileId: '', durationMs: 0, durationCommitted: false, format: '', byteLength: 0, status: 'ready',
        rawTranscript: '', editedTranscript: text, transcriptRevision: 0, errorCode: '',
        createdBy: member.memberId, createdAt: now, updatedBy: member.memberId, updatedAt: now,
        audioDeletedAt: null, audioDeletePending: false, draftExpiresAt: now + RECORDING_TTL_MS,
      });
    },
  );
  return { recording };
}

async function updateTranscript(repository, member, familyId, dishId, event, now) {
  const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
  const revision = requireTranscriptRevision(event.transcriptRevision);
  const text = requireValue(event.text, 'TEXT_REQUIRED', '请输入转写文字');
  return repository.runTransaction(async (transaction) => {
    const recording = await transaction.getRecording(familyId, dishId, recordingId);
    if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
    if (recording.status === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
    if (recording.transcriptRevision !== revision) {
      throw createConflictError(
        'TRANSCRIPT_CONFLICT', '转写内容已被更新，请刷新后重试',
        recording, recording.transcriptRevision
      );
    }
    const updated = await transaction.setRecording(recordingId, {
      ...recording, editedTranscript: text, transcriptRevision: revision + 1,
      updatedBy: member.memberId, updatedAt: now,
    });
    return { recording: updated };
  });
}

async function attachRecordWorkspace(
  repository, member, familyId, dishId, rawRecordId, dependencies, now, authorization
) {
  const recordId = requireValue(rawRecordId, 'RECORD_REQUIRED', '缺少制作记录');
  await finishWorkspaceClaim(
    dependencies.db, configFor(dependencies), familyId, dishId, recordId, member.memberId, 'attached', now,
    { createIfMissing: Boolean(authorization && authorization.hasWorkspace) }
  );
  const recordings = await repository.listRecordings(familyId, dishId, recordId);
  for (const recording of recordings) {
    await repository.runTransaction(async (transaction) => {
      const current = await transaction.getRecording(familyId, dishId, recording._id);
      if (!current || current.status === 'deleted' || current.draftExpiresAt == null) return current;
      return transaction.setRecording(current._id, {
        ...current, draftExpiresAt: null, updatedBy: member.memberId, updatedAt: now,
      });
    });
  }
  const draft = await repository.getDraft({ familyId, dishId, recordId });
  if (draft) {
    await repository.runTransaction(async (transaction) => {
      const current = await transaction.getDraft({ familyId, dishId, draftId: draft._id, recordId });
      if (!current || current.status === 'cancelled' || current.draftExpiresAt == null) return current;
      return transaction.setDraft(current._id, { ...current, draftExpiresAt: null, updatedAt: now });
    });
  }
  return { attached: true };
}

async function cancelRecordWorkspace(repository, member, familyId, dishId, rawRecordId, dependencies, now, authorization) {
  const recordId = requireValue(rawRecordId, 'RECORD_REQUIRED', '缺少制作记录');
  const fileApi = dependencies.fileApi;
  await finishWorkspaceClaim(
    dependencies.db, configFor(dependencies), familyId, dishId, recordId, member.memberId, 'cancelled', now,
    { createIfMissing: Boolean(authorization
      && (authorization.kind === 'provisional' || authorization.hasWorkspace)) }
  );
  const recordings = await repository.listRecordings(familyId, dishId, recordId);
  for (const recording of recordings.filter((item) => item.status !== 'deleted' && item.draftExpiresAt != null)) {
    await tombstoneRecording(repository, member, recording, fileApi, now);
  }
  const draft = await repository.getDraft({ familyId, dishId, recordId });
  if (draft && draft.draftExpiresAt != null) await repository.setDraft(draft._id, { ...draft, status: 'cancelled', deletedAt: now, updatedAt: now });
  return { cancelled: true };
}

async function deleteRecordingAudio(repository, member, familyId, dishId, event, fileApi, now) {
  const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
  const recording = await repository.getRecording(familyId, dishId, recordingId);
  if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
  const prepared = await repository.runTransaction(async (transaction) => {
    const current = await transaction.getRecording(familyId, dishId, recordingId);
    if (!current) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
    if (current.status === 'deleted') throw createRecipeError('RECORDING_DELETED', '这个录音片段已删除');
    if (!String(current.editedTranscript || current.rawTranscript || '').trim()) {
      throw createRecipeError('TRANSCRIPT_REQUIRED', '删除语音前请先保留文字内容');
    }
    const cleanupFileId = String(current.fileId || '');
    if (!cleanupFileId) return { recording: current, cleanupFileId };
    const pending = await transaction.setRecording(recordingId, {
      ...current, audioDeletePending: true, updatedBy: member.memberId, updatedAt: now,
    });
    return { recording: pending, cleanupFileId };
  });
  if (!prepared.cleanupFileId) return { recording: prepared.recording };
  let pending = prepared.recording;
  try {
    await deleteCloudFile(fileApi, prepared.cleanupFileId);
    pending = await repository.runTransaction(async (transaction) => {
      const current = await transaction.getRecording(familyId, dishId, recordingId);
      if (!current || current.fileId !== prepared.cleanupFileId) return current || pending;
      return transaction.setRecording(recordingId, {
        ...current, fileId: '', audioDeletedAt: now, audioDeletePending: false,
        updatedBy: member.memberId, updatedAt: now,
      });
    });
  } catch (_) {
    // The durable pending flag makes the next call a safe retry.
  }
  return { recording: pending };
}

async function deleteRecording(repository, member, familyId, dishId, event, fileApi, now) {
  const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
  const recording = await repository.getRecording(familyId, dishId, recordingId);
  if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
  if (recording.status === 'deleted') {
    if (!recording.audioDeletePending || !recording.fileId) return { recording };
    try {
      await deleteCloudFile(fileApi, recording.fileId);
      const cleaned = await repository.setRecording(recordingId, {
        ...recording, fileId: '', audioDeletedAt: now, audioDeletePending: false,
        updatedBy: member.memberId, updatedAt: now,
      });
      return { recording: cleaned };
    } catch (_) {
      return { recording };
    }
  }
  return { recording: await tombstoneRecording(repository, member, recording, fileApi, now) };
}

async function tombstoneRecording(repository, member, recording, fileApi, now) {
  const prepared = await repository.runTransaction(async (transaction) => {
    const current = await transaction.getRecording(recording.familyId, recording.dishId, recording._id);
    if (!current) return { tombstone: recording, cleanupFileId: '' };
    const cleanupFileId = String(current.fileId || '');
    if (current.status === 'deleted') return { tombstone: current, cleanupFileId };
    const state = await transaction.getWorkspaceState(current.familyId, current.dishId, current.recordId);
    if (state) {
      await transaction.setWorkspaceState(current.familyId, current.dishId, current.recordId, {
        ...state,
        activeCount: Math.max(0, (Number(state.activeCount) || 0) - 1),
        totalDurationMs: Math.max(0, (Number(state.totalDurationMs) || 0)
          - (current.durationCommitted ? validDuration(current.durationMs) : 0)),
        updatedAt: now,
      });
    }
    await settleAsrReservationIfPresent(transaction, current, now);
    const tombstone = await transaction.setRecording(current._id, {
      ...current, status: 'deleted', deletedAt: now, audioDeletePending: Boolean(cleanupFileId),
      asrSubmitToken: '', asrSubmitLeaseExpiresAt: null,
      updatedBy: member.memberId, updatedAt: now,
    });
    return { tombstone, cleanupFileId };
  });
  let tombstone = prepared.tombstone;
  if (prepared.cleanupFileId) {
    try {
      await deleteCloudFile(fileApi, prepared.cleanupFileId);
      tombstone = await repository.runTransaction(async (transaction) => {
        const current = await transaction.getRecording(recording.familyId, recording.dishId, recording._id);
        if (!current || current.fileId !== prepared.cleanupFileId) return current || tombstone;
        return transaction.setRecording(recording._id, {
          ...current, fileId: '', audioDeletedAt: now, audioDeletePending: false,
          updatedBy: member.memberId, updatedAt: now,
        });
      });
    } catch (_) {
      // Keep the tombstone and retry marker; never resurrect deleted content.
    }
  }
  return tombstone;
}

function nextSequence(recordings) {
  return recordings.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1;
}

function validDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function fileIdMatchesCloudPath(fileId, cloudPath) {
  const expected = String(cloudPath || '');
  const value = String(fileId || '');
  if (!expected) return false;
  const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(value);
  return Boolean(match && match[1] === expected);
}

function fileIdBelongsToFamily(fileId, familyId) {
  const prefix = `families/${familyId}/recipe-audio/`;
  const value = String(fileId || '');
  const path = value.startsWith('cloud://') ? value.replace(/^cloud:\/\/[^/]+\//, '') : value;
  return path.startsWith(prefix) && path.endsWith('.mp3') && !path.slice(prefix.length).includes('/');
}

async function trustedFileMetadata(fileApi, fileId) {
  if (!fileApi || typeof fileApi.getFileInfo !== 'function') {
    throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  }
  try {
    const result = await fileApi.getFileInfo({ fileId });
    const info = result && (result.fileInfo || result.data || result);
    const trustedFileId = String(info && (info.fileId || info.fileID) || fileId);
    const byteLength = Number(info && (info.byteLength ?? info.size));
    const durationMs = Number(info && info.durationMs);
    const format = String(info && (info.format || info.extension) || fileId.split('.').pop() || '').toLowerCase();
    if (trustedFileId !== fileId || !Number.isFinite(byteLength) || byteLength < 0 || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('incomplete metadata');
    }
    return { byteLength, durationMs, format };
  } catch (error) {
    if (error && error.name === 'RecipeAssistantError') throw error;
    throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  }
}

async function temporaryFileUrl(fileApi, fileId) {
  if (!fileApi || typeof fileApi.getTempFileURL !== 'function') throw createRecipeError('FILE_ACCESS_DENIED', '无法读取录音文件');
  const response = await fileApi.getTempFileURL({ fileList: [fileId] });
  const entries = Array.isArray(response) ? response : response && response.fileList;
  const first = entries && entries[0];
  const url = String(first && (first.tempFileURL || first.tempFileUrl || first.url) || '');
  if (!url) throw createRecipeError('FILE_ACCESS_DENIED', '无法读取录音文件');
  return url;
}

async function deleteCloudFile(fileApi, fileId) {
  if (!fileApi || typeof fileApi.deleteFile !== 'function') throw new Error('file deletion unavailable');
  return fileApi.deleteFile({ fileList: [fileId] });
}

async function createManualDraft(repository, guards, member, familyId, dishId, event, now) {
  const sourceType = String(event.sourceType || 'manual').trim() || 'manual';
  if (!['manual', 'edit_main'].includes(sourceType)) {
    throw createRecipeError('SOURCE_TYPE_INVALID', '手动菜谱来源类型无效', 'validate');
  }
  const recordId = String(event.recordId || '').trim();
  if (recordId) await guards.requireCookingRecord(familyId, dishId, recordId);

  const pointer = await repository.getRecipePointer(familyId, dishId);
  const currentVersionId = String(pointer && pointer.currentVersionId || '');
  let recipe = emptyRecipe();
  if (sourceType === 'edit_main' && currentVersionId) {
    const currentVersion = await repository.getVersion(familyId, dishId, currentVersionId);
    if (!currentVersion) throw createRecipeError('VERSION_NOT_FOUND', '找不到当前菜谱版本');
    recipe = normalizeAndValidateRecipe(currentVersion.recipe);
  }
  const draft = await repository.setDraft('', {
    familyId,
    dishId,
    recordId,
    sourceRecordingIds: [],
    sourceType,
    status: 'editing',
    recipe,
    baseMainVersionId: currentVersionId,
    revision: 0,
    inputHash: '',
    modelProvider: '',
    modelName: '',
    promptVersion: '',
    lastErrorCode: '',
    confirmedVersionId: '',
    createdBy: member.memberId,
    createdAt: now,
    updatedBy: member.memberId,
    updatedAt: now,
  });
  return { draft };
}

async function organizeDraft(repository, member, familyId, dishId, event, dependencies, now) {
  const draftId = requireValue(event.draftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const sourceRecordingIds = uniqueRecordingIds(event.sourceRecordingIds);
  const modelName = configuredRecipeModel(dependencies);
  const promptVersion = configuredPromptVersion(dependencies);
  const leaseId = createOrganizeLeaseId(dependencies);

  await closeExpiredOrganizeReservation(repository, familyId, dishId, draftId, now);

  const acquired = await repository.runTransaction(async (transaction) => {
    const draft = await transaction.getDraft({ familyId, dishId, draftId });
    if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
    if (!String(draft.recordId || '').trim()) {
      throw createRecipeError('ACTION_INVALID', '这个草稿没有可整理的制作记录', 'validate');
    }
    if (draft.status === 'confirmed') {
      throw createConflictError(
        'DRAFT_CONFLICT', '菜谱草稿已经确认，不能重新整理', draft, draft.revision
      );
    }
    if (draft.status === 'cancelled') {
      throw createRecipeError('ACTION_INVALID', '这个菜谱草稿已经取消');
    }
    if (!sourceRecordingIds.length) {
      throw createRecipeError('SOURCE_REQUIRED', '请先选择要整理的文字片段', 'validate');
    }
    if (sourceRecordingIds.length > MAX_RECORDINGS) {
      throw createRecipeError('RECORDING_LIMIT_EXCEEDED', '每次制作最多保留 10 段录音', 'validate');
    }
    if (draft.status === 'organizing' && organizeLeaseIsActive(draft, now)) {
      throw createRecipeError('ORGANIZE_IN_PROGRESS', '菜谱正在整理，请稍后再试');
    }

    const recordings = await transaction.getRecordingsByIds(
      familyId, dishId, String(draft.recordId), sourceRecordingIds
    );
    if (recordings.some((recording) => !recording || recording.status === 'deleted')) {
      throw createRecipeError('RECORDING_NOT_FOUND', '找不到选中的录音片段', 'authorize');
    }
    if (recordings.some((recording) => recording.status !== 'ready')) {
      throw createRecipeError('RECORDINGS_PENDING', '还有录音片段尚未完成转写');
    }

    const orderedRecordings = recordings.slice().sort(compareRecordingSequence);
    const sourceCharacterCount = orderedRecordings.reduce(
      (count, recording) => count + Array.from(String(recording.editedTranscript || '').trim()).length,
      0,
    );
    if (sourceCharacterCount === 0) {
      throw createRecipeError('SOURCE_REQUIRED', '请先补充要整理的文字内容', 'validate');
    }
    if (sourceCharacterCount > MAX_SOURCE_CHARACTERS) {
      throw createRecipeError('SOURCE_TOO_LONG', '整理文字不能超过 30000 个字符', 'validate');
    }
    const sourceText = buildSourceText(orderedRecordings);
    const inputHash = createInputHash({ sourceText, modelName, promptVersion });
    if (draft.status === 'ready' && draft.inputHash === inputHash) {
      return { reused: true, draft };
    }
    recipeProviderFor(dependencies, modelName, promptVersion);
    const usageOperationId = createUsageOperationId({
      kind: 'organize', familyId, artifactId: draftId, leaseId, parameter: inputHash,
    });
    await transaction.reserveOrganizeUsage({ familyId, operationId: usageOperationId, now });

    const organizingDraft = await transaction.setDraft(draftId, {
      ...draft,
      sourceType: 'recording',
      sourceRecordingIds: orderedRecordings.map((recording) => recording._id),
      status: 'organizing',
      inputHash,
      organizeLeaseId: leaseId,
      organizeLeaseExpiresAt: now + ORGANIZE_LEASE_MS,
      organizeUsageOperationId: usageOperationId,
      organizeUsageReservedAt: now,
      organizeRequestIssuedAt: null,
      modelProvider: 'tokenhub',
      modelName,
      promptVersion,
      modelRequestId: '',
      modelUsage: {},
      lastErrorCode: '',
      updatedBy: member.memberId,
      updatedAt: now,
    });
    return {
      reused: false, draft: organizingDraft, sourceText, inputHash, leaseId,
      usageOperationId, usageReservedAt: now,
    };
  });

  if (acquired.reused) return { draft: acquired.draft, reused: true };

  let requestIssued = false;
  try {
    const provider = recipeProviderFor(dependencies, modelName, promptVersion);
    const issued = await markOrganizeRequestIssued(
      repository, familyId, dishId, draftId, acquired, nowMs(dependencies)
    );
    if (issued.stale) return { draft: issued.draft, stale: true };
    requestIssued = true;
    const result = await provider.organize({
      sourceText: acquired.sourceText,
      userId: familyModelUserId(familyId),
    });
    const recipe = normalizeAndValidateRecipe(result && result.recipe);
    return repository.runTransaction(async (transaction) => {
      const current = await transaction.getDraft({ familyId, dishId, draftId });
      if (!current) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
      await transaction.settleOrganizeUsage({
        familyId, operationId: acquired.usageOperationId,
        billingTimestamp: acquired.usageReservedAt, now: nowMs(dependencies),
      });
      if (!organizeLeaseMatches(current, acquired.leaseId, acquired.inputHash)) {
        return { draft: current, stale: true };
      }
      const readyDraft = clearOrganizeLease({
        ...current,
        status: 'ready',
        recipe,
        revision: (Number(current.revision) || 0) + 1,
        modelProvider: 'tokenhub',
        modelName: String(result && result.modelName || modelName).slice(0, 200),
        promptVersion,
        modelRequestId: String(result && result.requestId || '').slice(0, 200),
        modelUsage: sanitizeTokenUsage(result && result.usage),
        lastErrorCode: '',
        updatedBy: member.memberId,
        updatedAt: nowMs(dependencies),
      });
      return { draft: await transaction.setDraft(draftId, readyDraft), stale: false };
    });
  } catch (error) {
    if (error && error.requestIssued === false) requestIssued = false;
    const errorCode = safeOrganizeErrorCode(error);
    const failed = await repository.runTransaction(async (transaction) => {
      const current = await transaction.getDraft({ familyId, dishId, draftId });
      if (!current) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
      const usageInput = {
        familyId, operationId: acquired.usageOperationId,
        billingTimestamp: acquired.usageReservedAt, now: nowMs(dependencies),
      };
      if (requestIssued) await transaction.settleOrganizeUsage(usageInput);
      else await transaction.releaseOrganizeUsage(usageInput);
      if (!organizeLeaseMatches(current, acquired.leaseId, acquired.inputHash)) {
        return { draft: current, stale: true };
      }
      const failedDraft = clearOrganizeLease({
        ...current,
        status: 'failed',
        lastErrorCode: errorCode,
        updatedBy: member.memberId,
        updatedAt: nowMs(dependencies),
      });
      return { draft: await transaction.setDraft(draftId, failedDraft), stale: false };
    });
    if (failed.stale) return failed;
    throw createRecipeError(errorCode, organizeErrorMessage(errorCode));
  }
}

async function closeExpiredOrganizeReservation(repository, familyId, dishId, draftId, now) {
  return repository.runTransaction(async (transaction) => {
    const draft = await transaction.getDraft({ familyId, dishId, draftId });
    if (!draft || draft.status !== 'organizing' || organizeLeaseIsActive(draft, now)) return draft;
    const operationId = String(draft.organizeUsageOperationId || '').trim();
    if (!operationId) return draft;
    const usageInput = {
      familyId,
      operationId,
      billingTimestamp: timestampMs(draft.organizeUsageReservedAt) || now,
      now,
    };
    if (draft.organizeRequestIssuedAt == null) {
      await transaction.releaseOrganizeUsage(usageInput);
    } else {
      await transaction.settleOrganizeUsage(usageInput);
    }
    return draft;
  });
}

async function markOrganizeRequestIssued(repository, familyId, dishId, draftId, acquired, now) {
  return repository.runTransaction(async (transaction) => {
    const current = await transaction.getDraft({ familyId, dishId, draftId });
    if (!current) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
    if (!organizeLeaseMatches(current, acquired.leaseId, acquired.inputHash)) {
      await transaction.releaseOrganizeUsage({
        familyId,
        operationId: acquired.usageOperationId,
        billingTimestamp: acquired.usageReservedAt,
        now,
      });
      return { draft: current, stale: true };
    }
    const draft = await transaction.setDraft(draftId, {
      ...current,
      organizeRequestIssuedAt: now,
    });
    return { draft, stale: false };
  });
}

function uniqueRecordingIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function compareRecordingSequence(left, right) {
  const leftSequence = Number(left && left.sequence);
  const rightSequence = Number(right && right.sequence);
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return String(left && left._id || '').localeCompare(String(right && right._id || ''));
}

function configuredRecipeModel(dependencies) {
  const modelName = String(
    Object.hasOwn(dependencies, 'recipeModel')
      ? dependencies.recipeModel
      : process.env.RECIPE_MODEL || DEFAULT_RECIPE_MODEL,
  ).trim() || DEFAULT_RECIPE_MODEL;
  if (!ALLOWED_RECIPE_MODELS.includes(modelName)) {
    throw createRecipeError('AI_NOT_CONFIGURED', 'AI 整理服务尚未正确配置');
  }
  return modelName;
}

function configuredPromptVersion(dependencies) {
  return String(
    Object.hasOwn(dependencies, 'recipePromptVersion')
      ? dependencies.recipePromptVersion
      : process.env.RECIPE_PROMPT_VERSION || DEFAULT_RECIPE_PROMPT_VERSION,
  ).trim() || DEFAULT_RECIPE_PROMPT_VERSION;
}

function createOrganizeLeaseId(dependencies) {
  const generated = typeof dependencies.organizeLeaseIdGenerator === 'function'
    ? dependencies.organizeLeaseIdGenerator()
    : crypto.randomUUID();
  const value = String(generated || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw createRecipeError('INTERNAL_ERROR', '无法创建整理任务');
  }
  return `organize-${value.replace(/^organize-/, '')}`;
}

function organizeLeaseIsActive(draft, now) {
  return Boolean(String(draft && draft.organizeLeaseId || '').trim())
    && timestampMs(draft && draft.organizeLeaseExpiresAt) > now;
}

function organizeLeaseMatches(draft, leaseId, inputHash) {
  return draft && draft.status === 'organizing'
    && draft.organizeLeaseId === leaseId
    && draft.inputHash === inputHash;
}

function clearOrganizeLease(draft) {
  const cleaned = { ...draft };
  delete cleaned.organizeLeaseId;
  delete cleaned.organizeLeaseExpiresAt;
  delete cleaned.organizeRequestIssuedAt;
  return cleaned;
}

function timestampMs(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recipeProviderFor(dependencies, modelName, promptVersion) {
  if (!ALLOWED_RECIPE_MODELS.includes(modelName)) {
    throw createRecipeError('AI_NOT_CONFIGURED', 'AI 整理服务尚未正确配置');
  }
  if (dependencies.recipeProviderConfigured === false) {
    throw createRecipeError('AI_NOT_CONFIGURED', 'AI 整理服务尚未正确配置');
  }
  const provider = dependencies.recipeProvider
    || getProductionRecipeProvider(modelName, promptVersion);
  if (!provider || typeof provider.organize !== 'function') {
    throw createRecipeError('AI_NOT_CONFIGURED', 'AI 整理服务尚未正确配置');
  }
  return provider;
}

function familyModelUserId(familyId) {
  return crypto.createHash('sha256').update(String(familyId || ''), 'utf8').digest('hex');
}

function safeOrganizeErrorCode(error) {
  const code = runtimeErrorCode(error);
  if (code === 'RECIPE_INVALID') return 'AI_OUTPUT_INVALID';
  return [
    'AI_NOT_CONFIGURED', 'AI_HTTP_ERROR', 'AI_OUTPUT_INVALID', 'AI_OUTPUT_TOO_LARGE',
  ].includes(code) ? code : 'INTERNAL_ERROR';
}

function organizeErrorMessage(code) {
  const messages = {
    AI_NOT_CONFIGURED: 'AI 整理服务尚未配置',
    AI_HTTP_ERROR: 'AI 整理服务暂时不可用',
    AI_OUTPUT_INVALID: 'AI 整理结果不符合要求，请重试或手动编辑',
    AI_OUTPUT_TOO_LARGE: 'AI 整理结果过长，请精简文字后重试',
    INTERNAL_ERROR: '菜谱整理暂时失败，请稍后重试',
  };
  return messages[code] || messages.INTERNAL_ERROR;
}

async function getDraft(repository, familyId, dishId, rawDraftId) {
  const draftId = requireValue(rawDraftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const draft = await repository.getDraft({ familyId, dishId, draftId });
  if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
  return { draft };
}

async function updateDraft(repository, member, familyId, dishId, event, now) {
  const draftId = requireValue(event.draftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const revision = requireRevision(event.revision);
  const recipe = normalizeAndValidateRecipe(event.recipe);
  const hasBaseMainVersionId = Object.prototype.hasOwnProperty.call(event, 'baseMainVersionId');
  const baseMainVersionId = hasBaseMainVersionId
    ? String(event.baseMainVersionId || '').trim()
    : undefined;
  return repository.runTransaction(async (transaction) => {
    const draft = await transaction.getDraft({ familyId, dishId, draftId });
    if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
    if (draft.revision !== revision || draft.status === 'confirmed' || draft.status === 'organizing') {
      throw createConflictError(
        'DRAFT_CONFLICT', '菜谱草稿已被更新，请刷新后重试', draft, draft.revision
      );
    }
    const updated = await transaction.setDraft(draftId, {
      ...draft,
      recipe,
      ...(hasBaseMainVersionId ? { baseMainVersionId } : {}),
      revision: revision + 1,
      updatedBy: member.memberId,
      updatedAt: now,
    });
    return { draft: updated };
  });
}

async function confirmDraft(repository, member, familyId, dishId, event, now) {
  const draftId = requireValue(event.draftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const revision = requireRevision(event.revision);
  const publishAsMain = event.publishAsMain === true;
  const baseMainVersionId = String(event.baseMainVersionId || '').trim();
  return repository.runTransaction(async (transaction) => {
    const draft = await transaction.getDraft({ familyId, dishId, draftId });
    const pointer = await transaction.getRecipePointer(familyId, dishId);
    if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
    if (draft.status === 'organizing') {
      throw createConflictError(
        'DRAFT_CONFLICT', '菜谱正在整理，请稍后再确认', draft, draft.revision
      );
    }
    if (draft.revision !== revision) {
      throw createConflictError(
        'DRAFT_CONFLICT', '菜谱草稿已被更新，请刷新后重试', draft, draft.revision
      );
    }
    if (draft.status === 'confirmed' && draft.confirmedVersionId) {
      const version = await transaction.getVersion(familyId, dishId, draft.confirmedVersionId);
      if (!version) throw createRecipeError('VERSION_NOT_FOUND', '找不到已确认的菜谱版本');
      return { draft, version, pointer };
    }

    const recipe = normalizeAndValidateRecipe(draft.recipe);
    const previousMainVersionId = String(pointer && pointer.currentVersionId || '');
    const updatesExistingMain = Boolean(pointer && previousMainVersionId && publishAsMain);
    if (updatesExistingMain && baseMainVersionId !== previousMainVersionId) {
      throw createConflictError(
        'MAIN_RECIPE_CONFLICT', '主菜谱已被更新，请刷新后重试',
        pointer, pointer && pointer.currentVersionNumber
      );
    }

    const pointerVersionNumber = pointer ? Number(pointer.currentVersionNumber) || 0 : 0;
    const latestVersionNumber = pointer ? Number(pointer.latestVersionNumber) || 0 : 0;
    const versionNumber = Math.max(latestVersionNumber, pointerVersionNumber) + 1;
    const shouldPublishAsMain = !pointer || !previousMainVersionId || publishAsMain;
    const version = await transaction.createVersion({
      familyId,
      dishId,
      recordId: String(draft.recordId || ''),
      versionNumber,
      recipe,
      sourceDraftId: draftId,
      publishedAsMain: shouldPublishAsMain,
      previousMainVersionId,
      confirmedBy: member.memberId,
      confirmedAt: now,
    });

    const nextPointer = await transaction.setRecipePointer(familyId, dishId, {
      ...(pointer || {}),
      familyId,
      dishId,
      currentVersionId: shouldPublishAsMain ? version._id : previousMainVersionId,
      currentVersionNumber: shouldPublishAsMain ? versionNumber : pointerVersionNumber,
      latestVersionNumber: versionNumber,
      createdAt: pointer && pointer.createdAt != null ? pointer.createdAt : now,
      updatedBy: member.memberId,
      updatedAt: now,
    });
    const confirmedDraft = await transaction.setDraft(draftId, {
      ...draft,
      recipe,
      status: 'confirmed',
      confirmedVersionId: version._id,
      updatedBy: member.memberId,
      updatedAt: now,
    });
    return { draft: confirmedDraft, version, pointer: nextPointer };
  });
}

function emptyRecipe() {
  return { ingredients: [], steps: [], tips: [], failures: [], familyNotes: [], uncertainties: [] };
}

function normalizeAndValidateRecipe(value) {
  const validation = validateRecipe(value);
  if (!validation.ok) throw createRecipeError('RECIPE_INVALID', '菜谱内容不符合要求', 'validate');
  return normalizeRecipe(value);
}

async function authorizeRecordScope(action, event, member, dish, familyId, dishId, repository, guards, db, config) {
  if (!RECORD_SCOPED_ACTIONS.includes(action)) return null;
  if (RECORD_ID_ACTIONS.includes(action)) {
    const recordId = requireValue(event.recordId, 'RECORD_REQUIRED', '缺少制作记录');
    if (action === 'attachRecordWorkspace') {
      await guards.requireCookingRecord(familyId, dishId, recordId);
      const workspace = await inspectWorkspace(repository, db, config, familyId, dishId, recordId);
      requireWorkspaceOwner(workspace, member.memberId, { provisional: false });
      return { kind: 'saved', recordId, hasWorkspace: workspace.hasWorkspace };
    }

    const cookingRecord = await findCookingRecord(guards, familyId, dishId, recordId);
    if (cookingRecord) {
      const workspace = await inspectWorkspace(repository, db, config, familyId, dishId, recordId);
      requireWorkspaceOwner(workspace, member.memberId, { provisional: false });
      return { kind: 'saved', recordId, hasWorkspace: workspace.hasWorkspace };
    }

    requireProvisionalRecordId(recordId);
    requireActiveProvisionalDish(dish);
    const workspace = await inspectWorkspace(repository, db, config, familyId, dishId, recordId);
    requireWorkspaceOwner(workspace, member.memberId, {
      provisional: true,
      allowCancelled: action === 'cancelRecordWorkspace',
    });
    return { kind: 'provisional', recordId, hasWorkspace: workspace.hasWorkspace };
  }
  if (RECORD_ACTION_CONTRACTS.recordingId.includes(action)) {
    const recordingId = requireValue(event.recordingId, 'RECORDING_REQUIRED', '缺少录音片段');
    const recording = await repository.getRecording(familyId, dishId, recordingId);
    if (!recording) throw createRecipeError('RECORDING_NOT_FOUND', '找不到这个录音片段', 'authorize');
    const recordId = String(recording.recordId || '').trim();
    const cookingRecord = await findCookingRecord(guards, familyId, dishId, recordId);
    const workspace = await inspectWorkspace(repository, db, config, familyId, dishId, recordId);
    if (cookingRecord) {
      requireWorkspaceOwner(workspace, member.memberId, { provisional: false });
      return { kind: 'saved', recordId, recordingId, hasWorkspace: true };
    }

    requireProvisionalRecordId(recordId);
    requireActiveProvisionalDish(dish);
    requireProvisionalArtifactOwner(recording, member.memberId, { kind: 'provisional' });
    requireWorkspaceOwner(workspace, member.memberId, { provisional: true });
    return { kind: 'provisional', recordId, recordingId, hasWorkspace: true };
  }
  const draftId = requireValue(event.draftId, 'DRAFT_REQUIRED', '缺少菜谱草稿');
  const draft = await repository.getDraft(familyId, dishId, draftId);
  if (!draft) throw createRecipeError('DRAFT_NOT_FOUND', '找不到这个菜谱草稿', 'authorize');
  const recordId = String(draft.recordId || '').trim();
  if (recordId) await guards.requireCookingRecord(familyId, dishId, recordId);
  return { kind: recordId ? 'saved' : 'manual', recordId, draftId, hasWorkspace: true };
}

async function findCookingRecord(guards, familyId, dishId, recordId) {
  try {
    return await guards.requireCookingRecord(familyId, dishId, recordId);
  } catch (error) {
    if (runtimeErrorCode(error) === 'RECORD_NOT_FOUND') return null;
    throw error;
  }
}

function requireProvisionalRecordId(recordId) {
  if (/^record-\d{10,16}-\d{1,9}$/.test(String(recordId || ''))) return recordId;
  if (String(recordId || '').startsWith('record-')) throw workspaceNotFound();
  throw createRecipeError('RECORD_ID_INVALID', '制作记录编号无效', 'authorize');
}

function requireActiveProvisionalDish(dish) {
  if (dish && dish.status === 'active') return;
  throw createRecipeError('DISH_DELETED', '这道菜已进入回收站', 'authorize');
}

async function inspectWorkspace(repository, db, config, familyId, dishId, recordId) {
  const [claim, recordings, draft] = await Promise.all([
    getWorkspaceClaim(db, config, recordId),
    repository.listRecordings(familyId, dishId, recordId),
    repository.getDraft({ familyId, dishId, recordId }),
  ]);
  return {
    claim,
    recordings,
    draft,
    familyId,
    dishId,
    recordId,
    hasWorkspace: Boolean(claim || recordings.length || draft),
  };
}

function requireWorkspaceOwner(workspace, memberId, options) {
  const { claim, recordings, draft, familyId, dishId, recordId } = workspace;
  if (claim) {
    if (claim.workspaceFamilyId !== familyId
      || claim.workspaceDishId !== dishId
      || claim.workspaceRecordId !== recordId) throw workspaceNotFound();
    const validProvisionalStatus = claim.status === 'temporary'
      || (options.allowCancelled && claim.status === 'cancelled');
    if (options.provisional && !validProvisionalStatus) throw workspaceNotFound();
    if ((options.provisional || claim.status === 'temporary') && claim.createdBy !== memberId) {
      throw workspaceNotFound();
    }
  }
  for (const recording of recordings) {
    if (options.provisional && recording.draftExpiresAt == null) throw workspaceNotFound();
    if (recording.draftExpiresAt != null && recording.createdBy !== memberId) throw workspaceNotFound();
  }
  if (draft) {
    if (options.provisional && draft.draftExpiresAt == null) throw workspaceNotFound();
    if (draft.draftExpiresAt != null && draft.createdBy !== memberId) throw workspaceNotFound();
  }
}

function requireProvisionalArtifactOwner(artifact, memberId, authorization) {
  if (!authorization || authorization.kind !== 'provisional') return;
  if (!artifact || artifact.draftExpiresAt == null || artifact.createdBy !== memberId) throw workspaceNotFound();
}

function requireProvisionalStateOwner(state, memberId, authorization) {
  if (!authorization || authorization.kind !== 'provisional' || !state) return;
  if (state.createdBy !== memberId) throw workspaceNotFound();
}

function workspaceNotFound() {
  return createRecipeError('RECORD_NOT_FOUND', '找不到这次制作记录', 'authorize');
}

function workspaceClaimDocumentId(recordId) {
  return `workspace-claim-${recordId}`;
}

async function getWorkspaceClaim(db, config, recordId) {
  const claim = await getDocument(db, config.recordingCollection, workspaceClaimDocumentId(recordId));
  return claim && claim.sourceType === 'workspace_state' && claim.workspaceClaim === true
    && claim.workspaceRecordId === recordId ? claim : null;
}

async function claimProvisionalWorkspace(db, config, familyId, dishId, recordId, memberId, now) {
  requireProvisionalRecordId(recordId);
  if (!db || typeof db.runTransaction !== 'function') {
    throw createRecipeError('DATABASE_UNAVAILABLE', '菜谱服务暂时不可用', 'authorize');
  }
  const claimId = workspaceClaimDocumentId(recordId);
  return db.runTransaction(async (transaction) => {
    const current = await getDocument(transaction, config.recordingCollection, claimId);
    if (current) {
      if (current.sourceType !== 'workspace_state'
        || current.workspaceClaim !== true
        || current.workspaceFamilyId !== familyId
        || current.workspaceDishId !== dishId
        || current.workspaceRecordId !== recordId
        || current.status !== 'temporary'
        || current.createdBy !== memberId) throw workspaceNotFound();
      return current;
    }
    const claim = {
      familyId, dishId, recordId, sourceType: 'workspace_state', workspaceClaim: true,
      workspaceFamilyId: familyId, workspaceDishId: dishId,
      workspaceRecordId: recordId, status: 'temporary', createdBy: memberId,
      createdAt: now, updatedBy: memberId, updatedAt: now, draftExpiresAt: now + RECORDING_TTL_MS,
    };
    await transaction.collection(config.recordingCollection).doc(claimId).set({ data: claim });
    return { ...claim, _id: claimId };
  });
}

async function runSegmentCreationTransaction(
  repository, dependencies, authorization, familyId, dishId, recordId, memberId, callback
) {
  if (!authorization || authorization.kind !== 'provisional') {
    return repository.runTransaction(callback);
  }
  const db = dependencies.db;
  const config = configFor(dependencies);
  if (!db || typeof db.runTransaction !== 'function') {
    throw createRecipeError('DATABASE_UNAVAILABLE', '菜谱服务暂时不可用', 'authorize');
  }
  const claimId = workspaceClaimDocumentId(recordId);
  return db.runTransaction(async (transaction) => {
    const claim = await getDocument(transaction, config.recordingCollection, claimId);
    if (!claim
      || claim.sourceType !== 'workspace_state'
      || claim.workspaceClaim !== true
      || claim.familyId !== familyId
      || claim.dishId !== dishId
      || claim.recordId !== recordId
      || claim.workspaceFamilyId !== familyId
      || claim.workspaceDishId !== dishId
      || claim.workspaceRecordId !== recordId
      || claim.status !== 'temporary'
      || claim.createdBy !== memberId) throw workspaceNotFound();
    return callback(createRecipeRepository(transaction, config));
  });
}

async function finishWorkspaceClaim(
  db, config, familyId, dishId, recordId, memberId, status, now, options = {}
) {
  if (!db || typeof db.runTransaction !== 'function') return;
  const claimId = workspaceClaimDocumentId(recordId);
  return db.runTransaction(async (transaction) => {
    const current = await getDocument(transaction, config.recordingCollection, claimId);
    if (!current) {
      if (!options.createIfMissing) return null;
      const claim = {
        familyId, dishId, recordId, sourceType: 'workspace_state', workspaceClaim: true,
        workspaceFamilyId: familyId, workspaceDishId: dishId,
        workspaceRecordId: recordId, status, createdBy: memberId,
        createdAt: now, updatedBy: memberId, updatedAt: now,
        draftExpiresAt: status === 'attached' ? null : now + RECORDING_TTL_MS,
      };
      await transaction.collection(config.recordingCollection).doc(claimId).set({ data: claim });
      return { ...claim, _id: claimId };
    }
    if (current.sourceType !== 'workspace_state'
      || current.workspaceClaim !== true
      || current.workspaceFamilyId !== familyId
      || current.workspaceDishId !== dishId
      || current.workspaceRecordId !== recordId) throw workspaceNotFound();
    if (current.status === 'temporary' || current.status === 'cancelled') {
      if (current.createdBy !== memberId) throw workspaceNotFound();
    }
    if (current.status === status) return current;
    if (current.status !== 'temporary') throw workspaceNotFound();
    const updated = {
      ...current, status, updatedBy: memberId, updatedAt: now,
      draftExpiresAt: status === 'attached' ? null : current.draftExpiresAt,
    };
    await transaction.collection(config.recordingCollection).doc(claimId).set({ data: sanitizeSystemId(updated) });
    return updated;
  });
}

function sanitizeSystemId(document) {
  const { _id, ...data } = document || {};
  return data;
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
    const fileApi = createCloudFileApi(cloud);
    const asrProvider = {
      submit(input) {
        try {
          return getProductionAsrProvider().submit(input);
        } catch (error) {
          error.requestIssued = false;
          throw error;
        }
      },
      query(input) { return getProductionAsrProvider().query(input); },
    };
    const recipeProvider = {
      async organize(input) {
        try {
          return await getProductionRecipeProvider().organize(input);
        } catch (error) {
          if (runtimeErrorCode(error) === 'AI_NOT_CONFIGURED') error.requestIssued = false;
          throw error;
        }
      },
    };
    return handleAction(event, requestContext, {
      db,
      fileApi,
      asrProvider,
      asrProviderConfigured: productionAsrConfigured(process.env),
      recipeProvider,
      recipeProviderConfigured: Boolean(String(process.env.TOKENHUB_API_KEY || '').trim()),
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
    return { ok: false, error: publicErrorPayload(error) };
  }
}

function productionAsrConfigured(env = {}) {
  const runtimeId = env.TENCENTCLOUD_SECRETID || env.TENCENTCLOUD_SECRET_ID;
  const runtimeKey = env.TENCENTCLOUD_SECRETKEY || env.TENCENTCLOUD_SECRET_KEY;
  const dedicatedId = env.ASR_SECRET_ID;
  const dedicatedKey = env.ASR_SECRET_KEY;
  return Boolean((runtimeId && runtimeKey) || (dedicatedId && dedicatedKey));
}

function getProductionAsrProvider() {
  if (!productionAsrProvider) productionAsrProvider = createTencentAsrProvider();
  return productionAsrProvider;
}

function getProductionRecipeProvider(
  modelName = process.env.RECIPE_MODEL || DEFAULT_RECIPE_MODEL,
  promptVersion = process.env.RECIPE_PROMPT_VERSION || DEFAULT_RECIPE_PROMPT_VERSION,
) {
  const key = JSON.stringify([String(modelName), String(promptVersion), String(process.env.TOKENHUB_API_KEY || '')]);
  if (!productionRecipeProvider || productionRecipeProviderKey !== key) {
    productionRecipeProvider = createTokenHubProvider({ model: modelName, promptVersion });
    productionRecipeProviderKey = key;
  }
  return productionRecipeProvider;
}

function createCloudFileApi(cloud) {
  const api = {
    async getFileInfo({ fileId }) {
      if (!cloud || typeof cloud.downloadFile !== 'function') {
        throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
      }
      try {
        const result = await cloud.downloadFile({ fileID: fileId });
        const content = Buffer.isBuffer(result) ? result : result && result.fileContent;
        if (!Buffer.isBuffer(content)) throw new Error('downloaded content is not a Buffer');
        if (content.length > MAX_AUDIO_BYTES) throw createRecipeError('FILE_TOO_LARGE', '录音文件不能超过 5 MB');
        const durationMs = parseMp3Duration(content);
        return { fileId, byteLength: content.length, format: 'mp3', durationMs };
      } catch (error) {
        if (error && error.name === 'RecipeAssistantError') throw error;
        throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
      }
    },
  };
  if (cloud && typeof cloud.getTempFileURL === 'function') {
    api.getTempFileURL = (input) => cloud.getTempFileURL(input);
  }
  if (cloud && typeof cloud.deleteFile === 'function') {
    api.deleteFile = (input) => cloud.deleteFile(input);
  }
  return api;
}

function parseMp3Duration(content) {
  let offset = skipId3v2(content);
  let frameCount = 0;
  let durationMs = 0;
  while (offset < content.length) {
    if (content.length - offset === 128 && content.toString('ascii', offset, offset + 3) === 'TAG') {
      offset = content.length;
      break;
    }
    const frame = parseMp3FrameHeader(content, offset);
    if (!frame || offset + frame.byteLength > content.length) {
      throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
    }
    frameCount += 1;
    durationMs += (frame.samplesPerFrame * 1000) / frame.sampleRateHz;
    offset += frame.byteLength;
  }
  if (frameCount < 2 || offset !== content.length) {
    throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  }
  return Math.round(durationMs);
}

function skipId3v2(content) {
  if (content.length < 3 || content.toString('ascii', 0, 3) !== 'ID3') return 0;
  if (content.length < 10) throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  const sizeBytes = [content[6], content[7], content[8], content[9]];
  if (sizeBytes.some((value) => value > 0x7f)) throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  const tagSize = sizeBytes.reduce((size, value) => (size << 7) | value, 0);
  const footerSize = (content[5] & 0x10) !== 0 ? 10 : 0;
  const offset = 10 + tagSize + footerSize;
  if (offset > content.length) throw createRecipeError('FILE_METADATA_UNAVAILABLE', '无法验证录音文件');
  return offset;
}

function parseMp3FrameHeader(content, offset) {
  if (offset + 4 > content.length) return null;
  const header = content.readUInt32BE(offset);
  if ((header >>> 21) !== 0x7ff) return null;
  const versionBits = (header >>> 19) & 0x3;
  const layerBits = (header >>> 17) & 0x3;
  const bitrateIndex = (header >>> 12) & 0xf;
  const sampleRateIndex = (header >>> 10) & 0x3;
  const padding = (header >>> 9) & 0x1;
  if (versionBits === 0x1 || layerBits !== 0x1 || bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 0x3) {
    return null;
  }
  const version = versionBits === 0x3 ? 1 : versionBits === 0x2 ? 2 : 2.5;
  const bitrateTable = version === 1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRateTable = version === 1
    ? [44100, 48000, 32000]
    : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const bitrateKbps = bitrateTable[bitrateIndex];
  const sampleRateHz = sampleRateTable[sampleRateIndex];
  const samplesPerFrame = version === 1 ? 1152 : 576;
  const coefficient = version === 1 ? 144000 : 72000;
  const byteLength = Math.floor((coefficient * bitrateKbps) / sampleRateHz) + padding;
  return byteLength >= 4 ? { byteLength, sampleRateHz, samplesPerFrame } : null;
}

module.exports = {
  DEFAULT_CONFIG,
  RECORD_ACTION_CONTRACTS,
  RECORD_ID_ACTIONS,
  RECORD_SCOPED_ACTIONS,
  buildSourceText,
  createInputHash,
  createCloudFileApi,
  createGuards,
  handleAction,
  main,
  publicMessage,
  runtimeErrorCode,
};
