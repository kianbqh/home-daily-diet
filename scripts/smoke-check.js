const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
const cloudConfig = require(path.join(root, 'cloudbase.config.js'));
const requiredFiles = [
  'app.js',
  'app.json',
  'app.wxss',
  'sitemap.json',
  'services/domain.js',
  'services/storage.js',
  'services/cloudbase-sync.js',
  'services/app-bootstrap.js',
  'services/app-store.js',
  'services/recipe-assistant.js',
  'cloudfunctions/family-access/index.js',
  'cloudfunctions/family-access/logic.js',
  'cloudfunctions/family-access/package.json',
  'cloudfunctions/recipe-assistant/index.js',
  'cloudfunctions/recipe-assistant/logic.js',
  'cloudfunctions/recipe-assistant/repository.js',
  'cloudfunctions/recipe-assistant/recipe-schema.js',
  'cloudfunctions/recipe-assistant/providers/tencent-asr.js',
  'cloudfunctions/recipe-assistant/providers/tokenhub.js',
  'cloudfunctions/recipe-assistant/package.json',
  'cloudfunctions/recipe-assistant/package-lock.json',
  'utils/format.js',
  'utils/page-refresh.js',
  'utils/view-model.js',
  'components/dish-card/dish-card.js',
  'components/dish-card/dish-card.wxml',
  'components/dish-card/dish-card.wxss',
  'components/recipe-editor/recipe-editor.js',
  'components/recipe-editor/recipe-editor.json',
  'components/recipe-editor/recipe-editor.wxml',
  'components/recipe-editor/recipe-editor.wxss',
  'components/recipe-recording-workspace/recipe-recording-workspace.js',
  'components/recipe-recording-workspace/recipe-recording-workspace.json',
  'components/recipe-recording-workspace/recipe-recording-workspace.wxml',
  'components/recipe-recording-workspace/recipe-recording-workspace.wxss',
  'pages/index/index.js',
  'pages/index/index.wxml',
  'pages/index/index.wxss',
  'pages/dishes/dishes.js',
  'pages/dishes/dishes.wxml',
  'pages/dishes/dishes.wxss',
  'pages/dish-edit/dish-edit.js',
  'pages/dish-edit/dish-edit.wxml',
  'pages/dish-edit/dish-edit.wxss',
  'pages/recipe/recipe.js',
  'pages/recipe/recipe.json',
  'pages/recipe/recipe.wxml',
  'pages/recipe/recipe.wxss',
  'pages/recipe-draft/recipe-draft.js',
  'pages/recipe-draft/recipe-draft.json',
  'pages/recipe-draft/recipe-draft.wxml',
  'pages/recipe-draft/recipe-draft.wxss',
  'pages/meal/meal.js',
  'pages/meal/meal.wxml',
  'pages/meal/meal.wxss',
  'pages/family/family.js',
  'pages/family/family.wxml',
  'pages/family/family.wxss',
  'pages/trash/trash.js',
  'pages/trash/trash.wxml',
  'pages/trash/trash.wxss',
  '.env.example',
  'docs/cloudbase-phase-two-setup.md',
  'docs/qa/phase-two-dual-account-checklist.md',
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`SMOKE FAIL: missing files\n${missing.join('\n')}`);
  process.exit(1);
}

const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const envValues = new Map(envExample.split(/\r?\n/).filter(Boolean).map((line) => {
  const separator = line.indexOf('=');
  return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
}));
const expectedEnvironment = new Map([
  ['TOKENHUB_API_KEY', 'replace-in-cloud-function-console'],
  ['RECIPE_MODEL', 'hy3'],
  ['RECIPE_PROMPT_VERSION', 'v1'],
  ['ASR_SECRET_ID', 'replace-in-cloud-function-console'],
  ['ASR_SECRET_KEY', 'replace-in-cloud-function-console'],
  ['ASR_SESSION_TOKEN', ''],
  ['ASR_REGION', 'ap-shanghai'],
  ['ASR_ENGINE', '16k_zh'],
]);
const environmentMismatches = [...expectedEnvironment].filter(
  ([key, value]) => envValues.get(key) !== value
);
if (environmentMismatches.length) {
  console.error(`SMOKE FAIL: phase two environment example mismatch\n${environmentMismatches.map(
    ([key, value]) => `${key}: expected ${value || '<empty>'}`
  ).join('\n')}`);
  process.exit(1);
}

