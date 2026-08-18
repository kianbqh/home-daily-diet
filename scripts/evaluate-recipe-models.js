const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeRecipe,
  validateRecipe,
} = require('../cloudfunctions/recipe-assistant/recipe-schema');
const {
  ALLOWED_MODELS,
  createTokenHubProvider,
} = require('../cloudfunctions/recipe-assistant/providers/tokenhub');

const FACT_RECALL_GATE = 0.9;
const FACT_TYPES = Object.freeze(new Set([
  'ingredient',
  'ingredient.note',
  'step.instruction',
  'step.heat',
  'step.duration',
  'step.keypoint',
  'tip',
  'failure.problem',
  'failure.cause',
  'failure.remedy',
  'familynote',
]));
const METRIC_FIELDS = Object.freeze([
  'schemaPass',
  'unsupportedFacts',
  'factRecall',
  'fieldAccuracy',
  'expectedHits',
  'expectedCount',
  'fieldCorrectCount',
  'fieldUnionCount',
  'latencyMs',
  'inputTokens',
  'outputTokens',
]);

function canonicalizeFact(value) {
  return String(value == null ? '' : value)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseAnnotatedFact(value, { allowWildcard = false } = {}) {
  const raw = String(value == null ? '' : value).trim();
  const separator = raw.indexOf('=');
  if (separator <= 0) throw new Error(`fact must use field=value syntax: ${raw || '<blank>'}`);
  const type = raw.slice(0, separator).trim().toLowerCase();
  const fact = canonicalizeFact(raw.slice(separator + 1));
  if ((!FACT_TYPES.has(type) && !(allowWildcard && type === '*')) || !fact) {
    throw new Error(`fact has an unsupported field or blank value: ${raw}`);
  }
  return { type, value: fact, key: `${type}=${fact}` };
}

function collectRecipeFacts(value) {
  return new Set(collectRecipeFactEntries(value).map((entry) => entry.key));
}

function collectRecipeFactEntries(value) {
  const recipe = normalizeRecipe(value);
  const uncertainPaths = recipe.uncertainties
    .map((item) => String(item.fieldPath || '').trim())
    .filter(Boolean);
  const entries = new Map();
  const add = (type, fact, paths, itemUncertain = false) => {
    const canonical = canonicalizeFact(fact);
    if (!canonical) return;
    const key = `${type}=${canonical}`;
    const uncertain = itemUncertain
      || (Array.isArray(paths) ? paths : [paths]).some((path) => isPathUncertain(path, uncertainPaths));
    const existing = entries.get(key);
    entries.set(key, {
      key,
      type,
      value: canonical,
      uncertain: existing ? existing.uncertain && uncertain : uncertain,
    });
  };

  recipe.ingredients.forEach((ingredient, index) => {
    const basePath = `ingredients[${index}]`;
    add(
      'ingredient',
      encodeIngredientTuple(ingredient.name, ingredient.amountText),
      [`${basePath}.name`, `${basePath}.amountText`],
      ingredient.uncertain,
    );
    add('ingredient.note', ingredient.note, `${basePath}.note`, ingredient.uncertain);
  });
  recipe.steps.forEach((step, index) => {
    const basePath = `steps[${index}]`;
    add('step.instruction', step.instruction, `${basePath}.instruction`, step.uncertain);
    add('step.heat', step.heat, `${basePath}.heat`, step.uncertain);
    add('step.duration', step.durationText, `${basePath}.durationText`, step.uncertain);
    add('step.keypoint', step.keyPoint, `${basePath}.keyPoint`, step.uncertain);
  });
  recipe.tips.forEach((tip, index) => add('tip', tip, `tips[${index}]`));
  recipe.failures.forEach((failure, index) => {
    const basePath = `failures[${index}]`;
    add('failure.problem', failure.problem, `${basePath}.problem`);
    add('failure.cause', failure.cause, `${basePath}.cause`);
    add('failure.remedy', failure.remedy, `${basePath}.remedy`);
  });
  recipe.familyNotes.forEach((note, index) => add('familynote', note, `familyNotes[${index}]`));
  return [...entries.values()];
}

function encodeIngredientTuple(name, amountText) {
  return `${escapeIngredientTuplePart(name)}|${escapeIngredientTuplePart(amountText)}`;
}

function escapeIngredientTuplePart(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

function isPathUncertain(path, uncertainPaths) {
  const candidate = String(path || '').trim();
  return Boolean(candidate) && uncertainPaths.some((marker) => (
    marker === candidate
    || candidate.startsWith(`${marker}.`)
    || candidate.startsWith(`${marker}[`)
  ));
}

function forbiddenMatches(rule, candidate) {
  return rule.value === candidate.value && (rule.type === '*' || rule.type === candidate.type);
}

function scoreRecipe({ recipe, expectedFacts = [], forbiddenFacts = [] } = {}) {
  const preciseFacts = new Set(
    collectRecipeFactEntries(recipe)
      .filter((entry) => !entry.uncertain)
      .map((entry) => entry.key),
  );
  const expected = canonicalFactList(expectedFacts);
  const expectedSet = new Set(expected);
  const forbidden = canonicalFactList(forbiddenFacts, { allowWildcard: true })
    .map((fact) => parseAnnotatedFact(fact, { allowWildcard: true }));
  const expectedHits = expected.filter((fact) => preciseFacts.has(fact)).length;
  const unsupportedFacts = [...preciseFacts].filter((fact) => {
    const parsed = parseAnnotatedFact(fact);
    return !expectedSet.has(fact) || forbidden.some((rule) => forbiddenMatches(rule, parsed));
  }).length;
  const expectedCount = expected.length;
  const fieldCorrectCount = expectedHits;
  const fieldUnionCount = new Set([...expected, ...preciseFacts]).size;
  const factRecall = expectedCount ? expectedHits / expectedCount : 1;
  const fieldAccuracy = fieldUnionCount ? fieldCorrectCount / fieldUnionCount : 1;
  return {
    schemaPass: validateRecipe(recipe).ok,
    unsupportedFacts,
    factRecall: roundMetric(factRecall),
    fieldAccuracy: roundMetric(fieldAccuracy),
    expectedHits,
    expectedCount,
    fieldCorrectCount,
    fieldUnionCount,
  };
}

function buildEvaluationReport({ mode, models = [], caseResults = [], generatedAt } = {}) {
  const live = mode === 'live';
  const modelReports = models.map((model) => {
    const cases = caseResults
      .filter((item) => item.model === model)
      .map(sanitizeCaseResult);
    return {
      model,
      cases,
      summary: summarizeModel(cases, live),
    };
  });
  return {
    formatVersion: 2,
    mode: live ? 'live' : 'dry-run',
    generatedAt: String(generatedAt || new Date().toISOString()),
    thresholds: {
      schemaPassRate: 1,
      unsupportedFacts: 0,
      factRecall: FACT_RECALL_GATE,
    },
    models: modelReports,
    releaseGate: {
      evaluated: live,
      passed: live ? modelReports.every((item) => item.summary.gates.passed) : true,
    },
  };
}

async function evaluateFixture(options = {}) {
  const fixture = validateFixture(options.fixture);
  const models = validateModels(options.models);
  const live = options.live === true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const providerFactory = options.providerFactory || (({ model }) => createTokenHubProvider({ model }));
  const caseResults = [];

  for (const model of models) {
    if (!live) {
      fixture.forEach((item) => caseResults.push(notRunResult(item.id, model)));
      continue;
    }

    let provider;
    let providerError = null;
    try {
      provider = providerFactory({ model });
      if (!provider || typeof provider.organize !== 'function') {
        throw evaluationError('PROVIDER_INVALID');
      }
    } catch (error) {
      providerError = error;
    }

    for (const item of fixture) {
      const startedAt = now();
      if (providerError) {
        caseResults.push(failedCaseResult(
          item.id,
          model,
          now() - startedAt,
          providerError,
          item.expectedFacts.length,
        ));
        continue;
      }
      try {
        const result = await provider.organize({
          sourceText: item.transcript,
          userId: `recipe-eval:${item.id}`,
        });
        const score = scoreRecipe({
          recipe: result && result.recipe,
          expectedFacts: item.expectedFacts,
          forbiddenFacts: item.forbiddenFacts,
        });
        const usage = result && result.usage && typeof result.usage === 'object' ? result.usage : {};
        caseResults.push({
          id: item.id,
          model,
          status: 'ok',
          ...score,
          latencyMs: nonNegativeNumber(now() - startedAt),
          inputTokens: usageNumber(usage, ['prompt_tokens', 'input_tokens', 'inputTokens']),
          outputTokens: usageNumber(usage, ['completion_tokens', 'output_tokens', 'outputTokens']),
        });
      } catch (error) {
        caseResults.push(failedCaseResult(
          item.id,
          model,
          now() - startedAt,
          error,
          item.expectedFacts.length,
        ));
      }
    }
  }

  return buildEvaluationReport({
    mode: live ? 'live' : 'dry-run',
    models,
    caseResults,
    generatedAt: new Date(now()).toISOString(),
  });
}

function parseArgs(argv = []) {
  let fixturePath = '';
  let outPath = '';
  let models = [];
  let live = false;
  let modeFlag = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture' || arg === '--models' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || String(value).startsWith('--')) throw new Error(`missing value for ${arg}`);
      index += 1;
      if (arg === '--fixture') fixturePath = value;
      if (arg === '--out') outPath = value;
      if (arg === '--models') models = String(value).split(',').map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === '--live' || arg === '--dry-run') {
      if (modeFlag && modeFlag !== arg) throw new Error('choose either --live or --dry-run');
      modeFlag = arg;
      live = arg === '--live';
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!fixturePath) throw new Error('missing required --fixture');
  if (!outPath) throw new Error('missing required --out');
  if (!models.length) throw new Error('missing required --models');
  validateModels(models);
  return { fixturePath, models, outPath, live };
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const fixturePath = path.resolve(options.fixturePath);
  const outPath = path.resolve(options.outPath);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const report = await evaluateFixture({
    fixture,
    models: options.models,
    live: options.live,
    providerFactory: dependencies.providerFactory,
    now: dependencies.now,
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const output = dependencies.output || process.stdout;
  output.write(`${report.mode}: ${report.models.length} model(s), report written to ${outPath}\n`);
  return report.mode === 'live' && !report.releaseGate.passed ? 1 : 0;
}

function validateFixture(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('fixture must be a non-empty array');
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`fixture item ${index + 1} must be an object`);
    }
    const id = String(item.id || '').trim();
    const transcript = String(item.transcript || '').trim();
    if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`fixture item ${index + 1} has an invalid id`);
    if (ids.has(id)) throw new Error(`fixture id ${id} is duplicated`);
    if (!transcript) throw new Error(`fixture item ${id} has a blank transcript`);
    if (!Array.isArray(item.expectedFacts) || !Array.isArray(item.forbiddenFacts)) {
      throw new Error(`fixture item ${id} must define expectedFacts and forbiddenFacts arrays`);
    }
    const expectedFacts = canonicalFactList(item.expectedFacts);
    const forbiddenFacts = canonicalFactList(item.forbiddenFacts, { allowWildcard: true });
    const forbiddenRules = forbiddenFacts
      .map((fact) => parseAnnotatedFact(fact, { allowWildcard: true }));
    expectedFacts.forEach((fact) => {
      const expected = parseAnnotatedFact(fact);
      if (forbiddenRules.some((rule) => forbiddenMatches(rule, expected))) {
        throw new Error(`fixture item ${id} lists the same fact as expected and forbidden`);
      }
    });
    ids.add(id);
    return {
      id,
      transcript,
      expectedFacts,
      forbiddenFacts,
    };
  });
}

