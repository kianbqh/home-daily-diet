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

function createHttpResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Request failed',
    async json() { return body; },
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

test('submit rejects an invalid Tencent task id with a stable provider error', async () => {
  const invalidTaskIds = [undefined, null, false, true, [1], 0, -1, 1.5, 'not-a-number', Number.MAX_SAFE_INTEGER + 1];
  for (const taskId of invalidTaskIds) {
    const provider = createTencentAsrProvider({ client: createClient({ create: {
      Data: { TaskId: taskId }, RequestId: 'invalid-task-request',
    } }) });
    await assert.rejects(
      provider.submit({ url: 'https://signed.example/audio.mp3' }),
      (error) => error && error.code === 'ASR_SUBMIT_RESPONSE_INVALID',
      String(taskId)
    );
  }
});

test('query rejects an invalid stored task id before calling Tencent', async () => {
  const invalidTaskIds = [undefined, null, false, true, [1], 0, -1, 1.5, '', 'not-a-number', Number.MAX_SAFE_INTEGER + 1];
  for (const taskId of invalidTaskIds) {
    let calls = 0;
    const provider = createTencentAsrProvider({ client: {
      async DescribeTaskStatus() { calls += 1; throw new Error('must not query'); },
    } });
    await assert.rejects(
      provider.query({ taskId }),
      (error) => error && error.code === 'ASR_TASK_ID_INVALID',
      String(taskId)
    );
    assert.equal(calls, 0, String(taskId));
  }
});

test('production HTTP client signs ASR requests with runtime-role temporary credentials', async () => {
  const requests = [];
  const signedAt = Date.parse('2026-08-14T00:00:00.000Z');
  const provider = createTencentAsrProvider({
    env: {
      TENCENTCLOUD_SECRETID: 'runtime-id',
      TENCENTCLOUD_SECRETKEY: 'runtime-key',
      TENCENTCLOUD_SESSIONTOKEN: 'runtime-token',
      ASR_SECRET_ID: 'fallback-id',
      ASR_SECRET_KEY: 'fallback-key',
    },
    clock: () => signedAt,
    apiClock: () => signedAt,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return createHttpResponse({
        Response: { Data: { TaskId: 1001 }, RequestId: 'create-request' },
      });
    },
  });

  const result = await provider.submit({ url: 'https://signed.example/audio.mp3' });

  assert.deepEqual(result, {
    taskId: 1001,
    requestId: 'create-request',
    submittedAt: signedAt,
    expiresAt: signedAt + 24 * 60 * 60 * 1000,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://asr.tencentcloudapi.com');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    EngineModelType: '16k_zh',
    ChannelNum: 1,
    ResTextFormat: 0,
    SourceType: 0,
    Url: 'https://signed.example/audio.mp3',
    SpeakerDiarization: 0,
    EmotionRecognition: 0,
    FilterModal: 0,
  });
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(requests[0].init.headers.Host, 'asr.tencentcloudapi.com');
  assert.equal(requests[0].init.headers['X-TC-Action'], 'CreateRecTask');
  assert.equal(requests[0].init.headers['X-TC-Version'], '2019-06-14');
  assert.equal(requests[0].init.headers['X-TC-Region'], 'ap-shanghai');
  assert.equal(requests[0].init.headers['X-TC-Timestamp'], '1786665600');
  assert.equal(requests[0].init.headers['X-TC-Token'], 'runtime-token');
  assert.equal(
    requests[0].init.headers.Authorization,
    'TC3-HMAC-SHA256 Credential=runtime-id/2026-08-14/asr/tc3_request, '
      + 'SignedHeaders=content-type;host, '
      + 'Signature=8b7cf3f4b6ba38365021f296f70455f30fe8bfce3be1d421acde89a2deea1af1',
  );
});

test('production HTTP client falls back to dedicated ASR credentials and exposes Tencent error codes', async () => {
  const requests = [];
  const provider = createTencentAsrProvider({
    env: { ASR_SECRET_ID: 'fallback-id', ASR_SECRET_KEY: 'fallback-key' },
    apiClock: () => Date.parse('2026-08-14T00:00:00.000Z'),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return createHttpResponse({ Response: {
        Error: { Code: 'AuthFailure.SignatureFailure', Message: 'provider detail' },
        RequestId: 'failed-request',
      } });
    },
  });

  await assert.rejects(
    provider.query({ taskId: 1001 }),
    (error) => error && error.code === 'AuthFailure.SignatureFailure',
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].init.headers.Authorization, /Credential=fallback-id\/2026-08-14\/asr\/tc3_request/);
  assert.equal('X-TC-Token' in requests[0].init.headers, false);
});
