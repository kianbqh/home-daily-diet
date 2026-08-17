const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadDefinition(relativePath, globalName) {
  const modulePath = require.resolve(path.join(root, relativePath));
  const original = global[globalName];
  let definition = null;
  global[globalName] = (config) => { definition = config; };
  delete require.cache[modulePath];
  require(modulePath);
  global[globalName] = original;
  return definition;
}

function loadPage(relativePath) {
  return loadDefinition(relativePath, 'Page');
}

function loadComponent(relativePath) {
  return loadDefinition(relativePath, 'Component');
}

function setAtPath(data, pathExpression, value) {
  const segments = pathExpression.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (segments.length === 1) {
    data[segments[0]] = value;
    return;
  }
  let cursor = data;
  while (segments.length > 1) {
    const segment = segments.shift();
    const current = cursor[segment];
    cursor[segment] = Array.isArray(current) ? [...current] : { ...(current || {}) };
    cursor = cursor[segment];
  }
  cursor[segments[0]] = value;
}

function createPageInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ...data },
    setData(next) {
      Object.entries(next).forEach(([key, value]) => setAtPath(this.data, key, value));
    },
  };
}

function createComponentInstance(definition, data = {}) {
  const events = [];
  return {
    ...definition.methods,
    data: { ...definition.data, ...data },
    events,
    setData(next) {
      Object.entries(next).forEach(([key, value]) => setAtPath(this.data, key, value));
    },
    triggerEvent(name, detail) {
      events.push({ name, detail });
    },
  };
}

function completeRecipe(overrides = {}) {
  return {
    ingredients: [],
    steps: [],
    tips: [],
    failures: [],
    familyNotes: [],
    uncertainties: [],
    ...overrides,
  };
}

