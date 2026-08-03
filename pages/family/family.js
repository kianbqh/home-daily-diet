const { buildFamilyViewModel } = require('../../utils/view-model');

Page({
  data: {
    ...buildFamilyViewModel(null, null),
    joinCode: '',
  },
  getStore() {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData ? app.globalData.store : null;
  },
  requireStore() {
    const store = this.getStore();
    if (!store) {
      wx.showToast({ title: '应用正在初始化，请稍后再试', icon: 'none' });
    }
    return store;
  },
  onLoad(options = {}) {
    const store = this.getStore();
    if (store && typeof store.subscribe === 'function') {
      this.unsubscribe = store.subscribe(() => this.refresh());
    }
    if (options.inviteCode) {
      this.setData({ joinCode: options.inviteCode });
      setTimeout(() => wx.showModal({
        title: '加入家庭空间？',
        content: '加入后可以和家人一起记录菜品、提交想吃的菜。',
        confirmText: '加入家庭',
        cancelText: '暂不加入',
        success: (result) => {
          if (result.confirm) this.tryJoin(options.inviteCode);
        },
      }), 0);
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
    const model = store
      ? buildFamilyViewModel(store.getState(), store.getFamilySummary())
      : buildFamilyViewModel(null, null);
    this.setData(model);
  },
  onNameInput(event) {
    this.setData({ name: event.detail.value });
  },
  saveName() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '家庭名称不能为空', icon: 'none' });
      return;
    }
    const store = this.requireStore();
    if (!store) return;
    store.updateFamily({ name });
    wx.showToast({ title: '已保存', icon: 'success' });
    this.refresh();
  },
  onMemberNameInput(event) {
    this.setData({ memberName: event.detail.value });
  },
  saveMemberName() {
    const displayName = this.data.memberName.trim();
    if (!displayName) {
      wx.showToast({ title: '请写下你的称呼', icon: 'none' });
      return;
    }
    const store = this.requireStore();
    if (!store) return;
    store.updateMember({ displayName });
    wx.showToast({ title: '称呼已保存', icon: 'success' });
    this.refresh();
  },
  tryJoin(inviteCode) {
    const store = this.requireStore();
    if (!store) return;
    const state = store.getState();
    const current = state.members.find((member) => member.id === state.currentMemberId);
    store.joinFamily(inviteCode, {
      id: state.currentMemberId,
      displayName: current ? current.displayName : '新成员',
    }).then(() => {
      wx.showToast({ title: '已加入家庭', icon: 'success' });
      this.refresh();
    }).catch(() => {
      wx.showModal({
        title: '暂时无法加入',
        content: '家庭云端目前不可用，请稍后重试。你的本地数据不会丢失。',
        showCancel: false,
      });
    });
  },
  copyInvite() {
    if (!this.data.family.inviteCode) {
      wx.showToast({ title: '邀请信息尚未准备好', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.family.inviteCode,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }),
    });
  },
  onShareAppMessage() {
    const family = this.data.family || buildFamilyViewModel(null, null).family;
    return {
      title: `加入${family.name}，一起记录家里的菜`,
      path: `/pages/family/family?inviteCode=${family.inviteCode || ''}`,
    };
  },
});
