const { buildTrashViewModel } = require('../../utils/view-model');
const { isCloudFileId, resolveCloudFileUrls } = require('../../utils/cloud-image');
const { syncPageFromCloud } = require('../../utils/page-refresh');

Page({
  data: {
    dishes: [],
    count: 0,
    isEmpty: true,
    emptyTitle: '回收站是空的',
    emptyDescription: '移除的菜品会先放在这里。',
  },

  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },

  onShow() {
    syncPageFromCloud(this).catch(() => {});
  },

  onPullDownRefresh() {
    return syncPageFromCloud(this, { force: true, manual: true });
  },

  refresh() {
    const store = this.getStore();
    if (!store) return;
    const model = buildTrashViewModel(store.getState());
    const dishes = model.dishes.map((dish) => ({
      ...dish,
      displayCoverImage: isCloudFileId(dish.coverImage) ? '' : dish.coverImage || '',
    }));
    this.setData({ ...model, dishes });
    const cloudImages = dishes.filter((dish) => isCloudFileId(dish.coverImage));
    if (!cloudImages.length) return;
    resolveCloudFileUrls(cloudImages.map((dish) => dish.coverImage), store)
      .then((urls) => {
        this.setData({
          dishes: dishes.map((dish) => ({
            ...dish,
            displayCoverImage: urls.get(dish.coverImage) || dish.displayCoverImage,
          })),
        });
      })
      .catch(() => {});
  },

  openDish(event) {
    const dishId = String(event.currentTarget.dataset.dishId || '');
    if (dishId && typeof wx !== 'undefined') {
      wx.navigateTo({ url: `/pages/dish-edit/dish-edit?dishId=${dishId}&mode=archived` });
    }
  },

  restoreDish(event) {
    const dishId = String(event.currentTarget.dataset.dishId || '');
    if (!dishId || typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
    wx.showModal({
      title: '恢复这道菜？',
      content: '恢复后它会重新出现在菜品库，也可以继续追加制作记录。',
      confirmText: '恢复',
      success: (result) => {
        if (!result.confirm) return;
        const store = this.getStore();
        if (!store || typeof store.restoreDish !== 'function') return;
        try {
          store.restoreDish({ dishId });
          this.refresh();
          wx.showToast({ title: '已恢复', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: error.message || '恢复失败', icon: 'none' });
        }
      },
    });
  },

  purgeDish(event) {
    const dishId = String(event.currentTarget.dataset.dishId || '');
    if (!dishId || typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
    wx.showModal({
      title: '彻底删除这道菜？',
      content: '会同时删除它的制作记录和评价，删除后无法恢复。',
      confirmText: '彻底删除',
      confirmColor: '#b85c45',
      success: (result) => {
        if (!result.confirm) return;
        const store = this.getStore();
        if (!store || typeof store.purgeDish !== 'function') return;
        try {
          store.purgeDish({ dishId });
          this.refresh();
          wx.showToast({ title: '已彻底删除', icon: 'success' });
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  goBack() {
    if (typeof wx !== 'undefined' && typeof wx.navigateBack === 'function') wx.navigateBack({ delta: 1 });
  },
});