function validateModels(value) {
  const models = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
  if (!models.length) throw new Error('models must not be empty');
  models.forEach((model) => {
    if (!ALLOWED_MODELS.includes(model)) throw new Error(`unsupported model: ${model}`);
  });
  return models;
}

function summarizeModel(cases, live) {
  if (!live) {
    return {
      caseCount: cases.length,
      evaluatedCases: 0,
      schemaPassRate: null,
      unsupportedFacts: null,
      factRecall: null,
      fieldAccuracy: null,
      expectedHits: null,
      expectedCount: null,
      fieldCorrectCount: null,
      fieldUnionCount: null,
      averageLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      gates: { schemaPass: null, unsupportedFacts: null, factRecall: null, passed: true },
    };
  }
  const count = cases.length;
  const schemaPassRate = count ? cases.filter((item) => item.schemaPass === true).length / count : 0;
  const unsupportedFacts = sum(cases, 'unsupportedFacts');
  const expectedHits = integerSum(cases, 'expectedHits');
  const expectedCount = integerSum(cases, 'expectedCount');
  const fieldCorrectCount = integerSum(cases, 'fieldCorrectCount');
  const fieldUnionCount = integerSum(cases, 'fieldUnionCount');
  const rawFactRecall = expectedCount ? expectedHits / expectedCount : 1;
  const rawFieldAccuracy = fieldUnionCount ? fieldCorrectCount / fieldUnionCount : 1;
  const gates = {
    schemaPass: schemaPassRate === 1,
    unsupportedFacts: unsupportedFacts === 0,
    factRecall: rawFactRecall >= FACT_RECALL_GATE,
  };
  return {
    caseCount: count,
    evaluatedCases: count,
    schemaPassRate: roundMetric(schemaPassRate),
    unsupportedFacts,
    factRecall: roundMetric(rawFactRecall),
    fieldAccuracy: roundMetric(rawFieldAccuracy),
    expectedHits,
    expectedCount,
    fieldCorrectCount,
    fieldUnionCount,
    averageLatencyMs: roundMetric(average(cases, 'latencyMs')),
    inputTokens: sum(cases, 'inputTokens'),
    outputTokens: sum(cases, 'outputTokens'),
    gates: { ...gates, passed: Object.values(gates).every(Boolean) },
  };
}

