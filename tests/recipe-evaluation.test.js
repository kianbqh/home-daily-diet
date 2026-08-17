const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEvaluationReport,
  canonicalizeFact,
  collectRecipeFacts,
  evaluateFixture,
  parseArgs,
  runCli,
  scoreRecipe,
} = require('../scripts/evaluate-recipe-models');

function validRecipe(overrides = {}) {
  return {
    ingredients: [],
    steps: [],
    tips: [],
    failures: [],
    familyNotes: [],
    uncertainties: [],
    ...overrides,
  };
}

test('scores canonical recipe facts deterministically without fuzzy invention matching', () => {
  const recipe = validRecipe({
    ingredients: [{ name: ' 鸡蛋 ', amountText: '3个', note: '', uncertain: false }],
    steps: [{
      order: 1,
      instruction: '炒到凝固',
      heat: '中大火',
      durationText: '',
      keyPoint: '',
      uncertain: false,
    }],
  });

  assert.equal(canonicalizeFact('  DeepSeek   V4  '), 'deepseek v4');
  assert.deepEqual([...collectRecipeFacts(recipe)].sort(), ['中大火', '炒到凝固', '鸡蛋|3个'].sort());
  assert.deepEqual(scoreRecipe({
    recipe,
    expectedFacts: ['鸡蛋|3个', '中大火'],
    forbiddenFacts: ['180度'],
  }), {
    schemaPass: true,
    unsupportedFacts: 0,
    factRecall: 1,
    fieldAccuracy: 1,
  });
});

test('counts explicit forbidden precise facts and reports recall and field accuracy separately', () => {
  const score = scoreRecipe({
    recipe: validRecipe({
      ingredients: [{ name: '鸡蛋', amountText: '3个', note: '', uncertain: false }],
      steps: [{
        order: 1,
        instruction: '炒到凝固',
        heat: '180度',
        durationText: '',
        keyPoint: '',
        uncertain: false,
      }],
    }),
    expectedFacts: ['鸡蛋|3个', '中大火'],
    forbiddenFacts: ['180度'],
  });

  assert.deepEqual(score, {
    schemaPass: true,
    unsupportedFacts: 1,
    factRecall: 0.5,
    fieldAccuracy: 0.3333,
  });
});

test('builds per-model release gates and fails any live model below a required threshold', () => {
  const report = buildEvaluationReport({
    mode: 'live',
    generatedAt: '2026-08-18T00:00:00.000Z',
    models: ['hy3', 'deepseek-v4-flash'],
    caseResults: [
      {
        id: 'case-1', model: 'hy3', schemaPass: true, unsupportedFacts: 0,
        factRecall: 1, fieldAccuracy: 1, latencyMs: 20, inputTokens: 10, outputTokens: 5,
      },
      {
        id: 'case-1', model: 'deepseek-v4-flash', schemaPass: true, unsupportedFacts: 1,
        factRecall: 0.8, fieldAccuracy: 0.5, latencyMs: 30, inputTokens: 12, outputTokens: 6,
      },
    ],
  });

  assert.equal(report.models[0].summary.gates.passed, true);
  assert.equal(report.models[1].summary.gates.schemaPass, true);
  assert.equal(report.models[1].summary.gates.unsupportedFacts, false);
  assert.equal(report.models[1].summary.gates.factRecall, false);
  assert.equal(report.releaseGate.evaluated, true);
  assert.equal(report.releaseGate.passed, false);
});

test('dry-run validates the matrix without creating providers, making requests, or copying transcripts', async () => {
  let providerCalls = 0;
  const transcript = 'PRIVATE_TRANSCRIPT_MUST_NOT_ENTER_REPORT';
  const report = await evaluateFixture({
    fixture: [{
      id: 'dry-case', transcript,
      expectedFacts: ['土豆|2个'], forbiddenFacts: ['180度'],
    }],
    models: ['hy3', 'deepseek-v4-flash'],
    live: false,
    providerFactory() {
      providerCalls += 1;
      throw new Error('dry-run must not construct a provider');
    },
    now: () => 1_000,
  });

  assert.equal(providerCalls, 0);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.releaseGate.evaluated, false);
  assert.equal(report.releaseGate.passed, true);
  assert.equal(report.models.length, 2);
  assert.deepEqual(report.models[0].cases[0], {
    id: 'dry-case', model: 'hy3', status: 'not_run',
    schemaPass: null, unsupportedFacts: null, factRecall: null, fieldAccuracy: null,
    latencyMs: 0, inputTokens: 0, outputTokens: 0,
  });
  assert.equal(JSON.stringify(report).includes(transcript), false);
});

