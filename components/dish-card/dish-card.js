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
      if (!isCloudFileId(sourceImage) || typeof wx === 'undefined' || !wx.cloud) return;
      resolveCloudFileUrls([sourceImage], wx.cloud)
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
