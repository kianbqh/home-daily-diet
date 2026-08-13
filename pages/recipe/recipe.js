const { buildRecipeSummary, decorateVersion, decorateVersions } = require('../../utils/recipe-view-model');

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
    version: null,
    recipe: null,
    summary: buildRecipeSummary(null),
    versions: [],
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
    const { store, recipeAssistant } = this.getContext();
    if (!recipeAssistant) {
      this.setData({
        loading: false,
        unavailable: true,
        error: '家庭菜谱需要启用 CloudBase',
      });
      return;
    }
    const state = store && typeof store.getState === 'function' ? store.getState() : {};
    const members = Array.isArray(state.members) ? state.members : [];
    this.setData({ loading: true, error: '', unavailable: false });
    try {
      const request = { familyId: this.data.familyId, dishId: this.data.dishId };
      const [recipeResult, versionsResult] = await Promise.all([
        this.data.versionId
          ? recipeAssistant.getVersion({ ...request, versionId: this.data.versionId })
          : recipeAssistant.getRecipe(request),
        recipeAssistant.listVersions(request),
      ]);
      const version = decorateVersion(recipeResult && recipeResult.version, members);
      this.setData({
        loading: false,
        version,
        recipe: version ? version.recipe : null,
        summary: buildRecipeSummary({ version }, members),
        versions: decorateVersions(versionsResult && versionsResult.versions, members),
      });
    } catch (error) {
      this.setData({ loading: false, error: '家庭菜谱暂时无法读取' });
    }
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

  async editMainRecipe() {
    const { recipeAssistant } = this.getContext();
    if (!recipeAssistant) {
      showToast('家庭菜谱需要启用 CloudBase');
      return;
    }
    try {
      const result = await recipeAssistant.createManualDraft({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        sourceType: 'edit_main',
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
    } catch (error) {
      showToast('暂时无法创建菜谱草稿');
    }
  },
});
