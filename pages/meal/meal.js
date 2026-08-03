const { buildMealViewModel } = require('../../utils/view-model');
const { todayString } = require('../../utils/format');

function joinErrorMessage(error) {
  switch (error && error.code) {
    case 'INVITE_INVALID': return '邀请码无效，请核对后再试。';
    case 'INVITE_REVOKED': return '邀请码已撤销，请让家人重新生成。';
    case 'INVITE_EXPIRED': return '邀请码已过期，请让家人重新生成。';
    default: return '请先加入家庭云端空间，再打开这条选餐链接。';
  }
}

Page({
  data: {
    date: '',
    sessionId: '',
    finalDishIds: [],
    finalInitialized: false,
    joining: false,
    model: {},
  },
  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },
  onLoad(options = {}) {
    const store = this.getStore();
    if (store && typeof store.subscribe === 'function') {
      this.unsubscribe = store.subscribe(() => {
        if (!this.data.joining) this.refresh();
      });
    }
    const sharedMeal = options.sessionId
      && store.getState().mealSessions.find((session) => session.id === options.sessionId);
    const joiningSharedFamily = Boolean(
      options.inviteCode
      && options.sessionId
      && !sharedMeal
    );
    this.setData({
      date: sharedMeal ? sharedMeal.date : (options.date || todayString()),
      sessionId: options.sessionId || '',
      joining: joiningSharedFamily,
    });
    if (joiningSharedFamily) {
      setTimeout(() => this.confirmJoinFromMeal(options.inviteCode, options.sessionId, options.date), 0);
    }
  },
  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  },
  onShow() {
    if (this.data.joining) return;
    const store = this.getStore();
    if (store.getFamilySummary().cloudEnabled) {
      store.hydrateFromCloud().then(() => this.refresh()).catch(() => this.refresh());
      return;
    }
    this.refresh();
  },
  confirmJoinFromMeal(inviteCode, sessionId, fallbackDate) {
    wx.showModal({
      title: '加入家庭后查看晚餐？',
      content: '这条分享来自一个家庭空间，加入后才能看到完整的菜品和候选。',
      confirmText: '加入并查看',
      cancelText: '暂不加入',
      success: (result) => {
        if (!result.confirm) {
          this.setData({ joining: false });
          wx.reLaunch({ url: '/pages/index/index' });
          return;
        }
        const store = this.getStore();
        const state = store.getState();
        const current = state.members.find((member) => member.id === state.currentMemberId);
        store.joinFamilyByInvite(inviteCode, {
          id: state.currentMemberId,
          displayName: current ? current.displayName : '家庭成员',
        }).then(() => {
          const meal = store.getState().mealSessions.find((item) => item.id === sessionId);
          this.setData({
            date: meal ? meal.date : (fallbackDate || todayString()),
            joining: false,
            finalDishIds: [],
            finalInitialized: false,
          }, () => this.refresh());
        }).catch((error) => {
          this.setData({ joining: false });
          wx.showModal({
            title: '暂时无法打开晚餐',
            content: joinErrorMessage(error),
            showCancel: false,
            success: () => wx.reLaunch({ url: '/pages/index/index' }),
          });
        });
      },
    });
  },
  refresh() {
    const store = this.getStore();
    if (!store) return;
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
    const store = this.getStore();
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
    const store = this.getStore();
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
    const store = this.getStore();
    const sessionId = this.data.model.meal ? this.data.model.meal.id : this.data.sessionId;
    const inviteCode = store.getFamilySummary().inviteCode || '';
    return {
      title: '今天晚餐吃什么？来选一道家里的菜',
      path: inviteCode
        ? `/pages/meal/meal?sessionId=${sessionId}&date=${this.data.date}&inviteCode=${encodeURIComponent(inviteCode)}`
        : '/pages/family/family',
    };
  },
});
