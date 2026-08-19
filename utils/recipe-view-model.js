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

function buildRecordRecipeState(workspace, recordId) {
  const empty = {
    state: 'none',
    label: '暂无做法',
    actionLabel: '',
    draftId: '',
    versionId: '',
    actionable: false,
  };
  if (!workspace || typeof workspace !== 'object') return empty;

  const draft = workspace.draft && typeof workspace.draft === 'object' ? workspace.draft : null;
  const draftId = String(draft && (draft._id || draft.id) || '');
  const sameRecord = !draft || !recordId || String(draft.recordId || '') === String(recordId);
  if (draft && sameRecord && draft.status === 'confirmed' && draft.confirmedVersionId) {
    return {
      state: 'confirmed',
      label: '已保存本次做法',
      actionLabel: '查看本次做法',
      draftId,
      versionId: String(draft.confirmedVersionId),
      actionable: true,
    };
  }

  if (draft && sameRecord && ['editing', 'organizing', 'ready', 'failed'].includes(draft.status)) {
    const actionable = ['editing', 'ready', 'failed'].includes(draft.status);
    return {
      state: 'draft',
      label: '菜谱草稿待确认',
      actionLabel: actionable ? '继续整理' : '',
      draftId,
      versionId: '',
      actionable,
    };
  }

  const recordings = (Array.isArray(workspace.recordings) ? workspace.recordings : [])
    .filter((item) => item && item.status !== 'deleted');
  if (recordings.some((item) => item.status !== 'ready')) {
    return {
      ...empty,
      state: 'transcribing',
      label: '语音转写中',
      draftId,
    };
  }

  if (!draft && recordings.length
    && recordings.some((item) => String(item.editedTranscript || item.rawTranscript || '').trim())) {
    return {
      state: 'draft',
      label: '菜谱草稿待确认',
      actionLabel: '继续整理',
      draftId: '',
      versionId: '',
      actionable: true,
    };
  }

  return empty;
}

module.exports = {
  buildRecordRecipeState,
  buildRecipeSummary,
  decorateVersion,
  decorateVersions,
  formatRecipeTime,
};
