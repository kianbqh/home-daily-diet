const { createApplicationStore } = require('./services/app-bootstrap');
const cloudbaseConfig = require('./cloudbase.config.js');

App({
  globalData: {
    store: null,
    recipeAssistant: null,
    cloudInitError: null,
  },
  onLaunch() {
    const result = createApplicationStore({
      api: typeof wx === 'undefined' ? null : wx,
      config: cloudbaseConfig,
    });
    this.globalData.store = result.store;
    this.globalData.recipeAssistant = result.recipeAssistant;
    this.globalData.cloudInitError = result.cloudInitError;
    result.store.hydrateFromCloud();
  },
});
