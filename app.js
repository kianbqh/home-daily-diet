const { createApplicationStore } = require('./services/app-bootstrap');
const cloudbaseConfig = require('./cloudbase.config.json');

App({
  globalData: {
    store: null,
    cloudInitError: null,
  },
  onLaunch() {
    const result = createApplicationStore({
      api: typeof wx === 'undefined' ? null : wx,
      config: cloudbaseConfig,
    });
    this.globalData.store = result.store;
    this.globalData.cloudInitError = result.cloudInitError;
    result.store.hydrateFromCloud();
  },
});
