function normalizeRecipeError(error, action) {
  const normalized = new Error(
    error && (error.errMsg || error.message)
      ? (error.errMsg || error.message)
      : 'recipe assistant request failed'
  );
  normalized.code = error && error.code ? error.code : 'RECIPE_ASSISTANT_ERROR';
  normalized.action = action;
  return normalized;
}

function unwrapRecipeResult(result, action) {
  const body = result && result.result ? result.result : result;
  if (body && body.ok === true) return body.data || {};
  const error = new Error(
    body && body.error && body.error.message
      ? body.error.message
      : 'recipe assistant request failed'
  );
  error.code = body && body.error && body.error.code
    ? body.error.code
    : 'RECIPE_ASSISTANT_ERROR';
  error.action = action;
  throw error;
}

function createReservationError() {
  const error = new Error('recording reservation is invalid');
  error.code = 'INVALID_RECORDING_RESERVATION';
  return error;
}

function createRecipeAssistant(api, options = {}) {
  const envId = String(options.envId || '').trim();
  if (!envId) return null;
  if (!api || !api.cloud || typeof api.cloud.callFunction !== 'function') {
    throw new Error('recipe assistant cloud function is unavailable');
  }

  async function call(action, payload = {}) {
    try {
      const result = await api.cloud.callFunction({
        name: options.recipeFunction || 'recipe-assistant',
        data: { action, ...payload },
      });
      return unwrapRecipeResult(result, action);
    } catch (error) {
      throw normalizeRecipeError(error, action);
    }
  }

  async function uploadRecording(reservation, filePath) {
    const familyId = reservation && reservation.familyId;
    const cloudPath = reservation && reservation.cloudPath;
    const expectedPrefix = `families/${familyId}/recipe-audio/`;
    if (!familyId || typeof cloudPath !== 'string' || !cloudPath.startsWith(expectedPrefix)) {
      throw createReservationError();
    }
    if (typeof api.cloud.uploadFile !== 'function') {
      const error = new Error('recipe audio upload is unavailable');
      error.code = 'RECIPE_AUDIO_UPLOAD_UNAVAILABLE';
      throw error;
    }
    const result = await api.cloud.uploadFile({ cloudPath, filePath });
    if (!result || !result.fileID) {
      const error = new Error('recipe audio upload did not return a file id');
      error.code = 'RECIPE_AUDIO_UPLOAD_UNAVAILABLE';
      throw error;
    }
    return result.fileID;
  }

  const actions = [
    'createManualDraft', 'getDraft', 'updateDraft', 'confirmDraft', 'getRecipe', 'listVersions',
    'getVersion', 'getRecordWorkspace', 'reserveRecording', 'submitRecording', 'refreshWorkspace',
    'updateTranscript', 'addManualText', 'deleteRecordingAudio', 'deleteRecording',
    'attachRecordWorkspace', 'cancelRecordWorkspace', 'organizeDraft', 'purgeDishArtifacts',
  ];
  const service = { uploadRecording };
  actions.forEach((action) => {
    service[action] = (payload) => call(action, payload);
  });
  return service;
}

module.exports = { createRecipeAssistant };
