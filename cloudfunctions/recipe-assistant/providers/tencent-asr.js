const DEFAULT_REGION = 'ap-shanghai';
const DEFAULT_ENGINE = '16k_zh';
const TASK_TTL_MS = 24 * 60 * 60 * 1000;

function createTencentAsrProvider(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const engine = String(options.engine || process.env.ASR_ENGINE || DEFAULT_ENGINE);
  const client = options.client || createProductionClient({
    region: String(options.region || process.env.ASR_REGION || DEFAULT_REGION),
    env: options.env || process.env,
    sdk: options.sdk,
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

function createProductionClient({ region, env, sdk }) {
  const loaded = sdk || require('tencentcloud-sdk-nodejs-asr');
  const Client = loaded && loaded.asr && loaded.asr.v20190614 && loaded.asr.v20190614.Client;
  if (typeof Client !== 'function') throw new Error('Tencent ASR SDK is unavailable');
  const credential = runtimeCredential(env);
  if (!credential.secretId || !credential.secretKey) throw new Error('Tencent ASR credentials are unavailable');
  return new Client({
    credential,
    region,
    profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com' } },
  });
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
