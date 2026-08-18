const crypto = require('node:crypto');

const BILLING_TIMEZONE = 'Asia/Shanghai';
const BILLING_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const ASR_DAILY_SECONDS = 3600;
const ORGANIZE_DAILY_CALLS = 20;

function createRecipeError(code, message, stage = 'action') {
  const error = new Error(message);
  error.name = 'RecipeAssistantError';
  error.code = code;
  error.stage = stage;
  return error;
}

function runtimeErrorCode(error) {
  const code = error && (error.errCode || error.code);
  return code == null || code === '' ? 'INTERNAL_ERROR' : String(code);
}

function publicMessage(error) {
  const code = runtimeErrorCode(error);
  if (code === 'INTERNAL_ERROR' || !error || error.name !== 'RecipeAssistantError') {
    return '菜谱服务暂时不可用';
  }
  return error.message || '菜谱服务暂时不可用';
}

function requireValue(value, code, message) {
  const normalized = String(value || '').trim();
  if (normalized) return normalized;
  throw createRecipeError(code, message, 'validate');
}

function requireRevision(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  throw createRecipeError('REVISION_INVALID', '草稿版本号无效', 'validate');
}

function requireTranscriptRevision(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  throw createRecipeError('TRANSCRIPT_REVISION_INVALID', '转写版本号无效', 'validate');
}

function withoutSystemId(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const payload = { ...data };
  delete payload._id;
  return payload;
}

function buildSourceText(recordings) {
  return (Array.isArray(recordings) ? recordings : [])
    .slice()
    .sort(compareRecordings)
    .map((recording, index) => {
      const sequence = positiveInteger(recording && recording.sequence) || index + 1;
      return `【第 ${sequence} 段】\n${String(recording && recording.editedTranscript || '').trim()}`;
    })
    .join('\n\n');
}

function createInputHash({ sourceText, modelName, promptVersion } = {}) {
  const payload = JSON.stringify([
    String(modelName || ''),
    String(promptVersion || ''),
    String(sourceText || ''),
  ]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function usageDocumentId(familyId, timestamp = Date.now()) {
  const normalizedFamilyId = boundedUsagePart(familyId);
  const time = Number(timestamp);
  if (!Number.isFinite(time)) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  const billingDate = new Date(time + BILLING_TIMEZONE_OFFSET_MINUTES * 60 * 1000)
    .toISOString().slice(0, 10);
  return `${normalizedFamilyId}|${billingDate}`;
}

function createUsageOperationId({ kind, familyId, artifactId, leaseId, parameter = '' } = {}) {
  const normalizedKind = String(kind || '').trim();
  if (!['asr', 'organize'].includes(normalizedKind)) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  const parts = [familyId, artifactId, leaseId].map(boundedUsagePart);
  const normalizedParameter = String(parameter == null ? '' : parameter);
  if (normalizedParameter.length > 500) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([normalizedKind, ...parts, normalizedParameter]), 'utf8')
    .digest('hex');
  return `${normalizedKind}-${digest}`;
}

function boundedUsagePart(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 300) {
    throw createRecipeError('USAGE_OPERATION_INVALID', '用量操作信息无效', 'validate');
  }
  return normalized;
}

function sanitizeTokenUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = [
    'prompt_tokens', 'completion_tokens', 'total_tokens',
    'input_tokens', 'output_tokens',
  ];
  return Object.fromEntries(allowed.flatMap((key) => {
    const count = Number(value[key]);
    return Number.isFinite(count) && count >= 0 ? [[key, count]] : [];
  }));
}

function compareRecordings(left, right) {
  const leftSequence = positiveInteger(left && left.sequence) || Number.MAX_SAFE_INTEGER;
  const rightSequence = positiveInteger(right && right.sequence) || Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return String(left && (left._id || left.id) || '').localeCompare(String(right && (right._id || right.id) || ''));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey(key))
    .map(([key, item]) => [key, sanitize(item)]));
}

function sensitiveKey(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'audiourls') return false;
  return normalized.includes('openid')
    || normalized === 'asrsubmittoken'
    || normalized === 'asrsubmitleaseexpiresat'
    || normalized === 'asrusagereservedat'
    || normalized.endsWith('usageoperationid')
    || normalized === 'organizeleaseid'
    || normalized === 'organizeleaseexpiresat'
    || normalized === 'organizeusagereservedat'
    || normalized === 'organizerequestissuedat'
    || normalized === 'conflictreopengrants'
    || /urls?$/.test(normalized);
}

module.exports = {
  ASR_DAILY_SECONDS,
  BILLING_TIMEZONE,
  BILLING_TIMEZONE_OFFSET_MINUTES,
  ORGANIZE_DAILY_CALLS,
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
  usageDocumentId,
  withoutSystemId,
};
