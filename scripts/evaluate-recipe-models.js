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
const METRIC_FIELDS = Object.freeze([
  'schemaPass',
  'unsupportedFacts',
  'factRecall',
  'fieldAccuracy',
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

function collectRecipeFacts(value) {
  const recipe = normalizeRecipe(value);
  const facts = new Set();
  const add = (fact) => {
    const canonical = canonicalizeFact(fact);
    if (canonical) facts.add(canonical);
  };

  recipe.ingredients.forEach((ingredient) => {
    add(ingredient.amountText
      ? `${ingredient.name}|${ingredient.amountText}`
      : ingredient.name);
    add(ingredient.note);
  });
  recipe.steps.forEach((step) => {
    add(step.instruction);
    add(step.heat);
    add(step.durationText);
    add(step.keyPoint);
  });
  recipe.tips.forEach(add);
  recipe.failures.forEach((failure) => {
    add(failure.problem);
    add(failure.cause);
    add(failure.remedy);
  });
  recipe.familyNotes.forEach(add);
  return facts;
}

function scoreRecipe({ recipe, expectedFacts = [], forbiddenFacts = [] } = {}) {
  const facts = collectRecipeFacts(recipe);
  const expected = canonicalFactList(expectedFacts);
  const forbidden = canonicalFactList(forbiddenFacts);
  const expectedHits = expected.filter((fact) => facts.has(fact)).length;
  const unsupportedFacts = forbidden.filter((fact) => facts.has(fact)).length;
  const factRecall = expected.length ? expectedHits / expected.length : 1;
  const fieldCount = expected.length + forbidden.length;
  const fieldAccuracy = fieldCount
    ? (expectedHits + forbidden.length - unsupportedFacts) / fieldCount
    : 1;
  return {
    schemaPass: validateRecipe(recipe).ok,
    unsupportedFacts,
    factRecall: roundMetric(factRecall),
    fieldAccuracy: roundMetric(fieldAccuracy),
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
    formatVersion: 1,
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
        caseResults.push(failedCaseResult(item.id, model, now() - startedAt, providerError));
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
        caseResults.push(failedCaseResult(item.id, model, now() - startedAt, error));
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
    ids.add(id);
    return {
      id,
      transcript,
      expectedFacts: canonicalFactList(item.expectedFacts),
      forbiddenFacts: canonicalFactList(item.forbiddenFacts),
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
      averageLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      gates: { schemaPass: null, unsupportedFacts: null, factRecall: null, passed: true },
    };
  }
  const count = cases.length;
  const schemaPassRate = count ? cases.filter((item) => item.schemaPass === true).length / count : 0;
  const unsupportedFacts = sum(cases, 'unsupportedFacts');
  const factRecall = average(cases, 'factRecall');
  const fieldAccuracy = average(cases, 'fieldAccuracy');
  const gates = {
    schemaPass: schemaPassRate === 1,
    unsupportedFacts: unsupportedFacts === 0,
    factRecall: factRecall >= FACT_RECALL_GATE,
  };
  return {
    caseCount: count,
    evaluatedCases: count,
    schemaPassRate: roundMetric(schemaPassRate),
    unsupportedFacts,
    factRecall,
    fieldAccuracy,
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
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function failedCaseResult(id, model, latencyMs, error) {
  return {
    id,
    model,
    status: 'error',
    schemaPass: false,
    unsupportedFacts: 0,
    factRecall: 0,
    fieldAccuracy: 0,
    latencyMs: nonNegativeNumber(latencyMs),
    inputTokens: 0,
    outputTokens: 0,
    errorCode: publicErrorCode(error && error.code),
  };
}

function canonicalFactList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalizeFact)
    .filter(Boolean))];
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

function average(items, field) {
  return items.length ? roundMetric(sum(items, field) / items.length) : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
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