const setupGuide = fs.readFileSync(path.join(root, 'docs/cloudbase-phase-two-setup.md'), 'utf8');
const requiredGuideFragments = [
  'recipe_recordings', 'recipe_drafts', 'family_recipes', 'recipe_versions', 'recipe_usage_daily',
  '仅管理端可读写', 'Node.js 20.19', 'index.main', 'CreateRecTask', 'DescribeTaskStatus',
  'TOKENHUB_API_KEY', 'ASR_SECRET_ID', '50%', '80%', '100%',
  '麦克风', '原始语音', 'TokenHub', '彻底删除',
  '只读访问 `family_members` 和 `family_states`',
  '客户端仅允许上传', 'wx.cloud.uploadFile',
];
const missingGuideFragments = requiredGuideFragments.filter((fragment) => !setupGuide.includes(fragment));
if (missingGuideFragments.length) {
  console.error(`SMOKE FAIL: phase two setup guide is incomplete\n${missingGuideFragments.join('\n')}`);
  process.exit(1);
}

const acceptanceChecklist = fs.readFileSync(
  path.join(root, 'docs/qa/phase-two-dual-account-checklist.md'),
  'utf8'
);
const requiredAcceptanceFragments = [
  '| caseId | account | device | buildVersion | result | screenshotOrLog | notes |',
  'P0-01', 'P0-02', 'P0-03', 'P0-04', 'P0-05', 'P0-06', 'P0-07', 'P0-08', 'P0-09', 'P0-10',
  'P0-11', 'P0-12', 'P1-13', 'P0-14', 'P0-15', 'P1-16', 'P0-17', 'P1-18', 'P0-19', 'P0-20',
  'FILE_ACCESS_DENIED', 'TOKENHUB_API_KEY', 'ASR_SECRET_ID', '回滚',
];
const missingAcceptanceFragments = requiredAcceptanceFragments.filter(
  (fragment) => !acceptanceChecklist.includes(fragment)
);
const acceptanceRows = acceptanceChecklist.split(/\r?\n/).filter((line) => /^\| P[01]-\d{2} \|/.test(line));
const allowedAcceptanceResults = new Set(['待执行', '通过', '失败', '阻塞']);
const invalidAcceptanceRows = acceptanceRows.filter((line) => {
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  return cells.length !== 7
    || !allowedAcceptanceResults.has(cells[4])
    || (cells[4] === '通过' && (!cells[5] || cells[5] === '—'));
});
const checklistGateMatch = acceptanceChecklist.match(/发布门槛状态：`(待执行|通过|失败|阻塞)`/);
const passedWithoutCompleteEvidence = checklistGateMatch && checklistGateMatch[1] === '通过'
  && acceptanceRows.some((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return cells[4] !== '通过' || !cells[5] || cells[5] === '—';
  });
if (missingAcceptanceFragments.length || acceptanceRows.length !== 20 || invalidAcceptanceRows.length
  || !checklistGateMatch || passedWithoutCompleteEvidence) {
  console.error(`SMOKE FAIL: phase two device acceptance checklist is incomplete or claims unverified evidence\n${[
    ...missingAcceptanceFragments,
    acceptanceRows.length === 20 ? '' : `expected 20 evidence rows, found ${acceptanceRows.length}`,
    ...invalidAcceptanceRows,
    checklistGateMatch ? '' : 'missing release gate state',
    passedWithoutCompleteEvidence ? 'release gate cannot pass before every evidence row passes' : '',
  ].filter(Boolean).join('\n')}`);
  process.exit(1);
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeGateMatch = readme.match(/发布门槛状态：`(待执行|通过|失败|阻塞)`/);
if (!readme.includes('[第二阶段双账号真机验收表](docs/qa/phase-two-dual-account-checklist.md)')
  || !readmeGateMatch
  || (readmeGateMatch[1] === '通过' && (!checklistGateMatch || checklistGateMatch[1] !== '通过'))) {
  console.error('SMOKE FAIL: README must link and accurately report the phase two device release gate');
  process.exit(1);
}

const expectedPages = [
  'pages/index/index',
  'pages/dishes/dishes',
  'pages/dish-edit/dish-edit',
  'pages/recipe/recipe',
  'pages/recipe-draft/recipe-draft',
  'pages/meal/meal',
  'pages/family/family',
  'pages/trash/trash',
];
const missingPages = expectedPages.filter((page) => !appConfig.pages.includes(page));
if (missingPages.length) {
  console.error(`SMOKE FAIL: missing routes\n${missingPages.join('\n')}`);
  process.exit(1);
}

const expectedReleaseConfig = {
  appid: 'wx6e247df29f902c68',
  envId: 'home-daily-diet-d8f5e7d6907dd53a',
  stateCollection: 'family_states',
  eventCollection: 'family_states_events',
  memberCollection: 'family_members',
  inviteCollection: 'family_invites',
  accessFunction: 'family-access',
  recipeFunction: 'recipe-assistant',
  recipeAudioPrefix: 'families/',
};
const actualReleaseConfig = {
  appid: projectConfig.appid,
  envId: cloudConfig.envId,
  stateCollection: cloudConfig.stateCollection,
  eventCollection: cloudConfig.eventCollection,
  memberCollection: cloudConfig.memberCollection,
  inviteCollection: cloudConfig.inviteCollection,
  accessFunction: cloudConfig.accessFunction,
  recipeFunction: cloudConfig.recipeFunction,
  recipeAudioPrefix: cloudConfig.recipeAudioPrefix,
};
const configMismatches = Object.keys(expectedReleaseConfig).filter(
  (key) => actualReleaseConfig[key] !== expectedReleaseConfig[key]
);
if (configMismatches.length) {
  console.error(`SMOKE FAIL: release configuration mismatch\n${configMismatches.map((key) => (
    `${key}: expected ${expectedReleaseConfig[key]}, received ${actualReleaseConfig[key]}`
  )).join('\n')}`);
  process.exit(1);
}

const shareSourceFiles = [
  'pages/index/index.js',
  'pages/meal/meal.js',
  'pages/family/family.js',
];
const shareLeaks = shareSourceFiles.filter((file) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return /familyId=/.test(source);
});
if (shareLeaks.length) {
  console.error(`SMOKE FAIL: raw family id remains in share paths\n${shareLeaks.join('\n')}`);
  process.exit(1);
}

