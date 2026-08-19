const crypto = require('node:crypto');

const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_ENGINE = '16k_zh';
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const ASR_HOST = 'asr.tencentcloudapi.com';
const ASR_SERVICE = 'asr';
const ASR_VERSION = '2019-06-14';

function createTencentAsrProvider(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const engine = String(options.engine || process.env.ASR_ENGINE || DEFAULT_ENGINE);
  const client = options.client || createProductionClient({
    region: String(options.region || process.env.ASR_REGION || DEFAULT_REGION),
    env: options.env || process.env,
    fetchImpl: options.fetch,
    clock: options.apiClock,
  });

  return {
    async submit({ url } = {}) {
      const submittedAt = Number(clock());
      const response = await client.CreateRecTask({
        EngineModelType: engine,
        ChannelNum: 1,
        ResTextFormat: 0,
        SourceType: 0,
        Url: String(url || ''),
        SpeakerDiarization: 0,
        EmotionRecognition: 0,
        FilterModal: 0,
      });
      const taskId = requireTaskId(response && response.Data && response.Data.TaskId, 'ASR_SUBMIT_RESPONSE_INVALID');
      return {
        taskId,
        requestId: String(response && response.RequestId || ''),
        submittedAt,
        expiresAt: submittedAt + TASK_TTL_MS,
      };
    },

    async query({ taskId, submittedAt } = {}) {
      const normalizedTaskId = requireTaskId(taskId, 'ASR_TASK_ID_INVALID');
      if (submittedAt != null && Number(clock()) > Number(submittedAt) + TASK_TTL_MS) {
        return queryResult('failed', '', 0, '', 'ASR_TASK_EXPIRED');
      }
      const response = await client.DescribeTaskStatus({ TaskId: normalizedTaskId });
      const data = response && response.Data || {};
      const durationMs = Math.max(0, Math.round((Number(data.AudioDuration) || 0) * 1000));
      const requestId = String(response && response.RequestId || '');
      if (data.Status === 0 || data.Status === 1) {
        return queryResult('transcribing', '', durationMs, requestId, '');
      }
      if (data.Status === 2) {
        return queryResult('ready', stripTimestampPrefixes(data.Result), durationMs, requestId, '');
      }
      return queryResult('failed', '', durationMs, requestId, 'ASR_TASK_FAILED');
    },
  };
}

function createProductionClient({ region, env, fetchImpl, clock }) {
  const credential = runtimeCredential(env);
  if (!credential.secretId || !credential.secretKey) throw new Error('Tencent ASR credentials are unavailable');
  const request = createTencentApiRequester({ credential, region, fetchImpl, clock });
  return {
    CreateRecTask(input) { return request('CreateRecTask', input); },
    DescribeTaskStatus(input) { return request('DescribeTaskStatus', input); },
  };
}

function createTencentApiRequester({ credential, region, fetchImpl, clock }) {
  const requestFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof requestFetch !== 'function') throw new Error('Tencent ASR HTTP client is unavailable');
  const requestClock = typeof clock === 'function' ? clock : Date.now;

  return async function request(action, input) {
    const body = JSON.stringify(input || {});
    const headers = signRequest({
      action,
      body,
      credential,
      region,
      timestamp: Math.floor(Number(requestClock()) / 1000),
    });
    const response = await requestFetch(`https://${ASR_HOST}`, {
      method: 'POST',
      headers,
      body,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw providerError('ASR_RESPONSE_INVALID', 'Tencent ASR response is not valid JSON');
    }
    const providerResponse = payload && payload.Response;
    if (!response.ok) {
      throw providerError(`ASR_HTTP_${response.status}`, `Tencent ASR HTTP ${response.status}`);
    }
    if (providerResponse && providerResponse.Error) {
      throw providerError(
        String(providerResponse.Error.Code || 'ASR_REQUEST_FAILED'),
        String(providerResponse.Error.Message || 'Tencent ASR request failed'),
      );
    }
    if (!providerResponse || typeof providerResponse !== 'object') {
      throw providerError('ASR_RESPONSE_INVALID', 'Tencent ASR response is invalid');
    }
    return providerResponse;
  };
}

function signRequest({ action, body, credential, region, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host';
  const canonicalHeaders = `content-type:${contentType}\nhost:${ASR_HOST}\n`;
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join('\n');
  const credentialScope = `${date}/${ASR_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const secretDate = hmac(`TC3${credential.secretKey}`, date);
  const secretService = hmac(secretDate, ASR_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  const headers = {
    Authorization: `TC3-HMAC-SHA256 Credential=${credential.secretId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: ASR_HOST,
    'X-TC-Action': action,
    'X-TC-Version': ASR_VERSION,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': region,
  };
  if (credential.token) headers['X-TC-Token'] = credential.token;
  return headers;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function providerError(code, message) {
  const error = new Error(message);
  error.name = 'TencentAsrProviderError';
  error.code = code;
  return error;
}

function runtimeCredential(env = {}) {
  const runtimeSecretId = env.TENCENTCLOUD_SECRETID || env.TENCENTCLOUD_SECRET_ID;
  const runtimeSecretKey = env.TENCENTCLOUD_SECRETKEY || env.TENCENTCLOUD_SECRET_KEY;
  const runtimeToken = env.TENCENTCLOUD_SESSIONTOKEN || env.TENCENTCLOUD_TOKEN;
  if (runtimeSecretId && runtimeSecretKey) {
    return compactCredential(runtimeSecretId, runtimeSecretKey, runtimeToken);
  }
  return compactCredential(env.ASR_SECRET_ID, env.ASR_SECRET_KEY, env.ASR_SESSION_TOKEN);
}

function compactCredential(secretId, secretKey, token) {
  const credential = { secretId: String(secretId || ''), secretKey: String(secretKey || '') };
  if (token) credential.token = String(token);
  return credential;
}

function requireTaskId(taskId, code) {
  const validType = typeof taskId === 'number'
    || (typeof taskId === 'string' && /^\d+$/.test(taskId));
  const numeric = Number(taskId);
  if (!validType || !Number.isSafeInteger(numeric) || numeric <= 0) {
    const error = new Error('Tencent ASR task id is invalid');
    error.name = 'TencentAsrProviderError';
    error.code = code;
    throw error;
  }
  return numeric;
}

function stripTimestampPrefixes(value) {
  return String(value || '')
    .replace(/^\[\d+:\d+(?:\.\d+)?,\d+:\d+(?:\.\d+)?\]\s*/gm, '')
    .trim();
}

function queryResult(status, transcript, durationMs, requestId, errorCode) {
  return { status, transcript, durationMs, requestId, errorCode };
}

module.exports = {
  DEFAULT_ENGINE,
  DEFAULT_REGION,
  TASK_TTL_MS,
  createTencentAsrProvider,
};
