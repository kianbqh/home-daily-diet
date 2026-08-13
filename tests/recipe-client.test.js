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
          return { fileID: 'cloud://env/families/family-1/recipe-audio/audio-1.m4a' };
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
    cloudPath: 'families/family-1/recipe-audio/reserved-audio.m4a',
  }, 'wxfile://recording.m4a');

  assert.equal(fileID, 'cloud://env/families/family-1/recipe-audio/audio-1.m4a');
  assert.deepEqual(fake.uploads, [{
    cloudPath: 'families/family-1/recipe-audio/reserved-audio.m4a',
    filePath: 'wxfile://recording.m4a',
  }]);
});

test('recording upload rejects a reservation outside its family audio namespace', async () => {
  const fake = createFakeApi();
  const service = createRecipeAssistant(fake.api, { envId: 'env-test' });

  await assert.rejects(
    service.uploadRecording({
      familyId: 'family-1',
      cloudPath: 'families/family-2/recipe-audio/reserved-audio.m4a',
    }, 'wxfile://recording.m4a'),
    (error) => error && error.code === 'INVALID_RECORDING_RESERVATION'
  );
  assert.equal(fake.uploads.length, 0);
});
