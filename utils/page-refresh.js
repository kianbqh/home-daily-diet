async function syncPageFromCloud(page, options = {}) {
  const force = Boolean(options.force);
  const manual = Boolean(options.manual);
  const store = page && typeof page.getStore === 'function' ? page.getStore() : null;

  try {
    if (store && typeof store.syncFromCloud === 'function') {
      await store.syncFromCloud({ force });
      if (manual && store.getSyncStatus && store.getSyncStatus().status === 'error') {
        throw new Error('cloud sync failed');
      }
    }
  } catch (error) {
    if (manual && typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title: '云端同步失败，请稍后重试', icon: 'none' });
    }
  } finally {
    if (page && typeof page.refresh === 'function') page.refresh();
    if (manual && typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  }
}

module.exports = { syncPageFromCloud };
