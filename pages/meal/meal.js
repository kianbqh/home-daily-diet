const { buildMealViewModel } = require('../../utils/view-model');
const { todayString } = require('../../utils/format');

Page({
  data: {
    date: '',
    sessionId: '',
    finalDishIds: [],
    finalInitialized: false,
    joining: false,
    model: {},
  },
  onLoad(options) {
    const store = getApp().globalData.store;
    const sharedMeal = options.sessionId
      && store.getState().mealSessions.find((session) => session.id === options.sessionId);
    const joiningSharedFamily = Boolean(
      options.familyId
      && options.sessionId
      && !sharedMeal
      && store.getState().family.id !== options.familyId
    );
    this.setData({
      date: sharedMeal ? sharedMeal.date : (options.date || todayString()),
      sessionId: options.sessionId || '',
      joining: joiningSharedFamily,
    });
    if (joiningSharedFamily) {
      setTimeout(() => this.confirmJoinFromMeal(options.familyId, options.sessionId, options.date), 0);
    }
  },
  onShow() {
    if (this.data.joining) return;
    const store = getApp().globalData.store;
    if (store.getFamilySummary().cloudEnabled) {
      store.hydrateFromCloud().then(() => this.refresh()).catch(() => this.refresh());
      return;
    }
    this.refresh();
  },
  confirmJoinFromMeal(familyId, sessionId, fallbackDate) {
    wx.showModal({
      title: '加入家庭后查看晚餐？',
      content: '这个分享来自一个家庭空间，加入后才能看到完整的菜品和候选。',
      confirmText: '加入并查看',
      cancelText: '暂不加入',
      success: (result) => {
        if (!result.confirm) {
          this.setData({ joining: false });
          wx.reLaunch({ url: '/pages/index/index' });
          return;
        }
        const store = getApp().globalData.store;
        const state = store.getState();
        const current = state.members.find((member) => member.id === state.currentMemberId);
        store.joinFamily(familyId, {
          id: state.currentMemberId,
          displayName: current ? current.displayName : '我',
        }).then(() => {
          const meal = store.getState().mealSessions.find((item) => item.id === sessionId);
          this.setData({
            date: meal ? meal.date : (fallbackDate || todayString()),
            joining: false,
            finalDishIds: [],
            finalInitialized: false,
          }, () => this.refresh());
        }).catch(() => {
          this.setData({ joining: false });
          wx.showModal({
            title: '暂时无法打开晚餐',
            content: '请先配置 CloudBase 并加入家庭空间，再打开群里的选餐链接。',
            showCancel: false,
            success: () => wx.reLaunch({ url: '/pages/index/index' }),
          });
        });
      },
    });
  },
  refresh() {
    const store = getApp().globalData.store;
    const state = store.getState();
    if (state.dishes.length && !store.getMeal(this.data.date, 'dinner')) {
      store.ensureMeal({ date: this.data.date, mealType: 'dinner' });
    }
    const model = buildMealViewModel(store.getState(), this.data.date, store.getState().currentMemberId);
    const selectedIds = model.dishes.filter((dish) => dish.selected).map((dish) => dish.id);
    let finalDishIds = this.data.finalDishIds.filter((id) => selectedIds.includes(id));
    if (!this.data.finalInitialized) finalDishIds = selectedIds;
    model.dishes = model.dishes.map((dish) => ({
      ...dish,
      finalSelected: finalDishIds.includes(dish.id),
    }));
    model.finalDishCount = finalDishIds.length;
    this.setData({ model, finalDishIds, finalInitialized: true });
  },
  toggleDish(event) {
    const store = getApp().globalData.store;
    const model = this.data.model;
    if (!model.canEdit || !model.meal) return;
    const dish = model.dishes.find((item) => item.id === event.currentTarget.dataset.id);
    if (!dish) return;
    if (dish.selectedByMe) {
      store.cancelSelection({ sessionId: model.meal.id, dishId: dish.id });
      this.setData({ finalDishIds: this.data.finalDishIds.filter((id) => id !== dish.id) });
    } else {
      store.selectDish({ sessionId: model.meal.id, dishId: dish.id });
      this.setData({
        finalDishIds: this.data.finalDishIds.includes(dish.id)
          ? this.data.finalDishIds
          : [...this.data.finalDishIds, dish.id],
      });
    }
    this.refresh();
  },
  toggleFinalDish(event) {
    const id = event.currentTarget.dataset.id;
    const dish = this.data.model.dishes.find((item) => item.id === id);
    if (!dish || !dish.selected || !this.data.model.canEdit) return;
    const finalDishIds = dish.finalSelected
      ? this.data.finalDishIds.filter((item) => item !== id)
      : [...this.data.finalDishIds, id];
    this.setData({ finalDishIds }, () => this.refresh());
  },
  confirmMeal() {
    const store = getApp().globalData.store;
    const model = this.data.model;
    if (!model.meal || !model.selectedDishCount || !model.finalDishCount) {
      wx.showToast({ title: '至少选一道菜', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认今晚菜单？',
      content: `将把 ${model.finalDishCount} 道菜作为今晚最终菜单，确认后大家不能再修改选择。`,
      confirmText: '确定菜单',
      cancelText: '再看看',
      success: (result) => {
        if (!result.confirm) return;
        store.confirmMeal({ sessionId: model.meal.id, finalDishIds: this.data.finalDishIds });
        wx.showToast({ title: '菜单已确认', icon: 'success' });
        this.refresh();
      },
    });
  },
  goRecordFirst() {
    wx.navigateTo({ url: '/pages/dish-edit/dish-edit' });
  },
  recordDish(event) {
    wx.navigateTo({ url: `/pages/dish-edit/dish-edit?dishId=${event.currentTarget.dataset.id}` });
  },
  onShareAppMessage() {
    const sessionId = this.data.model.meal ? this.data.model.meal.id : this.data.sessionId;
    const familyId = this.data.model.meal
      ? this.data.model.meal.familyId
      : getApp().globalData.store.getState().family.id;
    return {
      title: '今天晚餐吃什么？来选一道家里的菜',
      path: `/pages/meal/meal?sessionId=${sessionId}&date=${this.data.date}&familyId=${familyId}`,
    };
  },
});
