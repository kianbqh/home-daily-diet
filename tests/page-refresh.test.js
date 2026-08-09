const test = require('node:test');
const assert = require('node:assert/strict');

const { syncPageFromCloud } = require('../utils/page-refresh');

test('manual page refresh forces cloud sync and always stops the native animation', async () => {
  const calls = [];
  const originalWx = global.wx;
  global.wx = {
    stopPullDownRefresh() { calls.push('stop'); },
    showToast() { calls.push('toast'); },
  };
  const page = {
    getStore() {
      return {
        async syncFromCloud(options) { calls.push(options.force ? 'force' : 'auto'); },
        getSyncStatus() { return { status: 'ready' }; },
      };
    },
    refresh() { calls.push('render'); },
  };

  try {
    await syncPageFromCloud(page, { force: true, manual: true });
    assert.deepEqual(calls, ['force', 'render', 'stop']);
  } finally {
    global.wx = originalWx;
  }
});

test('manual page refresh reports cloud failure, renders, and stops the native animation', async () => {
  const calls = [];
  const originalWx = global.wx;
  global.wx = {
    stopPullDownRefresh() { calls.push('stop'); },
    showToast(options) {
      calls.push('toast');
      assert.deepEqual(options, { title: '云端同步失败，请稍后重试', icon: 'none' });
    },
  };
  const page = {
    getStore() {
      return {
        async syncFromCloud(options) { calls.push(options.force ? 'force' : 'auto'); },
        getSyncStatus() { return { status: 'error' }; },
      };
    },
    refresh() { calls.push('render'); },
  };

  try {
    await syncPageFromCloud(page, { force: true, manual: true });
    assert.deepEqual(calls, ['force', 'toast', 'render', 'stop']);
  } finally {
    global.wx = originalWx;
  }
});

test('automatic page refresh remains silent when cloud sync fails', async () => {
  const calls = [];
  const originalWx = global.wx;
  global.wx = {
    stopPullDownRefresh() { calls.push('stop'); },
    showToast() { calls.push('toast'); },
  };
  const page = {
    getStore() {
      return {
        async syncFromCloud(options) {
          calls.push(options.force ? 'force' : 'auto');
          throw new Error('network unavailable');
        },
      };
    },
    refresh() { calls.push('render'); },
  };

  try {
    await syncPageFromCloud(page);
    assert.deepEqual(calls, ['auto', 'render']);
  } finally {
    global.wx = originalWx;
  }
});