function draftFixture(overrides = {}) {
  return {
    _id: 'draft-1',
    familyId: 'family-internal-1',
    dishId: 'dish-1',
    recordId: '',
    sourceType: 'manual',
    recipe: completeRecipe(),
    baseMainVersionId: '',
    revision: 0,
    status: 'editing',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createRecordingWx(initialEntries = []) {
  const handlers = {};
  let storedEntries = clone(initialEntries);
  const removedFiles = [];
  const recorder = {
    startCalls: [],
    stopCalls: 0,
    offCalls: [],
    onStop(callback) { handlers.stop = callback; },
    onError(callback) { handlers.error = callback; },
    onInterruptionBegin(callback) { handlers.interruption = callback; },
    offStop(callback) { if (handlers.stop === callback) delete handlers.stop; this.offCalls.push('stop'); },
    offError(callback) { if (handlers.error === callback) delete handlers.error; this.offCalls.push('error'); },
    offInterruptionBegin(callback) { if (handlers.interruption === callback) delete handlers.interruption; this.offCalls.push('interruption'); },
    start(options) { this.startCalls.push(clone(options)); },
    stop() { this.stopCalls += 1; },
    finish(result) { return handlers.stop && handlers.stop(result); },
  };
  const api = {
    getRecorderManager() { return recorder; },
    getFileSystemManager() {
      return {
        saveFile({ tempFilePath, success }) {
          success({ savedFilePath: `wxfile://saved/${tempFilePath.split('/').pop()}` });
        },
        getFileInfo({ success }) { success({ size: 321 }); },
        removeSavedFile({ filePath, success }) { removedFiles.push(filePath); success({}); },
      };
    },
    getStorageSync() { return clone(storedEntries); },
    setStorageSync(key, value) { storedEntries = clone(value); },
    showToast() {},
  };
  return {
    api,
    recorder,
    removedFiles,
    storageEntries: () => clone(storedEntries),
  };
}

test('manual recipe pages are registered, package-safe, and keep history read only', () => {
  const appConfig = JSON.parse(read('app.json'));
  const draftConfig = JSON.parse(read('pages/recipe-draft/recipe-draft.json'));
  const draftWxml = read('pages/recipe-draft/recipe-draft.wxml');
  const recipeWxml = read('pages/recipe/recipe.wxml');
  const dishWxml = read('pages/dish-edit/dish-edit.wxml');

  assert.ok(appConfig.pages.includes('pages/recipe/recipe'));
  assert.ok(appConfig.pages.includes('pages/recipe-draft/recipe-draft'));
  assert.equal(draftConfig.usingComponents['recipe-editor'], '/components/recipe-editor/recipe-editor');
  assert.match(draftWxml, /<recipe-editor/);
  assert.match(recipeWxml, /历史版本/);
  assert.doesNotMatch(recipeWxml, /回滚|覆盖/);
  assert.match(dishWxml, /家庭菜谱/);
  assert.doesNotMatch(dishWxml, /family-internal|familyId/);
});

test('recipe editor emits a complete normalized recipe and validation without app or cloud access', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  global.getApp = () => { throw new Error('editor must not read the app'); };
  global.wx = { cloud: new Proxy({}, { get() { throw new Error('editor must not read cloud'); } }) };
  try {
    const definition = loadComponent('components/recipe-editor/recipe-editor.js');
    const editor = createComponentInstance(definition, { recipe: completeRecipe() });

    editor.addIngredient();
    editor.onIngredientInput({ currentTarget: { dataset: { index: 0, field: 'name' } }, detail: { value: '  番茄  ' } });
    editor.addStep();
    editor.onStepInput({ currentTarget: { dataset: { index: 0, field: 'instruction' } }, detail: { value: '  炒匀  ' } });

    const changes = editor.events.filter((event) => event.name === 'change');
    const validations = editor.events.filter((event) => event.name === 'validation');
    assert.deepEqual(changes.at(-1).detail.recipe, completeRecipe({
      ingredients: [{ name: '番茄', amountText: '', note: '', uncertain: false }],
      steps: [{ order: 1, instruction: '炒匀', heat: '', durationText: '', keyPoint: '', uncertain: false }],
    }));
    assert.deepEqual(validations.at(-1).detail, { ok: true, errors: [] });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('recipe editor uses visible native input and textarea controls with no shadow text overlay', () => {
  const template = read('components/recipe-editor/recipe-editor.wxml');
  const styles = read('components/recipe-editor/recipe-editor.wxss');

  assert.match(template, /<input[^>]*class="visible-native-input"/);
  assert.match(template, /<textarea[^>]*class="visible-native-textarea"/);
  assert.doesNotMatch(template, /input-capture|input-visible|shadow/);
  assert.match(styles, /\.visible-native-input[\s\S]*color:\s*#2e302d/);
  assert.match(styles, /\.visible-native-textarea[\s\S]*color:\s*#2e302d/);
  assert.doesNotMatch(styles, /color:\s*transparent|caret-color:\s*transparent/);
});

test('disabled recipe editor ignores handlers and disables every native control', () => {
  const draftTemplate = read('pages/recipe-draft/recipe-draft.wxml');
  const editorTemplate = read('components/recipe-editor/recipe-editor.wxml');
  const definition = loadComponent('components/recipe-editor/recipe-editor.js');
  const originalRecipe = completeRecipe({
    ingredients: [{ name: '番茄', amountText: '2个', note: '', uncertain: false }],
  });
  const editor = createComponentInstance(definition, { disabled: true, recipe: originalRecipe });

  editor.addIngredient();
  editor.onIngredientInput({
    currentTarget: { dataset: { index: 0, field: 'name' } },
    detail: { value: '不应写入' },
  });

  assert.deepEqual(editor.data.recipe, originalRecipe);
  assert.deepEqual(editor.events, []);
  assert.match(draftTemplate, /<recipe-editor[^>]*disabled="\{\{confirming\}\}"/);
  const nativeControls = editorTemplate.match(/<(?:input|textarea|button)\b[^>]*>/g) || [];
  assert.ok(nativeControls.length > 0);
  nativeControls.forEach((control) => assert.match(control, /disabled="\{\{disabled\}\}"/));
});

test('recipe validation remains package-safe when Node Buffer is unavailable', () => {
  const { validateRecipe } = require('../services/recipe-domain');
  const originalBuffer = global.Buffer;
  global.Buffer = undefined;
  try {
    assert.deepEqual(validateRecipe(completeRecipe()), { ok: true, errors: [] });
  } finally {
    global.Buffer = originalBuffer;
  }
});

test('recipe byte length counts a non-BMP emoji without Buffer or TextEncoder', () => {
  const { recipeByteLength } = require('../services/recipe-domain');
  const originalBuffer = global.Buffer;
  const originalTextEncoder = global.TextEncoder;
  global.Buffer = undefined;
  global.TextEncoder = undefined;
  try {
    const recipe = completeRecipe({ familyNotes: ['😀'] });
    assert.equal(recipeByteLength(recipe), 95);
  } finally {
    global.Buffer = originalBuffer;
    global.TextEncoder = originalTextEncoder;
  }
});

test('dish recipe entry creates a manual draft when no main exists and opens read only when it does', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const navigations = [];
  const recipeAssistant = {
    async createManualDraft(payload) {
      calls.push(payload);
      return { draft: draftFixture() };
    },
  };
  global.getApp = () => ({
    globalData: {
      store: { getState: () => ({ family: { id: 'family-internal-1' } }) },
      recipeAssistant,
    },
  });
  global.wx = { navigateTo(options) { navigations.push(options.url); }, showToast() {} };
  try {
    const definition = loadPage('pages/dish-edit/dish-edit.js');
    const page = createPageInstance(definition, {
      dishId: 'dish-1',
      recipeSummary: { hasRecipe: false },
    });

    await page.openFamilyRecipe();
    assert.deepEqual(calls, [{ familyId: 'family-internal-1', dishId: 'dish-1', sourceType: 'manual' }]);
    assert.equal(navigations[0], '/pages/recipe-draft/recipe-draft?familyId=family-internal-1&dishId=dish-1&draftId=draft-1');

    page.setData({ recipeSummary: { hasRecipe: true } });
    await page.openFamilyRecipe();
    assert.equal(calls.length, 1);
    assert.equal(navigations[1], '/pages/recipe/recipe?familyId=family-internal-1&dishId=dish-1');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('dish recipe failure is isolated and lifecycle refresh does not replace recipe state', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  const state = {
    family: { id: 'family-internal-1' },
    dishes: [{ id: 'dish-1', name: '番茄炒蛋', coverImage: '', category: '', tags: [], status: 'active' }],
    cookingRecords: [],
    recordReviews: [],
    members: [],
  };
  global.getApp = () => ({
    globalData: {
      store: { getState: () => state },
      recipeAssistant: { async getRecipe() { throw new Error('cloud down'); } },
    },
  });
  global.wx = { showToast(options) { toasts.push(options.title); } };
  try {
    const definition = loadPage('pages/dish-edit/dish-edit.js');
    const page = createPageInstance(definition, {
      isExisting: true,
      dishId: 'dish-1',
      history: [{ id: 'record-local' }],
      reviews: [{ id: 'review-local' }],
      recipeSummary: { hasRecipe: true, ingredientCount: 2 },
    });

    await page.refreshRecipeSummary();
    assert.equal(page.data.recipeError, '家庭菜谱暂时无法读取');
    assert.deepEqual(page.data.history, [{ id: 'record-local' }]);
    assert.deepEqual(page.data.reviews, [{ id: 'review-local' }]);

    const summary = page.data.recipeSummary;
    page.refresh();
    assert.equal(page.data.recipeSummary, summary);
    assert.equal(toasts.length, 0);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('manual recipe path reports unavailable CloudBase without breaking the dish page', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  let navigated = false;
  global.getApp = () => ({
    globalData: {
      store: { getState: () => ({ family: { id: 'family-internal-1' } }) },
      recipeAssistant: null,
    },
  });
  global.wx = {
    showToast(options) { toasts.push(options.title); },
    navigateTo() { navigated = true; },
  };
  try {
    const page = createPageInstance(loadPage('pages/dish-edit/dish-edit.js'), {
      dishId: 'dish-1',
      recipeSummary: { hasRecipe: false },
    });
    await page.refreshRecipeSummary();
    await page.openFamilyRecipe();

    assert.equal(page.data.recipeUnavailable, true);
    assert.equal(page.data.recipeError, '家庭菜谱需要启用 CloudBase');
    assert.deepEqual(toasts, ['家庭菜谱需要启用 CloudBase']);
    assert.equal(navigated, false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('draft autosave waits 800 ms and preserves a complete local copy on conflict', async () => {
  const originalGetApp = global.getApp;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const callbacks = [];
  const cleared = [];
  const calls = [];
  const localRecipe = completeRecipe({
    ingredients: [{ name: '番茄', amountText: '2个', note: '', uncertain: false }],
  });
  global.setTimeout = (callback, delay) => {
    callbacks.push({ callback, delay });
    return callbacks.length;
  };
  global.clearTimeout = (id) => { cleared.push(id); };
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async updateDraft(payload) {
          calls.push(payload);
          const error = new Error('conflict');
          error.code = 'DRAFT_CONFLICT';
          throw error;
        },
      },
    },
  });
  try {
    const page = createPageInstance(loadPage('pages/recipe-draft/recipe-draft.js'), {
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      draft: draftFixture({ revision: 3 }),
      recipe: localRecipe,
      validation: { ok: true, errors: [] },
    });

    page.scheduleAutosave();
    page.scheduleAutosave();
    assert.equal(callbacks.at(-1).delay, 800);
    assert.deepEqual(cleared, [1]);
    await callbacks.at(-1).callback();

    assert.deepEqual(calls, [{
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      revision: 3,
      recipe: localRecipe,
    }]);
    assert.deepEqual(page.data.recipe, localRecipe);
    assert.notEqual(page.data.localConflictRecipe, page.data.recipe);
    assert.deepEqual(page.data.localConflictRecipe, localRecipe);
    assert.equal(page.data.saveState, 'conflict');
    assert.equal(page.data.saveMessage, '保存冲突，刷新后可重新应用本地内容');
  } finally {
    global.getApp = originalGetApp;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('draft save drain serializes overlapping edits and persists the latest generation', async () => {
  const originalGetApp = global.getApp;
  const requests = [];
  const pending = [];
  const firstRecipe = completeRecipe({ familyNotes: ['第一版'] });
  const latestRecipe = completeRecipe({ familyNotes: ['第二版'] });
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        updateDraft(payload) {
          requests.push(payload);
          const request = deferred();
          pending.push(request);
          return request.promise;
        },
      },
    },
  });
  try {
    const page = createPageInstance(loadPage('pages/recipe-draft/recipe-draft.js'), {
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      draft: draftFixture({ revision: 3, recipe: firstRecipe }),
      recipe: firstRecipe,
      validation: { ok: true, errors: [] },
    });
    page.recipeDirty = true;
    page.editGeneration = 1;

    const firstSave = page.saveDraftNow();
    page.onRecipeChange({ detail: { recipe: latestRecipe } });
    const queuedSave = page.saveDraftNow();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].revision, 3);
    assert.deepEqual(requests[0].recipe, firstRecipe);

    pending[0].resolve({ draft: draftFixture({ revision: 4, recipe: firstRecipe }) });
    await flushPromises();

    assert.equal(requests.length, 2);
    assert.equal(requests[1].revision, 4);
    assert.deepEqual(requests[1].recipe, latestRecipe);

    pending[1].resolve({ draft: draftFixture({ revision: 5, recipe: latestRecipe }) });
    assert.equal(await firstSave, true);
    assert.equal(await queuedSave, true);
    assert.equal(page.data.draft.revision, 5);
    assert.equal(page.recipeDirty, false);
    assert.equal(page.data.saveState, 'saved');
    assert.equal(page.data.localConflictRecipe, null);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('confirmation locks before saving, ignores edits, and confirms only the persisted revision', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const update = deferred();
  const calls = [];
  const persistedRecipe = completeRecipe({ familyNotes: ['确认这一版'] });
  const attemptedRecipe = completeRecipe({ familyNotes: ['不应写入'] });
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        updateDraft(payload) {
          calls.push({ action: 'updateDraft', payload });
          return update.promise;
        },
        async confirmDraft(payload) {
          calls.push({ action: 'confirmDraft', payload });
          return { version: { _id: 'version-1' } };
        },
      },
    },
  });
  global.wx = { redirectTo() {}, showToast() {} };
  try {
    const page = createPageInstance(loadPage('pages/recipe-draft/recipe-draft.js'), {
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      draft: draftFixture({ revision: 6, recipe: persistedRecipe }),
      recipe: persistedRecipe,
      validation: { ok: true, errors: [] },
    });
    page.recipeDirty = true;
    page.editGeneration = 1;

    const confirmation = page.confirmRecipe();
    const lockedImmediately = page.data.confirming;
    page.onRecipeChange({ detail: { recipe: attemptedRecipe } });
    const generationAfterAttempt = page.editGeneration;

    assert.equal(calls.filter((call) => call.action === 'confirmDraft').length, 0);
    update.resolve({ draft: draftFixture({ revision: 7, recipe: persistedRecipe }) });
    await confirmation;

    assert.equal(lockedImmediately, true);
    assert.deepEqual(page.data.recipe, persistedRecipe);
    assert.equal(generationAfterAttempt, 1);
    assert.deepEqual(calls.map((call) => call.action), ['updateDraft', 'confirmDraft']);
    assert.equal(calls[1].payload.revision, 7);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('confirmation unlocks when the queued save fails', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const update = deferred();
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        updateDraft() { return update.promise; },
        async confirmDraft() { throw new Error('confirm must not run'); },
      },
    },
  });
  global.wx = { showToast() {} };
  try {
    const page = createPageInstance(loadPage('pages/recipe-draft/recipe-draft.js'), {
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      draft: draftFixture({ revision: 2 }),
      recipe: completeRecipe(),
      validation: { ok: true, errors: [] },
    });
    page.recipeDirty = true;
    page.editGeneration = 1;

    const confirmation = page.confirmRecipe();
    const lockedImmediately = page.data.confirming;
    update.reject(new Error('network unavailable'));
    await confirmation;

    assert.equal(lockedImmediately, true);
    assert.equal(page.data.confirming, false);
    assert.equal(page.data.saveState, 'error');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('refreshing a conflicted draft keeps the local copy available to reapply', async () => {
  const originalGetApp = global.getApp;
  const localRecipe = completeRecipe({
    familyNotes: ['本地保留：少放盐'],
  });
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async getDraft() {
          return { draft: draftFixture({ revision: 4, recipe: completeRecipe() }) };
        },
      },
    },
  });
  try {
    const page = createPageInstance(loadPage('pages/recipe-draft/recipe-draft.js'), {
      familyId: 'family-internal-1',
      dishId: 'dish-1',
      draftId: 'draft-1',
      draft: draftFixture({ revision: 3 }),
      recipe: localRecipe,
      localConflictRecipe: localRecipe,
      saveState: 'conflict',
    });

    await page.refreshAfterConflict();

    assert.deepEqual(page.data.recipe, completeRecipe());
    assert.deepEqual(page.data.localConflictRecipe, localRecipe);
    assert.match(read('pages/recipe-draft/recipe-draft.wxml'), /wx:if="\{\{localConflictRecipe\}\}"/);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('draft confirmation modes preserve record defaults and force required main publication', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const confirmations = [];
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async confirmDraft(payload) {
          confirmations.push(payload);
          return { version: { _id: `version-${confirmations.length}` } };
        },
      },
    },
  });
  global.wx = { redirectTo() {}, showToast() {} };
  try {
    const definition = loadPage('pages/recipe-draft/recipe-draft.js');

    const recordWithMain = createPageInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', draftId: 'record-draft',
      draft: draftFixture({ _id: 'record-draft', recordId: 'record-1', baseMainVersionId: 'main-v1', revision: 2 }),
      recipe: completeRecipe(), validation: { ok: true, errors: [] },
    });
    recordWithMain.applyDraftMode();
    assert.equal(recordWithMain.data.confirmMode, 'record');
    assert.equal(recordWithMain.data.publishAsMain, false);
    assert.equal(recordWithMain.data.publishLocked, false);
    await recordWithMain.confirmRecipe();

    const firstMain = createPageInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', draftId: 'first-draft',
      draft: draftFixture({ _id: 'first-draft', recordId: 'record-2', revision: 1 }),
      recipe: completeRecipe(), validation: { ok: true, errors: [] },
    });
    firstMain.applyDraftMode();
    assert.equal(firstMain.data.confirmMode, 'record');
    assert.equal(firstMain.data.publishAsMain, true);
    assert.equal(firstMain.data.publishLocked, true);
    await firstMain.confirmRecipe();

    const mainEntry = createPageInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', draftId: 'main-draft',
      draft: draftFixture({ _id: 'main-draft', sourceType: 'edit_main', baseMainVersionId: 'main-v1', revision: 4 }),
      recipe: completeRecipe(), validation: { ok: true, errors: [] },
    });
    mainEntry.applyDraftMode();
    assert.equal(mainEntry.data.confirmMode, 'main');
    assert.equal(mainEntry.data.publishAsMain, true);
    await mainEntry.confirmRecipe();

    assert.deepEqual(confirmations.map((item) => item.publishAsMain), [false, true, true]);
    assert.deepEqual(confirmations.map((item) => item.baseMainVersionId), ['main-v1', '', 'main-v1']);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('draft clears its autosave timer on unload and after successful confirmation', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalClearTimeout = global.clearTimeout;
  const cleared = [];
  global.clearTimeout = (id) => { cleared.push(id); };
  global.getApp = () => ({
    globalData: {
      recipeAssistant: { async confirmDraft() { return { version: { _id: 'version-1' } }; } },
    },
  });
  global.wx = { redirectTo() {}, showToast() {} };
  try {
    const definition = loadPage('pages/recipe-draft/recipe-draft.js');
    const page = createPageInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', draftId: 'draft-1',
      draft: draftFixture(), recipe: completeRecipe(), validation: { ok: true, errors: [] },
    });
    page.autosaveTimer = 17;
    page.onUnload();
    page.autosaveTimer = 23;
    await page.confirmRecipe();

    assert.deepEqual(cleared, [17, 23]);
    assert.equal(page.autosaveTimer, null);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
    global.clearTimeout = originalClearTimeout;
  }
});

