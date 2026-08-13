const { emptyRecipe, normalizeRecipe, validateRecipe } = require('../../services/recipe-domain');

function indexFrom(event) {
  return Number(event && event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset.index
    : -1);
}

function fieldFrom(event) {
  return String(event && event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset.field || ''
    : '');
}

function inputValue(event) {
  return String(event && event.detail ? event.detail.value || '' : '');
}

Component({
  properties: {
    value: {
      type: Object,
      value: null,
      observer(value) {
        this.setData({ recipe: normalizeRecipe(value || emptyRecipe()) });
      },
    },
    disabled: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    recipe: emptyRecipe(),
  },

  lifetimes: {
    attached() {
      this.setData({ recipe: normalizeRecipe(this.data.value || this.data.recipe || emptyRecipe()) });
    },
  },

  methods: {
    commit(nextRecipe) {
      if (this.data.disabled) return;
      const recipe = normalizeRecipe(nextRecipe);
      const validation = validateRecipe(recipe);
      this.setData({ recipe });
      this.triggerEvent('change', { recipe });
      this.triggerEvent('validation', validation);
    },

    addIngredient() {
      const recipe = normalizeRecipe(this.data.recipe);
      recipe.ingredients.push({ name: '', amountText: '', note: '', uncertain: false });
      this.commit(recipe);
    },

    removeIngredient(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      if (index < 0 || index >= recipe.ingredients.length) return;
      recipe.ingredients.splice(index, 1);
      this.commit(recipe);
    },

    onIngredientInput(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      const field = fieldFrom(event);
      if (!recipe.ingredients[index] || !['name', 'amountText', 'note'].includes(field)) return;
      recipe.ingredients[index][field] = inputValue(event);
      this.commit(recipe);
    },

    addStep() {
      const recipe = normalizeRecipe(this.data.recipe);
      recipe.steps.push({
        order: recipe.steps.length + 1,
        instruction: '',
        heat: '',
        durationText: '',
        keyPoint: '',
        uncertain: false,
      });
      this.commit(recipe);
    },

    removeStep(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      if (index < 0 || index >= recipe.steps.length) return;
      recipe.steps.splice(index, 1);
      this.commit(recipe);
    },

    onStepInput(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      const field = fieldFrom(event);
      if (!recipe.steps[index]
        || !['instruction', 'heat', 'durationText', 'keyPoint'].includes(field)) return;
      recipe.steps[index][field] = inputValue(event);
      this.commit(recipe);
    },

    addTextItem(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const field = fieldFrom(event);
      if (!['tips', 'familyNotes'].includes(field)) return;
      recipe[field].push('');
      this.commit(recipe);
    },

    removeTextItem(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const field = fieldFrom(event);
      const index = indexFrom(event);
      if (!['tips', 'familyNotes'].includes(field) || index < 0 || index >= recipe[field].length) return;
      recipe[field].splice(index, 1);
      this.commit(recipe);
    },

    onTextItemInput(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const field = fieldFrom(event);
      const index = indexFrom(event);
      if (!['tips', 'familyNotes'].includes(field) || !Object.hasOwn(recipe[field], index)) return;
      recipe[field][index] = inputValue(event);
      this.commit(recipe);
    },

    addFailure() {
      const recipe = normalizeRecipe(this.data.recipe);
      recipe.failures.push({ problem: '', cause: '', remedy: '' });
      this.commit(recipe);
    },

    removeFailure(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      if (index < 0 || index >= recipe.failures.length) return;
      recipe.failures.splice(index, 1);
      this.commit(recipe);
    },

    onFailureInput(event) {
      const recipe = normalizeRecipe(this.data.recipe);
      const index = indexFrom(event);
      const field = fieldFrom(event);
      if (!recipe.failures[index] || !['problem', 'cause', 'remedy'].includes(field)) return;
      recipe.failures[index][field] = inputValue(event);
      this.commit(recipe);
    },
  },
});
