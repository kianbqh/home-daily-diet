const { buildHomeViewModel } = require('../../utils/view-model');
const { todayString } = require('../../utils/format');

Page({
  data: {
    model: {},
  },
  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },
  onLoad() {
    const store = this.getStore();
    if (store && typeof store.subscribe === 'function') {
      this.unsubscribe = store.subscribe(() => this.refresh());
    }
  },
  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    const store = this.getStore();
    if (!store) return;
    this.setData({ model: buildHomeViewModel(store.getState(), todayString()) });
  },
  goRecord() {
    wx.navigateTo({ url: '/pages/dish-edit/dish-edit' });
  },
  goDishes() {
    wx.navigateTo({ url: '/pages/dishes/dishes' });
  },
  goFamily() {
    wx.navigateTo({ url: '/pages/family/family' });
  },
  goMeal() {
    const store = this.getStore();
    if (store.getState().dishes.length === 0) {
      wx.showToast({ title: '先记录一道菜', icon: 'none' });
      this.goRecord();
      return;
    }
    const meal = store.ensureMeal({ date: todayString(), mealType: 'dinner' });
    wx.navigateTo({ url: `/pages/meal/meal?sessionId=${meal.id}` });
  },
  onShareAppMessage() {
    const store = this.getStore();
    if (store.getState().dishes.length === 0) {
      return {
        title: '一起记录家里的菜',
        path: '/pages/index/index',
      };
    }
    const meal = store.ensureMeal({ date: todayString(), mealType: 'dinner' });
    const inviteCode = store.getFamilySummary().inviteCode || '';
    return {
      title: '今天晚餐吃什么？来选一道家里的菜',
      path: inviteCode
        ? `/pages/meal/meal?sessionId=${meal.id}&date=${todayString()}&inviteCode=${encodeURIComponent(inviteCode)}`
        : '/pages/family/family',
    };
  },
});