test('live evaluation uses only injected approved providers and maps usage without exposing source text', async () => {
  const calls = [];
  let clock = 100;
  const report = await evaluateFixture({
    fixture: [{
      id: 'live-case', transcript: '鸡蛋三个，中大火炒熟。',
      expectedFacts: ['鸡蛋|3个', '中大火'], forbiddenFacts: ['180度'],
    }],
    models: ['hy3'],
    live: true,
    providerFactory({ model }) {
      calls.push({ type: 'provider', model });
      return {
        async organize({ sourceText, userId }) {
          calls.push({ type: 'organize', sourceText, userId });
          clock += 25;
          return {
            recipe: validRecipe({
              ingredients: [{ name: '鸡蛋', amountText: '3个', note: '', uncertain: false }],
              steps: [{ order: 1, instruction: '炒熟', heat: '中大火', durationText: '', keyPoint: '', uncertain: false }],
            }),
            usage: { prompt_tokens: 21, completion_tokens: 9 },
          };
        },
      };
    },
    now: () => clock,
  });

  assert.deepEqual(calls[0], { type: 'provider', model: 'hy3' });
  assert.equal(calls[1].sourceText, '鸡蛋三个，中大火炒熟。');
  assert.equal(calls[1].userId, 'recipe-eval:live-case');
  assert.equal(report.models[0].cases[0].latencyMs, 25);
  assert.equal(report.models[0].cases[0].inputTokens, 21);
  assert.equal(report.models[0].cases[0].outputTokens, 9);
  assert.equal(report.releaseGate.passed, true);
  assert.equal(JSON.stringify(report).includes('鸡蛋三个，中大火炒熟。'), false);
});

test('CLI parsing is dry-run by default and rejects unapproved models before evaluation', () => {
  assert.deepEqual(parseArgs([
    '--fixture', 'fixture.json', '--models', 'hy3,deepseek-v4-flash', '--out', 'report.json',
  ]), {
    fixturePath: 'fixture.json',
    models: ['hy3', 'deepseek-v4-flash'],
    outPath: 'report.json',
    live: false,
  });
  assert.throws(() => parseArgs([
    '--fixture', 'fixture.json', '--models', 'kimi', '--out', 'report.json', '--live',
  ]), /unsupported model/i);
});

test('live CLI writes a transcript-free report and exits one when a release gate fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-eval-'));
  const fixturePath = path.join(directory, 'private-fixture.json');
  const reportPath = path.join(directory, 'report.json');
  const transcript = 'TRANSCRIPT_SENT_TO_PROVIDER_BUT_NOT_REPORT';
  fs.writeFileSync(fixturePath, JSON.stringify([{
    id: 'gate-case', transcript,
    expectedFacts: ['鸡蛋|3个', '中大火'], forbiddenFacts: ['180度'],
  }]), 'utf8');
  try {
    const exitCode = await runCli([
      '--fixture', fixturePath,
      '--models', 'hy3',
      '--out', reportPath,
      '--live',
    ], {
      providerFactory() {
        return {
          async organize() {
            return {
              recipe: validRecipe({
                ingredients: [{ name: '鸡蛋', amountText: '3个', note: '', uncertain: false }],
                steps: [{ order: 1, instruction: '炒熟', heat: '180度', durationText: '', keyPoint: '', uncertain: false }],
              }),
              usage: {},
            };
          },
        };
      },
      output: { write() {} },
      now: () => 1_000,
    });
    const serialized = fs.readFileSync(reportPath, 'utf8');
    const report = JSON.parse(serialized);
    assert.equal(exitCode, 1);
    assert.equal(report.releaseGate.evaluated, true);
    assert.equal(report.releaseGate.passed, false);
    assert.equal(serialized.includes(transcript), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('committed fixture contains exactly two fictional sanitized Mandarin samples', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'recipe-transcripts.sample.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.length, 2);
  fixture.forEach((item) => {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.transcript, 'string');
    assert.ok(item.transcript.length > 10);
    assert.ok(Array.isArray(item.expectedFacts));
    assert.ok(Array.isArray(item.forbiddenFacts));
    assert.doesNotMatch(item.transcript, /(?:openid|wxid_|1\d{10}|@|PRIVATE_)/i);
  });
});