test('recipe page loads an immutable selected version and edits main by cloning a draft', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  let navigation = '';
  const recipeAssistant = {
    async getVersion(payload) {
      calls.push({ action: 'getVersion', payload });
      return { version: { _id: 'version-2', versionNumber: 2, recipe: completeRecipe(), confirmedBy: 'member-1', confirmedAt: 123 } };
    },
    async listVersions(payload) {
      calls.push({ action: 'listVersions', payload });
      return { versions: [{ _id: 'version-2', versionNumber: 2, confirmedBy: 'member-1', confirmedAt: 123 }] };
    },
    async createManualDraft(payload) {
      calls.push({ action: 'createManualDraft', payload });
      return { draft: draftFixture({ _id: 'edit-draft', sourceType: 'edit_main' }) };
    },
  };
  global.getApp = () => ({
    globalData: {
      store: { getState: () => ({ members: [{ id: 'member-1', displayName: '妈妈' }] }) },
      recipeAssistant,
    },
  });
  global.wx = { navigateTo(options) { navigation = options.url; }, showToast() {} };
  try {
    const page = createPageInstance(loadPage('pages/recipe/recipe.js'));
    await page.onLoad({ familyId: 'family-internal-1', dishId: 'dish-1', versionId: 'version-2' });

    assert.equal(page.data.isHistorical, true);
    assert.equal(page.data.version.confirmedByLabel, '妈妈');
    assert.deepEqual(calls.slice(0, 2).map((call) => call.action), ['getVersion', 'listVersions']);
    await page.editMainRecipe();
    assert.deepEqual(calls.at(-1), {
      action: 'createManualDraft',
      payload: { familyId: 'family-internal-1', dishId: 'dish-1', sourceType: 'edit_main' },
    });
    assert.equal(navigation, '/pages/recipe-draft/recipe-draft?familyId=family-internal-1&dishId=dish-1&draftId=edit-draft');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('recording workspace uses native lifecycle and uploads each completed clip in order', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const harness = createRecordingWx();
  const calls = [];
  const recipeAssistant = {
    async reserveRecording(payload) {
      calls.push({ action: 'reserveRecording', payload });
      return {
        recordingId: 'recording-1',
        cloudPath: 'families/family-internal-1/recipe-audio/recording-1.mp3',
      };
    },
    async uploadRecording(reservation, filePath) {
      calls.push({ action: 'uploadRecording', reservation, filePath });
      return 'cloud://env/families/family-internal-1/recipe-audio/recording-1.mp3';
    },
    async submitRecording(payload) {
      calls.push({ action: 'submitRecording', payload });
      return {
        recording: {
          _id: 'recording-1', sourceType: 'audio', sequence: 1, status: 'transcribing',
          fileId: payload.fileId, durationMs: 1200, editedTranscript: '', transcriptRevision: 0,
        },
      };
    },
  };
  global.getApp = () => ({ globalData: { recipeAssistant } });
  global.wx = harness.api;
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    assert.deepEqual(Object.keys(definition.properties).sort(), ['disabled', 'dishId', 'familyId', 'recordId']);
    const component = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
    });
    definition.lifetimes.attached.call(component);

    component.startRecording();
    await harness.recorder.finish({ tempFilePath: 'wxfile://tmp/clip.mp3', duration: 1200 });
    await flushPromises();
    await flushPromises();

    assert.deepEqual(calls.map((item) => item.action), [
      'reserveRecording', 'uploadRecording', 'submitRecording',
    ]);
    assert.equal(calls[0].payload.recordId, 'record-1');
    assert.equal(calls[1].reservation.familyId, 'family-internal-1');
    assert.equal(component.data.clips[0].statusLabel, '转写中');
    assert.equal(component.data.clips[0].localPath, '', 'uploaded clips must not retain a deleted local playback path');
    assert.equal(harness.storageEntries()[0].uploadStatus, 'uploaded');

    component.startRecording();
    assert.equal(harness.recorder.startCalls.length, 2, 'a transcribing clip must not block the next recording');
    definition.lifetimes.detached.call(component);
    assert.deepEqual(harness.recorder.offCalls.sort(), ['error', 'interruption', 'stop']);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('recording workspace retains a local clip and offers re-upload after upload failure', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const harness = createRecordingWx();
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async reserveRecording() {
          return {
            recordingId: 'recording-failed-upload',
            cloudPath: 'families/family-internal-1/recipe-audio/recording-failed-upload.mp3',
          };
        },
        async uploadRecording() { throw new Error('offline'); },
        async submitRecording() { throw new Error('must not submit'); },
      },
    },
  });
  global.wx = harness.api;
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const component = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
    });
    definition.lifetimes.attached.call(component);
    component.startRecording();
    await harness.recorder.finish({ tempFilePath: 'wxfile://tmp/offline.mp3', duration: 900 });
    await flushPromises();
    await flushPromises();

    assert.equal(component.data.clips[0].statusLabel, '等待上传');
    assert.equal(component.data.clips[0].uploadFailed, true);
    assert.equal(harness.storageEntries()[0].uploadStatus, 'pending');
    assert.equal(component.hasPendingLocalClips(), true);
    assert.equal(await component.finalizeAfterAttach(), false);
    assert.equal(harness.storageEntries()[0].uploadStatus, 'pending');
    assert.equal(harness.removedFiles.length, 0);
    assert.match(read('components/recipe-recording-workspace/recipe-recording-workspace.wxml'), /重新上传/);
    definition.lifetimes.detached.call(component);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('recording workspace keeps unsaved manual text distinct from pending local audio', async () => {
  const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
  const component = createComponentInstance(definition, {
    familyId: 'family-internal-1',
    dishId: 'dish-1',
    recordId: 'record-1',
    disabled: false,
    manualTextDraft: ' 少放盐，出锅前再放葱 ',
  });

  assert.equal(component.hasPendingLocalClips(), false);
  assert.equal(component.hasUncommittedInput(), true);
  assert.equal(component.canFinalizeWorkspace(), false);
  assert.equal(await component.finalizeAfterAttach(), false);
  assert.equal(component.data.manualTextDraft, ' 少放盐，出锅前再放葱 ');
});

