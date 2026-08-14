const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTencentAsrProvider,
} = require('../cloudfunctions/recipe-assistant/providers/tencent-asr');

function createClient(responses = {}) {
  return {
    createCalls: [],
    describeCalls: [],
    async CreateRecTask(input) {
      this.createCalls.push(input);
      return responses.create || { Data: { TaskId: 1001 }, RequestId: 'create-request' };
    },
    async DescribeTaskStatus(input) {
      this.describeCalls.push(input);
      return responses.describe || { Data: { Status: 0 }, RequestId: 'query-request' };
    },
  };
}

test('submit maps the recording-file ASR request and response exactly', async () => {
  const client = createClient();
  const now = Date.parse('2026-08-14T00:00:00.000Z');
  const provider = createTencentAsrProvider({ client, clock: () => now });

  const result = await provider.submit({ url: 'https://signed.example/audio.mp3' });

  assert.deepEqual(client.createCalls, [{
    EngineModelType: '16k_zh',
    ChannelNum: 1,
    ResTextFormat: 0,
    SourceType: 0,
    Url: 'https://signed.example/audio.mp3',
    SpeakerDiarization: 0,
    EmotionRecognition: 0,
    FilterModal: 0,
  }]);
  assert.deepEqual(result, {
    taskId: 1001,
    requestId: 'create-request',
    submittedAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
  });
});

test('query maps pending statuses and Tencent response request IDs', async () => {
  for (const status of [0, 1]) {
    const client = createClient({ describe: {
      Data: { TaskId: 1001, Status: status, AudioDuration: 12.5 },
      RequestId: `request-${status}`,
    } });
    const provider = createTencentAsrProvider({ client });

    const result = await provider.query({ taskId: 1001 });

    assert.deepEqual(client.describeCalls, [{ TaskId: 1001 }]);
    assert.deepEqual(result, {
      status: 'transcribing', transcript: '', durationMs: 12500,
      requestId: `request-${status}`, errorCode: '',
    });
  }
});

test('query maps ready results and removes only leading sentence timestamps', async () => {
  const client = createClient({ describe: {
    Data: {
      Status: 2,
      Result: '[0:0.000,0:1.200] 先把锅烧热\n[0:1.200,0:2.500] [保留这段括号]少放盐',
      AudioDuration: 2.5,
    },
    RequestId: 'ready-request',
  } });
  const provider = createTencentAsrProvider({ client });

  const result = await provider.query({ taskId: '1001' });

  assert.deepEqual(result, {
    status: 'ready',
    transcript: '先把锅烧热\n[保留这段括号]少放盐',
    durationMs: 2500,
    requestId: 'ready-request',
    errorCode: '',
  });
});

test('query maps failed and expired tasks without exposing provider messages', async () => {
  const failed = createTencentAsrProvider({ client: createClient({ describe: {
    Data: { Status: 3, ErrorMsg: 'secret provider detail' }, RequestId: 'failed-request',
  } }) });
  assert.deepEqual(await failed.query({ taskId: 1001 }), {
    status: 'failed', transcript: '', durationMs: 0,
    requestId: 'failed-request', errorCode: 'ASR_TASK_FAILED',
  });

  let calls = 0;
  const expired = createTencentAsrProvider({
    client: { async DescribeTaskStatus() { calls += 1; throw new Error('must not query'); } },
    clock: () => Date.parse('2026-08-15T00:00:00.001Z'),
  });
  assert.deepEqual(await expired.query({
    taskId: 1001,
    submittedAt: Date.parse('2026-08-14T00:00:00.000Z'),
  }), {
    status: 'failed', transcript: '', durationMs: 0,
    requestId: '', errorCode: 'ASR_TASK_EXPIRED',
  });
  assert.equal(calls, 0);
});

test('production client prefers runtime-role temporary credentials and fixed regional defaults', async () => {
  const constructed = [];
  class Client {
    constructor(config) { constructed.push(config); }
  }
  createTencentAsrProvider({
    sdk: { asr: { v20190614: { Client } } },
    env: {
      TENCENTCLOUD_SECRETID: 'runtime-id',
      TENCENTCLOUD_SECRETKEY: 'runtime-key',
      TENCENTCLOUD_SESSIONTOKEN: 'runtime-token',
      ASR_SECRET_ID: 'fallback-id',
      ASR_SECRET_KEY: 'fallback-key',
    },
  });

  assert.deepEqual(constructed, [{
    credential: { secretId: 'runtime-id', secretKey: 'runtime-key', token: 'runtime-token' },
    region: 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com' } },
  }]);
});

test('production client falls back to dedicated ASR credentials', async () => {
  const constructed = [];
  class Client { constructor(config) { constructed.push(config); } }
  createTencentAsrProvider({
    sdk: { asr: { v20190614: { Client } } },
    env: { ASR_SECRET_ID: 'fallback-id', ASR_SECRET_KEY: 'fallback-key' },
  });

  assert.equal(constructed[0].credential.secretId, 'fallback-id');
  assert.equal(constructed[0].credential.secretKey, 'fallback-key');
  assert.equal('token' in constructed[0].credential, false);
});
