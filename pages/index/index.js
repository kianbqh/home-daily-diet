const { buildHomeViewModel } = require('../../utils/view-model');
const { todayString } = require('../../utils/format');

Page({
  data: {
    model: {},
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    const store = getApp().globalData.store;
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
    const store = getApp().globalData.store;
    if (store.getState().dishes.length === 0) {
      wx.showToast({ title: '先记录一道菜', icon: 'none' });
      this.goRecord();
      return;
    }
    const meal = store.ensureMeal({ date: todayString(), mealType: 'dinner' });
    wx.navigateTo({ url: `/pages/meal/meal?sessionId=${meal.id}` });
  },
  onShareAppMessage() {
    const store = getApp().globalData.store;
    if (store.getState().dishes.length === 0) {
      return {
        title: '一起记录家里的菜',
        path: '/pages/index/index',
      };
    }
    const meal = store.ensureMeal({ date: todayString(), mealType: 'dinner' });
    return {
      title: '今天晚餐吃什么？来选一道家里的菜',
      path: `/pages/meal/meal?sessionId=${meal.id}&date=${todayString()}&familyId=${store.getState().family.id}`,
    };
  },
});