const ignoredEntries = new Set(
  ((projectConfig.packOptions && projectConfig.packOptions.ignore) || []).map((entry) => entry.value)
);
const requiredIgnoredEntries = [
  '.agents',
  '.codex-downloads',
  '.wechat-devtools-data',
  '.wechat-devtools-profile',
  '.superpowers',
  '.worktrees',
  'docs',
  'scripts',
  'tests',
  '.env',
  '.env.example',
  'README.md',
  'SPEC.md',
  'package.json',
  'project.private.config.json',
];
const missingIgnoreEntries = requiredIgnoredEntries.filter((entry) => !ignoredEntries.has(entry));
if (missingIgnoreEntries.length) {
  console.error(`SMOKE FAIL: upload ignore entries missing\n${missingIgnoreEntries.join('\n')}`);
  process.exit(1);
}

const cloudFunctionRoot = String(projectConfig.cloudfunctionRoot || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/$/, '')
  .split('/')[0];
const implicitExcludedRoots = new Set(['node_modules', cloudFunctionRoot].filter(Boolean));

function isPackagePathIgnored(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const rootName = normalized.split('/')[0];
  return implicitExcludedRoots.has(rootName)
    || ignoredEntries.has(rootName)
    || ignoredEntries.has(normalized);
}

const protectedPackagePaths = [
  '.env',
  '.env.example',
  '.superpowers/sdd/review.diff',
  '.worktrees/feature-branch/app.js',
  'tests/fixtures/private/example.json',
  'docs/cloudbase-phase-two-setup.md',
  'docs/qa/phase-two-dual-account-checklist.md',
  'scripts/smoke-check.js',
];
const leakedProtectedPaths = protectedPackagePaths.filter((file) => !isPackagePathIgnored(file));
if (leakedProtectedPaths.length) {
  console.error(`SMOKE FAIL: private or development paths enter the main package\n${leakedProtectedPaths.join('\n')}`);
  process.exit(1);
}

function listIncludedFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const rootName = relativePath.split('/')[0];
    if (isPackagePathIgnored(relativePath)) return [];
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listIncludedFiles(absolutePath, relativePath)
      : [{ absolutePath, relativePath }];
  });
}

const includedFiles = listIncludedFiles(root);
const packageBytes = includedFiles.reduce((total, file) => total + fs.statSync(file.absolutePath).size, 0);
const maxPackageBytes = 1.5 * 1024 * 1024;
if (packageBytes > maxPackageBytes) {
  console.error(`SMOKE FAIL: estimated main package is ${(packageBytes / 1024 / 1024).toFixed(2)} MB`);
  process.exit(1);
}