function sanitizeCaseResult(item) {
  const result = {
    id: String(item.id || ''),
    model: String(item.model || ''),
    status: String(item.status || 'ok'),
  };
  METRIC_FIELDS.forEach((field) => {
    result[field] = item[field] == null ? null : item[field];
  });
  if (item.errorCode) result.errorCode = publicErrorCode(item.errorCode);
  return result;
}

function notRunResult(id, model) {
  return {
    id,
    model,
    status: 'not_run',
    schemaPass: null,
    unsupportedFacts: null,
    factRecall: null,
    fieldAccuracy: null,
    expectedHits: null,
    expectedCount: null,
    fieldCorrectCount: null,
    fieldUnionCount: null,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function failedCaseResult(id, model, latencyMs, error, expectedCount = 0) {
  const safeExpectedCount = nonNegativeInteger(expectedCount);
  return {
    id,
    model,
    status: 'error',
    schemaPass: false,
    unsupportedFacts: 0,
    factRecall: 0,
    fieldAccuracy: 0,
    expectedHits: 0,
    expectedCount: safeExpectedCount,
    fieldCorrectCount: 0,
    fieldUnionCount: safeExpectedCount,
    latencyMs: nonNegativeNumber(latencyMs),
    inputTokens: 0,
    outputTokens: 0,
    errorCode: publicErrorCode(error && error.code),
  };
}

function canonicalFactList(values, options = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => parseAnnotatedFact(value, options).key))];
}

function usageNumber(usage, keys) {
  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function sum(items, field) {
  return items.reduce((total, item) => total + nonNegativeNumber(item[field]), 0);
}

function integerSum(items, field) {
  return items.reduce((total, item) => total + nonNegativeInteger(item[field]), 0);
}

function average(items, field) {
  return items.length ? roundMetric(sum(items, field) / items.length) : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function roundMetric(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function publicErrorCode(value) {
  const code = String(value || 'EVALUATION_FAILED');
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'EVALUATION_FAILED';
}

function evaluationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

if (require.main === module) {
  runCli()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch(() => {
      process.stderr.write('recipe evaluation failed; check arguments, sanitized fixtures, and provider configuration\n');
      process.exitCode = 1;
    });
}

module.exports = {
  FACT_RECALL_GATE,
  buildEvaluationReport,
  canonicalizeFact,
  collectRecipeFacts,
  evaluateFixture,
  parseArgs,
  runCli,
  scoreRecipe,
  validateFixture,
  validateModels,
};
