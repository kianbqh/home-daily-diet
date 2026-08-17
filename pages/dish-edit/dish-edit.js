const { DISH_CATEGORIES, DISH_TAGS, createCookingRecordId } = require('../../services/domain');
const { todayString } = require('../../utils/format');
const { buildDishDetailViewModel } = require('../../utils/view-model');
const { buildRecipeSummary, buildRecordRecipeState } = require('../../utils/recipe-view-model');
const { isCloudFileId, resolveCloudFileUrls } = require('../../utils/cloud-image');
const { syncPageFromCloud } = require('../../utils/page-refresh');

function isoForDate(date) {
  return `${date}T12:00:00.000Z`;
}

function showToast(title, icon = 'none') {
  if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
    wx.showToast({ title, icon });
  }
}

function withHistoryDisplayImages(detail = {}) {
  const history = (Array.isArray(detail.history) ? detail.history : []).map((record) => ({
    ...record,
    displayImage: isCloudFileId(record.image) ? '' : record.image || '',
  }));
  const reviews = (Array.isArray(detail.reviews) ? detail.reviews : []).map((review) => ({
    ...review,
    displayRecordImage: isCloudFileId(review.recordImage) ? '' : review.recordImage || '',
  }));
  return { history, reviews };
}

Page({
  data: {
    isExisting: false,
    isEditingProfile: false,
    editProfileVisible: false,
    recordFormVisible: false,
    recordIdDraft: '',
    recordingFamilyKey: '',
    recordWorkspaceHasContent: false,
    recordWorkspaceReady: false,
    recordWorkspacePendingCount: 0,
    recordWorkspaceBusy: false,
    isArchived: false,
    canAddRecord: true,
    canEditProfile: false,
    dishId: '',
    name: '',
    nameDraft: '',
    image: '',
    displayImage: '',
    dishCover: '',
    selectedCategory: '',
    selectedTags: [],
    categoryOptions: DISH_CATEGORIES.map((key) => ({ key, label: key })),
    tagOptions: DISH_TAGS.map((key) => ({ key, label: key, selected: false })),
    recordDate: todayString(),
    mealType: '',
    mealTypeLabel: '未指定餐次',
    customMealType: '',
    customMealTypeDraft: '',
    mealTypes: [
      { key: '', label: '未指定餐次' },
      { key: 'breakfast', label: '早餐' },
      { key: 'lunch', label: '午餐' },
      { key: 'dinner', label: '晚餐' },
      { key: 'custom', label: '其他餐次' },
    ],
    history: [],
    reviews: [],
    reviewStats: null,
    reviewingRecordId: '',
    reviewStars: 0,
    reviewText: '',
    starRows: [1, 2, 3, 4, 5].map((value) => ({
      full: value,
      half: value - 0.5,
    })),
    myRating: '',
    ratingOptions: [],
    recipeSummary: buildRecipeSummary(null),
    recipeLoading: false,
    recipeError: '',
    recipeUnavailable: false,
  },

  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },

  getRecipeContext() {
    const app = typeof getApp === 'function' ? getApp() : null;
    const globalData = app && app.globalData ? app.globalData : {};
    return {
      store: globalData.store || null,
      recipeAssistant: globalData.recipeAssistant || null,
    };
  },

  makeTagOptions(selectedTags = []) {
    return DISH_TAGS.map((key) => ({
      key,
      label: key,
      selected: selectedTags.includes(key),
    }));
  },

  beginImageResolution(scope) {
    this.imageResolutionGenerations = this.imageResolutionGenerations || {};
    const generation = (this.imageResolutionGenerations[scope] || 0) + 1;
    this.imageResolutionGenerations[scope] = generation;
    return generation;
  },

  isCurrentImageResolution(scope, generation) {
    return Boolean(this.imageResolutionGenerations)
      && generation === this.imageResolutionGenerations[scope];
  },

  onLoad(options = {}) {
    const store = this.getStore();
    if (!store) return;
    const state = store.getState();
    const dish = options.dishId
      ? state.dishes.find((item) => item.id === options.dishId)
      : null;
    if (!dish) return;

    const isArchived = dish.status === 'deleted';
    const isEditingProfile = options.mode === 'edit' && !isArchived;
    const detail = buildDishDetailViewModel(state, dish.id);
    const displayDetail = withHistoryDisplayImages(detail);
    const image = isEditingProfile ? dish.coverImage || '' : '';
    const visibleImage = isCloudFileId(image) ? '' : image;
    const visibleCover = isCloudFileId(dish.coverImage || '') ? '' : dish.coverImage || '';
    this.setData({
      isExisting: true,
      isEditingProfile,
      editProfileVisible: isEditingProfile,
      recordFormVisible: false,
      recordingFamilyKey: String(state && state.family && state.family.id || ''),
      recordWorkspaceHasContent: false,
      recordWorkspaceReady: false,
      recordWorkspacePendingCount: 0,
      recordWorkspaceBusy: false,
      isArchived,
      canAddRecord: !isArchived,
      canEditProfile: !isArchived,
      dishId: dish.id,
      name: dish.name,
      nameDraft: dish.name,
      image,
      displayImage: visibleImage,
      dishCover: visibleCover,
      selectedCategory: dish.category || '',
      selectedTags: Array.isArray(dish.tags) ? dish.tags : [],
      tagOptions: this.makeTagOptions(Array.isArray(dish.tags) ? dish.tags : []),
      history: displayDetail.history,
      reviews: displayDetail.reviews,
      reviewStats: detail.reviewStats,
      reviewStars: 0,
      reviewText: '',
    });
    const coverGeneration = this.beginImageResolution('cover');
    const profilePreviewGeneration = this.beginImageResolution('profilePreview');
    const historyGeneration = this.beginImageResolution('history');
    this.resolveCloudImage(dish.coverImage, 'dishCover', 'cover', coverGeneration);
    this.resolveCloudImage(image, 'displayImage', 'profilePreview', profilePreviewGeneration);
    this.resolveHistoryImages(displayDetail.history, displayDetail.reviews, historyGeneration);
    this.refreshRecipeSummary();
    this.refreshRecordRecipeStates();
  },

  onShow() {
    syncPageFromCloud(this)
      .then(() => Promise.all([this.refreshRecipeSummary(), this.refreshRecordRecipeStates()]))
      .catch(() => {});
  },

  onPullDownRefresh() {
    return syncPageFromCloud(this, { force: true, manual: true })
      .then(() => Promise.all([this.refreshRecipeSummary(), this.refreshRecordRecipeStates()]));
  },

  onUnload() {
    this.beginImageResolution('cover');
    this.beginImageResolution('profilePreview');
    this.beginImageResolution('history');
    this.recipeRequestGeneration = (this.recipeRequestGeneration || 0) + 1;
    this.recordRecipePageGeneration = (this.recordRecipePageGeneration || 0) + 1;
  },

  async refreshRecipeSummary() {
    if (!this.data.dishId) return;
    const generation = (this.recipeRequestGeneration || 0) + 1;
    this.recipeRequestGeneration = generation;
    const { store, recipeAssistant } = this.getRecipeContext();
    if (!recipeAssistant) {
      this.setData({
        recipeLoading: false,
        recipeUnavailable: true,
        recipeError: '家庭菜谱需要启用 CloudBase',
      });
      return;
    }
    this.setData({ recipeLoading: true, recipeError: '', recipeUnavailable: false });
    try {
      const state = store && typeof store.getState === 'function' ? store.getState() : {};
      const familyId = String(state && state.family && state.family.id || '');
      if (!familyId) throw new Error('missing family');
      const result = await recipeAssistant.getRecipe({ familyId, dishId: this.data.dishId });
      if (generation !== this.recipeRequestGeneration) return;
      this.setData({
        recipeSummary: buildRecipeSummary(result, state.members),
        recipeLoading: false,
        recipeError: '',
      });
    } catch (error) {
      if (generation !== this.recipeRequestGeneration) return;
      this.setData({ recipeLoading: false, recipeError: '家庭菜谱暂时无法读取' });
    }
  },

  async openFamilyRecipe() {
    if (!this.data.dishId) return;
    const { store, recipeAssistant } = this.getRecipeContext();
    if (!recipeAssistant) {
      this.setData({ recipeUnavailable: true, recipeError: '家庭菜谱需要启用 CloudBase' });
      showToast('家庭菜谱需要启用 CloudBase');
      return;
    }
    const state = store && typeof store.getState === 'function' ? store.getState() : {};
    const familyId = String(state && state.family && state.family.id || '');
    if (!familyId) {
      showToast('家庭信息还没有准备好');
      return;
    }
    try {
      let url = `/pages/recipe/recipe?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}`;
      if (!this.data.recipeSummary || !this.data.recipeSummary.hasRecipe) {
        if (this.data.isArchived) {
          showToast('历史菜品不能新建菜谱');
          return;
        }
        const result = await recipeAssistant.createManualDraft({
          familyId,
          dishId: this.data.dishId,
          sourceType: 'manual',
        });
        const draftId = result && result.draft && (result.draft._id || result.draft.id);
        if (!draftId) throw new Error('missing draft');
        url = `/pages/recipe-draft/recipe-draft?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}&draftId=${encodeURIComponent(draftId)}`;
      }
      if (typeof wx !== 'undefined' && typeof wx.navigateTo === 'function') wx.navigateTo({ url });
    } catch (error) {
      showToast('暂时无法打开家庭菜谱');
    }
  },

  async refreshRecordRecipeStates(options = {}) {
    if (!this.data.dishId) return false;
    const recordId = String(options.recordId || '');
    const pageGeneration = this.recordRecipePageGeneration || 0;
    const { recipeAssistant } = this.getRecipeContext();
    const familyId = this.currentFamilyId();
    const history = Array.isArray(this.data.history) ? this.data.history : [];
    const targets = recordId ? history.filter((item) => item.id === recordId) : history;
    if (!targets.length) return true;
    this.recordRecipeRequestVersions = this.recordRecipeRequestVersions || {};
    const requestVersions = new Map(targets.map((item) => {
      const version = (this.recordRecipeRequestVersions[item.id] || 0) + 1;
      this.recordRecipeRequestVersions[item.id] = version;
      return [item.id, version];
    }));
    if (!recipeAssistant || typeof recipeAssistant.getRecordWorkspace !== 'function' || !familyId) {
      const targetIds = new Set(targets.map((item) => item.id));
      this.setData({
        history: history.map((item) => targetIds.has(item.id) ? {
          ...item,
          recipeStateLoading: false,
          recipeStateError: '做法状态暂时无法读取',
        } : item),
      });
      return false;
    }

    const targetIds = new Set(targets.map((item) => item.id));
    this.setData({
      history: history.map((item) => targetIds.has(item.id)
        ? { ...item, recipeStateLoading: true, recipeStateError: '' }
        : item),
    });
    const results = await Promise.all(targets.map(async (record) => {
      try {
        const workspace = await recipeAssistant.getRecordWorkspace({
          familyId,
          dishId: this.data.dishId,
          recordId: record.id,
        });
        const state = buildRecordRecipeState(workspace, record.id);
        return {
          recordId: record.id,
          patch: {
            recipeState: state.state,
            recipeLabel: state.label,
            recipeActionLabel: state.actionLabel,
            recipeDraftId: state.draftId,
            recipeVersionId: state.versionId,
            recipeStateLoading: false,
            recipeStateError: '',
          },
        };
      } catch (error) {
        return {
          recordId: record.id,
          patch: { recipeStateLoading: false, recipeStateError: '做法状态暂时无法读取' },
        };
      }
    }));
    if (pageGeneration !== (this.recordRecipePageGeneration || 0)) return false;
    const patches = new Map(results
      .filter((item) => this.recordRecipeRequestVersions[item.recordId] === requestVersions.get(item.recordId))
      .map((item) => [item.recordId, item.patch]));
    this.setData({
      history: (this.data.history || []).map((item) => (
        patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item
      )),
    });
    return true;
  },

  retryRecordRecipeState(event) {
    const recordId = String(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.recordId || ''
      : '');
    return this.refreshRecordRecipeStates({ recordId });
  },

  async openRecordRecipe(event) {
    const recordId = String(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.recordId || ''
      : '');
    const record = (this.data.history || []).find((item) => item.id === recordId);
    const familyId = this.currentFamilyId();
    if (!record || !familyId || typeof wx === 'undefined' || typeof wx.navigateTo !== 'function') return;
    if (record.recipeVersionId) {
      wx.navigateTo({
        url: `/pages/recipe/recipe?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}&versionId=${encodeURIComponent(record.recipeVersionId)}`,
      });
      return;
    }
    if (record.recipeDraftId) {
      wx.navigateTo({
        url: `/pages/recipe-draft/recipe-draft?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}&draftId=${encodeURIComponent(record.recipeDraftId)}`,
      });
      return;
    }
    if (record.recipeState !== 'draft' || this.recordRecipeOpeningId) return;
    const { recipeAssistant } = this.getRecipeContext();
    if (!recipeAssistant || typeof recipeAssistant.createManualDraft !== 'function') {
      showToast('菜谱草稿暂时无法创建');
      return;
    }
    this.recordRecipeOpeningId = recordId;
    try {
      let draftId = '';
      if (typeof recipeAssistant.getRecordWorkspace === 'function') {
        const workspace = await recipeAssistant.getRecordWorkspace({
          familyId,
          dishId: this.data.dishId,
          recordId,
        });
        draftId = String(workspace && workspace.draft
          && (workspace.draft._id || workspace.draft.id) || '');
      }
      if (!draftId) {
        const result = await recipeAssistant.createManualDraft({
          familyId,
          dishId: this.data.dishId,
          recordId,
          sourceType: 'manual',
        });
        draftId = String(result && result.draft && (result.draft._id || result.draft.id) || '');
      }
      if (!draftId) throw new Error('missing draft');
      wx.navigateTo({
        url: `/pages/recipe-draft/recipe-draft?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}&draftId=${encodeURIComponent(draftId)}`,
      });
    } catch (error) {
      showToast('菜谱草稿暂时无法创建');
    } finally {
      this.recordRecipeOpeningId = '';
    }
  },

  refresh() {
    if (!this.data.dishId || this.data.isEditingProfile) return;
    const store = this.getStore();
    if (!store) return;
    const state = store.getState();
    const dish = state.dishes.find((item) => item.id === this.data.dishId);
    if (!dish) return;

    const detail = buildDishDetailViewModel(state, dish.id);
    const displayDetail = withHistoryDisplayImages(detail);
    const isArchived = dish.status === 'deleted';
    const coverImage = dish.coverImage || '';
    this.setData({
      isExisting: true,
      isArchived,
      canAddRecord: !isArchived,
      canEditProfile: !isArchived,
      dishId: dish.id,
      name: dish.name,
      nameDraft: dish.name,
      dishCover: isCloudFileId(coverImage) ? '' : coverImage,
      selectedCategory: dish.category || '',
      selectedTags: Array.isArray(dish.tags) ? dish.tags : [],
      tagOptions: this.makeTagOptions(Array.isArray(dish.tags) ? dish.tags : []),
      history: displayDetail.history,
      reviews: displayDetail.reviews,
      reviewStats: detail.reviewStats,
    });
    const coverGeneration = this.beginImageResolution('cover');
    const historyGeneration = this.beginImageResolution('history');
    this.resolveCloudImage(coverImage, 'dishCover', 'cover', coverGeneration);
    this.resolveHistoryImages(displayDetail.history, displayDetail.reviews, historyGeneration);
  },

  onNameInput(event) {
    this.setData({ nameDraft: String(event.detail.value || '') });
  },

  chooseCategory(event) {
    if (this.data.isExisting && !this.data.isEditingProfile) return;
    const category = String(event.currentTarget.dataset.category || '');
    this.setData({ selectedCategory: category });
  },

  toggleTag(event) {
    if (this.data.isExisting && !this.data.isEditingProfile) return;
    const tag = String(event.currentTarget.dataset.tag || '');
    const selected = Array.isArray(this.data.selectedTags) ? this.data.selectedTags : [];
    const next = selected.includes(tag)
      ? selected.filter((item) => item !== tag)
      : [...selected, tag];
    this.setData({ selectedTags: next, tagOptions: this.makeTagOptions(next) });
  },

  chooseMealType(event) {
    const index = Number(event.detail.value);
    const mealType = this.data.mealTypes[index];
    if (!mealType) return;
    this.setData({ mealType: mealType.key, mealTypeLabel: mealType.label });
  },

  onCustomMealTypeInput(event) {
    this.setData({ customMealTypeDraft: String(event.detail.value || '') });
  },

  onRecordDateChange(event) {
    this.setData({ recordDate: event.detail.value });
  },

  startRecordEntry() {
    if (!this.data.isExisting || this.data.isArchived || this.data.editProfileVisible) return;
    let recordId = String(this.data.recordIdDraft || '');
    const familyId = this.currentFamilyId();
    if (!recordId) {
      const workspace = this.getRecordingWorkspace();
      const recovered = workspace && typeof workspace.findWorkspace === 'function'
        ? workspace.findWorkspace({ familyId, dishId: this.data.dishId })
        : null;
      recordId = String(recovered && recovered.recordId || '') || createCookingRecordId();
    }
    this.setData({
      recordFormVisible: true,
      recordIdDraft: recordId,
      recordDate: todayString(),
    });
  },

  getRecordingWorkspace() {
    if (typeof this.selectComponent !== 'function') return null;
    return this.selectComponent('#recipeRecordingWorkspace');
  },

  currentFamilyId() {
    if (this.data.recordingFamilyKey) return String(this.data.recordingFamilyKey);
    const store = this.getStore();
    const state = store && typeof store.getState === 'function' ? store.getState() : {};
    return String(state && state.family && state.family.id || '');
  },

  confirmRecordCancellation() {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
      wx.showModal({
        title: '取消本次记录？',
        content: '本次未保存的录音和文字会被删除',
        confirmText: '确认删除',
        confirmColor: '#b85c45',
        success: (result) => resolve(Boolean(result && result.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  resetRecordEntry() {
    this.setData({
      recordFormVisible: false,
      recordIdDraft: '',
      image: '',
      displayImage: '',
      recordDate: todayString(),
      mealType: '',
      mealTypeLabel: '未指定餐次',
      customMealType: '',
      customMealTypeDraft: '',
      recordWorkspaceHasContent: false,
      recordWorkspaceReady: false,
      recordWorkspacePendingCount: 0,
      recordWorkspaceBusy: false,
    });
  },

  async cancelRecordEntry() {
    if (!this.data.isExisting || this.data.recordWorkspaceBusy) return;
    const confirmed = await this.confirmRecordCancellation();
    if (!confirmed) return;
    const recordId = String(this.data.recordIdDraft || '');
    const familyId = this.currentFamilyId();
    const workspace = this.getRecordingWorkspace();
    const { recipeAssistant } = this.getRecipeContext();
    this.setData({ recordWorkspaceBusy: true });
    try {
      if (recordId && familyId && recipeAssistant
        && typeof recipeAssistant.cancelRecordWorkspace === 'function') {
        await recipeAssistant.cancelRecordWorkspace({
          familyId,
          dishId: this.data.dishId,
          recordId,
        });
      }
      if (workspace && typeof workspace.clearLocalClips === 'function') {
        await workspace.clearLocalClips();
      }
      this.resetRecordEntry();
    } catch (error) {
      this.setData({ recordWorkspaceBusy: false });
      showToast('制作过程暂时无法取消，请稍后重试');
    }
  },

  onRecordingWorkspaceChange(event) {
    const detail = event && event.detail ? event.detail : {};
    this.setData({
      recordWorkspaceHasContent: Boolean(detail.hasContent),
      recordWorkspaceReady: Boolean(detail.readyToOrganize),
      recordWorkspacePendingCount: Number(detail.pendingCount) || 0,
    });
  },

  onOpenRecordingDraft(event) {
    const draftId = String(event && event.detail && event.detail.draftId || '');
    const familyId = this.currentFamilyId();
    if (!draftId || !familyId || !this.data.dishId) return;
    if (typeof wx !== 'undefined' && typeof wx.navigateTo === 'function') {
      wx.navigateTo({
        url: `/pages/recipe-draft/recipe-draft?familyId=${encodeURIComponent(familyId)}&dishId=${encodeURIComponent(this.data.dishId)}&draftId=${encodeURIComponent(draftId)}`,
      });
    }
  },

  chooseImage() {
    if (typeof wx === 'undefined' || typeof wx.chooseMedia !== 'function') {
      showToast('当前环境暂不支持选图');
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (result) => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        const apply = (filePath) => this.setData({ image: filePath, displayImage: filePath });
        if (typeof wx.saveFile === 'function') {
          wx.saveFile({
            tempFilePath: file.tempFilePath,
            success: (saved) => apply(saved.savedFilePath),
            fail: () => apply(file.tempFilePath),
          });
          return;
        }
        apply(file.tempFilePath);
      },
    });
  },

  previewImage(event) {
    const current = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.src || ''
        : ''
    ).trim();
    if (!current
      || isCloudFileId(current)
      || typeof wx === 'undefined'
      || typeof wx.previewImage !== 'function') return;

    const history = Array.isArray(this.data.history) ? this.data.history : [];
    const reviews = Array.isArray(this.data.reviews) ? this.data.reviews : [];
    const candidates = [
      this.data.dishCover,
      ...history.map((record) => record.displayImage),
      ...reviews.map((review) => review.displayRecordImage),
    ];
    const urls = [...new Set(candidates
      .map((url) => String(url || '').trim())
      .filter((url) => url && !isCloudFileId(url)))];

    wx.previewImage({
      current,
      urls: urls.includes(current) ? urls : [current, ...urls],
    });
  },

  resolveCloudImage(fileId, field, scope, generation) {
    if (!fileId) return;
    if (!isCloudFileId(fileId)) {
      this.setData({ [field]: fileId });
      return;
    }
    const store = this.getStore();
    if (!store) return;
    resolveCloudFileUrls([fileId], store)
      .then((urls) => {
        if (!this.isCurrentImageResolution(scope, generation)) return;
        const image = urls.get(fileId) || '';
        this.setData({ [field]: image });
      })
      .catch(() => {
        if (!this.isCurrentImageResolution(scope, generation)) return;
        this.setData({ [field]: '' });
      });
  },

  resolveHistoryImages(history, reviews, generation) {
    const cloudFileIds = [
      ...history.map((record) => record.image),
      ...reviews.map((review) => review.recordImage),
    ].filter(isCloudFileId);
    const store = this.getStore();
    if (!cloudFileIds.length || !store) return;
    resolveCloudFileUrls(cloudFileIds, store)
      .then((urls) => {
        if (!this.isCurrentImageResolution('history', generation)) return;
        this.setData({
          history: history.map((record) => ({
            ...record,
            displayImage: isCloudFileId(record.image)
              ? urls.get(record.image) || ''
              : record.displayImage,
          })),
          reviews: reviews.map((review) => ({
            ...review,
            displayRecordImage: isCloudFileId(review.recordImage)
              ? urls.get(review.recordImage) || ''
              : review.displayRecordImage,
          })),
        });
      })
      .catch(() => {});
  },

  startReview(event) {
    if (!this.data.canAddRecord || this.data.isArchived) return;
    const recordId = String(event.currentTarget.dataset.recordId || '');
    const record = this.data.history.find((item) => item.id === recordId);
    if (!record) return;
    this.setData({
      reviewingRecordId: recordId,
      reviewStars: record.myReview ? Number(record.myReview.stars) : 0,
      reviewText: record.myReview ? record.myReview.text || '' : '',
    });
  },

  chooseReviewStar(event) {
    const stars = Number(event.currentTarget.dataset.stars);
    if (!Number.isFinite(stars) || stars < 0.5 || stars > 5) return;
    this.setData({ reviewStars: Math.round(stars * 2) / 2 });
  },

  onReviewTextInput(event) {
    this.setData({ reviewText: String(event.detail.value || '') });
  },

  cancelReview() {
    this.setData({ reviewingRecordId: '', reviewStars: 0, reviewText: '' });
  },

  submitReview() {
    const stars = Number(this.data.reviewStars);
    const recordId = this.data.reviewingRecordId;
    if (!recordId || !stars) {
      showToast('先选一个星级');
      return;
    }
    const store = this.getStore();
    if (!store || typeof store.rateRecord !== 'function') {
      showToast('应用还没有连接云端');
      return;
    }
    try {
      store.rateRecord({
        dishId: this.data.dishId,
        recordId,
        stars,
        text: String(this.data.reviewText || '').trim(),
      });
      const detail = buildDishDetailViewModel(store.getState(), this.data.dishId);
      const displayDetail = withHistoryDisplayImages(detail);
      const historyGeneration = this.beginImageResolution('history');
      this.setData({
        history: displayDetail.history,
        reviews: displayDetail.reviews,
        reviewStats: detail.reviewStats,
        reviewingRecordId: '',
        reviewStars: 0,
        reviewText: '',
      });
      this.resolveHistoryImages(displayDetail.history, displayDetail.reviews, historyGeneration);
      showToast('评价已保存', 'success');
    } catch (error) {
      showToast(error.message || '评价暂时无法保存');
    }
  },

  startProfileEdit() {
    if (!this.data.canEditProfile) return;
    const store = this.getStore();
    const dish = store && store.getState().dishes.find((item) => item.id === this.data.dishId);
    if (!dish) return;
    this.setData({
      isEditingProfile: true,
      editProfileVisible: true,
      name: dish.name,
      nameDraft: dish.name,
      image: dish.coverImage || '',
      displayImage: isCloudFileId(dish.coverImage || '') ? '' : dish.coverImage || '',
      dishCover: isCloudFileId(dish.coverImage || '') ? '' : dish.coverImage || '',
      selectedCategory: dish.category || '',
      selectedTags: Array.isArray(dish.tags) ? dish.tags : [],
      tagOptions: this.makeTagOptions(Array.isArray(dish.tags) ? dish.tags : []),
    });
    const generation = this.beginImageResolution('profilePreview');
    this.resolveCloudImage(dish.coverImage, 'displayImage', 'profilePreview', generation);
  },

  cancelProfileEdit() {
    const store = this.getStore();
    const dish = store && store.getState().dishes.find((item) => item.id === this.data.dishId);
    if (!dish) return;
    const coverImage = dish.coverImage || '';
    this.setData({
      isEditingProfile: false,
      editProfileVisible: false,
      name: dish.name,
      nameDraft: dish.name,
      image: '',
      displayImage: isCloudFileId(coverImage) ? '' : coverImage,
      dishCover: isCloudFileId(coverImage) ? '' : coverImage,
      selectedCategory: dish.category || '',
      selectedTags: Array.isArray(dish.tags) ? dish.tags : [],
      tagOptions: this.makeTagOptions(Array.isArray(dish.tags) ? dish.tags : []),
    });
    this.beginImageResolution('profilePreview');
    const generation = this.beginImageResolution('cover');
    this.resolveCloudImage(coverImage, 'dishCover', 'cover', generation);
  },

  // Kept as a compatibility shim for old local data/tests; the visible UI uses record reviews.
  chooseRating(event) {
    const rating = event.currentTarget.dataset.rating;
    const store = this.getStore();
    if (!rating || !store || typeof store.rateDish !== 'function') return;
    const legacyStars = { like: 5, neutral: 3, dislike: 1 }[rating];
    if (!legacyStars) return;
    try {
      store.rateDish({ dishId: this.data.dishId, rating });
      this.setData({ myRating: rating });
    } catch (error) {
      showToast(error.message || '评价暂时无法保存');
    }
  },

  deleteCurrentDish() {
    if (!this.data.isExisting || this.data.isEditingProfile || this.data.editProfileVisible || this.data.isArchived) return;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
    wx.showModal({
      title: '从菜品库移除？',
      content: '这道菜会进入回收站，过去的制作记录和评价会保留。',
      confirmText: '确认移除',
      confirmColor: '#b85c45',
      success: (result) => {
        if (!result.confirm) return;
        const store = this.getStore();
        if (!store || typeof store.deleteDish !== 'function') {
          showToast('应用还没有完成初始化');
          return;
        }
        store.deleteDish({ dishId: this.data.dishId });
        showToast('已移入回收站', 'success');
        setTimeout(() => wx.navigateBack({ delta: 1 }), 450);
      },
    });
  },

  async uploadCurrentImage() {
    const image = this.data.image;
    if (!image || /^(cloud:\/\/|https?:\/\/)/.test(image)) return image;
    const store = this.getStore();
    if (!store || typeof store.uploadImage !== 'function') return image;
    if (typeof wx !== 'undefined' && typeof wx.showLoading === 'function') {
      wx.showLoading({ title: '正在上传照片' });
    }
    try {
      return await store.uploadImage(image);
    } finally {
      if (typeof wx !== 'undefined' && typeof wx.hideLoading === 'function') wx.hideLoading();
    }
  },

  async save() {
    const name = String(this.data.nameDraft || this.data.name || '').trim();
    if (!name) {
      showToast('先写下菜名');
      return;
    }
    const store = this.getStore();
    if (!store) {
      showToast('应用还没有完成初始化');
      return;
    }
    const savingRecord = this.data.isExisting && !this.data.editProfileVisible;
    let recordWorkspace = null;
    let recipeAssistant = null;
    let recordFamilyId = '';
    if (savingRecord) {
      if (this.data.recordWorkspaceBusy) return;
      this.setData({ recordWorkspaceBusy: true });
      recordWorkspace = this.getRecordingWorkspace();
      const context = this.getRecipeContext();
      recipeAssistant = context.recipeAssistant;
      recordFamilyId = this.currentFamilyId();
      const hasUncommittedInput = Boolean(recordWorkspace
        && typeof recordWorkspace.hasUncommittedInput === 'function'
        && recordWorkspace.hasUncommittedInput());
      if (hasUncommittedInput) {
        this.setData({ recordWorkspaceBusy: false });
        showToast('请先添加或清空文字说明');
        return;
      }
      const hasPendingLocalClips = Boolean(recordWorkspace
        && typeof recordWorkspace.hasPendingLocalClips === 'function'
        && recordWorkspace.hasPendingLocalClips());
      if (hasPendingLocalClips) {
        this.setData({ recordWorkspaceBusy: false });
        showToast('仍有录音尚未上传，请重试后再保存');
        return;
      }
      if (this.data.recordWorkspaceHasContent
        && (!recordFamilyId || !recipeAssistant
          || typeof recipeAssistant.attachRecordWorkspace !== 'function')) {
        this.setData({ recordWorkspaceBusy: false });
        showToast('制作过程尚未连接云端，请稍后再保存');
        return;
      }
    }
    const existingRecord = savingRecord && typeof store.getState === 'function'
      ? (store.getState().cookingRecords || []).find((item) => (
        item.id === this.data.recordIdDraft && item.dishId === this.data.dishId
      )) || null
      : null;
    let image = '';
    try {
      image = existingRecord ? String(existingRecord.image || '') : await this.uploadCurrentImage();
    } catch (error) {
      if (savingRecord) this.setData({ recordWorkspaceBusy: false });
      showToast('照片上传失败，请重试');
      return;
    }

    const customMealType = String(this.data.customMealTypeDraft || this.data.customMealType || '').trim();
    const mealType = this.data.mealType === 'custom' ? customMealType || '其他餐次' : this.data.mealType;
    const tags = Array.isArray(this.data.selectedTags) ? this.data.selectedTags : [];

    try {
      if (this.data.isExisting && this.data.editProfileVisible) {
        store.updateDish({
          dishId: this.data.dishId,
          name,
          category: this.data.selectedCategory,
          tags,
          image,
        });
        const updatedDish = store.getState().dishes.find((item) => item.id === this.data.dishId);
        const detail = buildDishDetailViewModel(store.getState(), this.data.dishId);
        const displayDetail = withHistoryDisplayImages(detail);
        const coverImage = updatedDish ? updatedDish.coverImage || '' : '';
        const historyGeneration = this.beginImageResolution('history');
        this.setData({
          isEditingProfile: false,
          editProfileVisible: false,
          name: updatedDish ? updatedDish.name : name,
          nameDraft: updatedDish ? updatedDish.name : name,
          image: '',
          displayImage: '',
          dishCover: isCloudFileId(coverImage) ? '' : coverImage,
          selectedCategory: updatedDish ? updatedDish.category || '' : this.data.selectedCategory,
          selectedTags: updatedDish && Array.isArray(updatedDish.tags) ? updatedDish.tags : tags,
          tagOptions: this.makeTagOptions(updatedDish && Array.isArray(updatedDish.tags) ? updatedDish.tags : tags),
          history: displayDetail.history,
          reviews: displayDetail.reviews,
          reviewStats: detail.reviewStats,
        });
        this.beginImageResolution('profilePreview');
        const generation = this.beginImageResolution('cover');
        this.resolveCloudImage(coverImage, 'dishCover', 'cover', generation);
        this.resolveHistoryImages(displayDetail.history, displayDetail.reviews, historyGeneration);
        showToast('菜品信息已更新', 'success');
        return;
      }

      const payload = {
        name,
        category: this.data.selectedCategory,
        tags,
        image,
        recordedAt: existingRecord ? existingRecord.recordedAt : isoForDate(this.data.recordDate),
        mealType: existingRecord ? existingRecord.mealType : mealType,
      };
      if (this.data.isExisting) {
        if (typeof store.addCookingRecordAndWait !== 'function') {
          throw new Error('家庭云端保存暂时不可用');
        }
        await store.addCookingRecordAndWait({
          ...payload, id: this.data.recordIdDraft, dishId: this.data.dishId,
        });
        let workspaceAttached = false;
        if (recordFamilyId && recipeAssistant && typeof recipeAssistant.attachRecordWorkspace === 'function') {
          await recipeAssistant.attachRecordWorkspace({
            familyId: recordFamilyId,
            dishId: this.data.dishId,
            recordId: this.data.recordIdDraft,
          });
          workspaceAttached = true;
        }
        if (workspaceAttached && recordWorkspace
          && typeof recordWorkspace.finalizeAfterAttach === 'function') {
          const finalized = await recordWorkspace.finalizeAfterAttach();
          if (!finalized) throw new Error('仍有录音尚未上传，请重试后再保存');
        }
        this.resetRecordEntry();
        this.finishAndGoBack('这次记录已追加');
        return;
      }

      const duplicate = store.findDishByName ? store.findDishByName(name) : null;
      if (duplicate) {
        store.addCookingRecord({ ...payload, dishId: duplicate.id });
        this.setData({ image: '', displayImage: '' });
        this.finishAndGoBack('已追加到同名菜品');
        return;
      }
      store.addDish(payload);
      this.setData({ image: '', displayImage: '' });
      this.guideAfterFirstDish();
    } catch (error) {
      if (savingRecord) this.setData({ recordWorkspaceBusy: false });
      showToast(error.message || '菜品暂时无法保存');
    }
  },

  guideAfterFirstDish() {
    if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') return;
    wx.showActionSheet({
      itemList: ['去选今天吃什么', '继续记录下一道', '看看菜品库'],
      success: (result) => {
        const urls = ['/pages/meal/meal', '/pages/dish-edit/dish-edit', '/pages/dishes/dishes'];
        wx.redirectTo({ url: urls[result.tapIndex] });
      },
    });
  },

  finishAndGoBack(message) {
    showToast(message, 'success');
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') {
      setTimeout(() => wx.navigateBack({ delta: 1 }), 450);
    }
  },
});