test('submit rejection keeps saved audio recoverable after component and controller recreation', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const harness = createRecordingWx();
  let recipeAssistant = {
    async reserveRecording() {
      return {
        recordingId: 'recording-submit-failed',
        cloudPath: 'families/family-internal-1/recipe-audio/recording-submit-failed.mp3',
      };
    },
    async uploadRecording() {
      return 'cloud://env/families/family-internal-1/recipe-audio/recording-submit-failed.mp3';
    },
    async submitRecording() {
      throw new Error('submit unavailable');
    },
  };
  global.getApp = () => ({ globalData: { recipeAssistant } });
  global.wx = harness.api;
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const first = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
    });
    definition.lifetimes.attached.call(first);
    first.startRecording();
    await harness.recorder.finish({ tempFilePath: 'wxfile://tmp/recoverable.mp3', duration: 1100 });
    await flushPromises();
    await flushPromises();

    assert.equal(first.data.clips[0].statusLabel, '转写失败');
    assert.equal(harness.storageEntries()[0].uploadStatus, 'pending');
    assert.match(harness.storageEntries()[0].savedFilePath, /recoverable\.mp3$/);
    assert.equal(harness.removedFiles.length, 0);
    assert.equal(first.hasPendingLocalClips(), true);
    definition.lifetimes.detached.call(first);

    recipeAssistant = {
      async reserveRecording() {
        return {
          recordingId: 'recording-submit-retry',
          cloudPath: 'families/family-internal-1/recipe-audio/recording-submit-retry.mp3',
        };
      },
      async uploadRecording() {
        return 'cloud://env/families/family-internal-1/recipe-audio/recording-submit-retry.mp3';
      },
      async submitRecording(payload) {
        return {
          recording: {
            _id: 'recording-submit-retry', sourceType: 'audio', sequence: 1,
            status: 'transcribing', fileId: payload.fileId, durationMs: 1100,
            editedTranscript: '', transcriptRevision: 0,
          },
        };
      },
    };
    const second = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
    });
    definition.lifetimes.attached.call(second);

    assert.equal(second.data.clips.length, 1);
    assert.match(second.data.clips[0].localPath, /recoverable\.mp3$/);
    assert.equal(second.hasPendingLocalClips(), true);
    await second.uploadLocalClip(second.data.clips[0].localId);

    assert.equal(harness.storageEntries()[0].uploadStatus, 'uploaded');
    assert.equal(harness.removedFiles.length, 1);
    assert.equal(second.hasPendingLocalClips(), false);
    assert.equal(await second.finalizeAfterAttach(), true);
    assert.deepEqual(harness.storageEntries(), []);
    definition.lifetimes.detached.call(second);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('recording workspace refreshes once on page show and emits its public events', async () => {
  const originalGetApp = global.getApp;
  const calls = [];
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async getRecordWorkspace(payload) {
          calls.push({ action: 'getRecordWorkspace', payload });
          return {
            recordings: [{
              _id: 'recording-1', sourceType: 'audio', sequence: 1, status: 'transcribing',
              fileId: 'cloud://audio', durationMs: 1000, editedTranscript: '', transcriptRevision: 0,
            }],
            draft: { _id: 'draft-1' },
            audioUrls: { 'recording-1': 'https://temp.example/audio.mp3' },
          };
        },
        async refreshWorkspace(payload) {
          calls.push({ action: 'refreshWorkspace', payload });
          return {
            recordings: [{
              _id: 'recording-1', sourceType: 'audio', sequence: 1, status: 'ready',
              fileId: 'cloud://audio', durationMs: 1000, editedTranscript: '少放盐', transcriptRevision: 0,
            }],
          };
        },
      },
    },
  });
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const component = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
    });

    await definition.pageLifetimes.show.call(component);
    component.openDraft();

    assert.deepEqual(calls.map((item) => item.action), ['getRecordWorkspace', 'refreshWorkspace']);
    assert.equal(component.data.clips[0].statusLabel, '可校对');
    assert.deepEqual(component.events.filter((event) => event.name === 'workspacechange').at(-1).detail, {
      hasContent: true,
      readyToOrganize: true,
      pendingCount: 0,
    });
    assert.deepEqual(component.events.filter((event) => event.name === 'opendraft').at(-1).detail, {
      draftId: 'draft-1',
    });
  } finally {
    global.getApp = originalGetApp;
  }
});

