const { emptyRecipe, normalizeRecipe, validateRecipe } = require('../../services/recipe-domain');

function cloneRecipe(value) {
  return normalizeRecipe(JSON.parse(JSON.stringify(normalizeRecipe(value || emptyRecipe()))));
}

function showToast(title, icon = 'none') {
  if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon });
  }
}

function recipeUrl(values) {
  const query = Object.entries(values)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/pages/recipe/recipe?${query}`;
}

const DRAFT_STATE_MESSAGES = Object.freeze({
  editing: '草稿可继续手动编辑',
  organizing: '正在整理，可以离开页面',
  ready: '智能整理已完成，请检查后确认',
  failed: '智能整理没有完成，转写和当前草稿都已保留。',
  confirmed: '本次做法已经保存',
});

function uncertaintyFieldLabel(fieldPath) {
  const value = String(fieldPath || '');
  const match = /^(ingredients|steps|tips|failures|familyNotes)(?:\[(\d+)\])?(?:\.(\w+))?/.exec(value);
  if (!match) return '菜谱内容';
  const sectionLabels = {
    ingredients: '食材', steps: '步骤', tips: '技巧', failures: '失败经验', familyNotes: '家庭经验',
  };
  const fieldLabels = {
    name: '名称', amountText: '用量', note: '备注', description: '说明',
    heat: '火候', durationText: '时长',
  };
  const index = match[2] == null ? '' : ` ${Number(match[2]) + 1}`;
  const field = match[3] && fieldLabels[match[3]] ? ` · ${fieldLabels[match[3]]}` : '';
  return `${sectionLabels[match[1]]}${index}${field}`;
}

function uncertaintyViews(recipe) {
  return (Array.isArray(recipe && recipe.uncertainties) ? recipe.uncertainties : []).map((item, index) => ({
    ...item,
    index,
    key: `${String(item && item.fieldPath || 'recipe')}:${index}`,
    fieldLabel: uncertaintyFieldLabel(item && item.fieldPath),
  }));
}

function sourceRecordingView(recording, audioUrls, index) {
  const id = String(recording && (recording._id || recording.id) || '');
  const sequence = Number(recording && recording.sequence);
  return {
    ...recording,
    id,
    title: recording && recording.sourceType === 'manual_text'
      ? `文字说明 ${Number.isFinite(sequence) ? sequence : index + 1}`
      : `录音片段 ${Number.isFinite(sequence) ? sequence : index + 1}`,
    rawTranscript: String(recording && recording.rawTranscript || ''),
    editedTranscript: String(recording && recording.editedTranscript || ''),
    audioUrl: String(audioUrls && audioUrls[id] || ''),
  };
}

Page({
  data: {
    familyId: '',
    dishId: '',
    draftId: '',
    loading: true,
    error: '',
    unavailable: false,
    draft: null,
    recipe: emptyRecipe(),
    validation: { ok: true, errors: [] },
    saveState: 'idle',
    saveMessage: '',
    localConflictRecipe: null,
    publishAsMain: false,
    publishLocked: false,
    confirmMode: 'main',
    confirming: false,
    draftStatus: '',
    stateMessage: '',
    manualEditing: false,
    organizeRequestPending: false,
    sourceExpanded: false,
    sourceLoading: false,
    sourceError: '',
    sourceRecordings: [],
    canOrganizeSources: false,
    uncertaintyItems: [],
    playingSourceId: '',
  },

  getRecipeAssistant() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.recipeAssistant : null;
  },

  async onLoad(options = {}) {
    this.setData({
      familyId: String(options.familyId || ''),
      dishId: String(options.dishId || ''),
      draftId: String(options.draftId || ''),
    });
  },

  onShow() {
    if (!this.data.draftId) return Promise.resolve(false);
    return this.loadDraft();
  },

  onUnload() {
    this.clearAutosaveTimer();
    this.draftLoadGeneration = (this.draftLoadGeneration || 0) + 1;
    this.destroySourceAudio();
  },

  clearAutosaveTimer() {
    if (this.autosaveTimer != null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  },

  async loadDraft(options = {}) {
    const recipeAssistant = this.getRecipeAssistant();
    if (!recipeAssistant) {
      this.setData({
        loading: false,
        unavailable: true,
        error: '家庭菜谱需要启用 CloudBase',
      });
      return;
    }
    const generation = (this.draftLoadGeneration || 0) + 1;
    this.draftLoadGeneration = generation;
    this.setData({ loading: true, error: '', unavailable: false });
    try {
      const result = await recipeAssistant.getDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId: this.data.draftId,
      });
      const draft = result && result.draft;
      if (!draft) throw new Error('missing draft');
      if (generation !== this.draftLoadGeneration) return false;
      const recipe = cloneRecipe(draft.recipe);
      this.lastSavedRecipeJson = JSON.stringify(recipe);
      this.recipeDirty = false;
      const draftStatus = String(draft.status || 'editing');
      this.setData({
        loading: false,
        draft,
        recipe,
        validation: validateRecipe(recipe),
        saveState: 'saved',
        saveMessage: '已保存',
        draftStatus,
        stateMessage: DRAFT_STATE_MESSAGES[draftStatus] || '',
        manualEditing: draftStatus !== 'failed',
        organizeRequestPending: false,
        uncertaintyItems: uncertaintyViews(recipe),
      });
      this.applyDraftMode();
      if (!options.keepConflict) this.setData({ localConflictRecipe: null });
      await this.loadSources(draft, generation, recipeAssistant);
      return true;
    } catch (error) {
      if (generation === this.draftLoadGeneration) {
        this.setData({ loading: false, error: '菜谱草稿暂时无法读取' });
      }
      return false;
    }
  },

  async loadSources(draft, generation, recipeAssistant) {
    const recordId = String(draft && draft.recordId || '');
    if (!recordId || !recipeAssistant || typeof recipeAssistant.getRecordWorkspace !== 'function') {
      if (generation === this.draftLoadGeneration) {
        this.setData({ sourceLoading: false, sourceError: '', sourceRecordings: [], canOrganizeSources: false });
      }
      return;
    }
    this.setData({ sourceLoading: true, sourceError: '' });
    try {
      const workspace = await recipeAssistant.getRecordWorkspace({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        recordId,
      });
      if (generation !== this.draftLoadGeneration) return;
      const selectedIds = new Set((Array.isArray(draft.sourceRecordingIds) ? draft.sourceRecordingIds : [])
        .map((value) => String(value)));
      const recordings = (Array.isArray(workspace && workspace.recordings) ? workspace.recordings : [])
        .filter((item) => !selectedIds.size || selectedIds.has(String(item && (item._id || item.id) || '')))
        .map((item, index) => sourceRecordingView(item, workspace && workspace.audioUrls, index));
      const canOrganizeSources = recordings.length > 0 && recordings.every((item) => (
        item.status === 'ready' && String(item.editedTranscript || '').trim()
      ));
      this.setData({
        sourceLoading: false,
        sourceError: '',
        sourceRecordings: recordings,
        canOrganizeSources,
      });
    } catch (error) {
      if (generation === this.draftLoadGeneration) {
        this.setData({
          sourceLoading: false,
          sourceError: '来源片段暂时无法读取',
          sourceRecordings: [],
          canOrganizeSources: false,
        });
      }
    }
  },

  applyDraftMode() {
    const draft = this.data.draft || {};
    const recordEntry = Boolean(draft.recordId);
    const mainEntry = !recordEntry || ['manual', 'edit_main'].includes(draft.sourceType) && !draft.recordId;
    if (mainEntry) {
      this.setData({ confirmMode: 'main', publishAsMain: true, publishLocked: true });
      return;
    }
    const hasMain = Boolean(draft.baseMainVersionId);
    this.setData({
      confirmMode: 'record',
      publishAsMain: !hasMain,
      publishLocked: !hasMain,
    });
  },

  toggleSources() {
    this.setData({ sourceExpanded: !this.data.sourceExpanded });
  },

  playSource(event) {
    if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return;
    const id = String(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id || ''
      : '');
    const source = (this.data.sourceRecordings || []).find((item) => item.id === id);
    if (!source || !source.audioUrl) {
      showToast('这段原始语音暂时不可播放');
      return;
    }
    this.destroySourceAudio();
    const context = wx.createInnerAudioContext();
    this.sourceAudioContext = context;
    this.setData({ playingSourceId: id });
    if (typeof context.onEnded === 'function') context.onEnded(() => this.destroySourceAudio());
    if (typeof context.onError === 'function') context.onError(() => this.destroySourceAudio());
    context.src = source.audioUrl;
    if (typeof context.play === 'function') context.play();
  },

  destroySourceAudio() {
    const context = this.sourceAudioContext;
    this.sourceAudioContext = null;
    if (context && typeof context.destroy === 'function') {
      try {
        context.destroy();
      } catch (error) {
        // Audio cleanup is best effort.
      }
    }
    if (this.data.playingSourceId) this.setData({ playingSourceId: '' });
  },

  acknowledgeUncertainty(event) {
    if (this.data.confirming || this.data.draftStatus === 'organizing' || this.data.draftStatus === 'confirmed') return;
    const index = Number(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : -1);
    const recipe = cloneRecipe(this.data.recipe);
    if (!Number.isInteger(index) || index < 0 || index >= recipe.uncertainties.length) return;
    recipe.uncertainties = recipe.uncertainties.filter((_item, itemIndex) => itemIndex !== index);
    this.recipeDirty = true;
    this.editGeneration = (this.editGeneration || 0) + 1;
    this.setData({
      recipe,
      uncertaintyItems: uncertaintyViews(recipe),
      validation: validateRecipe(recipe),
    });
    this.scheduleAutosave();
  },

  continueManualEditing() {
    if (this.data.draftStatus !== 'failed' || this.data.confirming) return;
    this.setData({ manualEditing: true });
  },

  openConfirmedRecipe() {
    const versionId = String(this.data.draft && this.data.draft.confirmedVersionId || '');
    if (typeof wx !== 'undefined' && typeof wx.redirectTo === 'function') {
      wx.redirectTo({
        url: recipeUrl({ familyId: this.data.familyId, dishId: this.data.dishId, versionId }),
      });
    }
  },

  async retryOrganize() {
    if (this.data.organizeRequestPending || this.data.draftStatus === 'organizing' || !this.data.draft) return false;
    const recipeAssistant = this.getRecipeAssistant();
    if (!recipeAssistant || typeof recipeAssistant.organizeDraft !== 'function') {
      showToast('智能整理需要启用 CloudBase');
      return false;
    }
    let sourceRecordingIds = (Array.isArray(this.data.draft.sourceRecordingIds)
      ? this.data.draft.sourceRecordingIds
      : [])
      .map((value) => String(value))
      .filter(Boolean);
    if (!sourceRecordingIds.length && this.data.canOrganizeSources) {
      sourceRecordingIds = (this.data.sourceRecordings || []).map((item) => String(item.id || '')).filter(Boolean);
    }
    if (!sourceRecordingIds.length) {
      showToast('没有可重新整理的来源文字');
      return false;
    }
    this.setData({
      organizeRequestPending: true,
      draftStatus: 'organizing',
      stateMessage: DRAFT_STATE_MESSAGES.organizing,
      manualEditing: false,
      draft: { ...this.data.draft, status: 'organizing' },
    });
    try {
      const result = await recipeAssistant.organizeDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId: this.data.draftId,
        sourceRecordingIds,
      });
      const draft = result && result.draft;
      if (!draft) return this.loadDraft();
      const recipe = cloneRecipe(draft.recipe);
      this.lastSavedRecipeJson = JSON.stringify(recipe);
      this.recipeDirty = false;
      const draftStatus = String(draft.status || 'ready');
      this.setData({
        draft,
        recipe,
        validation: validateRecipe(recipe),
        draftStatus,
        stateMessage: DRAFT_STATE_MESSAGES[draftStatus] || '',
        organizeRequestPending: false,
        manualEditing: draftStatus !== 'failed',
        uncertaintyItems: uncertaintyViews(recipe),
      });
      this.applyDraftMode();
      return true;
    } catch (error) {
      this.setData({ organizeRequestPending: false });
      await this.loadDraft();
      return false;
    }
  },

  onRecipeChange(event) {
    if (this.data.confirming || this.data.draftStatus === 'organizing' || this.data.draftStatus === 'confirmed') return;
    const recipe = cloneRecipe(event.detail && event.detail.recipe);
    this.recipeDirty = true;
    this.editGeneration = (this.editGeneration || 0) + 1;
    this.setData({ recipe, uncertaintyItems: uncertaintyViews(recipe), localConflictRecipe: null });
    this.scheduleAutosave();
  },

  onRecipeValidation(event) {
    if (this.data.confirming) return;
    this.setData({ validation: event.detail || { ok: false, errors: ['菜谱内容不完整'] } });
  },

  scheduleAutosave() {
    this.clearAutosaveTimer();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      return this.saveDraftNow();
    }, 800);
  },

  async saveDraftNow() {
    this.clearAutosaveTimer();
    if (this.saveDrainPromise) return this.saveDrainPromise;
    if (this.data.draftStatus === 'organizing' || this.data.draftStatus === 'confirmed') return false;
    const validation = validateRecipe(this.data.recipe);
    this.setData({ validation });
    if (!validation.ok || !this.data.draft) {
      this.setData({ saveState: 'invalid', saveMessage: '请先补全必填内容' });
      return false;
    }
    const recipeAssistant = this.getRecipeAssistant();
    if (!recipeAssistant) {
      this.setData({ saveState: 'error', saveMessage: '家庭菜谱需要启用 CloudBase' });
      return false;
    }
    this.saveDrainPromise = this.drainDraftSaves(recipeAssistant)
      .finally(() => { this.saveDrainPromise = null; });
    return this.saveDrainPromise;
  },

  async drainDraftSaves(recipeAssistant) {
    let shouldSave = this.recipeDirty
      || this.lastSavedRecipeJson !== JSON.stringify(normalizeRecipe(this.data.recipe));
    while (shouldSave) {
      this.clearAutosaveTimer();
      const validation = validateRecipe(this.data.recipe);
      this.setData({ validation });
      if (!validation.ok || !this.data.draft) {
        this.setData({ saveState: 'invalid', saveMessage: '请先补全必填内容' });
        return false;
      }
      const recipe = cloneRecipe(this.data.recipe);
      const generation = this.editGeneration || 0;
      const revision = this.data.draft.revision;
      this.setData({ saveState: 'saving', saveMessage: '保存中' });
      try {
        const result = await recipeAssistant.updateDraft({
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          draftId: this.data.draftId,
          revision,
          recipe,
        });
        const draft = result && result.draft
          ? result.draft
          : { ...this.data.draft, revision: revision + 1 };
        this.lastSavedRecipeJson = JSON.stringify(recipe);
        const hasNewerEdit = (this.editGeneration || 0) !== generation;
        this.recipeDirty = hasNewerEdit;
        shouldSave = hasNewerEdit;
        this.setData({
          draft,
          saveState: hasNewerEdit ? 'saving' : 'saved',
          saveMessage: hasNewerEdit ? '保存中' : '已保存',
        });
      } catch (error) {
        if (error && error.code === 'DRAFT_CONFLICT') {
          const localConflictRecipe = cloneRecipe(this.data.recipe);
          this.setData({
            localConflictRecipe,
            saveState: 'conflict',
            saveMessage: '保存冲突，刷新后可重新应用本地内容',
          });
          return false;
        }
        this.setData({ saveState: 'error', saveMessage: '暂时无法保存，请稍后重试' });
        return false;
      }
    }
    return true;
  },

  async refreshAfterConflict() {
    const localConflictRecipe = this.data.localConflictRecipe
      ? cloneRecipe(this.data.localConflictRecipe)
      : cloneRecipe(this.data.recipe);
    this.setData({ localConflictRecipe });
    await this.loadDraft({ keepConflict: true });
  },

  reapplyLocalConflict() {
    if (!this.data.localConflictRecipe) return;
    const recipe = cloneRecipe(this.data.localConflictRecipe);
    this.recipeDirty = true;
    this.editGeneration = (this.editGeneration || 0) + 1;
    this.setData({
      recipe,
      uncertaintyItems: uncertaintyViews(recipe),
      validation: validateRecipe(recipe),
      localConflictRecipe: null,
    });
    this.scheduleAutosave();
  },

  chooseRecordOnly() {
    if (this.data.confirming || this.data.confirmMode !== 'record' || this.data.publishLocked) return;
    this.setData({ publishAsMain: false });
  },

  choosePublishMain() {
    if (this.data.confirming || this.data.confirmMode !== 'record') return;
    this.setData({ publishAsMain: true });
  },

  async confirmRecipe() {
    const validation = validateRecipe(this.data.recipe);
    this.setData({ validation });
    if (!validation.ok || !this.data.draft || this.data.confirming
      || this.data.draftStatus === 'organizing' || this.data.draftStatus === 'confirmed') {
      if (!validation.ok) showToast('请先补全菜谱必填内容');
      return;
    }
    this.setData({ confirming: true });
    this.clearAutosaveTimer();
    let confirmed = false;
    try {
      if (this.recipeDirty || this.saveDrainPromise) {
        const saved = await this.saveDraftNow();
        if (!saved) return;
      }
      const recipeAssistant = this.getRecipeAssistant();
      if (!recipeAssistant) {
        showToast('家庭菜谱需要启用 CloudBase');
        return;
      }
      const publishAsMain = this.data.confirmMode === 'main'
        || this.data.publishLocked
        || this.data.publishAsMain;
      const result = await recipeAssistant.confirmDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId: this.data.draftId,
        revision: this.data.draft.revision,
        publishAsMain,
        baseMainVersionId: String(this.data.draft.baseMainVersionId || ''),
      });
      confirmed = true;
      this.clearAutosaveTimer();
      showToast('菜谱已确认', 'success');
      const versionId = result && result.version && (result.version._id || result.version.id);
      if (typeof wx !== 'undefined' && typeof wx.redirectTo === 'function') {
        wx.redirectTo({
          url: recipeUrl({
            familyId: this.data.familyId,
            dishId: this.data.dishId,
            versionId: publishAsMain ? '' : versionId,
          }),
        });
      }
    } catch (error) {
      if (error && (error.code === 'DRAFT_CONFLICT' || error.code === 'MAIN_RECIPE_CONFLICT')) {
        this.setData({
          localConflictRecipe: cloneRecipe(this.data.recipe),
          saveState: 'conflict',
          saveMessage: '保存冲突，刷新后可重新应用本地内容',
        });
      } else {
        showToast('暂时无法确认菜谱');
      }
    } finally {
      if (!confirmed) this.setData({ confirming: false });
    }
  },
});
