const { buildRecipeSummary, decorateVersion, decorateVersions } = require('../../utils/recipe-view-model');
const {
  recipeRecordingUrl,
  resolveRecipeRecordingRecordId,
} = require('../../utils/recipe-recording-entry');

function showToast(title) {
  if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon: 'none' });
  }
}

function recipeUrl(path, values) {
  const query = Object.entries(values)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/${path}?${query}`;
}

Page({
  data: {
    familyId: '',
    dishId: '',
    versionId: '',
    loading: true,
    error: '',
    unavailable: false,
    isHistorical: false,
    isArchived: false,
    version: null,
    recipe: null,
    summary: buildRecipeSummary(null),
    versions: [],
    versionsError: '',
    actionBusy: false,
  },

  getContext() {
    const app = typeof getApp === 'function' ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    return {
      store: globalData.store || null,
      recipeAssistant: globalData.recipeAssistant || null,
    };
  },

  async onLoad(options = {}) {
    this.setData({
      familyId: String(options.familyId || ''),
      dishId: String(options.dishId || ''),
      versionId: String(options.versionId || ''),
      isHistorical: Boolean(options.versionId),
      isArchived: String(options.archived || '') === '1',
    });
    await this.loadRecipe();
  },

  async onPullDownRefresh() {
    try {
      await this.loadRecipe();
    } finally {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh();
      }
    }
  },

  async loadRecipe() {
    const generation = (this.recipeLoadGeneration || 0) + 1;
    this.recipeLoadGeneration = generation;
    const { store, recipeAssistant } = this.getContext();
    if (!recipeAssistant) {
      this.setData({
        loading: false,
        unavailable: true,
        error: '家庭菜谱需要启用 CloudBase',
        versionsError: '',
      });
      return false;
    }
    const state = store && typeof store.getState === 'function' ? store.getState() : {};
    const members = Array.isArray(state.members) ? state.members : [];
    this.setData({ loading: true, error: '', unavailable: false, versionsError: '' });
    const request = { familyId: this.data.familyId, dishId: this.data.dishId };
    const settle = (promise) => Promise.resolve(promise)
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }));
    const recipeRequest = this.data.versionId
      ? recipeAssistant.getVersion({ ...request, versionId: this.data.versionId })
      : recipeAssistant.getRecipe(request);
    const versionsRequest = typeof recipeAssistant.listVersions === 'function'
      ? recipeAssistant.listVersions(request)
      : Promise.reject(new Error('listVersions unavailable'));
    const [recipeOutcome, versionsOutcome] = await Promise.all([
      settle(recipeRequest),
      settle(versionsRequest),
    ]);
    if (generation !== this.recipeLoadGeneration) return false;

    const patch = {
      loading: false,
      versionsError: versionsOutcome.ok ? '' : '历史版本暂时无法读取',
    };
    if (versionsOutcome.ok) {
      patch.versions = decorateVersions(
        versionsOutcome.value && versionsOutcome.value.versions,
        members,
      );
    }
    if (recipeOutcome.ok) {
      const recipeResult = recipeOutcome.value;
      const version = decorateVersion(recipeResult && recipeResult.version, members);
      Object.assign(patch, {
        error: '',
        version,
        recipe: version ? version.recipe : null,
        summary: buildRecipeSummary({ version }, members),
      });
    } else {
      patch.error = '家庭菜谱暂时无法读取';
    }
    this.setData(patch);
    return recipeOutcome.ok;
  },

  startVoiceRecipeEntry() {
    if (this.data.isHistorical || this.data.isArchived) return false;
    const { store } = this.getContext();
    const state = store && typeof store.getState === 'function' ? store.getState() : {};
    const recordId = resolveRecipeRecordingRecordId(
      state,
      this.data.dishId,
      '',
      this.data.familyId,
    );
    if (!recordId) {
      showToast('请先为这道菜保存一次制作记录');
      return false;
    }
    if (typeof wx === 'undefined' || typeof wx.navigateTo !== 'function') return false;
    wx.navigateTo({
      url: recipeRecordingUrl({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        recordId,
      }),
    });
    return true;
  },

  openVersion(event) {
    const versionId = String(event.currentTarget.dataset.versionId || '');
    if (!versionId || versionId === this.data.versionId) return;
    if (typeof wx !== 'undefined' && typeof wx.navigateTo === 'function') {
      wx.navigateTo({
        url: recipeUrl('pages/recipe/recipe', {
          familyId: this.data.familyId,
          dishId: this.data.dishId,
          versionId,
        }),
      });
    }
  },

  async openManualRecipe() {
    if (this.data.isHistorical || this.data.isArchived || this.data.actionBusy) return false;
    const { recipeAssistant } = this.getContext();
    if (!recipeAssistant) {
      showToast('家庭菜谱需要启用 CloudBase');
      return false;
    }
    if (this.data.loading || this.data.error) {
      showToast('请先刷新菜谱状态再手动填写');
      return false;
    }
    this.setData({ actionBusy: true });
    try {
      const result = await recipeAssistant.createManualDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        sourceType: this.data.version ? 'edit_main' : 'manual',
      });
      const draftId = result && result.draft && (result.draft._id || result.draft.id);
      if (!draftId) throw new Error('missing draft');
      if (typeof wx !== 'undefined' && typeof wx.navigateTo === 'function') {
        wx.navigateTo({
          url: recipeUrl('pages/recipe-draft/recipe-draft', {
            familyId: this.data.familyId,
            dishId: this.data.dishId,
            draftId,
          }),
        });
      }
      return true;
    } catch (error) {
      showToast('暂时无法创建菜谱草稿');
      return false;
    } finally {
      this.setData({ actionBusy: false });
    }
  },

  editMainRecipe() {
    return this.openManualRecipe();
  },
});