test('recording workspace supports transcript edits, manual text, retry, delete, and required controls', async () => {
  const originalGetApp = global.getApp;
  const calls = [];
  const recipeAssistant = {
    async updateTranscript(payload) {
      calls.push({ action: 'updateTranscript', payload });
      return { recording: { _id: 'recording-1', sequence: 1, sourceType: 'audio', status: 'ready', editedTranscript: payload.text, transcriptRevision: 2 } };
    },
    async addManualText(payload) {
      calls.push({ action: 'addManualText', payload });
      return { recording: { _id: 'manual-1', sequence: 2, sourceType: 'manual_text', status: 'ready', editedTranscript: payload.text, transcriptRevision: 0 } };
    },
    async submitRecording(payload) {
      calls.push({ action: 'submitRecording', payload });
      return { recording: { _id: 'recording-2', sequence: 3, sourceType: 'audio', status: 'transcribing', fileId: payload.fileId, editedTranscript: '', transcriptRevision: 0 } };
    },
    async deleteRecording(payload) {
      calls.push({ action: 'deleteRecording', payload });
      return { recording: { _id: payload.recordingId, status: 'deleted' } };
    },
  };
  global.getApp = () => ({ globalData: { recipeAssistant } });
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const component = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
      clips: [
        { key: 'recording-1', recordingId: 'recording-1', sequence: 1, sourceType: 'audio', status: 'ready', statusLabel: '可校对', editedTranscript: '原文字', transcriptRevision: 1 },
        { key: 'recording-2', recordingId: 'recording-2', sequence: 3, sourceType: 'audio', status: 'failed', statusLabel: '转写失败', fileId: 'cloud://audio-2', editedTranscript: '', transcriptRevision: 0 },
      ],
    });

    component.onTranscriptInput({ currentTarget: { dataset: { key: 'recording-1' } }, detail: { value: '修订文字' } });
    await component.saveTranscript({ currentTarget: { dataset: { key: 'recording-1' } } });
    component.onManualTextInput({ detail: { value: '补充一点糖' } });
    await component.addManualText();
    await component.retryClip({ currentTarget: { dataset: { key: 'recording-2' } } });
    await component.deleteClip({ currentTarget: { dataset: { key: 'recording-1' } } });

    assert.deepEqual(calls.map((item) => item.action), [
      'updateTranscript', 'addManualText', 'submitRecording', 'deleteRecording',
    ]);
    const template = read('components/recipe-recording-workspace/recipe-recording-workspace.wxml');
    for (const binding of ['startRecording', 'stopRecording', 'playClip', 'saveTranscript', 'retryClip', 'deleteClip', 'addManualText']) {
      assert.match(template, new RegExp(`bindtap="${binding}"`), binding);
    }
    assert.match(template, /倒计时/);
    assert.match(template, /添加文字说明/);
    for (const label of ['等待上传', '转写中', '可校对', '转写失败']) assert.match(read('components/recipe-recording-workspace/recipe-recording-workspace.js'), new RegExp(label));
  } finally {
    global.getApp = originalGetApp;
  }
});

