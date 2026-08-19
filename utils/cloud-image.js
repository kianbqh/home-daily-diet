function isCloudFileId(value) {
  return typeof value === 'string' && value.indexOf('cloud://') === 0;
}

function uniqueCloudFileIds(fileIds = []) {
  return [...new Set(
    (Array.isArray(fileIds) ? fileIds : [fileIds]).filter(isCloudFileId)
  )];
}

function resolveCloudFileUrls(fileIds = [], resolver) {
  const ids = uniqueCloudFileIds(fileIds);
  if (resolver && typeof resolver.resolveImageUrls === 'function') {
    return resolver.resolveImageUrls(ids);
  }
  return Promise.resolve(new Map());
}

module.exports = { isCloudFileId, resolveCloudFileUrls };
