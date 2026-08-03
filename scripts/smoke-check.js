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
  'cloudfunctions/family-access/index.js',
  'cloudfunctions/family-access/logic.js',
  'cloudfunctions/family-access/package.json',
  'utils/format.js',
  'utils/view-model.js',
  'components/dish-card/dish-card.js',
  'components/dish-card/dish-card.wxml',
  'components/dish-card/dish-card.wxss',
  'pages/index/index.js',
  'pages/index/index.wxml',
  'pages/index/index.wxss',
  'pages/dishes/dishes.js',
  'pages/dishes/dishes.wxml',
  'pages/dishes/dishes.wxss',
  'pages/dish-edit/dish-edit.js',
  'pages/dish-edit/dish-edit.wxml',
  'pages/dish-edit/dish-edit.wxss',
  'pages/meal/meal.js',
  'pages/meal/meal.wxml',
  'pages/meal/meal.wxss',
  'pages/family/family.js',
  'pages/family/family.wxml',
  'pages/family/family.wxss',
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`SMOKE FAIL: missing files\n${missing.join('\n')}`);
  process.exit(1);
}

const expectedPages = [
  'pages/index/index',
  'pages/dishes/dishes',
  'pages/dish-edit/dish-edit',
  'pages/meal/meal',
  'pages/family/family',
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
};
const actualReleaseConfig = {
  appid: projectConfig.appid,
  envId: cloudConfig.envId,
  stateCollection: cloudConfig.stateCollection,
  eventCollection: cloudConfig.eventCollection,
  memberCollection: cloudConfig.memberCollection,
  inviteCollection: cloudConfig.inviteCollection,
  accessFunction: cloudConfig.accessFunction,
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
  'docs',
  'scripts',
  'tests',
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

function listIncludedFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const rootName = relativePath.split('/')[0];
    if (ignoredEntries.has(rootName) || ignoredEntries.has(relativePath)) return [];
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

console.log(`SMOKE PASS: ${requiredFiles.length} required files, ${expectedPages.length} routes, ${(packageBytes / 1024).toFixed(1)} KB estimated main package`);
