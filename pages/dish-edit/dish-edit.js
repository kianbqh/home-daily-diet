const { DISH_CATEGORIES, DISH_TAGS } = require('../../services/domain');
const { todayString } = require('../../utils/format');
const { buildDishDetailViewModel } = require('../../utils/view-model');
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
  },

  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
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
    const dish = options.dishId
      ? store.getState().dishes.find((item) => item.id === options.dishId)
      : null;
    if (!dish) return;

    const isArchived = dish.status === 'deleted';
    const isEditingProfile = options.mode === 'edit' && !isArchived;
    const detail = buildDishDetailViewModel(store.getState(), dish.id);
    const displayDetail = withHistoryDisplayImages(detail);
    const image = isEditingProfile ? dish.coverImage || '' : '';
    const visibleImage = isCloudFileId(image) ? '' : image;
    const visibleCover = isCloudFileId(dish.coverImage || '') ? '' : dish.coverImage || '';
    this.setData({
      isExisting: true,
      isEditingProfile,
      editProfileVisible: isEditingProfile,
      recordFormVisible: false,
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
  },

  onShow() {
    syncPageFromCloud(this).catch(() => {});
  },

  onPullDownRefresh() {
    return syncPageFromCloud(this, { force: true, manual: true });
  },

  onUnload() {
    this.beginImageResolution('cover');
    this.beginImageResolution('profilePreview');
    this.beginImageResolution('history');
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
    this.setData({
      recordFormVisible: true,
      recordDate: todayString(),
    });
  },

  cancelRecordEntry() {
    if (!this.data.isExisting) return;
    this.setData({
      recordFormVisible: false,
      image: '',
      displayImage: '',
      recordDate: todayString(),
      mealType: '',
      mealTypeLabel: '未指定餐次',
      customMealType: '',
      customMealTypeDraft: '',
    });
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
    let image = '';
    try {
      image = await this.uploadCurrentImage();
    } catch (error) {
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
        recordedAt: isoForDate(this.data.recordDate),
        mealType,
      };
      if (this.data.isExisting) {
        store.addCookingRecord({ ...payload, dishId: this.data.dishId });
        this.setData({ image: '', displayImage: '', recordFormVisible: false });
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
