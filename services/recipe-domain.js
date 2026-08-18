const LIMITS = Object.freeze({
  ingredients: 50,
  steps: 30,
  tips: 20,
  failures: 20,
  familyNotes: 20,
  fieldChars: 1000,
  recipeBytes: 100 * 1024,
});

const RECIPE_KEYS = ['ingredients', 'steps', 'tips', 'failures', 'familyNotes', 'uncertainties'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function emptyRecipe() {
  return { ingredients: [], steps: [], tips: [], failures: [], familyNotes: [], uncertainties: [] };
}

function normalizeIngredient(value) {
  const item = object(value);
  return {
    name: text(item.name),
    amountText: text(item.amountText),
    note: text(item.note),
    uncertain: item.uncertain === true,
  };
}

function normalizeStep(value, index) {
  const item = object(value);
  return {
    order: index + 1,
    instruction: text(item.instruction),
    heat: text(item.heat),
    durationText: text(item.durationText),
    keyPoint: text(item.keyPoint),
    uncertain: item.uncertain === true,
  };
}

function normalizeFailure(value) {
  const item = object(value);
  return { problem: text(item.problem), cause: text(item.cause), remedy: text(item.remedy) };
}

function normalizeUncertainty(value) {
  const item = object(value);
  return { fieldPath: text(item.fieldPath), message: text(item.message) };
}

function normalizeRecipe(value) {
  const recipe = object(value);
  return {
    ingredients: list(recipe.ingredients).map(normalizeIngredient),
    steps: list(recipe.steps).map(normalizeStep),
    tips: list(recipe.tips).map(text),
    failures: list(recipe.failures).map(normalizeFailure),
    familyNotes: list(recipe.familyNotes).map(text),
    uncertainties: list(recipe.uncertainties).map(normalizeUncertainty),
  };
}

function recipeByteLength(value) {
  const json = JSON.stringify(normalizeRecipe(value));
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(json, 'utf8');
  }
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
  let bytes = 0;
  for (const character of json) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function validateRecipe(value) {
  return validateRecipeShape(value, { allowBlankRequiredFields: false });
}

function validateDraftRecipe(value) {
  return validateRecipeShape(value, { allowBlankRequiredFields: true });
}

function validateRecipeShape(value, options = {}) {
  const recipe = normalizeRecipe(value);
  const errors = [];
  const input = object(value);
  const allowBlankRequiredFields = options.allowBlankRequiredFields === true;

  RECIPE_KEYS.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} must be an array`);
  });

  [
    ['ingredients', LIMITS.ingredients],
    ['steps', LIMITS.steps],
    ['tips', LIMITS.tips],
    ['failures', LIMITS.failures],
    ['familyNotes', LIMITS.familyNotes],
  ].forEach(([key, limit]) => {
    if (recipe[key].length > limit) errors.push(`${key} exceeds the maximum item count`);
  });

  recipe.ingredients.forEach((item, index) => {
    requireFields(list(input.ingredients)[index], `ingredients[${index}]`, ['name', 'amountText', 'note', 'uncertain'], errors);
    requireTypes(list(input.ingredients)[index], `ingredients[${index}]`, { name: 'string', amountText: 'string', note: 'string', uncertain: 'boolean' }, errors);
    if (!allowBlankRequiredFields && !item.name) errors.push(`ingredients[${index}].name must not be blank`);
    validateTextFields(item, `ingredients[${index}]`, ['name', 'amountText', 'note'], errors);
  });
  recipe.steps.forEach((item, index) => {
    const original = list(input.steps)[index];
    requireFields(original, `steps[${index}]`, ['order', 'instruction', 'heat', 'durationText', 'keyPoint', 'uncertain'], errors);
    requireTypes(original, `steps[${index}]`, { order: 'number', instruction: 'string', heat: 'string', durationText: 'string', keyPoint: 'string', uncertain: 'boolean' }, errors);
    if (Number.isInteger(object(original).order) && object(original).order < 1) {
      errors.push(`steps[${index}].order must be at least 1`);
    }
    if (!allowBlankRequiredFields && !item.instruction) errors.push(`steps[${index}].instruction must not be blank`);
    validateTextFields(item, `steps[${index}]`, ['instruction', 'heat', 'durationText', 'keyPoint'], errors);
  });
  recipe.tips.forEach((item, index) => {
    requireType(list(input.tips)[index], `tips[${index}]`, 'string', errors);
    validateText(item, `tips[${index}]`, errors);
  });
  recipe.failures.forEach((item, index) => {
    requireFields(list(input.failures)[index], `failures[${index}]`, ['problem', 'cause', 'remedy'], errors);
    requireTypes(list(input.failures)[index], `failures[${index}]`, { problem: 'string', cause: 'string', remedy: 'string' }, errors);
    validateTextFields(item, `failures[${index}]`, ['problem', 'cause', 'remedy'], errors);
  });
  recipe.familyNotes.forEach((item, index) => {
    requireType(list(input.familyNotes)[index], `familyNotes[${index}]`, 'string', errors);
    validateText(item, `familyNotes[${index}]`, errors);
  });
  recipe.uncertainties.forEach((item, index) => {
    requireFields(list(input.uncertainties)[index], `uncertainties[${index}]`, ['fieldPath', 'message'], errors);
    requireTypes(list(input.uncertainties)[index], `uncertainties[${index}]`, { fieldPath: 'string', message: 'string' }, errors);
    if (!allowBlankRequiredFields && !item.fieldPath) errors.push(`uncertainties[${index}].fieldPath must not be blank`);
    if (!allowBlankRequiredFields && !item.message) errors.push(`uncertainties[${index}].message must not be blank`);
    validateTextFields(item, `uncertainties[${index}]`, ['fieldPath', 'message'], errors);
  });

  if (recipeByteLength(recipe) > LIMITS.recipeBytes) errors.push('recipe exceeds the maximum normalized JSON size');
  return { ok: errors.length === 0, errors };
}

function validateTextFields(item, path, keys, errors) {
  keys.forEach((key) => validateText(item[key], `${path}.${key}`, errors));
}

function requireFields(value, path, fields, errors) {
  const item = object(value);
  fields.forEach((field) => {
    if (!Object.hasOwn(item, field)) errors.push(`${path}.${field} is required`);
  });
}

function requireTypes(value, path, fields, errors) {
  Object.entries(fields).forEach(([field, type]) => requireType(object(value)[field], `${path}.${field}`, type, errors));
}

function requireType(value, path, type, errors) {
  if (typeof value !== type || (type === 'number' && !Number.isInteger(value))) errors.push(`${path} has an invalid type`);
}

function validateText(value, path, errors) {
  if (value.length > LIMITS.fieldChars) errors.push(`${path} exceeds the maximum character count`);
}

module.exports = {
  LIMITS,
  emptyRecipe,
  normalizeRecipe,
  recipeByteLength,
  validateDraftRecipe,
  validateRecipe,
};
