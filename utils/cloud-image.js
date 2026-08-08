function isCloudFileId(value) {
  return typeof value === 'string' && value.indexOf('cloud://') === 0;
}

function uniqueCloudFileIds(fileIds = []) {
  return [...new Set(
    (Array.isArray(fileIds) ? fileIds : [fileIds]).filter(isCloudFileId)
  )];
}

function resolveCloudFileUrls(fileIds = [], cloudApi) {
  const ids = uniqueCloudFileIds(fileIds);
  const urls = new Map();
  if (!ids.length || !cloudApi || typeof cloudApi.getTempFileURL !== 'function') {
    return Promise.resolve(urls);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const success = finish((result = {}) => {
      (result.fileList || []).forEach((file) => {
        const fileId = file && (file.fileID || file.fileId);
        const tempFileURL = file && (file.tempFileURL || file.tempFileUrl);
        if (fileId && tempFileURL) urls.set(fileId, tempFileURL);
      });
      resolve(urls);
    });
    const fail = finish(reject);

    try {
      const request = cloudApi.getTempFileURL({ fileList: ids, success, fail });
      if (request && typeof request.then === 'function') {
        request.then(success).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = { isCloudFileId, resolveCloudFileUrls };
