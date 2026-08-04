const { buildFamilyViewModel } = require('../../utils/view-model');

function inviteErrorMessage(error) {
  switch (error && error.code) {
    case 'INVITE_INVALID': return '邀请码无效，请核对后再试。';
    case 'INVITE_REVOKED': return '这个邀请码已经撤销，请让家人重新生成。';
    case 'INVITE_EXPIRED': return '这个邀请码已过期，请让家人重新生成。';
    case 'NOT_MEMBER': return '你还不是这个家庭的成员。';
    default: return '家庭云端暂时不可用，你的本地数据不会丢失。';
  }
}

Page({
  data: {
    ...buildFamilyViewModel(null, null),
    nameDraft: '',
    memberNameDraft: '',
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
        title: '加入家庭空间',
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
    this.loadInvite();
  },
  loadInvite() {
    const store = this.getStore();
    if (!store || typeof store.getInvite !== 'function') return;
    const summary = store.getFamilySummary();
    if (!summary || summary.syncStatus !== 'ready') return;
    store.getInvite().then(() => this.refresh()).catch(() => {});
  },
  refresh() {
    const store = this.getStore();
    const model = store
      ? buildFamilyViewModel(store.getState(), store.getFamilySummary())
      : buildFamilyViewModel(null, null);
    const preserveNameInput = Boolean(this.nameEditing || this.nameDraftDirty);
    const preserveMemberNameInput = Boolean(this.memberNameEditing || this.memberNameDraftDirty);
    if (preserveNameInput) {
      model.name = this.nameDraft;
    } else {
      this.nameDraft = model.name;
      model.nameDraft = model.name;
    }
    if (preserveMemberNameInput) {
      model.memberName = this.memberNameDraft;
    } else {
      this.memberNameDraft = model.memberName;
      model.memberNameDraft = model.memberName;
    }
    // Do not send a new value prop to a focused/edited native input. On iOS,
    // rebinding value during composition can clear the visible text while the
    // native control still retains the latest event.detail.value.
    if (preserveNameInput) delete model.nameDraft;
    if (preserveMemberNameInput) delete model.memberNameDraft;
    this.setData(model);
  },
  onNameFocus() {
    this.nameEditing = true;
    if (!this.nameDraftDirty) {
      this.nameDraft = String(this.data.nameDraft || this.data.name || '');
    }
  },
  onNameBlur() {
    this.nameEditing = false;
  },
  onNameInput(event) {
    this.nameDraft = String(event.detail.value || '');
    this.nameDraftDirty = true;
    this.setData({ nameDraft: this.nameDraft });
  },
  saveName() {
    const name = String(
      this.nameDraftDirty ? this.nameDraft : (this.data.nameDraft || this.data.name || '')
    ).trim();
    if (!name) {
      wx.showToast({ title: '家庭名称不能为空', icon: 'none' });
      return;
    }
    const store = this.requireStore();
    if (!store) return;
    this.nameDraft = name;
    this.nameDraftDirty = false;
    this.nameEditing = false;
    store.updateFamily({ name });
    wx.showToast({ title: '已保存', icon: 'success' });
    this.refresh();
  },
  onMemberNameFocus() {
    this.memberNameEditing = true;
    if (!this.memberNameDraftDirty) {
      this.memberNameDraft = String(this.data.memberNameDraft || this.data.memberName || '');
    }
  },
  onMemberNameBlur() {
    this.memberNameEditing = false;
  },
  onMemberNameInput(event) {
    this.memberNameDraft = String(event.detail.value || '');
    this.memberNameDraftDirty = true;
    this.setData({ memberNameDraft: this.memberNameDraft });
  },
  saveMemberName() {
    const displayName = String(
      this.memberNameDraftDirty
        ? this.memberNameDraft
        : (this.data.memberNameDraft || this.data.memberName || '')
    ).trim();
    if (!displayName) {
      wx.showToast({ title: '请写下你的称呼', icon: 'none' });
      return;
    }
    const store = this.requireStore();
    if (!store) return;
    this.memberNameDraft = displayName;
    this.memberNameDraftDirty = false;
    this.memberNameEditing = false;
    store.updateMember({ displayName });
    wx.showToast({ title: '称呼已保存', icon: 'success' });
    this.refresh();
  },
  tryJoin(inviteCode) {
    const store = this.requireStore();
    if (!store) return Promise.resolve();
    const state = store.getState();
    const current = state.members.find((member) => member.id === state.currentMemberId);
    return store.joinFamilyByInvite(inviteCode, {
      id: state.currentMemberId,
      displayName: current ? current.displayName : '家庭成员',
    }).then(() => {
      wx.showToast({ title: '已加入家庭', icon: 'success' });
      this.refresh();
    }).catch((error) => {
      wx.showModal({
        title: '暂时无法加入',
        content: inviteErrorMessage(error),
        showCancel: false,
      });
    });
  },
  createInvite() {
    const store = this.requireStore();
    if (!store || typeof store.createInvite !== 'function') return;
    store.createInvite()
      .then(() => {
        this.refresh();
        wx.showToast({ title: '邀请码已生成', icon: 'success' });
      })
      .catch((error) => wx.showToast({ title: inviteErrorMessage(error), icon: 'none' }));
  },
  revokeInvite() {
    const store = this.requireStore();
    if (!store || typeof store.revokeInvite !== 'function') return;
    store.revokeInvite()
      .then(() => {
        this.refresh();
        wx.showToast({ title: '邀请码已撤销', icon: 'success' });
      })
      .catch((error) => wx.showToast({ title: inviteErrorMessage(error), icon: 'none' }));
  },
  copyInvite() {
    const code = this.data.family && this.data.family.inviteCode;
    if (!code) {
      wx.showToast({ title: '请先生成邀请码', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }),
    });
  },
  onShareAppMessage() {
    const family = this.data.family || buildFamilyViewModel(null, null).family;
    const code = family.inviteCode || '';
    return {
      title: `加入${family.name}，一起记录家里的菜`,
      path: code
        ? `/pages/family/family?inviteCode=${encodeURIComponent(code)}`
        : '/pages/family/family',
    };
  },
});
