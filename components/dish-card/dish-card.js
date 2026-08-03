const { formatDate, initials } = require('../../utils/format');

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
      this.setData({
        displayDish: {
          ...dish,
          placeholder: initials(dish && dish.name),
          latestRecordLabel: formatDate(dish && dish.latestRecordAt),
        },
      });
      if (
        dish && dish.coverImage && dish.coverImage.indexOf('cloud://') === 0
        && typeof wx !== 'undefined'
        && wx.cloud && typeof wx.cloud.getTempFileURL === 'function'
      ) {
        wx.cloud.getTempFileURL({
          fileList: [dish.coverImage],
          success: (result) => {
            const file = result.fileList && result.fileList[0];
            if (file && file.tempFileURL) {
              this.setData({ 'displayDish.coverImage': file.tempFileURL });
            }
          },
        });
      }
    },
    onTap() {
      this.triggerEvent('dishTap', { dish: this.data.dish });
    },
  },
});
