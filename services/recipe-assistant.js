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

function createUploadError(code) {
  const error = new Error(code === 'INVALID_RECORDING_RESERVATION'
    ? 'recording reservation is invalid'
    : 'recipe audio upload failed');
  error.code = code;
  error.action = 'uploadRecording';
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
    const recordingId = reservation && reservation.recordingId;
    const cloudPath = reservation && reservation.cloudPath;
    const expectedPath = `families/${familyId}/recipe-audio/${recordingId}.mp3`;
    if (!familyId || !recordingId || cloudPath !== expectedPath) {
      throw createUploadError('INVALID_RECORDING_RESERVATION');
    }
    if (typeof api.cloud.uploadFile !== 'function') {
      throw createUploadError('RECIPE_AUDIO_UPLOAD_FAILED');
    }
    let result;
    try {
      result = await api.cloud.uploadFile({ cloudPath, filePath });
    } catch (error) {
      throw createUploadError('RECIPE_AUDIO_UPLOAD_FAILED');
    }
    if (!result || !result.fileID) {
      throw createUploadError('RECIPE_AUDIO_UPLOAD_FAILED');
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
