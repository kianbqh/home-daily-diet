const { resolveRecipeRecordingRecordId } = require('../../utils/recipe-recording-entry');

function draftUrl(values) {
  const query = Object.entries(values)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `/pages/recipe-draft/recipe-draft?${query}`;
}

Page({
  data: {
    familyId: '',
    dishId: '',
    recordId: '',
    preparing: true,
    error: '',
    hasContent: false,
    pendingCount: 0,
    draftStatus: '',
  },

  onLoad(options = {}) {
    this.setData({
      familyId: String(options.familyId || ''),
      dishId: String(options.dishId || ''),
      recordId: String(options.recordId || ''),
    });
  },

  onReady() {
    return this.prepareWorkspace();
  },

  prepareWorkspace() {
    const familyId = String(this.data.familyId || '');
    const dishId = String(this.data.dishId || '');
    if (!familyId || !dishId) {
      this.setData({ preparing: false, error: '缺少菜品信息，请返回后重试' });
      return false;
    }
    const workspace = typeof this.selectComponent === 'function'
      ? this.selectComponent('#recipeRecordingWorkspace')
      : null;
    const recovered = !this.data.recordId && workspace && typeof workspace.findWorkspace === 'function'
      ? workspace.findWorkspace({ familyId, dishId })
      : null;
    const app = typeof getApp === 'function' ? getApp() : null;
    const store = app && app.globalData ? app.globalData.store : null;
    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const preferredRecordId = String(this.data.recordId || (recovered && recovered.recordId) || '');
    const recordId = state
      ? resolveRecipeRecordingRecordId(state, dishId, preferredRecordId, familyId)
      : preferredRecordId;
    if (!recordId) {
      this.setData({
        preparing: false,
        error: '请先为这道菜保存一次制作记录，再使用语音整理菜谱',
      });
      return false;
    }
    this.setData({
      recordId,
      preparing: false,
      error: '',
    });
    return true;
  },

  onRecordingWorkspaceChange(event) {
    const detail = event && event.detail ? event.detail : {};
    this.setData({
      hasContent: Boolean(detail.hasContent),
      pendingCount: Number(detail.pendingCount) || 0,
      draftStatus: String(detail.draftStatus || ''),
    });
  },

  onOpenRecordingDraft(event) {
    const draftId = String(event && event.detail && event.detail.draftId || '');
    if (!draftId || !this.data.familyId || !this.data.dishId) return false;
    if (typeof wx === 'undefined' || typeof wx.navigateTo !== 'function') return false;
    wx.navigateTo({
      url: draftUrl({
        familyId: this.data.familyId,
        dishId: this.data.dishId,
        draftId,
      }),
    });
    return true;
  },
});
