const { todayString } = require('../../utils/format');
const { buildDishDetailViewModel } = require('../../utils/view-model');

function isoForDate(date) {
  return `${date}T12:00:00.000Z`;
}

Page({
  data: {
    isExisting: false,
    isEditingProfile: false,
    dishId: '',
    name: '',
    image: '',
    displayImage: '',
    tags: '',
    recordDate: todayString(),
    mealType: '',
    mealTypeLabel: '未指定餐次',
    customMealType: '',
    history: [],
    mealTypes: [
      { key: '', label: '未指定餐次' },
      { key: 'breakfast', label: '早餐' },
      { key: 'lunch', label: '午餐' },
      { key: 'dinner', label: '晚餐' },
      { key: 'custom', label: '其他餐次' },
    ],
  },
  onLoad(options = {}) {
    const store = getApp().globalData.store;
    const dish = options.dishId && store.getState().dishes.find((item) => item.id === options.dishId);
    if (!dish) return;
    const editProfile = options.mode === 'edit';
    const detail = buildDishDetailViewModel(store.getState(), dish.id);
    this.setData({
      isExisting: true,
      isEditingProfile: editProfile,
      dishId: dish.id,
      name: dish.name,
      tags: editProfile ? (dish.tags || []).join('、') : '',
      image: editProfile ? dish.coverImage : '',
      displayImage: editProfile ? dish.coverImage : '',
      history: detail.history,
    });
    this.resolveCloudImage(dish.coverImage, 'displayImage');
    this.resolveHistoryImages(detail.history);
  },
  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },
  onTagsInput(event) {
    this.setData({ tags: event.detail.value });
  },
  onCustomMealTypeInput(event) {
    this.setData({ customMealType: event.detail.value });
  },
  chooseMealType(event) {
    const index = Number(event.detail.value);
    const mealType = this.data.mealTypes[index];
    this.setData({
      mealType: mealType.key,
      mealTypeLabel: mealType.label,
    });
  },
  onRecordDateChange(event) {
    this.setData({ recordDate: event.detail.value });
  },
  chooseImage() {
    if (typeof wx.chooseMedia !== 'function') {
      wx.showToast({ title: '当前环境暂不支持选图', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (result) => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        if (typeof wx.saveFile === 'function') {
          wx.saveFile({
            tempFilePath: file.tempFilePath,
            success: (saved) => this.setData({
              image: saved.savedFilePath,
              displayImage: saved.savedFilePath,
            }),
            fail: () => this.setData({ image: file.tempFilePath, displayImage: file.tempFilePath }),
          });
          return;
        }
        this.setData({ image: file.tempFilePath, displayImage: file.tempFilePath });
      },
    });
  },
  startProfileEdit() {
    const dish = getApp().globalData.store.getState().dishes.find((item) => item.id === this.data.dishId);
    this.setData({
      isEditingProfile: true,
      tags: dish ? (dish.tags || []).join('、') : '',
      image: dish ? dish.coverImage : '',
      displayImage: dish ? dish.coverImage : '',
    });
    this.resolveCloudImage(dish && dish.coverImage, 'displayImage');
  },
  resolveCloudImage(fileId, field) {
    if (
      !fileId || fileId.indexOf('cloud://') !== 0
      || typeof wx === 'undefined' || !wx.cloud
      || typeof wx.cloud.getTempFileURL !== 'function'
    ) return;
    wx.cloud.getTempFileURL({
      fileList: [fileId],
      success: (result) => {
        const file = result.fileList && result.fileList[0];
        if (file && file.tempFileURL) this.setData({ [field]: file.tempFileURL });
      },
    });
  },
  resolveHistoryImages(history) {
    const cloudImages = history.filter((record) => record.image && record.image.indexOf('cloud://') === 0);
    if (!cloudImages.length || typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') return;
    wx.cloud.getTempFileURL({
      fileList: cloudImages.map((record) => record.image),
      success: (result) => {
        const urls = {};
        (result.fileList || []).forEach((file) => {
          if (file.fileID && file.tempFileURL) urls[file.fileID] = file.tempFileURL;
        });
        this.setData({
          history: history.map((record) => ({
            ...record,
            image: urls[record.image] || record.image,
          })),
        });
      },
    });
  },
  async save() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '先写下菜名', icon: 'none' });
      return;
    }
    const store = getApp().globalData.store;
    const tags = this.data.tags.split(/[，、\s]+/).filter(Boolean);
    let image = this.data.image;
    if (image && typeof store.uploadImage === 'function') {
      if (typeof wx.showLoading === 'function') wx.showLoading({ title: '正在保存图片' });
      try {
        image = await store.uploadImage(image);
      } catch (error) {
        image = '';
        wx.showToast({ title: '图片未上传，菜名已保存', icon: 'none' });
      } finally {
        if (typeof wx.hideLoading === 'function') wx.hideLoading();
      }
    }

    if (this.data.isExisting && this.data.isEditingProfile) {
      store.updateDish({ dishId: this.data.dishId, name, tags, image });
      this.finishAndGoBack('菜品信息已更新');
      return;
    }

    const payload = {
      name,
      image,
      tags,
      recordedAt: isoForDate(this.data.recordDate),
      mealType: this.data.mealType === 'custom'
        ? this.data.customMealType.trim() || '其他餐次'
        : this.data.mealType,
    };
    if (this.data.isExisting) {
      store.addCookingRecord({ ...payload, dishId: this.data.dishId });
      this.finishAndGoBack('这次记录已追加');
      return;
    }

    const duplicate = store.findDishByName(name);
    if (duplicate) {
      wx.showModal({
        title: '菜品库里已有同名菜',
        content: `要给“${duplicate.name}”追加一次制作记录吗？`,
        confirmText: '直接追加',
        cancelText: '继续新建',
        success: (result) => {
          if (result.confirm) {
            store.addCookingRecord({ ...payload, dishId: duplicate.id });
            this.finishAndGoBack('已追加制作记录');
            return;
          }
          store.addDish(payload);
          this.guideAfterFirstDish();
        },
      });
      return;
    }

    const similar = store.findSimilarDishes(name);
    if (similar.length) {
      wx.showModal({
        title: '发现相近的菜品',
        content: `菜品库里有“${similar[0].name}”，要先看看已有记录吗？`,
        confirmText: '去看看',
        cancelText: '仍然新建',
        success: (result) => {
          if (result.confirm) {
            wx.navigateTo({ url: `/pages/dishes/dishes?query=${encodeURIComponent(similar[0].name)}` });
            return;
          }
          store.addDish(payload);
          this.guideAfterFirstDish();
        },
      });
      return;
    }

    store.addDish(payload);
    this.guideAfterFirstDish();
  },
  guideAfterFirstDish() {
    wx.showActionSheet({
      itemList: ['去选今天吃什么', '继续记录下一道', '看看菜品库'],
      success: (result) => {
        const urls = [
          '/pages/meal/meal',
          '/pages/dish-edit/dish-edit',
          '/pages/dishes/dishes',
        ];
        wx.redirectTo({ url: urls[result.tapIndex] });
      },
    });
  },
  finishAndGoBack(message) {
    wx.showToast({ title: message, icon: 'success' });
    setTimeout(() => wx.navigateBack({ delta: 1 }), 450);
  },
});
