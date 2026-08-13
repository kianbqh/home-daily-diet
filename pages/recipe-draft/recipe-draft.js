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
    await this.loadDraft();
  },

  onUnload() {
    this.clearAutosaveTimer();
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
    this.setData({ loading: true, error: '', unavailable: false });
    try {
      const result = await recipeAssistant.getDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId: this.data.draftId,
      });
      const draft = result && result.draft;
      if (!draft) throw new Error('missing draft');
      const recipe = cloneRecipe(draft.recipe);
      this.lastSavedRecipeJson = JSON.stringify(recipe);
      this.recipeDirty = false;
      this.setData({
        loading: false,
        draft,
        recipe,
        validation: validateRecipe(recipe),
        saveState: 'saved',
        saveMessage: '已保存',
      });
      this.applyDraftMode();
      if (options.keepConflict) return;
      this.setData({ localConflictRecipe: null });
    } catch (error) {
      this.setData({ loading: false, error: '菜谱草稿暂时无法读取' });
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

  onRecipeChange(event) {
    if (this.data.confirming) return;
    const recipe = cloneRecipe(event.detail && event.detail.recipe);
    this.recipeDirty = true;
    this.editGeneration = (this.editGeneration || 0) + 1;
    this.setData({ recipe, localConflictRecipe: null });
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
    this.setData({ recipe, validation: validateRecipe(recipe), localConflictRecipe: null });
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
    if (!validation.ok || !this.data.draft || this.data.confirming) {
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