test('recording playback destroys the old context and refreshes an expired temporary URL', async () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const contexts = [];
  let workspaceReads = 0;
  global.getApp = () => ({
    globalData: {
      recipeAssistant: {
        async getRecordWorkspace() {
          workspaceReads += 1;
          return { recordings: [], draft: null, audioUrls: {} };
        },
      },
    },
  });
  global.wx = {
    createInnerAudioContext() {
      const context = {
        destroyed: false,
        played: false,
        play() { this.played = true; },
        destroy() { this.destroyed = true; },
        onEnded(callback) { this.ended = callback; },
        onError(callback) { this.failed = callback; },
      };
      contexts.push(context);
      return context;
    },
    showToast() {},
  };
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const component = createComponentInstance(definition, {
      familyId: 'family-internal-1', dishId: 'dish-1', recordId: 'record-1', disabled: false,
      clips: [
        { key: 'recording-1', recordingId: 'recording-1', audioUrl: 'https://temp.example/one.mp3' },
        { key: 'recording-2', recordingId: 'recording-2', audioUrl: 'https://temp.example/two.mp3' },
      ],
    });

    component.playClip({ currentTarget: { dataset: { key: 'recording-1' } } });
    component.playClip({ currentTarget: { dataset: { key: 'recording-2' } } });
    contexts[1].failed({ errMsg: 'url expired' });
    await flushPromises();

    assert.equal(contexts[0].destroyed, true);
    assert.equal(contexts[1].played, true);
    assert.equal(workspaceReads, 1);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('local workspace recovery is scoped by family, dish, and record and expires after seven days', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const now = Date.now();
  const harness = createRecordingWx([
    { localId: 'expired', workspaceKey: 'family-a|dish-1|record-expired', savedFilePath: 'wxfile://expired.mp3', durationMs: 1, createdAt: now - 8 * 86400000, uploadStatus: 'pending' },
    { localId: 'current', workspaceKey: 'family-a|dish-1|record-current', savedFilePath: 'wxfile://current.mp3', durationMs: 1, createdAt: now - 6 * 86400000, uploadStatus: 'pending' },
    { localId: 'foreign', workspaceKey: 'family-b|dish-1|record-foreign', savedFilePath: 'wxfile://foreign.mp3', durationMs: 1, createdAt: now - 86400000, uploadStatus: 'pending' },
  ]);
  global.getApp = () => ({ globalData: { recipeAssistant: null } });
  global.wx = harness.api;
  try {
    const definition = loadComponent('components/recipe-recording-workspace/recipe-recording-workspace.js');
    const component = createComponentInstance(definition, {
      familyId: 'family-a', dishId: 'dish-1', recordId: '', disabled: false,
    });
    definition.lifetimes.attached.call(component);

    assert.deepEqual(component.findWorkspace({ familyId: 'family-a', dishId: 'dish-1' }), {
      recordId: 'record-current', workspaceKey: 'family-a|dish-1|record-current',
    });
    assert.deepEqual(component.findWorkspace({ familyId: 'family-b', dishId: 'dish-1' }), {
      recordId: 'record-foreign', workspaceKey: 'family-b|dish-1|record-foreign',
    });
    assert.equal(harness.storageEntries().some((entry) => entry.localId === 'expired'), false);
    definition.lifetimes.detached.call(component);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});
