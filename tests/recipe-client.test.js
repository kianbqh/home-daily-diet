const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecipeAssistant } = require('../services/recipe-assistant');

function createFakeApi(result = { result: { ok: true, data: { recipe: { id: 'dish-1' } } } }) {
  const calls = [];
  const uploads = [];
  return {
    calls,
    uploads,
    api: {
      cloud: {
        async callFunction(request) {
          calls.push(request);
          return result;
        },
        async uploadFile(request) {
          uploads.push(request);
          return { fileID: 'cloud://env/families/family-1/recipe-audio/recording-1.mp3' };
        },
      },
    },
  };
}

test('recipe client sends each action and its payload through recipe-assistant', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, {
    envId: 'env-test',
    recipeFunction: 'recipe-assistant',
    recipeAudioPrefix: 'families/',
  });

  const recipe = await service.getRecipe({ familyId: 'family-1', dishId: 'dish-1' });

  assert.deepEqual(recipe, { recipe: { id: 'dish-1' } });
  assert.deepEqual(fake.calls[0], {
    name: 'recipe-assistant',
    data: { action: 'getRecipe', familyId: 'family-1', dishId: 'dish-1' },
  });
});

test('recipe client exposes every contract action as a thin wrapper', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });
  const methods = [
    'createManualDraft', 'getDraft', 'updateDraft', 'confirmDraft', 'getRecipe', 'listVersions',
    'getVersion', 'getRecordWorkspace', 'reserveRecording', 'submitRecording', 'refreshWorkspace',
    'updateTranscript', 'addManualText', 'deleteRecordingAudio', 'deleteRecording',
    'attachRecordWorkspace', 'cancelRecordWorkspace', 'organizeDraft', 'purgeDishArtifacts',
  ];

  for (const action of methods) {
    await service[action]({ familyId: 'family-1', requestId: action });
  }

  assert.deepEqual(fake.calls.map((call) => call.data), methods.map((action) => ({
    action,
    familyId: 'family-1',
    requestId: action,
  })));
});

test('recipe client normalizes cloud result errors with code and action', async () => {
  const fake = createFakeApi({
    result: { ok: false, error: { code: 'DRAFT_CONFLICT', message: 'draft changed elsewhere' } },
  });
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  await assert.rejects(
    service.getDraft({ familyId: 'family-1', draftId: 'draft-1' }),
    (error) => error && error.code === 'DRAFT_CONFLICT'
      && error.action === 'getDraft'
      && error.message === 'draft changed elsewhere'
  );
});

test('recipe client is disabled without an environment id', () => {
  assert.equal(createRecipeAssistant({ cloud: {} }, { envId: '' }), null);
});

test('recording upload uses only a matching server reservation and returns its file id', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, { envId: 'env-test', recipeAudioPrefix: 'families/' });

  const fileID = await service.uploadRecording({
    familyId: 'family-1',
    recordingId: 'recording-1',
    cloudPath: 'families/family-1/recipe-audio/recording-1.mp3',
  }, 'wxfile://recording.mp3');

  assert.equal(fileID, 'cloud://env/families/family-1/recipe-audio/recording-1.mp3');
  assert.deepEqual(fake.uploads, [{
    cloudPath: 'families/family-1/recipe-audio/recording-1.mp3',
    filePath: 'wxfile://recording.mp3',
  }]);
});

test('recording upload requires the reserved MP3 path to match its recording id', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  for (const reservation of [
    { familyId: 'family-1', recordingId: 'recording-1', cloudPath: 'families/family-1/recipe-audio/other.mp3' },
    { familyId: 'family-1', recordingId: 'recording-1', cloudPath: 'families/family-1/recipe-audio/recording-1.m4a' },
  ]) {
    await assert.rejects(service.uploadRecording(reservation, 'wxfile://recording.mp3'), {
      code: 'INVALID_RECORDING_RESERVATION', action: 'uploadRecording',
    });
  }
  assert.equal(fake.uploads.length, 0);
});

test('recording upload rejects a reservation outside its family audio namespace', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  await assert.rejects(
    service.uploadRecording({
      familyId: 'family-1',
      cloudPath: 'families/family-2/recipe-audio/reserved-audio.m4a',
    }, 'wxfile://recording.m4a'),
    (error) => error instanceof Error
      && error.code === 'INVALID_RECORDING_RESERVATION'
      && error.action === 'uploadRecording'
  );
  assert.equal(fake.uploads.length, 0);
});

test('recording upload normalizes transport failure without exposing reservation content', async () => {
  const fake = createFakeApi();
  fake.api.cloud.uploadFile = async () => {
    const error = new Error('upload failed for families/family-1/recipe-audio/private.m4a');
    error.code = 'PROVIDER_UPLOAD_FAILURE';
    throw error;
  };
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  await assert.rejects(
    service.uploadRecording({
      familyId: 'family-1',
      recordingId: 'recording-private',
      cloudPath: 'families/family-1/recipe-audio/recording-private.mp3',
    }, 'wxfile://recording.mp3'),
    (error) => error instanceof Error
      && error.code === 'RECIPE_AUDIO_UPLOAD_FAILED'
      && error.action === 'uploadRecording'
      && error.message === 'recipe audio upload failed'
  );
});

test('recording upload normalizes a response without a file id', async () => {
  const fake = createFakeApi();
  fake.api.cloud.uploadFile = async () => ({});
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  await assert.rejects(
    service.uploadRecording({
      familyId: 'family-1',
      recordingId: 'recording-empty',
      cloudPath: 'families/family-1/recipe-audio/recording-empty.mp3',
    }, 'wxfile://recording.mp3'),
    (error) => error instanceof Error
      && error.code === 'RECIPE_AUDIO_UPLOAD_FAILED'
      && error.action === 'uploadRecording'
      && error.message === 'recipe audio upload failed'
  );
});
