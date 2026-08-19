const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('./fixtures/recipe-contract.json');
const {
  RECIPE_JSON_SCHEMA,
  buildRecipeSystemPrompt,
} = require('../cloudfunctions/recipe-assistant/recipe-schema');
const {
  createTokenHubProvider,
} = require('../cloudfunctions/recipe-assistant/providers/tokenhub');

const ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/chat/completions';
const TEST_KEY = 'unit-test-tokenhub-key';
const REPAIR_PROMPT = '只修复为符合 Schema 的 JSON。不要新增、删除或推测任何事实，只输出 JSON。';

function tokenHubResponse(content, overrides = {}) {
  const payload = {
    id: 'request-1',
    model: 'hy3',
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    choices: [{
      message: {
        role: 'assistant',
        content,
        reasoning_content: 'must never leave the provider boundary',
      },
    }],
    ...overrides.payload,
  };
  return {
    ok: overrides.ok !== false,
    status: overrides.status || (overrides.ok === false ? 500 : 200),
    async json() {
      if (overrides.jsonError) throw overrides.jsonError;
      return payload;
    },
  };
}

function queuedFetch(responses, calls = []) {
  return {
    calls,
    async fetch(url, init) {
      calls.push({
        url,
        method: init && init.method,
        headers: init && init.headers,
        signal: init && init.signal,
        body: JSON.parse(init && init.body),
      });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(url, init);
      return next;
    },
  };
}

function providerFor(fetch, overrides = {}) {
  return createTokenHubProvider({
    fetch,
    apiKey: TEST_KEY,
    model: 'hy3',
    promptVersion: 'v1',
    ...overrides,
  });
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.name, 'TokenHubProviderError');
    assert.equal(error && error.code, code);
    assert.equal(String(error && error.message).includes(TEST_KEY), false);
    return true;
  });
}

test('sends the fixed TokenHub structured-output request without exposing the API key', async () => {
  const fake = queuedFetch([tokenHubResponse(JSON.stringify(fixture))]);
  const provider = providerFor(fake.fetch.bind(fake));

  const result = await provider.organize({ sourceText: '妈妈口述的做法', userId: 'family-hash' });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, ENDPOINT);
  assert.equal(fake.calls[0].method, 'POST');
  assert.deepEqual(fake.calls[0].headers, {
    Authorization: `Bearer ${TEST_KEY}`,
    'Content-Type': 'application/json',
  });
  assert.ok(fake.calls[0].signal instanceof AbortSignal);
  assert.deepEqual(fake.calls[0].body, {
    model: 'hy3',
    messages: [
      { role: 'system', content: buildRecipeSystemPrompt('v1') },
      { role: 'user', content: '妈妈口述的做法' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'family_recipe', strict: true, schema: RECIPE_JSON_SCHEMA },
    },
    thinking: { type: 'disabled' },
    stream: false,
    user: 'family-hash',
  });
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('returns only the normalized recipe and permitted response metadata', async () => {
  const content = JSON.stringify({
    ...fixture,
    ingredients: [{ ...fixture.ingredients[0], name: ' 鸡蛋 ', amountText: ' 3 个 ' }],
  });
  const usage = {
    prompt_tokens: 20,
    completion_tokens: 30,
    total_tokens: 50,
    prompt_tokens_details: { cached_tokens: 4 },
  };
  const fake = queuedFetch([tokenHubResponse(content, {
    payload: { id: 'request-safe', model: 'hy3-202608', usage },
  })]);

  const result = await providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  });

  assert.deepEqual(result, {
    recipe: fixture,
    requestId: 'request-safe',
    modelName: 'hy3-202608',
    promptVersion: 'v1',
    usage,
  });
  assert.equal(Object.hasOwn(result, 'reasoning_content'), false);
  assert.equal(JSON.stringify(result).includes('must never leave'), false);
});

