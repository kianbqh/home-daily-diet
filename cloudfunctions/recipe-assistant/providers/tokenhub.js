const {
  LIMITS,
  RECIPE_JSON_SCHEMA,
  buildRecipeSystemPrompt,
  normalizeRecipe,
  validateRecipe,
} = require('../recipe-schema');

const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com';
const DEFAULT_MODEL = 'hy3';
const DEFAULT_PROMPT_VERSION = 'v1';
const REQUEST_TIMEOUT_MS = 55_000;
const FORMAT_REPAIR_PROMPT = '只修复为符合 Schema 的 JSON。不要新增、删除或推测任何事实，只输出 JSON。';

function createTokenHubProvider(options = {}) {
  const requestFetch = options.fetch || globalThis.fetch;
  const apiKey = stringOption(options, 'apiKey', process.env.TOKENHUB_API_KEY).trim();
  const baseUrl = stringOption(options, 'baseUrl', DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const model = stringOption(options, 'model', process.env.RECIPE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const promptVersion = stringOption(
    options,
    'promptVersion',
    process.env.RECIPE_PROMPT_VERSION || DEFAULT_PROMPT_VERSION,
  ).trim() || DEFAULT_PROMPT_VERSION;
  const timer = createTimer(options.clock);
  const endpoint = createEndpoint(baseUrl);

  return {
    async organize({ sourceText, userId } = {}) {
      if (!apiKey || typeof requestFetch !== 'function') {
        throw createProviderError('AI_NOT_CONFIGURED', 'TokenHub is not configured');
      }

      const initial = await requestCompletion([
        { role: 'system', content: buildRecipeSystemPrompt(promptVersion) },
        { role: 'user', content: String(sourceText || '') },
      ], userId);
      const initialOutput = inspectOutput(initial);
      if (initialOutput.ok) return organizeResult(initialOutput.recipe, initial, promptVersion, model);
      if (initialOutput.code === 'AI_OUTPUT_TOO_LARGE') {
        throw createProviderError('AI_OUTPUT_TOO_LARGE', 'TokenHub output is too large');
      }
      if (!initialOutput.repairable) {
        throw createProviderError('AI_OUTPUT_INVALID', 'TokenHub output is invalid');
      }

      const repaired = await requestCompletion([
        { role: 'system', content: FORMAT_REPAIR_PROMPT },
        { role: 'user', content: initialOutput.raw },
      ], userId);
      const repairedOutput = inspectOutput(repaired);
      if (repairedOutput.ok) return organizeResult(repairedOutput.recipe, repaired, promptVersion, model);
      if (repairedOutput.code === 'AI_OUTPUT_TOO_LARGE') {
        throw createProviderError('AI_OUTPUT_TOO_LARGE', 'TokenHub output is too large');
      }
      throw createProviderError('AI_OUTPUT_INVALID', 'TokenHub output is invalid');
    },
  };

  async function requestCompletion(messages, userId) {
    const controller = new AbortController();
    const timeoutId = timer.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await requestFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'family_recipe',
              strict: true,
              schema: RECIPE_JSON_SCHEMA,
            },
          },
          thinking: { type: 'disabled' },
          stream: false,
          user: String(userId || ''),
        }),
      });
      if (!response || response.ok !== true || typeof response.json !== 'function') {
        throw createProviderError('AI_HTTP_ERROR', 'TokenHub request failed');
      }
      try {
        return await response.json();
      } catch (_error) {
        throw createProviderError('AI_HTTP_ERROR', 'TokenHub response is unavailable');
      }
    } catch (error) {
      if (error && error.name === 'TokenHubProviderError') throw error;
      throw createProviderError('AI_HTTP_ERROR', 'TokenHub request failed');
    } finally {
      timer.clearTimeout(timeoutId);
    }
  }
}

function inspectOutput(response) {
  const content = response
    && response.choices
    && response.choices[0]
    && response.choices[0].message
    && response.choices[0].message.content;
  if (typeof content !== 'string') return { ok: false, raw: '', repairable: false };
  if (Buffer.byteLength(content, 'utf8') > LIMITS.recipeBytes) {
    return { ok: false, raw: content, repairable: false, code: 'AI_OUTPUT_TOO_LARGE' };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_error) {
    return { ok: false, raw: content, repairable: true };
  }

  const validation = validateRecipe(parsed);
  const errors = [
    ...findAdditionalPropertyErrors(parsed, RECIPE_JSON_SCHEMA),
    ...validation.errors,
  ];
  if (errors.length === 0) return { ok: true, raw: content, recipe: normalizeRecipe(parsed) };
  if (errors.some((error) => error.includes('recipe exceeds the maximum normalized JSON size'))) {
    return { ok: false, raw: content, repairable: false, code: 'AI_OUTPUT_TOO_LARGE' };
  }
  return {
    ok: false,
    raw: content,
    repairable: errors.every(isSchemaFormattingError),
  };
}

function findAdditionalPropertyErrors(value, schema, path = 'recipe', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    Object.keys(value).forEach((field) => {
      if (!Object.hasOwn(properties, field)) errors.push(`${path}.${field} is not allowed`);
    });
    Object.keys(properties).forEach((field) => {
      if (Object.hasOwn(value, field)) {
        findAdditionalPropertyErrors(value[field], properties[field], `${path}.${field}`, errors);
      }
    });
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    value.forEach((item, index) => {
      findAdditionalPropertyErrors(item, schema.items, `${path}[${index}]`, errors);
    });
  }
  return errors;
}

function isSchemaFormattingError(error) {
  return error.endsWith(' must be an array')
    || error.endsWith(' is required')
    || error.endsWith(' has an invalid type')
    || error.endsWith(' is not allowed');
}

function organizeResult(recipe, response, promptVersion, fallbackModel) {
  return {
    recipe,
    requestId: String(response && response.id || ''),
    modelName: String(response && response.model || fallbackModel),
    promptVersion,
    usage: cloneUsage(response && response.usage),
  };
}

function cloneUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function createEndpoint(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v1\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/v1/chat/completions`;
}

function createTimer(clock) {
  const source = clock && (typeof clock === 'object' || typeof clock === 'function') ? clock : globalThis;
  const set = typeof source.setTimeout === 'function' ? source.setTimeout.bind(source) : setTimeout;
  const clear = typeof source.clearTimeout === 'function' ? source.clearTimeout.bind(source) : clearTimeout;
  return { setTimeout: set, clearTimeout: clear };
}

function stringOption(options, key, fallback) {
  return String(Object.hasOwn(options, key) ? options[key] || '' : fallback || '');
}

function createProviderError(code, message) {
  const error = new Error(message);
  error.name = 'TokenHubProviderError';
  error.code = code;
  return error;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_VERSION,
  FORMAT_REPAIR_PROMPT,
  REQUEST_TIMEOUT_MS,
  createTokenHubProvider,
};
