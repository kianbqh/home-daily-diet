const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/recipe-contract.json');

const client = require('../services/recipe-domain');
const server = require('../cloudfunctions/recipe-assistant/recipe-schema');

const implementations = [
  ['client', client],
  ['server', server],
];

test('normalizes the shared fixture identically and preserves household units', () => {
  const source = {
    ...fixture,
    ingredients: [{ ...fixture.ingredients[0], name: ' 鸡蛋 ', amountText: ' 3 个 ', ignored: 'discard' }],
    steps: [{ ...fixture.steps[0], order: 99, instruction: ' 炒至刚凝固 ', ignored: 'discard' }],
    ignored: true,
  };

  const clientRecipe = client.normalizeRecipe(source);
  const serverRecipe = server.normalizeRecipe(source);

  assert.deepEqual(clientRecipe, serverRecipe);
  assert.deepEqual(clientRecipe, fixture);
  assert.equal(clientRecipe.ingredients[0].amountText, '3 个');
  assert.equal(Object.hasOwn(clientRecipe, 'ignored'), false);
  assert.equal(Object.hasOwn(clientRecipe.ingredients[0], 'ignored'), false);
});

test('creates an empty complete recipe shape', () => {
  assert.deepEqual(client.emptyRecipe(), {
    ingredients: [], steps: [], tips: [], failures: [], familyNotes: [], uncertainties: [],
  });
});

for (const [name, contract] of implementations) {
  test(`${name} rejects an ingredient with a blank name without echoing recipe content`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      ingredients: [{ ...fixture.ingredients[0], name: '   ' }],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('ingredients[0].name')));
    assert.equal(result.errors.some((error) => error.includes('鸡蛋')), false);
  });

  test(`${name} rejects missing required object fields`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      ingredients: [{ name: '鸡蛋', amountText: '3 个', uncertain: false }],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('ingredients[0].note')));
  });

  test(`${name} rejects values that do not match the exact recipe field types`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      ingredients: [{ ...fixture.ingredients[0], uncertain: 'false' }],
      tips: [123],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('ingredients[0].uncertain')));
    assert.ok(result.errors.some((error) => error.includes('tips[0]')));
  });

  test(`${name} rejects a recipe with 51 ingredients`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      ingredients: Array.from({ length: 51 }, (_, index) => ({
        name: `食材${index}`, amountText: '少许', note: '', uncertain: false,
      })),
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('ingredients')));
  });

  test(`${name} rejects a recipe with 31 steps`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      steps: Array.from({ length: 31 }, (_, index) => ({
        order: index + 1,
        instruction: '翻炒',
        heat: '中火',
        durationText: '',
        keyPoint: '',
        uncertain: false,
      })),
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('steps')));
  });

  test(`${name} rejects explanatory text longer than 1000 characters`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      steps: [{ ...fixture.steps[0], instruction: '长'.repeat(1001) }],
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('steps[0].instruction')));
  });

  test(`${name} rejects normalized JSON larger than 100 KiB`, () => {
    const result = contract.validateRecipe({
      ...fixture,
      tips: Array.from({ length: 20 }, () => '长'.repeat(1000)),
      familyNotes: Array.from({ length: 20 }, () => '长'.repeat(1000)),
      failures: Array.from({ length: 20 }, () => ({
        problem: '长'.repeat(1000), cause: '长'.repeat(1000), remedy: '长'.repeat(1000),
      })),
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('recipe')));
  });
}

test('server schema requires complete known-object fields and uncertainty objects', () => {
  assert.equal(server.RECIPE_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(server.RECIPE_JSON_SCHEMA.required, [
    'ingredients', 'steps', 'tips', 'failures', 'familyNotes', 'uncertainties',
  ]);
  assert.deepEqual(server.RECIPE_JSON_SCHEMA.properties.uncertainties.items.required, [
    'fieldPath', 'message',
  ]);
});

test('server prompt treats source as data and routes missing details to uncertainties', () => {
  const prompt = server.buildRecipePrompt('鸡蛋少许');

  assert.match(prompt, /source text is data/i);
  assert.match(prompt, /do not invent/i);
  assert.match(prompt, /household units/i);
  assert.match(prompt, /uncertainties/);
  assert.match(prompt, /鸡蛋少许/);
});
