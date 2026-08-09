const { formatDate, initials } = require('../../utils/format');
const { isCloudFileId, resolveCloudFileUrls } = require('../../utils/cloud-image');

Component({
  properties: {
    dish: {
      type: Object,
      value: {},
      observer(dish) {
        this.updateDisplayDish(dish);
      },
    },
    selected: {
      type: Boolean,
      value: false,
    },
  },
  data: {
    displayDish: {},
  },
  attached() {
    const dish = this.data.dish || {};
    this.updateDisplayDish(dish);
  },
  methods: {
    getStore() {
      const app = typeof getApp === 'function' ? getApp() : null;
      return app && app.globalData ? app.globalData.store : null;
    },
    updateDisplayDish(dish) {
      const sourceImage = dish && dish.coverImage ? String(dish.coverImage) : '';
      const requestId = (this.imageRequestId || 0) + 1;
      this.imageRequestId = requestId;
      this.setData({
        displayDish: {
          ...dish,
          placeholder: initials(dish && dish.name),
          latestRecordLabel: formatDate(dish && dish.latestRecordAt),
          coverImage: isCloudFileId(sourceImage) ? '' : sourceImage,
          hasImage: Boolean(sourceImage && !isCloudFileId(sourceImage)),
        },
      });
      const store = this.getStore();
      if (!isCloudFileId(sourceImage) || !store) return;
      resolveCloudFileUrls([sourceImage], store)
        .then((urls) => {
          if (requestId !== this.imageRequestId) return;
          const image = urls.get(sourceImage) || '';
          this.setData({
            'displayDish.coverImage': image,
            'displayDish.hasImage': Boolean(image),
          });
        })
        .catch(() => {
          if (requestId === this.imageRequestId) {
            this.setData({ 'displayDish.coverImage': '', 'displayDish.hasImage': false });
          }
        });
    },
    onTap() {
      this.triggerEvent('dishTap', { dish: this.data.dish });
    },
  },
});
