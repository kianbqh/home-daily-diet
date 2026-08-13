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

function withoutSystemId(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const payload = { ...data };
  delete payload._id;
  return payload;
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
  return normalized.includes('openid') || /urls?$/.test(normalized);
}

module.exports = {
  createRecipeError,
  publicMessage,
  requireRevision,
  requireValue,
  runtimeErrorCode,
  sanitize,
  withoutSystemId,
};
