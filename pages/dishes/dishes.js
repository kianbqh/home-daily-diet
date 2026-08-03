const { buildLibraryViewModel } = require('../../utils/view-model');

Page({
  data: {
    query: '',
    activeTag: 'all',
    tags: [
      { key: 'all', label: '全部' },
      { key: '荤菜', label: '荤菜' },
      { key: '素菜', label: '素菜' },
      { key: '汤', label: '汤' },
      { key: '主食', label: '主食' },
      { key: 'favorite', label: '家人喜欢' },
    ],
    dishes: [],
    emptyTitle: '记录第一道家里的菜',
    emptyDescription: '记录一道家里的菜，它就会出现在这里，也能参与今天的选择。',
    hasSearch: false,
  },
  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },
  onLoad(options) {
    const store = this.getStore();
    if (store && typeof store.subscribe === 'function') {
      this.unsubscribe = store.subscribe(() => this.refresh());
    }
    if (options && options.query) this.setData({ query: options.query });
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
    const model = buildLibraryViewModel(store.getState(), {
      query: this.data.query,
      tag: this.data.activeTag,
    });
    this.setData({
      dishes: model.dishes,
      emptyTitle: model.emptyTitle,
      emptyDescription: model.emptyDescription,
      hasSearch: model.hasSearch,
    });
  },
  onSearch(event) {
    this.setData({ query: event.detail.value }, () => this.refresh());
  },
  clearSearch() {
    this.setData({ query: '' }, () => this.refresh());
  },
  chooseTag(event) {
    this.setData({ activeTag: event.currentTarget.dataset.tag }, () => this.refresh());
  },
  goAdd() {
    wx.navigateTo({ url: '/pages/dish-edit/dish-edit' });
  },
  onDishTap(event) {
    wx.navigateTo({ url: `/pages/dish-edit/dish-edit?dishId=${event.detail.dish.id}` });
  },
  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