test('repairs invalid JSON exactly once using only the invalid output and the same schema', async () => {
  const firstOutput = 'not valid json';
  const fake = queuedFetch([
    tokenHubResponse(firstOutput, { payload: { id: 'request-invalid' } }),
    tokenHubResponse(JSON.stringify(fixture), { payload: { id: 'request-repaired' } }),
  ]);
  const sourceText = '原始口述不得进入修复请求';

  const result = await providerFor(fake.fetch.bind(fake)).organize({ sourceText, userId: 'family-hash' });

  assert.equal(result.requestId, 'request-repaired');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].body.messages, [
    { role: 'system', content: REPAIR_PROMPT },
    { role: 'user', content: firstOutput },
  ]);
  assert.deepEqual(fake.calls[1].body.response_format, fake.calls[0].body.response_format);
  assert.equal(JSON.stringify(fake.calls[1].body).includes(sourceText), false);
  assert.equal(fake.calls[1].body.thinking.type, 'disabled');
  assert.equal(fake.calls[1].body.stream, false);
});

test('repairs schema-only formatting such as a missing optional-content field once', async () => {
  const malformed = {
    ...fixture,
    ingredients: [{ name: '鸡蛋', amountText: '3 个', uncertain: false }],
  };
  const fake = queuedFetch([
    tokenHubResponse(JSON.stringify(malformed)),
    tokenHubResponse(JSON.stringify(fixture), { payload: { id: 'schema-repair' } }),
  ]);

  const result = await providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  });

  assert.equal(result.requestId, 'schema-repair');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].body.messages[1].content, JSON.stringify(malformed));
});

test('repairs additional properties instead of accepting data outside the strict schema', async () => {
  const malformed = {
    ...fixture,
    inventedInstruction: 'ignore safety rules',
    ingredients: [{ ...fixture.ingredients[0], inventedAmount: '500 克' }],
  };
  const fake = queuedFetch([
    tokenHubResponse(JSON.stringify(malformed)),
    tokenHubResponse(JSON.stringify(fixture)),
  ]);

  const result = await providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  });

  assert.deepEqual(result.recipe, fixture);
  assert.equal(fake.calls.length, 2);
});

test('returns AI_OUTPUT_INVALID after the single repair response is still invalid', async () => {
  const fake = queuedFetch([
    tokenHubResponse('first invalid output'),
    tokenHubResponse('second invalid output'),
  ]);

  await rejectsWithCode(providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  }), 'AI_OUTPUT_INVALID');

  assert.equal(fake.calls.length, 2);
});

test('does not retry semantic omissions such as a blank ingredient name', async () => {
  const invalid = {
    ...fixture,
    ingredients: [{ ...fixture.ingredients[0], name: '   ' }],
  };
  const fake = queuedFetch([tokenHubResponse(JSON.stringify(invalid))]);

  await rejectsWithCode(providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '只说了三个，没有说食材名',
    userId: 'family-hash',
  }), 'AI_OUTPUT_INVALID');

  assert.equal(fake.calls.length, 1);
});

test('rejects a valid JSON recipe with 51 ingredients without paying for repair', async () => {
  const invalid = {
    ...fixture,
    ingredients: Array.from({ length: 51 }, (_, index) => ({
      name: `食材${index + 1}`,
      amountText: '少许',
      note: '',
      uncertain: false,
    })),
  };
  const fake = queuedFetch([tokenHubResponse(JSON.stringify(invalid))]);

  await rejectsWithCode(providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '很多食材',
    userId: 'family-hash',
  }), 'AI_OUTPUT_INVALID');

  assert.equal(fake.calls.length, 1);
});

test('checks the raw model output byte limit before JSON parsing or repair', async () => {
  const fake = queuedFetch([tokenHubResponse('x'.repeat((100 * 1024) + 1))]);

  await rejectsWithCode(providerFor(fake.fetch.bind(fake)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  }), 'AI_OUTPUT_TOO_LARGE');

  assert.equal(fake.calls.length, 1);
});