const wxmlFiles = requiredFiles.filter((file) => file.endsWith('.wxml'));
const unsupportedPatterns = [
  /=>/,
  /\.findIndex\(/,
  /getApp\(\)/,
  /data-[a-z-]+="\{\{item\}\}"/,
];
const badWxml = wxmlFiles.filter((file) => {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return unsupportedPatterns.some((pattern) => pattern.test(text));
});
if (badWxml.length) {
  console.error(`SMOKE FAIL: unsupported WXML expression in\n${badWxml.join('\n')}`);
  process.exit(1);
}

const dishDetailTemplate = fs.readFileSync(path.join(root, 'pages/dish-edit/dish-edit.wxml'), 'utf8');
const emptyFamilyRecipeBlockMatch = dishDetailTemplate.match(
  /<block wx:else>\s*<text class="recipe-empty-title">还没有记录做法<\/text>[\s\S]*?<\/block>/
);
const emptyFamilyRecipeBlock = emptyFamilyRecipeBlockMatch ? emptyFamilyRecipeBlockMatch[0] : '';
const recordingWorkspaceIndex = dishDetailTemplate.search(/<recipe-recording-workspace(?:\s|\/?>)/);
const optionalRecordMetadataIndex = dishDetailTemplate.indexOf('这次的照片');
const recipeEntryIssues = [
  /bindtap="startVoiceRecipeEntry"[^>]*>语音记录做法<\/button>/.test(emptyFamilyRecipeBlock)
    ? '' : 'missing visible voice-first recipe entry',
  /bindtap="openManualFamilyRecipe"[^>]*>直接手动填写<\/button>/.test(emptyFamilyRecipeBlock)
    ? '' : 'missing manual recipe fallback entry',
  recordingWorkspaceIndex >= 0 && optionalRecordMetadataIndex >= 0
    && recordingWorkspaceIndex < optionalRecordMetadataIndex
    ? '' : 'recording workspace must appear before optional record metadata',
].filter(Boolean);
if (recipeEntryIssues.length) {
  console.error(`SMOKE FAIL: unified recipe entry is incomplete\n${recipeEntryIssues.join('\n')}`);
  process.exit(1);
}

const recipeDraftTemplate = fs.readFileSync(path.join(root, 'pages/recipe-draft/recipe-draft.wxml'), 'utf8');
const recipeEditorTemplate = fs.readFileSync(path.join(root, 'components/recipe-editor/recipe-editor.wxml'), 'utf8');
const recipeSectionSpecs = [
  { field: 'ingredients', label: '+ 食材', handler: 'addIngredient' },
  { field: 'steps', label: '+ 步骤', handler: 'addStep' },
  { field: 'tips', label: '+ 技巧', handler: 'addTextItem', dataField: 'tips' },
  { field: 'failures', label: '+ 问题', handler: 'addFailure' },
  { field: 'familyNotes', label: '+ 经验', handler: 'addTextItem', dataField: 'familyNotes' },
];
const recipeSectionStartPattern = /<view class="editor-section card-surface \{\{!recipe\.([A-Za-z][A-Za-z0-9]*)\.length \? 'is-empty' : ''\}\}">/g;
const recipeSectionStarts = Array.from(recipeEditorTemplate.matchAll(recipeSectionStartPattern));
const recipeSections = recipeSectionStarts.map((match, index) => ({
  field: match[1],
  template: recipeEditorTemplate.slice(
    match.index,
    index + 1 < recipeSectionStarts.length ? recipeSectionStarts[index + 1].index : recipeEditorTemplate.length
  ),
}));
const compactSectionIssues = recipeSectionSpecs.flatMap((spec) => {
  const matchingSections = recipeSections.filter((section) => section.field === spec.field);
  if (matchingSections.length !== 1) {
    return [`expected exactly one compact ${spec.field} section, found ${matchingSections.length}`];
  }

  const sectionTemplate = matchingSections[0].template;
  const dataFieldAssertion = spec.dataField
    ? `(?=[^>]*data-field="${spec.dataField}")`
    : '';
  const escapedLabel = spec.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const emptyActionPattern = new RegExp(
    `<view wx:if="\\{\\{!recipe\\.${spec.field}\\.length\\}\\}" class="editor-empty">\\s*`
      + `<button(?=[^>]*class="editor-empty-action")(?=[^>]*bindtap="${spec.handler}")${dataFieldAssertion}[^>]*>`
      + `${escapedLabel}<\\/button>\\s*<\\/view>`
  );
  return emptyActionPattern.test(sectionTemplate)
    ? []
    : [`compact ${spec.field} section has an invalid empty binding, label, or handler`];
});
const compactDraftIssues = [
  /RECIPE DRAFT|class="page-title">整理家庭菜谱/.test(recipeDraftTemplate)
    ? 'recipe draft repeats the page title' : '',
  /bindtap="switchToVoiceRecording">改用语音记录<\/button>/.test(recipeDraftTemplate)
    ? '' : 'manual draft is missing the voice escape hatch',
  ...compactSectionIssues,
].filter(Boolean);
if (compactDraftIssues.length) {
  console.error(`SMOKE FAIL: compact recipe draft shell is incomplete\n${compactDraftIssues.join('\n')}`);
  process.exit(1);
}

console.log(`SMOKE PASS: ${requiredFiles.length} required files, ${expectedPages.length} routes, ${(packageBytes / 1024).toFixed(1)} KB estimated main package`);
