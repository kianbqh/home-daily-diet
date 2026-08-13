const { emptyRecipe, normalizeRecipe } = require('../services/recipe-domain');

function memberName(members, memberId) {
  const member = (Array.isArray(members) ? members : []).find((item) => item.id === memberId);
  return member && member.displayName ? member.displayName : '家庭成员';
}

function formatRecipeTime(value) {
  if (value == null || value === '') return '还没有确认时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '还没有确认时间';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function decorateVersion(version, members = []) {
  if (!version) return null;
  const recipe = normalizeRecipe(version.recipe || emptyRecipe());
  return {
    ...version,
    recipe,
    confirmedByLabel: memberName(members, version.confirmedBy),
    confirmedAtLabel: formatRecipeTime(version.confirmedAt),
    ingredientCount: recipe.ingredients.length,
    stepCount: recipe.steps.length,
  };
}

function buildRecipeSummary(result, members = []) {
  const version = decorateVersion(result && result.version, members);
  if (!version) {
    return {
      hasRecipe: false,
      ingredientCount: 0,
      stepCount: 0,
      confirmedByLabel: '',
      confirmedAtLabel: '',
      versionNumber: 0,
    };
  }
  return {
    hasRecipe: true,
    ingredientCount: version.ingredientCount,
    stepCount: version.stepCount,
    confirmedByLabel: version.confirmedByLabel,
    confirmedAtLabel: version.confirmedAtLabel,
    versionNumber: Number(version.versionNumber) || 0,
  };
}

function decorateVersions(versions, members = []) {
  return (Array.isArray(versions) ? versions : []).map((version) => decorateVersion(version, members));
}

module.exports = {
  buildRecipeSummary,
  decorateVersion,
  decorateVersions,
  formatRecipeTime,
};