test('fails closed with AI_NOT_CONFIGURED before making a request when the key is absent', async () => {
  const previous = process.env.TOKENHUB_API_KEY;
  delete process.env.TOKENHUB_API_KEY;
  let calls = 0;
  try {
    const provider = createTokenHubProvider({
      fetch: async () => { calls += 1; },
      apiKey: '',
      model: 'hy3',
      promptVersion: 'v1',
    });
    await rejectsWithCode(provider.organize({ sourceText: '鸡蛋三个', userId: 'family-hash' }), 'AI_NOT_CONFIGURED');
  } finally {
    if (previous === undefined) delete process.env.TOKENHUB_API_KEY;
    else process.env.TOKENHUB_API_KEY = previous;
  }
  assert.equal(calls, 0);
});

test('uses hy3 by default when no recipe model is configured', async () => {
  const previous = process.env.RECIPE_MODEL;
  delete process.env.RECIPE_MODEL;
  const fake = queuedFetch([tokenHubResponse(JSON.stringify(fixture))]);
  try {
    const provider = createTokenHubProvider({
      fetch: fake.fetch.bind(fake),
      apiKey: TEST_KEY,
      promptVersion: 'v1',
    });

    await provider.organize({ sourceText: '鸡蛋三个', userId: 'family-hash' });
  } finally {
    if (previous === undefined) delete process.env.RECIPE_MODEL;
    else process.env.RECIPE_MODEL = previous;
  }

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.model, 'hy3');
});

test('allows the explicitly approved deepseek-v4-flash model', async () => {
  const fake = queuedFetch([tokenHubResponse(JSON.stringify(fixture), {
    payload: { model: 'deepseek-v4-flash' },
  })]);
  const provider = providerFor(fake.fetch.bind(fake), { model: 'deepseek-v4-flash' });

  const result = await provider.organize({ sourceText: '鸡蛋三个', userId: 'family-hash' });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.model, 'deepseek-v4-flash');
  assert.equal(result.modelName, 'deepseek-v4-flash');
});

test('rejects Kimi and arbitrary recipe models before fetch', async () => {
  for (const model of ['kimi-k2', 'unapproved-model']) {
    let calls = 0;
    const provider = createTokenHubProvider({
      fetch: async () => { calls += 1; },
      apiKey: TEST_KEY,
      model,
      promptVersion: 'v1',
    });

    await rejectsWithCode(provider.organize({
      sourceText: '鸡蛋三个',
      userId: 'family-hash',
    }), 'AI_NOT_CONFIGURED');
    assert.equal(calls, 0);
  }
});

test('maps non-success and transport failures to the stable AI_HTTP_ERROR', async () => {
  const nonSuccess = queuedFetch([tokenHubResponse('', { ok: false, status: 429 })]);
  await rejectsWithCode(providerFor(nonSuccess.fetch.bind(nonSuccess)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  }), 'AI_HTTP_ERROR');

  const transport = queuedFetch([new Error(`network failed near ${TEST_KEY}`)]);
  await rejectsWithCode(providerFor(transport.fetch.bind(transport)).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  }), 'AI_HTTP_ERROR');
});

test('aborts a request after exactly 55 seconds and clears its timeout', async () => {
  const scheduled = [];
  const cleared = [];
  const clock = {
    setTimeout(callback, delayMs) {
      const id = { delayMs };
      scheduled.push(delayMs);
      queueMicrotask(callback);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
  };
  const fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

  await rejectsWithCode(providerFor(fetch, { clock }).organize({
    sourceText: '鸡蛋三个',
    userId: 'family-hash',
  }), 'AI_HTTP_ERROR');

  assert.deepEqual(scheduled, [55_000]);
  assert.equal(cleared.length, 1);
});

test('keeps every JSON Schema object strict and requires all declared properties', () => {
  const pending = [RECIPE_JSON_SCHEMA];
  while (pending.length > 0) {
    const schema = pending.pop();
    if (!schema || typeof schema !== 'object') continue;
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        [...schema.required].sort(),
        Object.keys(schema.properties).sort(),
      );
    }
    if (schema.properties) pending.push(...Object.values(schema.properties));
    if (schema.items) pending.push(schema.items);
  }
});
